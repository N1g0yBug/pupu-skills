/**
 * Markdown 技能存储：仅负责技能元数据与文档持久化。
 * 内部主键为 skillId（scope + workspaceId + name），支持同名技能在不同 workspace 共存。
 */

import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { logger } from "../utils/logger.js";

// ── 类型定义 ───────────────────────────────────────────────────────────

export interface ExecutionRecord {
  timestamp: string;
  success: boolean;
  duration: number;
  summary: string;
  error: string | null;
  context: string;
}

interface LegacyExecutionRecord {
  timestamp: string;
  exitCode: number;
  duration: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  args: string[];
}

export interface SkillRecord {
  name: string;
  description: string;
  filePath: string;
  builtin: boolean;
  triggers: string[];
  tags: string[];
  antiTriggers: string[];
  scope: "global" | "workspace";
  workspaceId?: string;
  createdAt: string;
  updatedAt: string;
  executionCount: number;
  successCount: number;
  lastError: string | null;
  utilityScore: number;
  history: ExecutionRecord[];
  calls: string[];
}

interface StoreData {
  version: number;
  skills: Record<string, SkillRecord>;
}

interface LegacySkillRecord {
  name: string;
  description: string;
  filePath: string;
  builtin?: boolean;
  triggers?: string[];
  tags?: string[];
  antiTriggers?: string[];
  scope?: "global" | "workspace";
  workspaceId?: string;
  createdAt?: string;
  updatedAt?: string;
  executionCount?: number;
  successCount?: number;
  lastError?: string | null;
  utilityScore?: number;
  history?: Array<ExecutionRecord | LegacyExecutionRecord>;
  calls?: string[];
}

type SaveInput = {
  name: string;
  content: string;
  description: string;
  triggers?: string[];
  calls?: string[];
  tags?: string[];
  antiTriggers?: string[];
  scope?: "global" | "workspace";
  workspaceId?: string;
};

type SaveCompatInput = SaveInput & {
  code?: never;
};

type SaveLegacyInput = {
  name: string;
  code: string;
  description: string;
  triggers?: string[];
  calls?: string[];
  tags?: string[];
  antiTriggers?: string[];
  scope?: "global" | "workspace";
  workspaceId?: string;
};

type BuiltinInput = {
  name: string;
  content: string;
  description: string;
  triggers?: string[];
  calls?: string[];
  tags?: string[];
  antiTriggers?: string[];
};

type BuiltinLegacyInput = {
  name: string;
  code: string;
  description: string;
  triggers?: string[];
  calls?: string[];
};

export interface SkillOptions {
  workspaceId?: string;
}

// ── 常量 ───────────────────────────────────────────────────────────────

const PUPU_HOME = join(homedir(), ".pupu_skills");
const STORE_FILE = join(PUPU_HOME, "skills.json");
const SKILLS_REPO_DIR = join(PUPU_HOME, "skills_repo");
const MAX_HISTORY = 50;

// ── 工具函数 ───────────────────────────────────────────────────────────

function clampScore(value: number): number {
  return Math.round(Math.max(0, Math.min(100, value)));
}

function isLegacyExecutionRecord(input: ExecutionRecord | LegacyExecutionRecord): input is LegacyExecutionRecord {
  return "exitCode" in input;
}

function normalizeExecutionRecord(input: ExecutionRecord | LegacyExecutionRecord): ExecutionRecord {
  if (!isLegacyExecutionRecord(input)) {
    return {
      timestamp: input.timestamp,
      success: input.success,
      duration: input.duration,
      summary: input.summary,
      error: input.error,
      context: input.context,
    };
  }

  const success = input.exitCode === 0 && !input.timedOut;
  return {
    timestamp: input.timestamp,
    success,
    duration: input.duration,
    summary: input.stdout.slice(0, 200),
    error: input.stderr?.trim() ? input.stderr : null,
    context: Array.isArray(input.args) ? input.args.join(" ") : "",
  };
}

function computeConsecutiveStreak(history: ExecutionRecord[], value: boolean): number {
  let streak = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].success === value) {
      streak++;
      continue;
    }
    break;
  }
  return streak;
}

/**
 * 效用分公式（v1 保持不变）
 * base = 50
 * + (successCount / executionCount) * 50
 * + min(consecutive_success_streak * 5, 25)
 * - min(consecutive_fail_streak * 10, 50)
 * - min(sqrt(daysSince) * 3, 20) // daysSince > 1
 */
