import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createInitializedStore } from "../bootstrap.js";
import { SkillStore } from "../memory/store.js";
import { buildSkillSummary, route } from "../router/router.js";
import { parseSkillFrontmatter } from "../skills/frontmatter.js";
import { resolveBuiltinSkillsDir } from "../skills/paths.js";
import { isSafeSkillName } from "../skills/validation.js";

const tests: { name: string; fn: () => Promise<boolean> }[] = [];
const passed: string[] = [];
const failed: string[] = [];

function test(name: string, fn: () => Promise<boolean>) {
  tests.push({ name, fn });
}

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

// 每次运行生成独立临时目录，避免污染用户环境
const tmpDir = resolve(mkdtempSync("pupu-test-"));
let counter = 0;

function iso(offset = 0): string {
  return new Date(Date.now() + offset).toISOString();
}

async function tmpStore() {
  counter++;
  return SkillStore.create({
    storePath: join(tmpDir, `skills_${counter}.json`),
    repoDir: join(tmpDir, `repo_${counter}`),
  });
}

async function seedSkill(
  store: SkillStore,
  name: string,
  options?: {
    content?: string;
    description?: string;
    triggers?: string[];
    calls?: string[];
    tags?: string[];
    antiTriggers?: string[];
    scope?: "global" | "workspace";
    workspaceId?: string;
  },
) {
  return store.save({
    name,
    content: options?.content ?? `# ${name}\n\nbody`,
    description: options?.description ?? `${name} description`,
    triggers: options?.triggers ?? [],
    calls: options?.calls ?? [],
    tags: options?.tags,
    antiTriggers: options?.antiTriggers,
    scope: options?.scope,
    workspaceId: options?.workspaceId,
  });
}

process.on("exit", () => {
  try {
    rmSync(tmpDir, { recursive: true });
  } catch {
    // 清理失败不影响测试结果
  }
});

// 1. 创建空 store
test("创建空 store", async () => {
  const store = await tmpStore();
  assert(store.list().length === 0, "空仓库 list() 应为 0");
  return true;
});

// 2. create 不应急切写入 store 文件
test("create 不应急切写入 store 文件", async () => {
  counter++;
  const storePath = join(tmpDir, `skills_${counter}.json`);
  await SkillStore.create({
    storePath,
    repoDir: join(tmpDir, `repo_${counter}`),
  });

  assert(!existsSync(storePath), "create 后在首次写入前不应生成 store 文件");
  return true;
});

// 3. save + get
test("save + get", async () => {
  const store = await tmpStore();
  await store.save({
    name: "hello",
    content: "# Hello\n\nWorld",
    description: "测试保存",
    triggers: ["hello", "world"],
    calls: ["pupu_route"],
  });

  const got = store.get("hello");
  assert(!!got, "应可 get 到技能");
  assert(got?.name === "hello", "name 应正确");
  assert(got?.description === "测试保存", "description 应正确");
  assert(got?.triggers.join(",") === "hello,world", "triggers 应正确");
  assert(got?.calls.join(",") === "pupu_route", "calls 应正确");
  return true;
});

// 4. save 写入 markdown 文件
test("save 写入 markdown 文件", async () => {
  const store = await tmpStore();
  await seedSkill(store, "write-md", { content: "# 标题\n\n正文" });
  const record = store.get("write-md");
  assert(!!record, "应存在记录");
  assert(existsSync(record!.filePath), "应写入 .md 文件");
  const md = readFileSync(record!.filePath, "utf-8");
  assert(md.startsWith("---\n"), "应包含 frontmatter 开头");
  assert(md.includes("\n---\n"), "应包含 frontmatter 结束");
  return true;
});

// 5. readSkillContent
test("readSkillContent", async () => {
  const store = await tmpStore();
  await seedSkill(store, "read-content", { content: "# A\n\nB" });
  const full = await store.readSkillContent("read-content");
  assert(full.includes("name: \"read-content\""), "应包含 name frontmatter");
  assert(full.includes("# A\n\nB"), "应包含正文");
  return true;
});

// 6. updateSkillContent
test("updateSkillContent", async () => {
  const store = await tmpStore();
  await seedSkill(store, "update-only-body", { content: "旧正文" });
  const before = await store.readSkillContent("update-only-body");

  await store.updateSkillContent("update-only-body", "新正文");
  const after = await store.readSkillContent("update-only-body");

  const beforeFrontmatterEnd = before.indexOf("\n---\n");
  const afterFrontmatterEnd = after.indexOf("\n---\n");
  assert(beforeFrontmatterEnd > 0 && afterFrontmatterEnd > 0, "前后都应包含 frontmatter");

  const beforeFrontmatter = before.slice(0, beforeFrontmatterEnd + 5);
  const afterFrontmatter = after.slice(0, afterFrontmatterEnd + 5);
  assert(beforeFrontmatter === afterFrontmatter, "更新正文后 frontmatter 应保持不变");
  assert(after.endsWith("新正文"), "正文应被替换");
  return true;
});

// 7. search 模糊匹配
test("search 模糊匹配", async () => {
  const store = await tmpStore();
  await seedSkill(store, "git-commit", {
    description: "提交代码到仓库",
    triggers: ["git commit", "提交"],
  });
  await seedSkill(store, "docker-run", {
    description: "运行容器",
    triggers: ["docker", "容器"],
  });

  const byName = store.search("git");
  assert(byName.some(s => s.name === "git-commit"), "应按名称命中");

  const byDesc = store.search("仓库");
  assert(byDesc.some(s => s.name === "git-commit"), "应按描述命中");

  const byTrigger = store.search("容器");
  assert(byTrigger.some(s => s.name === "docker-run"), "应按触发词命中");
  return true;
});

