/**
 * pupu_skills MCP Server 主入口。
 *
 * 新执行模型：技能是 markdown 文档，服务器只负责管理、检索、评分与路由。
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createInitializedStore } from "./bootstrap.js";
import { logger, setLogLevel, LogLevel } from "./utils/logger.js";
import { SkillStore, type SkillRecord } from "./memory/store.js";
import { route, buildSkillSummary } from "./router/router.js";
import { isSafeSkillName } from "./skills/validation.js";

const server = new McpServer(
  { name: "pupu-skills", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

let storePromise: Promise<SkillStore> | null = null;

function getStore(): Promise<SkillStore> {
  if (!storePromise) {
    storePromise = createInitializedStore();
  }
  return storePromise;
}

function withSkillSummary(text: string, store: SkillStore, workspaceId?: string): string {
  const summary = buildSkillSummary(store.list({ workspaceId }));
  return `${text}\n\n---\n${summary}`;
}

function ok(text: string, store: SkillStore, workspaceId?: string): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text", text: withSkillSummary(text, store, workspaceId) }],
  };
}

function fail(text: string, store: SkillStore, workspaceId?: string): { content: Array<{ type: "text"; text: string }>; isError: true } {
  return {
    content: [{ type: "text", text: withSkillSummary(text, store, workspaceId) }],
    isError: true,
  };
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
    workspaceId: z.string().optional().describe("工作区ID，用于筛选工作区专属技能"),
  },
  async ({ query, workspaceId }) => {
    const store = await getStore();
    const skills = store.search(query, { workspaceId });

    if (skills.length === 0) {
      return ok(`未找到与「${query}」匹配的技能。可使用 pupu_write 创建新技能。`, store, workspaceId);
    }

    const lines = skills.map(formatSkillBrief).join("\n\n");
    return ok(`共找到 ${skills.length} 个匹配技能（已按匹配度与效用排序）：\n\n${lines}`, store, workspaceId);
  }
);

server.tool(
  "pupu_write",
  "创建或更新技能：写入 markdown 内容并更新元数据（内置技能不可覆盖）。注意：更改 scope 会创建同名技能的新作用域版本，不会删除原版本。",
  {
    scriptName: z
      .string()
      .transform(name => name.trim())
      .refine(
        isSafeSkillName,
        "技能名不能包含路径分隔符、控制字符、Windows 保留名，且不能以空格或点结尾"
      )
      .describe("技能名称"),
    content: z.string().min(1, "content 不能为空").describe("技能 markdown 正文内容"),
    description: z.string().min(1, "description 不能为空").describe("技能描述"),
    triggers: z.array(z.string()).default([]).describe("触发词列表"),
    calls: z.array(z.string()).default([]).describe("依赖调用的技能列表"),
    tags: z.array(z.string()).default([]).describe("技能标签"),
    antiTriggers: z.array(z.string()).default([]).describe("反触发词列表，匹配时降低路由分数"),
    scope: z.enum(["global", "workspace"]).default("global").describe("技能作用域"),
    workspaceId: z.string().optional().describe("工作区ID（scope为workspace时必填）"),
  },
  async ({ scriptName, content, description, triggers, calls, tags, antiTriggers, scope, workspaceId }) => {
    const store = await getStore();

    if (scope === "workspace" && !workspaceId) {
      return fail("scope 为 workspace 时必须提供 workspaceId", store, workspaceId);
    }
    const existing = store.get(scriptName, { workspaceId });

    if (existing?.builtin) {
      return fail(`内置技能「${scriptName}」不可覆盖，请改用其他名称。`, store, workspaceId);
    }

    if (!content.trim()) {
      return fail("技能内容不能为空。", store, workspaceId);
    }

    try {
      const record = await store.save({
        name: scriptName,
        content,
        description,
        triggers,
        calls,
        tags,
        antiTriggers,
        scope,
        workspaceId,
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

      return ok(msg, store, workspaceId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return fail(`保存技能失败：${reason}`, store, workspaceId);
    }
  }
);

server.tool(
  "pupu_execute",
  "执行技能：读取技能 markdown 并返回执行指令（不运行任何子进程）。如有依赖技能，一并返回。",
  {
    scriptName: z.string().min(1).describe("技能名称"),
    context: z.string().default("").describe("任务上下文描述"),
    workspaceId: z.string().optional().describe("工作区ID"),
  },
  async ({ scriptName, context, workspaceId }) => {
    const store = await getStore();
    const skill = store.get(scriptName, { workspaceId });
    if (!skill) {
      return fail(`技能不存在：${scriptName}`, store, workspaceId);
    }

    const graph = store.resolveSkillGraph(scriptName, { workspaceId });

    if (graph.cycles.length > 0) {
      return fail(`技能调用链存在循环依赖：${graph.cycles.join(" -> ")}`, store, workspaceId);
    }

    try {
      if (graph.ordered.length <= 1) {
        const markdown = await store.readSkillContent(scriptName, { workspaceId });
        const text = [
          `═══ 技能: ${scriptName} ═══`,
          markdown,
          "═══",
          context.trim() ? `当前任务上下文：${context.trim()}` : "当前任务上下文：未提供",
          "请按照以上技能文档的步骤执行当前任务。",
          "完成后调用 pupu_after_task 或 pupu_report 汇报结果（success/failure）。",
        ].join("\n");
        return ok(text, store, workspaceId);
      }

      const sections: string[] = [];
      for (const node of graph.ordered) {
        if (node.name === scriptName) continue;
        const depMd = await store.readSkillContent(node.name, { workspaceId });
        sections.push(`═══ 依赖技能 [${node.depth}]: ${node.name} ═══\n${depMd}\n═══`);
      }

      const mainMd = await store.readSkillContent(scriptName, { workspaceId });
      const text = [
        `═══ 主技能: ${scriptName} ═══`,
        mainMd,
        "═══",
        "",
        "【依赖技能链（按执行顺序）】",
        ...sections,
        "",
        context.trim() ? `当前任务上下文：${context.trim()}` : "当前任务上下文：未提供",
        "请先阅读依赖技能，然后按主技能文档执行当前任务。",
        "完成后调用 pupu_after_task 或 pupu_report 汇报结果（success/failure）。",
      ].join("\n");
      return ok(text, store, workspaceId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return fail(`读取技能内容失败：${reason}`, store, workspaceId);
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
    duration: z.number().int().min(0).default(0).describe("执行耗时（毫秒）"),
    context: z.string().default("").describe("任务上下文描述"),
    workspaceId: z.string().optional().describe("工作区ID"),
  },
  async ({ scriptName, success, summary, error, duration, context, workspaceId }) => {
    const store = await getStore();
    const skill = store.get(scriptName, { workspaceId });
    if (!skill) {
      return fail(`技能不存在：${scriptName}`, store, workspaceId);
    }

    await store.recordExecution(scriptName, {
      timestamp: new Date().toISOString(),
      success,
      duration,
      summary,
      error: success ? null : (error ?? "执行失败"),
      context: context || summary,
    }, { workspaceId });

    const updated = store.get(scriptName, { workspaceId });
    if (!updated) {
      return fail(`技能记录更新后不可用：${scriptName}`, store, workspaceId);
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

    return ok(lines.filter(Boolean).join("\n"), store, workspaceId);
  }
);

server.tool(
  "pupu_reflect",
  "反思分析：基于最近执行结果与历史模式，给出具体技能改进建议。",
  {
    scriptName: z.string().min(1).describe("技能名称"),
    workspaceId: z.string().optional().describe("工作区ID"),
  },
  async ({ scriptName, workspaceId }) => {
    const store = await getStore();
    const skill = store.get(scriptName, { workspaceId });
    if (!skill) {
      return fail(`技能不存在：${scriptName}`, store, workspaceId);
    }

    const last = store.getLastExecution(scriptName, { workspaceId });
    if (!last) {
      return ok(`技能「${scriptName}」暂无执行历史，请先调用 pupu_execute 并在完成后用 pupu_report 汇报。`, store, workspaceId);
    }

    if (last.success) {
      return ok(`技能「${scriptName}」最近一次执行成功（${last.timestamp}），当前无需反思。`, store, workspaceId);
    }

    const recentHistory = store.getHistory(scriptName, 10, { workspaceId });
    const failCount = recentHistory.filter(item => !item.success).length;
    const successCount = recentHistory.filter(item => item.success).length;
    const sameErrorCount = recentHistory.filter(item => !item.success && item.error === last.error).length;

    let markdown = "";
    try {
      markdown = await store.readSkillContent(scriptName, { workspaceId });
    } catch {
      markdown = "(技能文档读取失败，无法定位具体段落)";
    }

    const sections = markdown.split(/\n##\s+/).map(s => s.trim()).filter(Boolean);
    const hasTriggerSection = /##\s*触发条件/.test(markdown);
    const hasStepSection = /##\s*执行步骤/.test(markdown);
    const hasNoteSection = /##\s*注意事项/.test(markdown);
    const hasApplicableSection = /##\s*适用场景/.test(markdown);
    const hasNotApplicableSection = /##\s*不适用场景/.test(markdown);
    const hasPrerequisiteSection = /##\s*前置条件/.test(markdown);
    const hasSuccessCriteriaSection = /##\s*成功判定/.test(markdown);
    const hasFailureBranchSection = /##\s*失败分支/.test(markdown);
    const hasExampleSection = /##\s*示例任务/.test(markdown);

    const suggestions: string[] = [];
    if (!hasTriggerSection) suggestions.push("补充\"触发条件\"章节，缩小误触发范围。");
    if (!hasStepSection) suggestions.push("补充\"执行步骤\"章节，并将步骤改为可验证的顺序动作。");
    if (!hasNoteSection) suggestions.push("补充\"注意事项\"章节，提前声明前置条件和失败兜底策略。");
    if (!hasApplicableSection) suggestions.push('补充"适用场景"章节，明确技能的最佳使用场景。');
    if (!hasNotApplicableSection) suggestions.push('补充"不适用场景"章节，避免误用。');
    if (!hasPrerequisiteSection) suggestions.push('补充"前置条件"章节，列出执行前必须满足的条件。');
    if (!hasSuccessCriteriaSection) suggestions.push('补充"成功判定"章节，定义可验证的完成标准。');
    if (!hasFailureBranchSection) suggestions.push('补充"失败分支"章节，为每种失败情况定义应对策略。');
    if (!hasExampleSection) suggestions.push('补充"示例任务"章节，提供典型输入/输出示例。');
    if (sameErrorCount >= 2) suggestions.push('同类错误重复出现，建议在步骤中加入"失败分支处理"与"重试条件"。');
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
      hasStepSection ? "- 优先修改\"执行步骤\"章节，增加前置检查、失败回退与结果验收。" : "- 先新增\"执行步骤\"章节。",
      hasTriggerSection ? "- 调整\"触发条件\"章节，避免任务不匹配时误用该技能。" : "- 新增\"触发条件\"章节。",
      "- 如需落地改动，请调用 pupu_write 更新 markdown。",
    ].join("\n");

    return ok(report, store, workspaceId);
  }
);

server.tool(
  "pupu_evolve",
  "技能进化评估：支持 assess 全量评估与 cleanup 低效技能清理建议。",
  {
    action: z.enum(["assess", "cleanup"]).describe("assess 或 cleanup"),
    workspaceId: z.string().optional().describe("工作区ID"),
  },
  async ({ action, workspaceId }) => {
    const store = await getStore();
    const all = store.list({ workspaceId });

    if (action === "cleanup") {
      const low = store.getLowUtility(30, { workspaceId });
      if (low.length === 0) {
        return ok("未发现效用分低于 30 且执行次数≥2 的技能。", store, workspaceId);
      }

      const lines = [
        `建议清理技能 ${low.length} 个（效用分 < 30）：`,
        ...low.map(skill => `- ${skill.name} | 效用分 ${skill.utilityScore} | 成功 ${skill.successCount}/${skill.executionCount}`),
      ];
      return ok(lines.join("\n"), store, workspaceId);
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

    return ok(report, store, workspaceId);
  }
);

server.tool(
  "pupu_delete",
  "删除技能：仅允许删除用户技能，内置技能受保护。",
  {
    scriptName: z.string().min(1).describe("技能名称"),
    workspaceId: z.string().optional().describe("工作区ID"),
  },
  async ({ scriptName, workspaceId }) => {
    const store = await getStore();
    const skill = store.get(scriptName, { workspaceId });

    if (!skill) {
      return fail(`技能不存在：${scriptName}`, store, workspaceId);
    }
    if (skill.builtin) {
      return fail(`内置技能「${scriptName}」不可删除。`, store, workspaceId);
    }

    const deleted = await store.delete(scriptName, { workspaceId });
    if (!deleted) {
      return fail(`删除失败：${scriptName}`, store, workspaceId);
    }

    return ok(`技能已删除：${scriptName}`, store, workspaceId);
  }
);

server.tool(
  "pupu_history",
  "查看技能执行历史：返回成功/失败、摘要与时间戳。",
  {
    scriptName: z.string().min(1).describe("技能名称"),
    limit: z.number().int().min(1).max(50).default(10).describe("返回条数（1-50）"),
    workspaceId: z.string().optional().describe("工作区ID"),
  },
  async ({ scriptName, limit, workspaceId }) => {
    const store = await getStore();
    const skill = store.get(scriptName, { workspaceId });
    if (!skill) {
      return fail(`技能不存在：${scriptName}`, store, workspaceId);
    }

    const history = store.getHistory(scriptName, limit, { workspaceId });
    if (history.length === 0) {
      return ok(`技能「${scriptName}」暂无执行历史。`, store, workspaceId);
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

    return ok(lines.join("\n"), store, workspaceId);
  }
);

server.tool(
  "pupu_route",
  "技能路由：根据任务描述推荐技能，并给出置信度与匹配原因。",
  {
    task: z.string().min(1).describe("任务描述"),
    workspaceId: z.string().optional().describe("工作区ID，同工作区技能优先"),
  },
  async ({ task, workspaceId }) => {
    const store = await getStore();
    const skills = store.list({ workspaceId });
    const result = route(task, skills, { workspaceId });

    if (result.recommendations.length === 0) {
      return ok(
        `任务：${task}\n未找到合适技能。${result.summary}\n建议：使用 pupu_write 创建新技能并补充 triggers。`,
        store,
        workspaceId
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

    return ok(`任务：${task}\n${result.summary}\n\n${recommendText}`, store, workspaceId);
  }
);

server.tool(
  "pupu_learn",
  "自动学习：分析当前任务上下文，判断是否值得生成新技能或优化已有技能。",
  {
    context: z.string().min(1).describe("当前任务上下文摘要：做了什么、怎么做的、用了什么工具/方法"),
    taskType: z.string().min(1).describe("任务类型分类，如：逆向分析、代码审计、API调试、重构、数据处理等"),
    approach: z.string().min(1).describe("采用的解决方法或步骤概述"),
    result: z.enum(["success", "failure"]).describe("任务最终结果"),
    workspaceId: z.string().optional().describe("工作区ID"),
  },
  async ({ context, taskType, approach, result, workspaceId }) => {
    const store = await getStore();
    const similarSkills = store.search(`${taskType} ${approach}`, { workspaceId });

    if (similarSkills.length > 0) {
      const topSkill = similarSkills[0];
      const lastExec = store.getLastExecution(topSkill.name, { workspaceId });
      const recentHistory = store.getHistory(topSkill.name, 5, { workspaceId });
      const recentFails = recentHistory.filter(item => !item.success).length;
      const needsOptimize = recentFails >= 2 || (lastExec !== null && !lastExec.success);

      if (needsOptimize) {
        const suggestions: string[] = [];
        if (recentFails >= 2) {
          suggestions.push(`- 近期失败率较高(${recentFails}/5)，建议优化执行步骤`);
        }
        if (lastExec !== null && !lastExec.success) {
          suggestions.push(`- 最近一次失败：${lastExec.error ?? "未知"}`);
        }

        return ok(
          [
            `自动学习结果`,
            `任务类型：${taskType}`,
            `已有类似技能：${topSkill.name}（效用分 ${topSkill.utilityScore}）`,
            "",
            "建议优化已有技能：",
            ...suggestions,
            "",
            "请调用 pupu_reflect 获取详细改进建议，再用 pupu_write 更新技能内容。",
          ].join("\n"),
          store,
          workspaceId
        );
      }

      return ok(
        [
          "自动学习结果",
          `任务类型：${taskType}`,
          `已有类似技能：${topSkill.name}（效用分 ${topSkill.utilityScore}）`,
          "",
          "已有技能可覆盖此任务，无需创建新技能。",
        ].join("\n"),
        store,
        workspaceId
      );
    }

    if (result === "failure") {
      return ok(
        [
          "自动学习结果",
          `任务类型：${taskType}`,
          `结果：失败`,
          "",
          "本次任务失败且无类似技能，不建议直接生成新技能。",
          "请先调用 pupu_reflect 分析失败原因，确认方法可行后再用 pupu_write 创建技能。",
        ].join("\n"),
        store,
        workspaceId
      );
    }

    const skillName = taskType
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40);

    const steps = approach
      .split(/[;\n]/)
      .map(step => step.trim())
      .filter(Boolean);

    const draftContent = [
      `# ${skillName}`,
      "",
      "## 触发条件",
      `当遇到${taskType}相关任务时使用此技能。`,
      "",
      "## 适用场景",
      `- ${taskType}`,
      "",
      "## 不适用场景",
      "- 待补充",
      "",
      "## 前置条件",
      "- 待补充",
      "",
      "## 执行步骤",
      ...(steps.length > 0 ? steps.map((step, index) => `${index + 1}. ${step}`) : ["1. 根据当前任务补充执行步骤。"]),
      "",
      "## 成功判定",
      "- 待补充",
      "",
      "## 失败分支",
      "- 待补充",
      "",
      "## 示例任务",
      `- ${context.slice(0, 80)}`,
      "",
      "## 注意事项",
      `- 来源任务上下文：${context.slice(0, 100)}`,
      "",
      "## 改进记录",
      "- v1: 由自动学习生成，需根据实际使用情况优化",
    ].join("\n");

    const triggerWords = [
      taskType,
      ...taskType.split(/[/、,]/).map(item => item.trim()).filter(Boolean),
      ...approach.split(/\s+/).map(item => item.trim()).filter(word => word.length >= 2).slice(0, 5),
    ].filter(Boolean);

    return ok(
      [
        "自动学习结果",
        `任务类型：${taskType}`,
        `结果：成功`,
        "",
        "未找到类似技能，建议创建新技能：",
        `名称：${skillName}`,
        `触发词：${triggerWords.slice(0, 6).join("、") || "无"}`,
        "",
        "技能草稿：",
        "```markdown",
        draftContent,
        "```",
        "",
        "如需保存，请调用 pupu_write，将上述草稿作为 content 参数传入。",
        "如需调整触发词或内容，请先修改后再保存。",
      ].join("\n"),
      store,
      workspaceId
    );
  }
);

server.tool(
  "pupu_after_task",
  "任务后处理：记录执行结果并自动判断是否需要创建或优化技能。整合了 report + learn 的闭环。",
  {
    workspaceId: z.string().optional().describe("工作区ID"),
    skillName: z.string().optional().describe("使用的技能名称（如有）"),
    task: z.string().min(1).describe("任务描述"),
    success: z.boolean().describe("是否成功"),
    summary: z.string().min(1).describe("执行摘要"),
    error: z.string().optional().describe("失败时的错误信息"),
    approach: z.string().default("").describe("采用的解决方法"),
    duration: z.number().int().min(0).default(0).describe("执行耗时（毫秒）"),
    resultArtifacts: z.array(z.string()).default([]).describe("产出的文件或资源路径"),
  },
  async ({ workspaceId, skillName, task, success, summary, error, approach, duration, resultArtifacts: _resultArtifacts }) => {
    const store = await getStore();

    if (skillName) {
      const skill = store.get(skillName, { workspaceId });
      if (skill) {
        await store.recordExecution(skillName, {
          timestamp: new Date().toISOString(),
          success,
          duration,
          summary,
          error: success ? null : (error ?? "执行失败"),
          context: task,
        }, { workspaceId });
      }
    }

    let action = "none";
    let targetSkill: string | undefined;
    let draft: string | undefined;
    let reason: string;

    if (!success && !skillName) {
      reason = "任务失败且未关联技能，不建议创建新技能。";
    } else if (skillName) {
      const skill = store.get(skillName, { workspaceId });
      if (!skill) {
        reason = `技能 ${skillName} 不存在。`;
      } else {
        const recentHistory = store.getHistory(skillName, 5, { workspaceId });
        const recentFails = recentHistory.filter(h => !h.success).length;
        const lastExec = store.getLastExecution(skillName, { workspaceId });

        if (recentFails >= 2 || (lastExec && !lastExec.success)) {
          action = "improve_existing";
          targetSkill = skillName;
          reason = recentFails >= 2
            ? `技能 ${skillName} 近期失败率较高 (${recentFails}/5)，建议优化。`
            : `技能 ${skillName} 最近一次执行失败，建议分析原因。`;
        } else {
          reason = `技能 ${skillName} 执行正常，无需优化。`;
        }
      }
    } else {
      const similarSkills = store.search(`${task} ${approach}`, { workspaceId });
      if (similarSkills.length > 0) {
        targetSkill = similarSkills[0].name;
        reason = `已有类似技能：${similarSkills[0].name}，无需创建新技能。`;
      } else {
        action = "create_draft";
        const nameDraft = task
          .toLowerCase()
          .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
          .replace(/-+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 40);

        const steps = approach.split(/[;\n]/).map(s => s.trim()).filter(Boolean);

        draft = [
          `# ${nameDraft}`,
          "",
          "## 触发条件",
          `当遇到${task}相关任务时使用此技能。`,
          "",
          "## 适用场景",
          `- ${task}`,
          "",
          "## 不适用场景",
          "- 待补充",
          "",
          "## 前置条件",
          "- 待补充",
          "",
          "## 执行步骤",
          ...(steps.length > 0 ? steps.map((s, i) => `${i + 1}. ${s}`) : ["1. 根据当前任务补充执行步骤。"]),
          "",
          "## 成功判定",
          "- 待补充",
          "",
          "## 失败分支",
          "- 待补充",
          "",
          "## 示例任务",
          `- ${summary.slice(0, 80)}`,
          "",
          "## 注意事项",
          `- 来源任务上下文：${summary.slice(0, 100)}`,
          "",
          "## 改进记录",
          "- v1: 由 pupu_after_task 自动生成，需根据实际使用情况优化",
        ].join("\n");

        reason = "未找到类似技能，已生成技能草稿。";
      }
    }

    const lines = [
      `═══ 任务后处理结果 ═══`,
      `动作：${action}`,
      targetSkill ? `目标技能：${targetSkill}` : null,
      `原因：${reason}`,
      action === "create_draft" ? "\n技能草稿：\n```markdown\n" + draft + "\n```" : null,
      action === "create_draft" ? "\n如需保存草稿，请调用 pupu_write 将上述内容作为 content 传入。" : null,
      action === "improve_existing" ? "\n请调用 pupu_reflect 获取改进建议，再用 pupu_write 更新技能。" : null,
    ].filter(Boolean).join("\n");

    return ok(lines, store, workspaceId);
  }
);

export async function startMcpServer(): Promise<void> {
  setLogLevel(LogLevel.INFO);
  const store = await getStore();

  const count = store.list().length;
  logger.info(`技能库已加载: ${count} 个技能`);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("pupu_skills MCP Server 已启动");
}