function computeUtilityScore(record: SkillRecord): number {
  let score = 50;

  if (record.executionCount > 0) {
    score += (record.successCount / record.executionCount) * 50;
  }

  const successStreak = computeConsecutiveStreak(record.history, true);
  const failStreak = computeConsecutiveStreak(record.history, false);
  score += Math.min(successStreak * 5, 25);
  score -= Math.min(failStreak * 10, 50);

  const lastExec = record.history[record.history.length - 1];
  if (lastExec) {
    const daysSince = (Date.now() - new Date(lastExec.timestamp).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince > 1) {
      score -= Math.min(Math.sqrt(daysSince) * 3, 20);
    }
  }

  return clampScore(score);
}

function toYamlScalar(value: string | number | null): string {
  if (value === null) return "null";
  return JSON.stringify(value);
}

function toYamlArray(values: string[]): string {
  return JSON.stringify(values);
}

function buildFrontmatter(record: SkillRecord): string {
  const lines = [
    "---",
    `name: ${toYamlScalar(record.name)}`,
    `description: ${toYamlScalar(record.description)}`,
    `triggers: ${toYamlArray(record.triggers)}`,
    `calls: ${toYamlArray(record.calls)}`,
  ];
  if (record.tags.length > 0) {
    lines.push(`tags: ${toYamlArray(record.tags)}`);
  }
  if (record.antiTriggers.length > 0) {
    lines.push(`antiTriggers: ${toYamlArray(record.antiTriggers)}`);
  }
  if (record.scope === "workspace") {
    lines.push(`scope: workspace`);
    if (record.workspaceId) {
      lines.push(`workspaceId: ${toYamlScalar(record.workspaceId)}`);
    }
  }
  lines.push(
    `utility: ${record.utilityScore}`,
    `created: ${toYamlScalar(record.createdAt)}`,
    `updated: ${toYamlScalar(record.updatedAt)}`,
    "---",
  );
  return lines.join("\n");
}

function splitMarkdown(content: string): { frontmatter: string; body: string } {
  const normalized = content.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---\n")) {
    return { frontmatter: "", body: normalized };
  }

  const endIndex = normalized.indexOf("\n---\n", 4);
  if (endIndex === -1) {
    return { frontmatter: "", body: normalized };
  }

  const frontmatter = normalized.slice(0, endIndex + 5);
  const body = normalized.slice(endIndex + 5);
  return { frontmatter, body };
}

function sanitizeStringArray(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input.filter((item): item is string => typeof item === "string");
}

/**
 * 构建技能唯一 ID（内部主键）。
 * global 技能: "global:<name>"
 * workspace 技能: "workspace:<workspaceId>:<name>"
 */
function buildSkillId(input: {
  name: string;
  scope: "global" | "workspace";
  workspaceId?: string;
}): string {
  return input.scope === "workspace" && input.workspaceId
    ? `workspace:${input.workspaceId}:${input.name}`
    : `global:${input.name}`;
}

/**
 * 根据技能名和 workspaceId 查找技能。
 * - 有 workspaceId: 优先 workspace, fallback global
 * - 无 workspaceId: 只查 global
 */
function resolveSkillKeys(name: string, options?: SkillOptions): string[] {
  if (options?.workspaceId) {
    return [`workspace:${options.workspaceId}:${name}`, `global:${name}`];
  }
  return [`global:${name}`];
}

/**
 * 构建技能的文件路径，按 workspace 分目录。
 */
function buildSkillFilePath(
  repoDir: string,
  name: string,
  scope: "global" | "workspace",
  workspaceId?: string,
): string {
  if (scope === "workspace" && workspaceId) {
    return resolve(repoDir, "workspace", workspaceId, `${name}.md`);
  }
  return resolve(repoDir, "global", `${name}.md`);
}

function normalizeSkillRecord(input: LegacySkillRecord, repoDir: string): SkillRecord {
  const now = new Date().toISOString();
  const name = input.name;
  const historyRaw = Array.isArray(input.history) ? input.history : [];
  const history = historyRaw.map(normalizeExecutionRecord).slice(-MAX_HISTORY);
  const executionCount = typeof input.executionCount === "number" ? input.executionCount : history.length;
  const successCount = typeof input.successCount === "number"
    ? input.successCount
    : history.filter(h => h.success).length;

  const scope = input.scope ?? "global";
  const workspaceId = scope === "workspace" ? input.workspaceId : undefined;

  const rawPath = typeof input.filePath === "string" && input.filePath.trim()
    ? input.filePath
    : buildSkillFilePath(repoDir, name, scope, workspaceId);

  const normalizedPath = rawPath.endsWith(".mjs")
    ? rawPath.slice(0, -4) + ".md"
    : rawPath;

  const normalized: SkillRecord = {
    name,
    description: input.description,
    filePath: normalizedPath,
    builtin: input.builtin ?? false,
    triggers: sanitizeStringArray(input.triggers),
    tags: sanitizeStringArray(input.tags),
    antiTriggers: sanitizeStringArray(input.antiTriggers),
    scope,
    workspaceId,
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
    executionCount,
    successCount,
    lastError: input.lastError ?? null,
    utilityScore: typeof input.utilityScore === "number" ? input.utilityScore : 50,
    history,
    calls: sanitizeStringArray(input.calls),
  };

  normalized.utilityScore = computeUtilityScore(normalized);
  return normalized;
}