// 8. search 按 utility score 排序
test("search 按 utility score 排序", async () => {
  const store = await tmpStore();
  await seedSkill(store, "same-high", { description: "abc", triggers: ["x"] });
  await seedSkill(store, "same-low", { description: "abc", triggers: ["x"] });

  for (let i = 0; i < 5; i++) {
    await store.recordExecution("same-high", {
      timestamp: iso(i),
      success: true,
      duration: 10,
      summary: "ok",
      error: null,
      context: "ctx",
    });
    await store.recordExecution("same-low", {
      timestamp: iso(i),
      success: false,
      duration: 10,
      summary: "bad",
      error: "err",
      context: "ctx",
    });
  }

  const result = store.search("abc");
  assert(result.length >= 2, "应命中两个技能");
  assert(result[0].name === "same-high", "同分词命中时应按 utility 降序");
  return true;
});

// 9. delete
test("delete", async () => {
  const store = await tmpStore();
  await seedSkill(store, "to-delete", { content: "x" });
  const path = store.get("to-delete")?.filePath ?? "";
  assert(path.length > 0, "应存在文件路径");

  const ok = await store.delete("to-delete");
  assert(ok, "删除用户技能应返回 true");
  assert(!store.get("to-delete"), "记录应被删除");
  assert(!existsSync(path), "文件应被删除");
  return true;
});

// 10. delete 内置保护
test("delete 内置保护", async () => {
  const store = await tmpStore();
  await store.registerBuiltin({
    name: "builtin-safe",
    content: "builtin",
    description: "内置",
    triggers: ["safe"],
    calls: [],
  });

  const ok = await store.delete("builtin-safe");
  assert(ok === false, "内置技能不可删除");
  assert(!!store.get("builtin-safe"), "内置技能应仍存在");
  return true;
});

// 11. registerBuiltin 不覆盖用户技能
test("registerBuiltin 不覆盖用户技能", async () => {
  const store = await tmpStore();
  await seedSkill(store, "same-name", {
    content: "user-content",
    description: "user-desc",
    triggers: ["user"],
  });

  await store.registerBuiltin({
    name: "same-name",
    content: "builtin-content",
    description: "builtin-desc",
    triggers: ["builtin"],
    calls: [],
  });

  const skill = store.get("same-name");
  assert(!!skill, "技能应存在");
  assert(skill?.builtin === false, "用户技能不应被标记为 builtin");
  const full = await store.readSkillContent("same-name");
  assert(full.includes("user-content"), "内容不应被内置技能覆盖");
  return true;
});

// 12. recordExecution 成功
test("recordExecution 成功", async () => {
  const store = await tmpStore();
  await seedSkill(store, "exec-ok");
  await store.recordExecution("exec-ok", {
    timestamp: iso(),
    success: true,
    duration: 120,
    summary: "done",
    error: null,
    context: "ctx",
  });

  const s = store.get("exec-ok");
  assert(s?.executionCount === 1, "executionCount 应 +1");
  assert(s?.successCount === 1, "successCount 应 +1");
  assert(s?.lastError === null, "成功后 lastError 应为 null");
  return true;
});

// 13. recordExecution 失败
test("recordExecution 失败", async () => {
  const store = await tmpStore();
  await seedSkill(store, "exec-fail");
  await store.recordExecution("exec-fail", {
    timestamp: iso(),
    success: false,
    duration: 80,
    summary: "failed",
    error: "boom",
    context: "ctx",
  });

  const s = store.get("exec-fail");
  assert(s?.executionCount === 1, "executionCount 应 +1");
  assert(s?.successCount === 0, "失败不应增加 successCount");
  assert(s?.lastError === "boom", "应记录 lastError");
  return true;
});

// 14. getHistory
test("getHistory", async () => {
  const store = await tmpStore();
  await seedSkill(store, "history-n");

  await store.recordExecution("history-n", {
    timestamp: "2025-01-01T00:00:00.000Z",
    success: true,
    duration: 1,
    summary: "s1",
    error: null,
    context: "c1",
  });
  await store.recordExecution("history-n", {
    timestamp: "2025-01-02T00:00:00.000Z",
    success: false,
    duration: 2,
    summary: "s2",
    error: "e2",
    context: "c2",
  });
  await store.recordExecution("history-n", {
    timestamp: "2025-01-03T00:00:00.000Z",
    success: true,
    duration: 3,
    summary: "s3",
    error: null,
    context: "c3",
  });

  const list = store.getHistory("history-n", 2);
  assert(list.length === 2, "应返回最近 2 条");
  assert(list[0].summary === "s3", "第一条应为最新记录");
  assert(list[1].summary === "s2", "第二条应为次新记录");
  return true;
});

// 15. getLastExecution
test("getLastExecution", async () => {
  const store = await tmpStore();
  await seedSkill(store, "last-one");
  await store.recordExecution("last-one", {
    timestamp: "2025-02-01T00:00:00.000Z",
    success: true,
    duration: 1,
    summary: "first",
    error: null,
    context: "ctx",
  });
  await store.recordExecution("last-one", {
    timestamp: "2025-02-02T00:00:00.000Z",
    success: false,
    duration: 1,
    summary: "second",
    error: "x",
    context: "ctx",
  });

  const last = store.getLastExecution("last-one");
  assert(!!last, "应返回最后一次执行");
  assert(last?.summary === "second", "应是最后记录");
  return true;
});

