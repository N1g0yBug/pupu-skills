import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { SkillStore } from "../memory/store.js";
import { buildSkillSummary, route } from "../router/router.js";

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
  },
) {
  return store.save({
    name,
    content: options?.content ?? `# ${name}\n\nbody`,
    description: options?.description ?? `${name} description`,
    triggers: options?.triggers ?? [],
    calls: options?.calls ?? [],
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

// 2. save + get
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

// 3. save 写入 markdown 文件
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

// 4. readSkillContent
test("readSkillContent", async () => {
  const store = await tmpStore();
  await seedSkill(store, "read-content", { content: "# A\n\nB" });
  const full = await store.readSkillContent("read-content");
  assert(full.includes("name: \"read-content\""), "应包含 name frontmatter");
  assert(full.includes("# A\n\nB"), "应包含正文");
  return true;
});

// 5. updateSkillContent
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

// 6. search 模糊匹配
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

// 7. search 按 utility score 排序
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

// 8. delete
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

// 9. delete 内置保护
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

// 10. registerBuiltin 不覆盖用户技能
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

// 11. recordExecution 成功
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

// 12. recordExecution 失败
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

// 13. getHistory
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

// 14. getLastExecution
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

// 15. history 上限裁剪
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

// 16. 效用分计算
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

// 17. getLowUtility 基本功能
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

// 18. getLowUtility 排除未执行
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

// 19. route 精确匹配
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

// 20. route 触发词匹配
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

// 21. route 无匹配
test("route 无匹配", async () => {
  const store = await tmpStore();
  await seedSkill(store, "only-git", {
    description: "git 相关",
    triggers: ["commit", "rebase"],
  });

  const result = route("烤蛋糕配方", store.list());
  assert(result.recommendations.length === 0, "无相关任务应无推荐");
  assert(result.summary.includes("未找到置信度≥15分"), "应返回无匹配提示");
  return true;
});

// 22. buildSkillSummary
test("buildSkillSummary", async () => {
  const store = await tmpStore();
  await seedSkill(store, "a-skill");
  await store.registerBuiltin({
    name: "b-skill",
    content: "builtin",
    description: "builtin",
    triggers: [],
    calls: [],
  });

  const text = buildSkillSummary(store.list());
  assert(text.includes("📊 技能库: 2 个技能 (1 内置)"), "应包含总数与内置数");
  assert(text.includes("📋 可用:"), "应包含可用技能列表");
  assert(text.includes("💡 提示:"), "应包含提示语");
  return true;
});

// 23. registerBuiltin 写入文件
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

// 24. registerBuiltin 重复不覆盖
test("registerBuiltin 重复不覆盖", async () => {
  const store = await tmpStore();
  await store.registerBuiltin({
    name: "builtin-same",
    content: "first",
    description: "desc1",
    triggers: ["t1"],
    calls: [],
  });

  const first = await store.readSkillContent("builtin-same");

  await store.registerBuiltin({
    name: "builtin-same",
    content: "second",
    description: "desc2",
    triggers: ["t2"],
    calls: ["x"],
  });

  const second = await store.readSkillContent("builtin-same");
  assert(first === second, "重复注册内置技能不应覆盖文件内容");
  return true;
});

// 25. save 生成正确 frontmatter
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

// 26. save 保留触发词
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
