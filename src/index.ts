/**
 * pupu_skills MCP Server 主入口。
 *
 * 新执行模型：技能是 markdown 文档，服务器只负责管理、检索、评分与路由。
 */

import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { logger, setLogLevel, LogLevel } from "./utils/logger.js";
import { SkillStore, type SkillRecord } from "./memory/store.js";
import { route, buildSkillSummary } from "./router/router.js";

const server = new McpServer(
  { name: "pupu-skills", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(__dirname, "..", "..", "skills");

let storePromise: Promise<SkillStore> | null = null;

function getStore(): Promise<SkillStore> {
  if (!storePromise) {
    storePromise = SkillStore.create();
  }
  return storePromise;
}

function withSkillSummary(text: string, store: SkillStore): string {
  const summary = buildSkillSummary(store.list());
  return `${text}\n\n---\n${summary}`;
}

function ok(text: string, store: SkillStore): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text", text: withSkillSummary(text, store) }],
  };
}

function fail(text: string, store: SkillStore): { content: Array<{ type: "text"; text: string }>; isError: true } {
  return {
    content: [{ type: "text", text: withSkillSummary(text, store) }],
    isError: true,
  };
}

function parseFrontmatter(markdown: string): {
  body: string;
  meta: { name?: string; description?: string; triggers?: string[]; calls?: string[] };
} {
  const normalized = markdown.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---\n")) {
    return { body: normalized, meta: {} };
  }

  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) {
    return { body: normalized, meta: {} };
  }

  const frontmatter = normalized.slice(4, end);
  const body = normalized.slice(end + 5).replace(/^\n+/, "");

  const lines = frontmatter.split(/\r?\n/);
  const meta: { name?: string; description?: string; triggers?: string[]; calls?: string[] } = {};

  let cursor = 0;
  while (cursor < lines.length) {
    const line = lines[cursor].trim();
    cursor += 1;

    if (!line || line.startsWith("#")) {
      continue;
    }

    if (line.startsWith("name:")) {
      const raw = line.slice(5).trim();
      if (raw) {
        meta.name = raw.replace(/^['"]|['"]$/g, "");
      }
      continue;
    }

    if (line.startsWith("description:")) {
      const raw = line.slice(12).trim();
      if (raw) {
        meta.description = raw.replace(/^['"]|['"]$/g, "");
      }
      continue;
    }

    if (line === "triggers:" || line === "calls:") {
      const target = line.startsWith("triggers") ? "triggers" : "calls";
      const values: string[] = [];

      while (cursor < lines.length) {
        const itemLine = lines[cursor];
        const trimmed = itemLine.trim();
        if (!trimmed.startsWith("-")) {
          break;
        }
        const value = trimmed.slice(1).trim().replace(/^['"]|['"]$/g, "");
        if (value) {
          values.push(value);
        }
        cursor += 1;
      }

      if (target === "triggers") {
        meta.triggers = values;
      } else {
        meta.calls = values;
      }
    }
  }

  return { body, meta };
}

async function loadBuiltinSkills(store: SkillStore): Promise<void> {
  const builtinFiles = [
    "filesystem",
    "web-search",
    "docx",
    "pdf",
    "xlsx",
    "pptx",
    "image-analysis",
    "grep",
    "skill-creator",
  ];

  for (const name of builtinFiles) {
    const filePath = join(SKILLS_DIR, `${name}.md`);

    try {
      const raw = await readFile(filePath, "utf-8");
      const parsed = parseFrontmatter(raw);

      const description =
        parsed.meta.description ??
        parsed.body.split(/\r?\n/).find(line => line.trim().length > 0)?.replace(/^#+\s*/, "") ??
        `内置技能 ${name}`;

      await store.registerBuiltin({
        name: parsed.meta.name ?? name,
        content: parsed.body,
        description,
        triggers: parsed.meta.triggers ?? [],
        calls: parsed.meta.calls ?? [],
      });
    } catch {
      logger.warn("内置技能加载失败", { name });
    }
  }
}

function formatSkillBrief(skill: SkillRecord): string {
  const tag = skill.builtin ? "[内置]" : "[用户]";
  const triggerText = skill.triggers.length > 0 ? skill.triggers.join("、") : "无";
  return [
    `- ${skill.name} ${tag} | 效用分: ${skill.utilityScore}`,
    `  描述: ${skill.description || "(无描述)"}`,
    `  触发词: ${triggerText}`,
  ].join("\n");
}

server.tool(
  "pupu_read",
  "搜索技能库：按名称、描述、触发词进行模糊匹配，并返回技能列表。",
  {
    query: z.string().min(1, "query 不能为空").describe("搜索关键词"),
  },
  async ({ query }) => {
    const store = await getStore();
    const skills = store.search(query);

    if (skills.length === 0) {
      return ok(`未找到与「${query}」匹配的技能。可使用 pupu_write 创建新技能。`, store);
    }

    const lines = skills.map(formatSkillBrief).join("\n\n");
    return ok(`共找到 ${skills.length} 个匹配技能（已按匹配度与效用排序）：\n\n${lines}`, store);
  }
);

server.tool(
  "pupu_write",
  "创建或更新技能：写入 markdown 内容并更新元数据（内置技能不可覆盖）。",
  {
    scriptName: z
      .string()
      .regex(/^[a-zA-Z0-9_-]+$/, "技能名仅允许字母、数字、下划线和连字符")
      .describe("技能名称"),
    content: z.string().min(1, "content 不能为空").describe("技能 markdown 正文内容"),
    description: z.string().min(1, "description 不能为空").describe("技能描述"),
    triggers: z.array(z.string()).default([]).describe("触发词列表"),
    calls: z.array(z.string()).default([]).describe("依赖调用的技能列表"),
  },
  async ({ scriptName, content, description, triggers, calls }) => {
    const store = await getStore();
    const existing = store.get(scriptName);

    if (existing?.builtin) {
      return fail(`内置技能「${scriptName}」不可覆盖，请改用其他名称。`, store);
    }

    if (!content.trim()) {
      return fail("技能内容不能为空。", store);
    }

    try {
      const record = await store.save({
        name: scriptName,
        content,
        description,
        triggers,
        calls,
      });

      const triggerText = record.triggers.length > 0 ? record.triggers.join("、") : "无";
      const callText = record.calls.length > 0 ? record.calls.join("、") : "无";
      const msg = [
        existing ? `技能已更新：${record.name}` : `技能已创建：${record.name}`,
        `描述：${record.description}`,
        `触发词：${triggerText}`,
        `调用链：${callText}`,
        `当前效用分：${record.utilityScore}`,
      ].join("\n");

      return ok(msg, store);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return fail(`保存技能失败：${reason}`, store);
    }
  }
);

server.tool(
  "pupu_execute",
  "执行技能：读取技能 markdown 并返回执行指令（不运行任何子进程）。",
  {
    scriptName: z.string().min(1).describe("技能名称"),
    context: z.string().default("").describe("任务上下文描述"),
  },
  async ({ scriptName, context }) => {
    const store = await getStore();
    const skill = store.get(scriptName);
    if (!skill) {
      return fail(`技能不存在：${scriptName}`, store);
    }

    try {
      const markdown = await store.readSkillContent(scriptName);
      const text = [
        `═══ 技能: ${scriptName} ═══`,
        markdown,
        "═══",
        context.trim() ? `当前任务上下文：${context.trim()}` : "当前任务上下文：未提供",
        "请按照以上技能文档的步骤执行当前任务。",
        "完成后调用 pupu_report 汇报结果（success/failure）。",
      ].join("\n");
      return ok(text, store);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return fail(`读取技能内容失败：${reason}`, store);
    }
  }
);

server.tool(
  "pupu_report",
  "汇报技能执行结果：记录成功/失败、摘要和错误信息，并更新效用分。",
  {
    scriptName: z.string().min(1).describe("技能名称"),
    success: z.boolean().describe("是否执行成功"),
    summary: z.string().min(1).describe("执行摘要"),
    error: z.string().optional().describe("失败时的错误信息"),
  },
  async ({ scriptName, success, summary, error }) => {
    const store = await getStore();
    const skill = store.get(scriptName);
    if (!skill) {
      return fail(`技能不存在：${scriptName}`, store);
    }

    await store.recordExecution(scriptName, {
      timestamp: new Date().toISOString(),
      success,
      duration: 0,
      summary,
      error: success ? null : (error ?? "执行失败"),
      context: summary,
    });

    const updated = store.get(scriptName);
    if (!updated) {
      return fail(`技能记录更新后不可用：${scriptName}`, store);
    }

    const lines = [
      `执行结果已记录：${scriptName}`,
      `状态：${success ? "成功" : "失败"}`,
      `摘要：${summary}`,
      `最新效用分：${updated.utilityScore}`,
    ];

    if (!success) {
      lines.push("建议下一步调用 pupu_reflect 进行失败反思与改进。", error ? `错误：${error}` : "");
    }

    return ok(lines.filter(Boolean).join("\n"), store);
  }
);

server.tool(
  "pupu_reflect",
  "反思分析：基于最近执行结果与历史模式，给出具体技能改进建议。",
  {
    scriptName: z.string().min(1).describe("技能名称"),
  },
  async ({ scriptName }) => {
    const store = await getStore();
    const skill = store.get(scriptName);
    if (!skill) {
      return fail(`技能不存在：${scriptName}`, store);
    }

    const last = store.getLastExecution(scriptName);
    if (!last) {
      return ok(`技能「${scriptName}」暂无执行历史，请先调用 pupu_execute 并在完成后用 pupu_report 汇报。`, store);
    }

    if (last.success) {
      return ok(`技能「${scriptName}」最近一次执行成功（${last.timestamp}），当前无需反思。`, store);
    }

    const recentHistory = store.getHistory(scriptName, 10);
    const failCount = recentHistory.filter(item => !item.success).length;
    const successCount = recentHistory.filter(item => item.success).length;
    const sameErrorCount = recentHistory.filter(item => !item.success && item.error === last.error).length;

    let markdown = "";
    try {
      markdown = await store.readSkillContent(scriptName);
    } catch {
      markdown = "(技能文档读取失败，无法定位具体段落)";
    }

    const sections = markdown.split(/\n##\s+/).map(s => s.trim()).filter(Boolean);
    const hasTriggerSection = /##\s*触发条件/.test(markdown);
    const hasStepSection = /##\s*执行步骤/.test(markdown);
    const hasNoteSection = /##\s*注意事项/.test(markdown);

    const suggestions: string[] = [];
    if (!hasTriggerSection) suggestions.push("补充“触发条件”章节，缩小误触发范围。");
    if (!hasStepSection) suggestions.push("补充“执行步骤”章节，并将步骤改为可验证的顺序动作。");
    if (!hasNoteSection) suggestions.push("补充“注意事项”章节，提前声明前置条件和失败兜底策略。");
    if (sameErrorCount >= 2) suggestions.push("同类错误重复出现，建议在步骤中加入“失败分支处理”与“重试条件”。");
    if (failCount > successCount) suggestions.push("近期失败多于成功，建议重写关键步骤并缩短单次执行链路。");
    if (suggestions.length === 0) suggestions.push("建议重点优化执行步骤中的命令顺序与输入校验。");

    const report = [
      `═══ 反思报告: ${scriptName} ═══`,
      `最近状态：失败`,
      `最近错误：${last.error ?? "(未提供)"}`,
      `最近摘要：${last.summary}`,
      `最近10次统计：成功 ${successCount} / 失败 ${failCount}`,
      `同类错误复现次数：${sameErrorCount}`,
      `文档章节数（粗略）：${sections.length}`,
      "",
      "【建议修改点】",
      ...suggestions.map(item => `- ${item}`),
      "",
      "【建议优先改动位置】",
      hasStepSection ? "- 优先修改“执行步骤”章节，增加前置检查、失败回退与结果验收。" : "- 先新增“执行步骤”章节。",
      hasTriggerSection ? "- 调整“触发条件”章节，避免任务不匹配时误用该技能。" : "- 新增“触发条件”章节。",
      "- 如需落地改动，请调用 pupu_write 更新 markdown。",
    ].join("\n");

    return ok(report, store);
  }
);

server.tool(
  "pupu_evolve",
  "技能进化评估：支持 assess 全量评估与 cleanup 低效技能清理建议。",
  {
    action: z.enum(["assess", "cleanup"]).describe("assess 或 cleanup"),
  },
  async ({ action }) => {
    const store = await getStore();
    const all = store.list();

    if (action === "cleanup") {
      const low = store.getLowUtility(30);
      if (low.length === 0) {
        return ok("未发现效用分低于 30 且执行次数≥2 的技能。", store);
      }

      const lines = [
        `建议清理技能 ${low.length} 个（效用分 < 30）：`,
        ...low.map(skill => `- ${skill.name} | 效用分 ${skill.utilityScore} | 成功 ${skill.successCount}/${skill.executionCount}`),
      ];
      return ok(lines.join("\n"), store);
    }

    const userSkills = all.filter(skill => !skill.builtin);
    const high = userSkills.filter(skill => skill.utilityScore >= 70);
    const mid = userSkills.filter(skill => skill.utilityScore >= 40 && skill.utilityScore < 70);
    const low = userSkills.filter(skill => skill.utilityScore < 40);

    const report = [
      "═══ 技能评估报告 ═══",
      `总技能数：${all.length}`,
      `内置技能：${all.filter(skill => skill.builtin).length}`,
      `用户技能：${userSkills.length}`,
      "",
      `高效（>=70）：${high.length}`,
      ...high.slice(0, 5).map(skill => `- ${skill.name} (${skill.utilityScore})`),
      "",
      `中效（40-69）：${mid.length}`,
      ...mid.slice(0, 5).map(skill => `- ${skill.name} (${skill.utilityScore})`),
      "",
      `低效（<40）：${low.length}`,
      ...low.slice(0, 8).map(skill => `- ${skill.name} (${skill.utilityScore})`),
      "",
      "建议：低效技能可先 pupu_reflect，再决定 pupu_write 重写或 pupu_delete 清理。",
    ].join("\n");

    return ok(report, store);
  }
);

server.tool(
  "pupu_delete",
  "删除技能：仅允许删除用户技能，内置技能受保护。",
  {
    scriptName: z.string().min(1).describe("技能名称"),
  },
  async ({ scriptName }) => {
    const store = await getStore();
    const skill = store.get(scriptName);

    if (!skill) {
      return fail(`技能不存在：${scriptName}`, store);
    }
    if (skill.builtin) {
      return fail(`内置技能「${scriptName}」不可删除。`, store);
    }

    const deleted = await store.delete(scriptName);
    if (!deleted) {
      return fail(`删除失败：${scriptName}`, store);
    }

    return ok(`技能已删除：${scriptName}`, store);
  }
);

server.tool(
  "pupu_history",
  "查看技能执行历史：返回成功/失败、摘要与时间戳。",
  {
    scriptName: z.string().min(1).describe("技能名称"),
    limit: z.number().int().min(1).max(50).default(10).describe("返回条数（1-50）"),
  },
  async ({ scriptName, limit }) => {
    const store = await getStore();
    const skill = store.get(scriptName);
    if (!skill) {
      return fail(`技能不存在：${scriptName}`, store);
    }

    const history = store.getHistory(scriptName, limit);
    if (history.length === 0) {
      return ok(`技能「${scriptName}」暂无执行历史。`, store);
    }

    const lines = [
      `技能：${scriptName}`,
      `最近 ${history.length} 条记录（总执行 ${skill.executionCount}）`,
      ...history.map(item => {
        const status = item.success ? "成功" : "失败";
        const errorText = item.success ? "" : ` | 错误: ${item.error ?? "(无)"}`;
        return `- [${item.timestamp}] ${status} | 摘要: ${item.summary}${errorText}`;
      }),
    ];

    return ok(lines.join("\n"), store);
  }
);

server.tool(
  "pupu_route",
  "技能路由：根据任务描述推荐技能，并给出置信度与匹配原因。",
  {
    task: z.string().min(1).describe("任务描述"),
  },
  async ({ task }) => {
    const store = await getStore();
    const skills = store.list();
    const result = route(task, skills);

    if (result.recommendations.length === 0) {
      return ok(
        `任务：${task}\n未找到合适技能。${result.summary}\n建议：使用 pupu_write 创建新技能并补充 triggers。`,
        store
      );
    }

    const recommendText = result.recommendations
      .map((item, index) => {
        return [
          `${index + 1}. ${item.skill.name}（置信度 ${item.confidence}）`,
          `   描述：${item.skill.description}`,
          `   原因：${item.matchReason}`,
        ].join("\n");
      })
      .join("\n\n");

    return ok(`任务：${task}\n${result.summary}\n\n${recommendText}`, store);
  }
);

export async function startMcpServer(): Promise<void> {
  setLogLevel(LogLevel.INFO);
  const store = await getStore();
  await loadBuiltinSkills(store);

  const count = store.list().length;
  logger.info(`技能库已加载: ${count} 个技能`);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("pupu_skills MCP Server 已启动");
}