// 16. history 上限裁剪
test("history 上限裁剪", async () => {
  const store = await tmpStore();
  await seedSkill(store, "history-cap");

  for (let i = 1; i <= 55; i++) {
    await store.recordExecution("history-cap", {
      timestamp: new Date(2025, 0, i).toISOString(),
      success: i % 2 === 0,
      duration: i,
      summary: `run-${i}`,
      error: i % 2 === 0 ? null : `err-${i}`,
      context: `ctx-${i}`,
    });
  }

  const all = store.getHistory("history-cap", 100);
  assert(all.length === 50, "历史应裁剪到 50 条");
  assert(all[0].summary === "run-55", "最新记录应保留");
  assert(all[49].summary === "run-6", "最旧保留应为第 6 条");
  return true;
});

// 17. 效用分计算
test("效用分计算", async () => {
  const store = await tmpStore();
  await seedSkill(store, "score-up");
  await seedSkill(store, "score-down");

  for (let i = 0; i < 5; i++) {
    await store.recordExecution("score-up", {
      timestamp: iso(i),
      success: true,
      duration: 1,
      summary: "ok",
      error: null,
      context: "ctx",
    });
    await store.recordExecution("score-down", {
      timestamp: iso(i),
      success: false,
      duration: 1,
      summary: "no",
      error: "e",
      context: "ctx",
    });
  }

  const up = store.get("score-up");
  const down = store.get("score-down");
  assert((up?.utilityScore ?? 0) > 50, "5 连胜后 utility 应 > 50");
  assert((down?.utilityScore ?? 100) < 30, "5 连败后 utility 应 < 30");
  return true;
});

// 18. getLowUtility 基本功能
test("getLowUtility 基本功能", async () => {
  const store = await tmpStore();
  await seedSkill(store, "low-one");
  await seedSkill(store, "high-one");

  for (let i = 0; i < 5; i++) {
    await store.recordExecution("low-one", {
      timestamp: iso(i),
      success: false,
      duration: 1,
      summary: "bad",
      error: "e",
      context: "ctx",
    });
    await store.recordExecution("high-one", {
      timestamp: iso(i),
      success: true,
      duration: 1,
      summary: "good",
      error: null,
      context: "ctx",
    });
  }

  const low = store.getLowUtility(30);
  assert(low.some(s => s.name === "low-one"), "低效用技能应返回");
  assert(!low.some(s => s.name === "high-one"), "高效用技能不应返回");
  return true;
});

// 19. getLowUtility 排除未执行
test("getLowUtility 排除未执行", async () => {
  const store = await tmpStore();
  await seedSkill(store, "never-run");
  await seedSkill(store, "low-run");

  for (let i = 0; i < 5; i++) {
    await store.recordExecution("low-run", {
      timestamp: iso(i),
      success: false,
      duration: 1,
      summary: "bad",
      error: "e",
      context: "ctx",
    });
  }

  const low = store.getLowUtility(30);
  assert(!low.some(s => s.name === "never-run"), "0 执行技能应被排除");
  assert(low.some(s => s.name === "low-run"), "执行过且低分技能应返回");
  return true;
});

// 20. route 精确匹配
test("route 精确匹配", async () => {
  const store = await tmpStore();
  await seedSkill(store, "lint fix", {
    description: "修复 lint 错误",
    triggers: ["lint", "fix lint"],
  });

  const result = route("lint fix", store.list());
  assert(result.recommendations.length >= 1, "应至少推荐一个技能");
  assert(result.recommendations[0].skill.name === "lint fix", "应优先命中精确名称");
  assert(result.recommendations[0].confidence >= 50, "精确匹配置信度应较高");
  return true;
});

// 21. route 触发词匹配
test("route 触发词匹配", async () => {
  const store = await tmpStore();
  await seedSkill(store, "deploy-helper", {
    description: "发布部署工具",
    triggers: ["发布", "部署", "deploy"],
  });

  const result = route("请帮我部署到生产环境", store.list());
  assert(result.recommendations.some(r => r.skill.name === "deploy-helper"), "触发词应命中技能");
  return true;
});

// 22. route 中文分词匹配
test("route 中文分词匹配", async () => {
  const store = await tmpStore();
  await seedSkill(store, "apk-reverse", {
    description: "逆向分析",
    triggers: ["逆向 apk"],
  });

  const result = route("帮我分析这个 APK 的逆向逻辑", store.list());
  assert(result.recommendations.some(item => item.skill.name === "apk-reverse"), "中文双字切分后应能命中技能");
  return true;
});

// 23. route 无匹配
test("route 无匹配", async () => {
  const store = await tmpStore();
  await seedSkill(store, "only-git", {
    description: "git 相关",
    triggers: ["commit", "rebase"],
  });
  for (let i = 0; i < 5; i++) {
    await store.recordExecution("only-git", {
      timestamp: iso(i),
      success: true,
      duration: 1,
      summary: "ok",
      error: null,
      context: "ctx",
    });
  }

  const result = route("烤蛋糕配方", store.list());
  assert(result.recommendations.length === 0, "无相关任务应无推荐");
  assert(result.summary.includes("未找到置信度≥15分"), "应返回无匹配提示");
  return true;
});

