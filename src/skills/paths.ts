import { fileURLToPath } from "node:url";

export function resolveBuiltinSkillsDir(moduleUrl: string): string {
  return fileURLToPath(new URL("../skills", moduleUrl));
}