/**
 * 获取可见技能列表。
 * - 有 workspaceId: global + 当前 workspace
 * - 无 workspaceId: 只返回 global
 */
function getVisibleSkills(all: SkillRecord[], options?: SkillOptions): SkillRecord[] {
  if (options?.workspaceId) {
    return all.filter(
      s => s.scope === "global" || s.workspaceId === options.workspaceId
    );
  }
  return all.filter(s => s.scope === "global");
}

// ── SkillStore ─────────────────────────────────────────────────────────

export class SkillStore {
  private data: StoreData;
  private readonly storePath: string;
  private readonly repoDir: string;

  private constructor(storePath: string, repoDir: string, data: StoreData) {
    this.storePath = storePath;
    this.repoDir = repoDir;
    this.data = data;
  }

  static async create(options?: {
    storePath?: string;
    repoDir?: string;
  }): Promise<SkillStore> {
    const storePath = options?.storePath ?? STORE_FILE;
    const repoDir = options?.repoDir ?? SKILLS_REPO_DIR;

    await mkdir(dirname(storePath), { recursive: true });
    await mkdir(repoDir, { recursive: true });

    let data: StoreData;
    try {
      const raw = await readFile(storePath, "utf-8");
      const parsed = JSON.parse(raw) as { version?: number; skills?: Record<string, LegacySkillRecord> };
      const skillsInput = parsed.skills ?? {};
      const skills: Record<string, SkillRecord> = {};

      for (const [key, value] of Object.entries(skillsInput)) {
        if (!value || typeof value !== "object") continue;
        if (typeof value.name !== "string") value.name = key;
        if (typeof value.description !== "string") value.description = "";

        const record = normalizeSkillRecord(value, repoDir);

        // 旧版数据 key 可能是 name（不含 `:` 分隔符），需要重新生成 skillId
        const scope = record.scope;
        const workspaceId = scope === "workspace" ? record.workspaceId : undefined;
        const skillId = buildSkillId({ name: record.name, scope, workspaceId });
        skills[skillId] = record;
      }

      data = { version: 3, skills };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") {
        data = { version: 3, skills: {} };
        logger.info("已初始化新技能存储", { path: storePath });
      } else {
        logger.error("技能存储读取/解析失败，已备份并初始化空存储", { path: storePath, error: String(error) });
        try {
          const { renameSync } = await import("node:fs");
          renameSync(storePath, `${storePath}.bak.${Date.now()}`);
        } catch {
          // 备份失败不阻塞启动
        }
        data = { version: 3, skills: {} };
      }
    }