// 24. route 最多返回 8 个候选
test("route 最多返回 8 个候选", async () => {
  const store = await tmpStore();

  for (let i = 1; i <= 10; i++) {
    await seedSkill(store, `deploy-${i}`, {
      description: `部署工具 ${i}`,
      triggers: ["deploy"],
    });
  }

  const result = route("deploy production", store.list());
  assert(result.recommendations.length === 8, "候选池应扩展到 8 个");
  return true;
});

// 25. buildSkillSummary
test("buildSkillSummary", async () => {
  const store = await tmpStore();
  await seedSkill(store, "a-skill", { description: "A 技能描述" });
  await store.registerBuiltin({
    name: "b-skill",
    content: "builtin",
    description: "builtin",
    triggers: [],
    calls: [],
  });

  const text = buildSkillSummary(store.list());
  assert(text.includes("技能库: 2 个技能 (1 内置)"), "应包含总数与内置数");
  assert(text.includes("可用:\n"), "应包含可用技能列表");
  assert(text.includes("a-skill(50分): A 技能描述"), "摘要中应包含技能描述");
  assert(text.includes("pupu_after_task"), "应包含 after_task 闭环规则");
  assert(!text.includes("必须调用 pupu_learn"), "不应包含旧的强推 pupu_learn 规则");
  assert(!text.includes("📊"), "摘要中不应包含 emoji");
  return true;
});

// 26. registerBuiltin 写入文件
test("registerBuiltin 写入文件", async () => {
  const store = await tmpStore();
  await store.registerBuiltin({
    name: "builtin-md",
    content: "# 内置\n\n内容",
    description: "内置技能",
    triggers: ["内置"],
    calls: ["pupu_route"],
  });

  const rec = store.get("builtin-md");
  assert(!!rec, "应有内置记录");
  assert(rec?.builtin === true, "应标记为 builtin");
  assert(existsSync(rec!.filePath), "应写入 markdown 文件");
  const md = readFileSync(rec!.filePath, "utf-8");
  assert(md.includes("name: \"builtin-md\""), "frontmatter 应包含 name");
  assert(md.includes("# 内置"), "文件应包含正文");
  return true;
});

// 27. registerBuiltin 重复会刷新内置技能
test("registerBuiltin 重复会刷新内置技能", async () => {
  const store = await tmpStore();
  await store.registerBuiltin({
    name: "builtin-same",
    content: "first",
    description: "desc1",
    triggers: ["t1"],
    calls: [],
  });

  await store.registerBuiltin({
    name: "builtin-same",
    content: "second",
    description: "desc2",
    triggers: ["t2"],
    calls: ["x"],
  });

  const second = await store.readSkillContent("builtin-same");
  const rec = store.get("builtin-same");
  assert(!!rec, "应保留内置技能记录");
  assert(rec?.description === "desc2", "描述应刷新");
  assert(rec?.triggers.join(",") === "t2", "触发词应刷新");
  assert(rec?.calls.join(",") === "x", "调用链应刷新");
  assert(second.includes("second"), "文件内容应刷新");
  return true;
});

// 28. parseSkillFrontmatter 支持 inline 数组
test("parseSkillFrontmatter 支持 inline 数组", async () => {
  const parsed = parseSkillFrontmatter(`---
name: "inline-skill"
description: "inline desc"
triggers: ["a","b"]
calls: []
---

# inline-skill

body`);

  assert(parsed.meta.name === "inline-skill", "应解析 name");
  assert(parsed.meta.description === "inline desc", "应解析 description");
  assert(parsed.meta.triggers?.join(",") === "a,b", "应解析 inline triggers");
  assert(parsed.meta.calls?.length === 0, "应解析空 calls");
  assert(parsed.body.includes("# inline-skill"), "应保留正文");
  return true;
});

// 29. isSafeSkillName 允许自然命名并拦截危险名称
test("isSafeSkillName 允许自然命名并拦截危险名称", async () => {
  assert(isSafeSkillName("lint fix"), "应允许带空格的技能名");
  assert(isSafeSkillName("逆向 APK"), "应允许中文技能名");
  assert(!isSafeSkillName("../escape"), "不应允许路径穿越");
  assert(!isSafeSkillName("bad/name"), "不应允许路径分隔符");
  assert(!isSafeSkillName("CON"), "不应允许 Windows 保留名");
  return true;
});

// 30. resolveBuiltinSkillsDir 同时兼容 src/dist 入口
test("resolveBuiltinSkillsDir 同时兼容 src/dist 入口", async () => {
  const expected = resolve("skills");
  const srcUrl = pathToFileURL(resolve("src", "index.ts")).href;
  const distUrl = pathToFileURL(resolve("dist", "index.js")).href;

  assert(resolveBuiltinSkillsDir(srcUrl) === expected, "src 入口应解析到项目根 skills/");
  assert(resolveBuiltinSkillsDir(distUrl) === expected, "dist 入口也应解析到项目根 skills/");
  return true;
});

// 31. createInitializedStore 会加载内置技能
test("createInitializedStore 会加载内置技能", async () => {
  counter++;
  const store = await createInitializedStore({
    storePath: join(tmpDir, `skills_${counter}.json`),
    repoDir: join(tmpDir, `repo_${counter}`),
  });

  const filesystem = store.get("filesystem");
  assert(!!filesystem, "初始化后应包含 filesystem 内置技能");
  assert(filesystem?.builtin === true, "内置技能应标记为 builtin");
  assert(store.list().length >= 9, "初始化后应至少加载 9 个内置技能");
  return true;
});

