import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SkillStore } from "./memory/store.js";
import { parseSkillFrontmatter } from "./skills/frontmatter.js";
import { resolveBuiltinSkillsDir } from "./skills/paths.js";
import { logger } from "./utils/logger.js";

const SKILLS_DIR = resolveBuiltinSkillsDir(import.meta.url);
const BUILTIN_SKILL_FILES = [
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

export async function loadBuiltinSkills(store: SkillStore): Promise<void> {
  for (const name of BUILTIN_SKILL_FILES) {
    const filePath = join(SKILLS_DIR, `${name}.md`);

    try {
      const raw = await readFile(filePath, "utf-8");
      const parsed = parseSkillFrontmatter(raw);

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
        tags: parsed.meta.tags ?? [],
        antiTriggers: parsed.meta.antiTriggers ?? [],
      });
    } catch {
      logger.warn("内置技能加载失败", { name });
    }
  }
}

export async function createInitializedStore(options?: {
  storePath?: string;
  repoDir?: string;
}): Promise<SkillStore> {
  const store = await SkillStore.create(options);
  await loadBuiltinSkills(store);
  return store;
}
