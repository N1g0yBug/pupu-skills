const INVALID_SKILL_NAME_CHARS = /[<>:"/\\|?*\x00-\x1F]/;
const WINDOWS_RESERVED_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);

/**
 * Keep skill names filesystem-safe without forcing ASCII-only slugs.
 */
export function isSafeSkillName(name: string): boolean {
  if (name !== name.trim()) return false;
  if (!name) return false;
  if (name === "." || name === "..") return false;
  if (INVALID_SKILL_NAME_CHARS.test(name)) return false;
  if (WINDOWS_RESERVED_NAMES.has(name.toUpperCase())) return false;
  return true;
}