// 32. save 生成正确 frontmatter
test("save 生成正确 frontmatter", async () => {
  const store = await tmpStore();
  await store.save({
    name: "yaml-skill",
    content: "正文",
    description: "yaml 测试",
    triggers: ["a", "b"],
    calls: ["c1", "c2"],
  });

  const md = await store.readSkillContent("yaml-skill");
  assert(md.startsWith("---\n"), "frontmatter 应以 --- 开头");
  assert(md.includes("name: \"yaml-skill\""), "应包含 name");
  assert(md.includes("description: \"yaml 测试\""), "应包含 description");
  assert(md.includes("triggers: [\"a\",\"b\"]"), "应包含 triggers 数组");
  assert(md.includes("calls: [\"c1\",\"c2\"]"), "应包含 calls 数组");
  assert(md.includes("utility: 50"), "初始 utility 应为 50");
  assert(md.includes("\n---\n正文"), "frontmatter 后应接正文");
  return true;
});

// 33. save 保留触发词
test("save 保留触发词", async () => {
  const store = await tmpStore();
  await store.save({
    name: "trigger-keep",
    content: "body",
    description: "desc",
    triggers: ["alpha beta", "中文触发", "deploy"],
    calls: [],
  });

  const skill = store.get("trigger-keep");
  assert(!!skill, "技能应存在");
  assert(skill?.triggers.length === 3, "内存中触发词数量应正确");
  const md = await store.readSkillContent("trigger-keep");
  assert(md.includes('triggers: ["alpha beta","中文触发","deploy"]'), "文件中应保留触发词");
  return true;
});

// 34. workspace 隔离 — search 按 workspaceId 过滤
test("workspace 隔离 — search 按 workspaceId 过滤", async () => {
  const store = await tmpStore();
  await seedSkill(store, "global-skill", { description: "全局技能" });
  await seedSkill(store, "ws-a-skill", { description: "A 工作区技能", scope: "workspace", workspaceId: "ws-a" });
  await seedSkill(store, "ws-b-skill", { description: "B 工作区技能", scope: "workspace", workspaceId: "ws-b" });

  const all = store.search("*");
  assert(all.length === 1, "不带 workspaceId 时应只返回 global 技能");

  const wsA = store.search("*", { workspaceId: "ws-a" });
  assert(wsA.length === 2, "ws-a 过滤应返回 2 个（global + ws-a）");
  assert(wsA.some(s => s.name === "global-skill"), "应包含全局技能");
  assert(wsA.some(s => s.name === "ws-a-skill"), "应包含 ws-a 技能");
  assert(!wsA.some(s => s.name === "ws-b-skill"), "不应包含 ws-b 技能");

  const wsB = store.search("*", { workspaceId: "ws-b" });
  assert(wsB.length === 2, "ws-b 过滤应返回 2 个");
  assert(!wsB.some(s => s.name === "ws-a-skill"), "不应包含 ws-a 技能");
  return true;
});

// 35. resolveSkillGraph 线性链
test("resolveSkillGraph 线性链", async () => {
  const store = await tmpStore();
  await seedSkill(store, "c", { description: "C", calls: [] });
  await seedSkill(store, "b", { description: "B", calls: ["c"] });
  await seedSkill(store, "a", { description: "A", calls: ["b"] });

  const graph = store.resolveSkillGraph("a");
  assert(graph.cycles.length === 0, "线性链不应有循环");
  assert(graph.ordered.length === 3, "应包含 3 个节点");
  assert(graph.ordered[0].name === "c", "第一个应是叶子节点 c");
  assert(graph.ordered[1].name === "b", "第二个应是 b");
  assert(graph.ordered[2].name === "a", "第三个应是根节点 a");
  return true;
});

// 36. resolveSkillGraph 循环检测
test("resolveSkillGraph 循环检测", async () => {
  const store = await tmpStore();
  await seedSkill(store, "x", { description: "X", calls: ["y"] });
  await seedSkill(store, "y", { description: "Y", calls: ["x"] });

  const graph = store.resolveSkillGraph("x");
  assert(graph.cycles.length > 0, "循环链应检测到循环");
  return true;
});

// 37. route antiTriggers 惩罚
test("route antiTriggers 惩罚", async () => {
  const store = await tmpStore();
  await seedSkill(store, "deploy-tool", {
    description: "部署工具",
    triggers: ["部署"],
    antiTriggers: ["测试", "test"],
  });

  const resultGood = route("帮我部署到生产环境", store.list());
  const resultBad = route("帮我测试部署", store.list());

  const goodRec = resultGood.recommendations.find(r => r.skill.name === "deploy-tool");
  const badRec = resultBad.recommendations.find(r => r.skill.name === "deploy-tool");

  assert(!!goodRec, "正常任务应命中 deploy-tool");
  if (badRec && goodRec) {
    assert(goodRec.confidence > badRec.confidence, "antiTriggers 命中后置信度应降低");
  }
  return true;
});

// 38. route workspace 加成
test("route workspace 加成", async () => {
  const store = await tmpStore();
  await seedSkill(store, "ws-deploy", {
    description: "部署",
    triggers: ["部署"],
    scope: "workspace",
    workspaceId: "my-ws",
  });
  await seedSkill(store, "global-deploy", {
    description: "部署",
    triggers: ["部署"],
  });

  const result = route("帮我部署", store.list({ workspaceId: "my-ws" }), { workspaceId: "my-ws" });
  const wsRec = result.recommendations.find(r => r.skill.name === "ws-deploy");
  const globalRec = result.recommendations.find(r => r.skill.name === "global-deploy");

  assert(!!wsRec, "应命中 ws-deploy");
  assert(!!globalRec, "应命中 global-deploy");
  assert(wsRec!.confidence > globalRec!.confidence, "同工作区技能置信度应更高");
  return true;
});

