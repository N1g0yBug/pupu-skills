import type { SkillRecord } from "../memory/store.js";

export interface RouteResult {
  skill: SkillRecord;
  confidence: number;
  matchReason: string;
}

export interface RouteResponse {
  task: string;
  recommendations: RouteResult[];
  summary: string;
}

const MAX_RECOMMENDATIONS = 5;
const MIN_CONFIDENCE = 15;

/** 将文本归一化后分词（小写、去标点、按空白切分） */
function tokenize(text: string): string[] {
  const normalized = text
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, " ")
    .trim();

  if (!normalized) return [];
  return normalized.split(/\s+/).filter(Boolean);
}

/** 提取技能触发词（兼容并行改造期间 triggers 可能未就绪） */
function getSkillTriggers(skill: SkillRecord): string[] {
  const maybeWithTriggers = skill as SkillRecord & { triggers?: string[] };
  if (!Array.isArray(maybeWithTriggers.triggers)) return [];
  return maybeWithTriggers.triggers.filter(trigger => typeof trigger === "string" && trigger.trim().length > 0);
}

/** 将分数限制在 0~100 */
function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

/** 判断短语是否匹配任务文本（完整短语或词集合包含） */
function isPhraseMatched(phrase: string, normalizedTaskText: string, taskTokenSet: Set<string>): boolean {
  const phraseTokens = tokenize(phrase);
  if (phraseTokens.length === 0) return false;

  const normalizedPhrase = phraseTokens.join(" ");
  if (normalizedTaskText.includes(normalizedPhrase)) return true;

  return phraseTokens.every(token => taskTokenSet.has(token));
}

/** 对单个技能计算匹配结果 */
function scoreSkill(task: string, skill: SkillRecord): RouteResult {
  const taskTokens = tokenize(task);
  const taskTokenSet = new Set(taskTokens);
  const normalizedTaskText = taskTokens.join(" ");

  const skillNameTokens = tokenize(skill.name);
  const normalizedSkillName = skillNameTokens.join(" ");

  let score = 0;
  const reasons: string[] = [];

  // 名称完全匹配 +40
  if (normalizedSkillName.length > 0 && (normalizedTaskText === normalizedSkillName || taskTokenSet.has(normalizedSkillName))) {
    score += 40;
    reasons.push("名称完全匹配(+40)");
  } else if (
    // 名称部分匹配 +20
    normalizedSkillName.length > 0 &&
    (normalizedTaskText.includes(normalizedSkillName) || skillNameTokens.some(token => taskTokenSet.has(token)))
  ) {
    score += 20;
    reasons.push("名称部分匹配(+20)");
  }

  // 描述关键词匹配：每词 +5，最多 +30
  const descriptionTokens = tokenize(skill.description);
  let descriptionHits = 0;
  for (const token of descriptionTokens) {
    if (taskTokenSet.has(token)) descriptionHits++;
  }
  if (descriptionHits > 0) {
    const descriptionScore = Math.min(30, descriptionHits * 5);
    score += descriptionScore;
    reasons.push(`描述关键词命中${descriptionHits}个(+${descriptionScore})`);
  }

  // 触发词匹配：每个 +10，最多 +40
  const triggers = getSkillTriggers(skill);
  let triggerHits = 0;
  for (const trigger of triggers) {
    if (isPhraseMatched(trigger, normalizedTaskText, taskTokenSet)) {
      triggerHits++;
    }
  }
  if (triggerHits > 0) {
    const triggerScore = Math.min(40, triggerHits * 10);
    score += triggerScore;
    reasons.push(`触发词命中${triggerHits}个(+${triggerScore})`);
  }

  // 效用分权重加成：utilityScore * 0.2
  const utilityBonus = Math.max(0, Math.min(20, skill.utilityScore * 0.2));
  score += utilityBonus;
  reasons.push(`效用分加成(+${Math.round(utilityBonus)})`);

  const confidence = clampScore(score);
  return {
    skill,
    confidence,
    matchReason: reasons.join("；"),
  };
}

export function route(task: string, skills: SkillRecord[]): RouteResponse {
  const ranked = skills
    .map(skill => scoreSkill(task, skill))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, MAX_RECOMMENDATIONS);

  const recommendations = ranked.filter(item => item.confidence >= MIN_CONFIDENCE);

  if (recommendations.length === 0) {
    return {
      task,
      recommendations: [],
      summary: "未找到置信度≥15分的技能，建议创建新技能并补充触发词。",
    };
  }

  const top = recommendations[0];
  return {
    task,
    recommendations,
    summary: `为任务推荐了 ${recommendations.length} 个技能，首选 ${top.skill.name}（${top.confidence}分）。`,
  };
}

export function buildSkillSummary(skills: SkillRecord[]): string {
  const total = skills.length;
  const builtinCount = skills.filter(skill => skill.builtin).length;

  const ranked = [...skills]
    .sort((a, b) => b.utilityScore - a.utilityScore)
    .slice(0, 8)
    .map(skill => `${skill.name}(${Math.round(skill.utilityScore)}分)`)
    .join(" | ");

  return [
    `📊 技能库: ${total} 个技能 (${builtinCount} 内置)`,
    `📋 可用: ${ranked || "暂无"}`,
    "💡 提示: 遇到新任务时，先调用 pupu_route 获取推荐技能",
  ].join("\n");
}