    const store = new SkillStore(storePath, repoDir, data);
    return store;
  }

  /**
   * 按名称查找技能。
   * - 有 workspaceId: 优先 workspace 技能，fallback global
   * - 无 workspaceId: 只命中 global
   */
  get(name: string, options?: SkillOptions): SkillRecord | undefined {
    for (const key of resolveSkillKeys(name, options)) {
      const skill = this.data.skills[key];
      if (skill) return skill;
    }
    return undefined;
  }

  /**
   * 列出可见技能。
   * - 有 workspaceId: 返回 global + 当前 workspace 的技能
   * - 无 workspaceId: 只返回 global 技能
   */
  list(options?: SkillOptions): SkillRecord[] {
    const visible = getVisibleSkills(Object.values(this.data.skills), options);

    return visible
      .map(skill => ({
        ...skill,
        history: [...skill.history],
        triggers: [...skill.triggers],
        calls: [...skill.calls],
        tags: [...skill.tags],
        antiTriggers: [...skill.antiTriggers],
      }))
      .sort((a, b) => b.utilityScore - a.utilityScore);
  }

  search(query: string, options?: SkillOptions): SkillRecord[] {
    const q = query.trim().toLowerCase();

    // 先获取可见技能
    const visible = this.list(options);

    if (!q || q === "*") {
      return visible;
    }

    const terms = q.split(/\s+/).filter(Boolean);
    const matches = visible
      .map(skill => {
        const haystack = [
          skill.name,
          skill.description,
          ...skill.triggers,
        ].join("\n").toLowerCase();

        const score = terms.reduce((acc, term) => (haystack.includes(term) ? acc + 1 : acc), 0);
        return { skill, score };
      })
      .filter(item => item.score > 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return b.skill.utilityScore - a.skill.utilityScore;
      });

    return matches.map(item => ({
      ...item.skill,
      history: [...item.skill.history],
      triggers: [...item.skill.triggers],
      calls: [...item.skill.calls],
      tags: [...item.skill.tags],
      antiTriggers: [...item.skill.antiTriggers],
    }));
  }

  getLowUtility(threshold: number, options?: SkillOptions): SkillRecord[] {
    const visible = getVisibleSkills(Object.values(this.data.skills), options);

    return visible
      .filter(skill => skill.executionCount >= 2 && skill.utilityScore < threshold)
      .sort((a, b) => a.utilityScore - b.utilityScore)
      .map(skill => ({
        ...skill,
        history: [...skill.history],
        triggers: [...skill.triggers],
        calls: [...skill.calls],
        tags: [...skill.tags],
        antiTriggers: [...skill.antiTriggers],
      }));
  }

  getHistory(name: string, limit: number, options?: SkillOptions): ExecutionRecord[] {
    const skill = this.get(name, options);
    if (!skill) return [];
    return skill.history.slice(-limit).reverse();
  }

  getLastExecution(name: string, options?: SkillOptions): ExecutionRecord | null {
    const skill = this.get(name, options);
    if (!skill || skill.history.length === 0) return null;
    return skill.history[skill.history.length - 1];
  }

  getRepoDir(): string {
    return this.repoDir;
  }

  getStorePath(): string {
    return this.storePath;
  }

  // 兼容旧调用：允许 code 字段
  async save(skill: SaveCompatInput | SaveLegacyInput): Promise<SkillRecord> {
    const scope = skill.scope ?? "global";

    // scope=global 时 workspaceId 强制清空
    const workspaceId = scope === "workspace" ? skill.workspaceId : undefined;

    const newSkillId = buildSkillId({ name: skill.name, scope, workspaceId });

    // 只在相同 scope+workspaceId 查找已有技能，不使用 fallback
    const existing = this.data.skills[newSkillId];

    if (existing?.builtin) {
      throw new Error(`内置技能 "${skill.name}" 不可覆盖`);
    }

    const now = new Date().toISOString();
    const content = "content" in skill ? skill.content : skill.code;
    const filePath = buildSkillFilePath(this.repoDir, skill.name, scope, workspaceId);

    const record: SkillRecord = {
      name: skill.name,
      description: skill.description,
      filePath,
      builtin: existing?.builtin ?? false,
      triggers: skill.triggers ?? existing?.triggers ?? [],
      tags: skill.tags ?? existing?.tags ?? [],
      antiTriggers: skill.antiTriggers ?? existing?.antiTriggers ?? [],
      scope,
      workspaceId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      executionCount: existing?.executionCount ?? 0,
      successCount: existing?.successCount ?? 0,
      lastError: existing?.lastError ?? null,
      utilityScore: existing?.utilityScore ?? 50,
      history: existing?.history ?? [],
      calls: skill.calls ?? existing?.calls ?? [],
    };

    record.utilityScore = computeUtilityScore(record);

    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, `${buildFrontmatter(record)}\n${content}`, "utf-8");
    this.data.skills[newSkillId] = record;
    await this.flush();

    logger.info("已保存 markdown 技能", { name: skill.name, scope, workspaceId, path: filePath });
    return record;
  }

  async delete(name: string, options?: SkillOptions): Promise<boolean> {
    const skill = this.get(name, options);
    if (!skill || skill.builtin) return false;

    const skillId = buildSkillId({ name: skill.name, scope: skill.scope, workspaceId: skill.workspaceId });
    delete this.data.skills[skillId];
    await this.flush();

    try {
      await unlink(skill.filePath);
      logger.info("已删除技能文档", { name, skillId, path: skill.filePath });
    } catch {
      logger.warn("技能文档删除失败", { name, skillId, path: skill.filePath });
    }

    return true;
  }

  async recordExecution(name: string, execRecord: ExecutionRecord | LegacyExecutionRecord, options?: SkillOptions): Promise<void> {
    const skill = this.get(name, options);
    if (!skill) return;

    const normalized = normalizeExecutionRecord(execRecord);
    skill.history.push(normalized);
    if (skill.history.length > MAX_HISTORY) {
      skill.history = skill.history.slice(-MAX_HISTORY);
    }

    skill.executionCount += 1;
    if (normalized.success) {
      skill.successCount += 1;
      skill.lastError = null;
    } else {
      skill.lastError = normalized.error ?? "执行失败";
    }

    skill.updatedAt = new Date().toISOString();
    skill.utilityScore = computeUtilityScore(skill);

    await this.flush();
  }

  async registerBuiltin(skill: BuiltinInput | BuiltinLegacyInput): Promise<void> {
    const now = new Date().toISOString();
    const scope = "global" as const;
    const content = "content" in skill ? skill.content : skill.code;
    const filePath = buildSkillFilePath(this.repoDir, skill.name, scope);
    const skillId = buildSkillId({ name: skill.name, scope });
    const existing = this.data.skills[skillId];

    if (existing && !existing.builtin) {
      return;
    }

    const record: SkillRecord = existing?.builtin
      ? {
          ...existing,
          name: skill.name,
          description: skill.description,
          filePath,
          builtin: true,
          triggers: skill.triggers ?? existing.triggers,
          tags: ("tags" in skill ? skill.tags : undefined) ?? existing.tags,
          antiTriggers: ("antiTriggers" in skill ? skill.antiTriggers : undefined) ?? existing.antiTriggers,
          updatedAt: now,
          calls: skill.calls ?? existing.calls,
        }
      : {
          name: skill.name,
          description: skill.description,
          filePath,
          builtin: true,
          triggers: skill.triggers ?? [],
          createdAt: now,
          updatedAt: now,
          executionCount: 0,
          successCount: 0,
          lastError: null,
          utilityScore: 50,
          history: [],
          calls: skill.calls ?? [],
          tags: ("tags" in skill ? skill.tags : undefined) ?? [],
          antiTriggers: ("antiTriggers" in skill ? skill.antiTriggers : undefined) ?? [],
          scope: "global" as const,
        };

    record.utilityScore = computeUtilityScore(record);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, `${buildFrontmatter(record)}\n${content}`, "utf-8");

    this.data.skills[skillId] = record;
    await this.flush();
    logger.info(existing?.builtin ? "已刷新内置 markdown 技能" : "已注册内置 markdown 技能", { name: skill.name });
  }

  async readSkillContent(name: string, options?: SkillOptions): Promise<string> {
    const skill = this.get(name, options);
    if (!skill) {
      throw new Error(`技能不存在: ${name}`);
    }
    return readFile(skill.filePath, "utf-8");
  }

  async updateSkillContent(name: string, content: string, options?: SkillOptions): Promise<void> {
    const skill = this.get(name, options);
    if (!skill) {
      throw new Error(`技能不存在: ${name}`);
    }

    const current = await readFile(skill.filePath, "utf-8");
    const { frontmatter } = splitMarkdown(current);
    const next = frontmatter ? `${frontmatter}\n${content}` : content;
    await writeFile(skill.filePath, next, "utf-8");
  }

  /**
   * 解析技能依赖图。
   * - 优先在当前 workspace 查找依赖技能
   * - fallback 到 global
   */
  resolveSkillGraph(rootName: string, options?: SkillOptions): { ordered: { name: string; depth: number }[]; cycles: string[] } {
    const rootSkill = this.get(rootName, options);
    if (!rootSkill) return { ordered: [], cycles: [] };

    const visited = new Set<string>();
    const inStack = new Set<string>();
    const ordered: { name: string; depth: number }[] = [];
    const cycles: string[] = [];
    const self = this;

    function dfs(name: string, depth: number): void {
      if (depth > 20) return;
      if (inStack.has(name)) {
        cycles.push(name);
        return;
      }
      if (visited.has(name)) return;

      inStack.add(name);
      const skill = self.get(name, options);
      if (skill) {
        for (const dep of skill.calls) {
          dfs(dep, depth + 1);
        }
      }
      inStack.delete(name);
      visited.add(name);
      ordered.push({ name, depth });
    }

    dfs(rootName, 0);
    return { ordered, cycles: [...new Set(cycles)] };
  }

  private async flush(): Promise<void> {
    await writeFile(this.storePath, JSON.stringify(this.data, null, 2), "utf-8");
  }
}