// 39. reflect 新章节检测
test("reflect 新章节检测（regex 测试）", async () => {
  const markdown = [
    "# test-skill",
    "",
    "## 触发条件",
    "- 当需要时",
    "",
    "## 执行步骤",
    "1. 做事",
    "",
    "## 注意事项",
    "- 注意",
  ].join("\n");

  assert(/##\s*适用场景/.test(markdown) === false, "不应检测到适用场景");
  assert(/##\s*前置条件/.test(markdown) === false, "不应检测到前置条件");
  assert(/##\s*成功判定/.test(markdown) === false, "不应检测到成功判定");
  assert(/##\s*失败分支/.test(markdown) === false, "不应检测到失败分支");
  assert(/##\s*示例任务/.test(markdown) === false, "不应检测到示例任务");
  assert(/##\s*触发条件/.test(markdown) === true, "应检测到触发条件");
  assert(/##\s*执行步骤/.test(markdown) === true, "应检测到执行步骤");
  assert(/##\s*注意事项/.test(markdown) === true, "应检测到注意事项");

  const fullMarkdown = markdown + "\n\n## 适用场景\n- 场景1\n\n## 成功判定\n- 完成\n";
  assert(/##\s*适用场景/.test(fullMarkdown) === true, "加入后应检测到适用场景");
  assert(/##\s*成功判定/.test(fullMarkdown) === true, "加入后应检测到成功判定");
  return true;
});

// 40. frontmatter 解析 tags/antiTriggers/scope/workspaceId
test("frontmatter 解析 tags/antiTriggers/scope/workspaceId", async () => {
  const parsed = parseSkillFrontmatter(`---
name: "test-fm"
description: "frontmatter 新字段测试"
triggers: ["a"]
calls: []
tags: ["typescript", "mcp"]
antiTriggers: ["danger", "unsafe"]
scope: workspace
workspaceId: "proj-123"
---

# test-fm

正文内容`);

  assert(parsed.meta.name === "test-fm", "name 应正确");
  assert(parsed.meta.tags?.join(",") === "typescript,mcp", "tags 应正确");
  assert(parsed.meta.antiTriggers?.join(",") === "danger,unsafe", "antiTriggers 应正确");
  assert(parsed.meta.scope === "workspace", "scope 应为 workspace");
  assert(parsed.meta.workspaceId === "proj-123", "workspaceId 应正确");
  assert(parsed.body.includes("正文内容"), "正文应保留");
  return true;
});

// 41. 旧版 skills.json 无新字段时兼容
test("旧版 skills.json 无新字段时兼容", async () => {
  counter++;
  const storePath = join(tmpDir, `skills_${counter}.json`);
  const repoDir = join(tmpDir, `repo_${counter}`);

  // 手动写入只有旧字段的 skills.json
  const { writeFileSync: writeSync, mkdirSync } = await import("node:fs");
  mkdirSync(repoDir, { recursive: true });
  const legacyData = {
    version: 1,
    skills: {
      "old-skill": {
        name: "old-skill",
        description: "旧版技能",
        filePath: join(repoDir, "old-skill.md"),
        triggers: ["old"],
        executionCount: 5,
        successCount: 3,
        history: [],
      },
    },
  };
  writeSync(storePath, JSON.stringify(legacyData));

  const store = await SkillStore.create({ storePath, repoDir });
  const skill = store.get("old-skill");
  assert(!!skill, "旧版技能应可读取");
  assert(skill!.tags.length === 0, "默认 tags 应为空数组");
  assert(skill!.antiTriggers.length === 0, "默认 antiTriggers 应为空数组");
  assert(skill!.scope === "global", "默认 scope 应为 global");
  assert(skill!.workspaceId === undefined, "默认 workspaceId 应为 undefined");
  assert(skill!.executionCount === 5, "旧字段 executionCount 应保留");
  return true;
});

// 42. after_task 成功无关联技能 — 搜索匹配
test("after_task 成功无关联技能时搜索类似", async () => {
  const store = await tmpStore();
  await seedSkill(store, "git-commit", {
    description: "Git 提交代码",
    triggers: ["提交", "commit"],
  });

  // 模拟 after_task 的搜索逻辑
  const task = "帮我提交代码到 git";
  const approach = "git add + git commit";
  const similarSkills = store.search(`${task} ${approach}`);

  assert(similarSkills.length > 0, "应搜索到类似技能");
  assert(similarSkills[0].name === "git-commit", "应匹配到 git-commit");
  return true;
});

// ═══════════════════════════════════════════════════════════════
// 新增：workspace 隔离专项测试
// ═══════════════════════════════════════════════════════════════

// 43. 同名技能在不同 workspace 下可共存
test("同名技能不同 workspace 共存", async () => {
  const store = await tmpStore();

  // deploy@global
  await seedSkill(store, "deploy", { description: "全局部署", triggers: ["deploy"] });
  // deploy@ws-a
  await seedSkill(store, "deploy", { description: "A 项目部署", scope: "workspace", workspaceId: "ws-a", triggers: ["deploy"] });
  // deploy@ws-b
  await seedSkill(store, "deploy", { description: "B 项目部署", scope: "workspace", workspaceId: "ws-b", triggers: ["deploy"] });

  // 三个都能各自读到
  const globalDeploy = store.get("deploy");
  const wsADeploy = store.get("deploy", { workspaceId: "ws-a" });
  const wsBDeploy = store.get("deploy", { workspaceId: "ws-b" });

  assert(!!globalDeploy, "全局 deploy 应存在");
  assert(!!wsADeploy, "ws-a deploy 应存在");
  assert(!!wsBDeploy, "ws-b deploy 应存在");

  assert(globalDeploy!.description === "全局部署", "全局 deploy 描述应正确");
  assert(wsADeploy!.description === "A 项目部署", "ws-a deploy 描述应正确");
  assert(wsBDeploy!.description === "B 项目部署", "ws-b deploy 描述应正确");

  // list 应该返回 3 个技能（1 global + 2 workspace）
  const all = store.list();
  assert(all.length === 1, "list() 不带 workspaceId 应只返回 global 技能");

  // list 带 workspaceId 应过滤
  const wsAList = store.list({ workspaceId: "ws-a" });
  assert(wsAList.length === 2, "ws-a list 应返回 2 个（global + ws-a）");
  assert(wsAList.every(s => s.name === "deploy"), "ws-a list 所有技能都应是 deploy");

  return true;
});

// 44. get/read/report/history/delete 按 workspaceId 精确命中
test("get/read/report/history/delete 按 workspaceId 精确命中", async () => {
  const store = await tmpStore();

  await seedSkill(store, "deploy", { description: "全局部署", scope: "global", triggers: ["deploy"] });
  await seedSkill(store, "deploy", { description: "A 部署", scope: "workspace", workspaceId: "ws-a", triggers: ["deploy"] });
  await seedSkill(store, "deploy", { description: "B 部署", scope: "workspace", workspaceId: "ws-b", triggers: ["deploy"] });

  // get 精确命中
  assert(store.get("deploy", { workspaceId: "ws-a" })?.description === "A 部署", "get ws-a 应命中 A 部署");
  assert(store.get("deploy", { workspaceId: "ws-b" })?.description === "B 部署", "get ws-b 应命中 B 部署");
  assert(store.get("deploy")?.description === "全局部署", "get 不带 workspaceId 应命中全局");

  // recordExecution 精确命中
  await store.recordExecution("deploy", {
    timestamp: iso(), success: true, duration: 10, summary: "ws-a exec", error: null, context: "ctx",
  }, { workspaceId: "ws-a" });
  await store.recordExecution("deploy", {
    timestamp: iso(), success: false, duration: 5, summary: "ws-b fail", error: "err", context: "ctx",
  }, { workspaceId: "ws-b" });

  const wsAHistory = store.getHistory("deploy", 10, { workspaceId: "ws-a" });
  const wsBHistory = store.getHistory("deploy", 10, { workspaceId: "ws-b" });
  const globalHistory = store.getHistory("deploy", 10);

  assert(wsAHistory.length === 1 && wsAHistory[0].summary === "ws-a exec", "ws-a history 应只有 ws-a 记录");
  assert(wsBHistory.length === 1 && wsBHistory[0].summary === "ws-b fail", "ws-b history 应只有 ws-b 记录");
  assert(globalHistory.length === 0, "全局 history 应为空（没有执行过全局 deploy）");

  // delete 精确命中
  const deleted = await store.delete("deploy", { workspaceId: "ws-a" });
  assert(deleted === true, "删除 ws-a deploy 应成功");
  assert(store.get("deploy", { workspaceId: "ws-a" })?.description === "全局部署", "删除 ws-a 后应 fallback 到全局");
  assert(store.get("deploy", { workspaceId: "ws-b" })?.description === "B 部署", "ws-b deploy 不受影响");

  return true;
});

// 45. route() 不返回其他 workspace 的技能
test("route() 不返回其他 workspace 的技能", async () => {
  const store = await tmpStore();

  await seedSkill(store, "deploy", { description: "全局部署", triggers: ["deploy", "发布"] });
  await seedSkill(store, "deploy", { description: "A 项目专用部署", scope: "workspace", workspaceId: "ws-a", triggers: ["deploy"] });
  await seedSkill(store, "analyze", { description: "B 项目专用分析", scope: "workspace", workspaceId: "ws-b", triggers: ["分析"] });

  // 当前在 ws-a，路由 deploy
  const resultWsA = route("帮我部署", store.list(), { workspaceId: "ws-a" });
  assert(resultWsA.recommendations.length >= 1, "ws-a 应有推荐");

  // 不应出现 ws-b 的 analyze 技能
  const hasWsB = resultWsA.recommendations.some(
    r => r.skill.workspaceId === "ws-b"
  );
  assert(!hasWsB, "ws-a 路由结果不应出现 ws-b 的技能");

  // 当前在 ws-b，路由分析
  const resultWsB = route("帮我分析代码", store.list(), { workspaceId: "ws-b" });
  const hasWsA = resultWsB.recommendations.some(
    r => r.skill.workspaceId === "ws-a"
  );
  assert(!hasWsA, "ws-b 路由结果不应出现 ws-a 的技能");

  return true;
});

// 46. buildSkillSummary() 不泄漏其他 workspace 技能
test("buildSkillSummary() 不泄漏其他 workspace", async () => {
  const store = await tmpStore();

  await seedSkill(store, "common", { description: "公共技能" });
  await seedSkill(store, "ws-a-only", { description: "A 专属", scope: "workspace", workspaceId: "ws-a" });
  await seedSkill(store, "ws-b-only", { description: "B 专属", scope: "workspace", workspaceId: "ws-b" });

  const wsASummary = buildSkillSummary(store.list({ workspaceId: "ws-a" }));
  assert(wsASummary.includes("common"), "ws-a 摘要应包含全局技能");
  assert(wsASummary.includes("ws-a-only"), "ws-a 摘要应包含 ws-a 技能");
  assert(!wsASummary.includes("ws-b-only"), "ws-a 摘要不应包含 ws-b 技能");

  const wsBSummary = buildSkillSummary(store.list({ workspaceId: "ws-b" }));
  assert(wsBSummary.includes("common"), "ws-b 摘要应包含全局技能");
  assert(wsBSummary.includes("ws-b-only"), "ws-b 摘要应包含 ws-b 技能");
  assert(!wsBSummary.includes("ws-a-only"), "ws-b 摘要不应包含 ws-a 技能");

  return true;
});

// 47. scope 从 workspace 改为 global 时清空 workspaceId
test("scope 切换 workspace→global 时清空 workspaceId", async () => {
  const store = await tmpStore();

  // 先创建 workspace 技能
  await seedSkill(store, "migrate", {
    description: "workspace 版本",
    scope: "workspace",
    workspaceId: "ws-old",
  });

  const wsSkill = store.get("migrate", { workspaceId: "ws-old" });
  assert(!!wsSkill, "workspace 版本应存在");
  assert(wsSkill!.scope === "workspace", "应为 workspace scope");
  assert(wsSkill!.workspaceId === "ws-old", "workspaceId 应为 ws-old");

  // 改为 global
  await store.save({
    name: "migrate",
    content: "# migrate\n\n改为全局",
    description: "全局版本",
    scope: "global",
  });

  // 全局版本应可获取
  const globalSkill = store.get("migrate");
  assert(!!globalSkill, "全局版本应存在");
  assert(globalSkill!.description === "全局版本", "描述应为全局版本");
  assert(globalSkill!.scope === "global", "scope 应为 global");
  assert(globalSkill!.workspaceId === undefined, "workspaceId 应被清空");

  // 旧的 workspace 版本仍然独立存在（不同命名空间）
  const wsOld = store.get("migrate", { workspaceId: "ws-old" });
  assert(!!wsOld, "旧的 workspace 版本应仍存在");
  assert(wsOld!.description === "workspace 版本", "workspace 版本描述不变");
  assert(wsOld!.scope === "workspace", "scope 仍为 workspace");

  // 不带 workspaceId 的 get 只命中 global
  assert(store.get("migrate")?.description === "全局版本", "不带 workspaceId 只命中 global");

  return true;
});

// 48. resolveSkillGraph() 优先同 workspace 依赖
test("resolveSkillGraph() 优先同 workspace 依赖", async () => {
  const store = await tmpStore();

  // 全局依赖
  await seedSkill(store, "helper", { description: "全局 helper", calls: [] });
  // workspace 专用依赖
  await seedSkill(store, "helper", {
    description: "ws-a helper",
    scope: "workspace",
    workspaceId: "ws-a",
    calls: [],
  });
  // workspace 专用主技能，依赖 helper
  await seedSkill(store, "main", {
    description: "ws-a main",
    calls: ["helper"],
    scope: "workspace",
    workspaceId: "ws-a",
  });

  // 在 ws-a 下解析依赖图
  const graph = store.resolveSkillGraph("main", { workspaceId: "ws-a" });
  assert(graph.cycles.length === 0, "不应有循环");
  assert(graph.ordered.length === 2, "应包含 2 个节点");

  // 应优先使用 ws-a 的 helper
  const helperNode = graph.ordered.find(n => n.name === "helper");
  assert(!!helperNode, "应包含 helper 依赖");

  return true;
});

// 49. builtin 的 tags/antiTriggers 会被加载
test("builtin 的 tags/antiTriggers 会被加载", async () => {
  const store = await tmpStore();

  await store.registerBuiltin({
    name: "test-builtin-tags",
    content: "# test\n\nbody",
    description: "测试内置标签",
    triggers: ["test"],
    calls: [],
    tags: ["typescript", "testing"],
    antiTriggers: ["danger", "unsafe"],
  });

  const skill = store.get("test-builtin-tags");
  assert(!!skill, "技能应存在");
  assert(skill!.tags.join(",") === "typescript,testing", "tags 应被正确加载");
  assert(skill!.antiTriggers.join(",") === "danger,unsafe", "antiTriggers 应被正确加载");
  assert(skill!.builtin === true, "应标记为 builtin");

  return true;
});

async function run() {
  for (const { name, fn } of tests) {
    try {
      const ok = await fn();
      if (ok) {
        passed.push(name);
        console.log(`✅ ${name}`);
      } else {
        failed.push(name);
        console.log(`❌ ${name}`);
      }
    } catch (error) {
      failed.push(name);
      const msg = error instanceof Error ? error.message : String(error);
      console.log(`❌ ${name} -> ${msg}`);
    }
  }

  console.log("\n=== 测试总结 ===");
  console.log(`通过: ${passed.length}`);
  console.log(`失败: ${failed.length}`);

  if (failed.length > 0) {
    console.log(`失败用例: ${failed.join(" | ")}`);
  }

  process.exit(failed.length > 0 ? 1 : 0);
}

await run();
