export interface ParsedSkillFrontmatter {
  body: string;
  meta: {
    name?: string;
    description?: string;
    triggers?: string[];
    calls?: string[];
  };
}

function stripWrappingQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/g, "");
}

function parseStringArray(raw: string): string[] | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === "string");
    }
  } catch {
    // Fall back to a lightweight parser for YAML-like inline arrays.
  }

  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) {
      return [];
    }

    return inner
      .split(",")
      .map(item => stripWrappingQuotes(item.trim()))
      .filter(Boolean);
  }

  return [stripWrappingQuotes(trimmed)];
}

export function parseSkillFrontmatter(markdown: string): ParsedSkillFrontmatter {
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
  const meta: ParsedSkillFrontmatter["meta"] = {};

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
        meta.name = stripWrappingQuotes(raw);
      }
      continue;
    }

    if (line.startsWith("description:")) {
      const raw = line.slice(12).trim();
      if (raw) {
        meta.description = stripWrappingQuotes(raw);
      }
      continue;
    }

    if (line.startsWith("triggers:") || line.startsWith("calls:")) {
      const target = line.startsWith("triggers:") ? "triggers" : "calls";
      const raw = line.slice(line.indexOf(":") + 1).trim();
      const inlineValues = parseStringArray(raw);
      if (inlineValues !== null) {
        meta[target] = inlineValues;
        continue;
      }

      const values: string[] = [];
      while (cursor < lines.length) {
        const itemLine = lines[cursor];
        const trimmed = itemLine.trim();
        if (!trimmed.startsWith("-")) {
          break;
        }

        const value = stripWrappingQuotes(trimmed.slice(1).trim());
        if (value) {
          values.push(value);
        }
        cursor += 1;
      }

      meta[target] = values;
    }
  }

  return { body, meta };
}
