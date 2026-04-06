/**
 * Markdown 技能存储：仅负责技能元数据与文档持久化。
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
};

type BuiltinInput = {
  name: string;
  content: string;
  description: string;
  triggers?: string[];
  calls?: string[];
};

type BuiltinLegacyInput = {
  name: string;
  code: string;
  description: string;
  triggers?: string[];
  calls?: string[];
};

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
  return [
    "---",
    `name: ${toYamlScalar(record.name)}`,
    `description: ${toYamlScalar(record.description)}`,
    `triggers: ${toYamlArray(record.triggers)}`,
    `calls: ${toYamlArray(record.calls)}`,
    `utility: ${record.utilityScore}`,
    `created: ${toYamlScalar(record.createdAt)}`,
    `updated: ${toYamlScalar(record.updatedAt)}`,
    "---",
  ].join("\n");
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

function normalizeSkillRecord(input: LegacySkillRecord, repoDir: string): SkillRecord {
  const now = new Date().toISOString();
  const name = input.name;
  const historyRaw = Array.isArray(input.history) ? input.history : [];
  const history = historyRaw.map(normalizeExecutionRecord).slice(-MAX_HISTORY);
  const executionCount = typeof input.executionCount === "number" ? input.executionCount : history.length;
  const successCount = typeof input.successCount === "number"
    ? input.successCount
    : history.filter(h => h.success).length;

  const rawPath = typeof input.filePath === "string" && input.filePath.trim()
    ? input.filePath
    : resolve(repoDir, `${name}.md`);
  const normalizedPath = rawPath.endsWith(".mjs")
    ? rawPath.slice(0, -4) + ".md"
    : rawPath;

  const normalized: SkillRecord = {
    name,
    description: input.description,
    filePath: normalizedPath,
    builtin: input.builtin ?? false,
    triggers: sanitizeStringArray(input.triggers),
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

      for (const [name, value] of Object.entries(skillsInput)) {
        if (!value || typeof value !== "object") continue;
        if (typeof value.name !== "string") value.name = name;
        if (typeof value.description !== "string") value.description = "";
        if (typeof value.filePath !== "string") value.filePath = resolve(repoDir, `${name}.md`);
        skills[name] = normalizeSkillRecord(value, repoDir);
      }

      data = {
        version: 2,
        skills,
      };
    } catch {
      data = { version: 2, skills: {} };
      logger.info("已初始化新技能存储", { path: storePath });
    }

    const store = new SkillStore(storePath, repoDir, data);
    return store;
  }

  get(name: string): SkillRecord | undefined {
    return this.data.skills[name];
  }

  list(): SkillRecord[] {
    return Object.values(this.data.skills)
      .map(skill => ({ ...skill, history: [...skill.history], triggers: [...skill.triggers], calls: [...skill.calls] }))
      .sort((a, b) => b.utilityScore - a.utilityScore);
  }

  search(query: string): SkillRecord[] {
    const q = query.trim().toLowerCase();
    if (!q || q === "*") return this.list();

    const terms = q.split(/\s+/).filter(Boolean);
    const matches = Object.values(this.data.skills)
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

    return matches.map(item => ({ ...item.skill, history: [...item.skill.history], triggers: [...item.skill.triggers], calls: [...item.skill.calls] }));
  }

  getLowUtility(threshold: number): SkillRecord[] {
    return Object.values(this.data.skills)
      .filter(skill => skill.executionCount >= 2 && skill.utilityScore < threshold)
      .sort((a, b) => a.utilityScore - b.utilityScore)
      .map(skill => ({ ...skill, history: [...skill.history], triggers: [...skill.triggers], calls: [...skill.calls] }));
  }

  getHistory(name: string, limit: number): ExecutionRecord[] {
    const skill = this.data.skills[name];
    if (!skill) return [];
    return skill.history.slice(-limit).reverse();
  }

  getLastExecution(name: string): ExecutionRecord | null {
    const skill = this.data.skills[name];
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
    const existing = this.data.skills[skill.name];
    if (existing?.builtin) {
      throw new Error(`内置技能 "${skill.name}" 不可覆盖`);
    }

    const now = new Date().toISOString();
    const content = "content" in skill ? skill.content : skill.code;
    const filePath = resolve(this.repoDir, `${skill.name}.md`);

    const record: SkillRecord = {
      name: skill.name,
      description: skill.description,
      filePath,
      builtin: existing?.builtin ?? false,
      triggers: skill.triggers ?? existing?.triggers ?? [],
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

    await writeFile(filePath, `${buildFrontmatter(record)}\n${content}`, "utf-8");
    this.data.skills[skill.name] = record;
    await this.flush();

    logger.info("已保存 markdown 技能", { name: skill.name, path: filePath });
    return record;
  }

  async delete(name: string): Promise<boolean> {
    const record = this.data.skills[name];
    if (!record || record.builtin) return false;

    delete this.data.skills[name];
    await this.flush();

    try {
      await unlink(record.filePath);
      logger.info("已删除技能文档", { name, path: record.filePath });
    } catch {
      logger.warn("技能文档删除失败", { name, path: record.filePath });
    }

    return true;
  }

  async recordExecution(name: string, execRecord: ExecutionRecord | LegacyExecutionRecord): Promise<void> {
    const skill = this.data.skills[name];
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
    const filePath = resolve(this.repoDir, `${skill.name}.md`);
    const content = "content" in skill ? skill.content : skill.code;
    const existing = this.data.skills[skill.name];

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
        };

    record.utilityScore = computeUtilityScore(record);
    await writeFile(filePath, `${buildFrontmatter(record)}\n${content}`, "utf-8");

    this.data.skills[skill.name] = record;
    await this.flush();
    logger.info(existing?.builtin ? "已刷新内置 markdown 技能" : "已注册内置 markdown 技能", { name: skill.name });
  }

  async readSkillContent(name: string): Promise<string> {
    const skill = this.data.skills[name];
    if (!skill) {
      throw new Error(`技能不存在: ${name}`);
    }
    return readFile(skill.filePath, "utf-8");
  }

  async updateSkillContent(name: string, content: string): Promise<void> {
    const skill = this.data.skills[name];
    if (!skill) {
      throw new Error(`技能不存在: ${name}`);
    }

    const current = await readFile(skill.filePath, "utf-8");
    const { frontmatter } = splitMarkdown(current);
    const next = frontmatter ? `${frontmatter}\n${content}` : content;
    await writeFile(skill.filePath, next, "utf-8");
  }

  private async flush(): Promise<void> {
    await writeFile(this.storePath, JSON.stringify(this.data, null, 2), "utf-8");
  }
}
