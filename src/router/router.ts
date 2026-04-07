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

export interface RouteOptions {
  workspaceId?: string;
}

interface ScoredRouteResult extends RouteResult {
  hasTaskSignal: boolean;
}

const MAX_RECOMMENDATIONS = 8;
const MIN_CONFIDENCE = 15;
const GENERIC_NAMES = new Set(["filesystem", "grep", "web-search"]);

/** 将文本归一化后分词：英文按空白切分，中文按单字+双字切分 */
function tokenize(text: string): string[] {
  const normalized = text
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, " ")
    .trim();

  if (!normalized) return [];

  const tokens: string[] = [];
  const segments = normalized.split(/\s+/).filter(Boolean);

  for (const segment of segments) {
    if (/^[\u4e00-\u9fff]+$/.test(segment)) {
      tokens.push(segment);
      for (const char of segment) {
        tokens.push(char);
      }
      if (segment.length >= 2) {
        for (let i = 0; i < segment.length - 1; i++) {
          tokens.push(segment.slice(i, i + 2));
        }
      }
      continue;
    }

    tokens.push(segment);
  }

  return tokens;
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
function scoreSkill(task: string, skill: SkillRecord): ScoredRouteResult {
  const taskTokens = tokenize(task);
  const taskTokenSet = new Set(taskTokens);
  const normalizedTaskText = taskTokens.join(" ");

  const skillNameTokens = tokenize(skill.name);
  const normalizedSkillName = skillNameTokens.join(" ");

  let signalScore = 0;
  const reasons: string[] = [];
  let hasTaskSignal = false;

  // 名称完全匹配 +40
  if (normalizedSkillName.length > 0 && (normalizedTaskText === normalizedSkillName || taskTokenSet.has(normalizedSkillName))) {
    signalScore += 40;
    hasTaskSignal = true;
    reasons.push("名称完全匹配(+40)");
  } else if (
    // 名称部分匹配 +20
    normalizedSkillName.length > 0 &&
    (normalizedTaskText.includes(normalizedSkillName) || skillNameTokens.some(token => taskTokenSet.has(token)))
  ) {
    signalScore += 20;
    hasTaskSignal = true;
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
    signalScore += descriptionScore;
    hasTaskSignal = true;
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
    signalScore += triggerScore;
    hasTaskSignal = true;
    reasons.push(`触发词命中${triggerHits}个(+${triggerScore})`);
  }

  // 标签匹配：每个 +3，最多 +15
  const tags = skill.tags ?? [];
  let tagHits = 0;
  for (const tag of tags) {
    const tagTokens = tokenize(tag);
    if (tagTokens.some(token => taskTokenSet.has(token))) tagHits++;
  }
  if (tagHits > 0) {
    const tagScore = Math.min(15, tagHits * 3);
    signalScore += tagScore;
    hasTaskSignal = true;
    reasons.push(`标签命中${tagHits}个(+${tagScore})`);
  }

  const utilityBonus = Math.max(0, Math.min(20, skill.utilityScore * 0.2));
  const score = signalScore + utilityBonus;
  reasons.push(`效用分加成(+${Math.round(utilityBonus)})`);

  const confidence = clampScore(score);
  return {
    skill,
    confidence,
    matchReason: reasons.join("；"),
    hasTaskSignal,
  };
}

export function route(task: string, skills: SkillRecord[], options?: RouteOptions): RouteResponse {
  const taskTokens = tokenize(task);
  const taskTokenSet = new Set(taskTokens);

  // Phase 1: 召回
  const ranked = skills
    .map(skill => scoreSkill(task, skill))
    .sort((a, b) => {
      if (a.hasTaskSignal !== b.hasTaskSignal) {
        return Number(b.hasTaskSignal) - Number(a.hasTaskSignal);
      }
      if (b.confidence !== a.confidence) {
        return b.confidence - a.confidence;
      }
      return b.skill.utilityScore - a.skill.utilityScore;
    })
    .slice(0, MAX_RECOMMENDATIONS);

  // Phase 2: 重排
  const reranked = ranked.map(item => {
    let bonus = 0;
    const rerankReasons: string[] = [];

    // 同工作区加分: +15
    if (options?.workspaceId && item.skill.workspaceId === options.workspaceId) {
      bonus += 15;
      rerankReasons.push("同工作区匹配(+15)");
    }

    // 反触发词惩罚: 每个 -20，最多 -60
    const antiTriggers = item.skill.antiTriggers ?? [];
    let antiHits = 0;
    for (const anti of antiTriggers) {
      const antiTokens = tokenize(anti);
      if (antiTokens.some(token => taskTokenSet.has(token))) antiHits++;
    }
    if (antiHits > 0) {
      const penalty = Math.min(60, antiHits * 20);
      bonus -= penalty;
      rerankReasons.push(`反触发词命中${antiHits}个(-${penalty})`);
    }

    // 通用内置技能降权: -10
    if (GENERIC_NAMES.has(item.skill.name) && item.skill.builtin) {
      bonus -= 10;
      rerankReasons.push("通用内置技能降权(-10)");
    }

    // 多步骤编排技能加成: +8
    if (item.skill.calls.length > 0) {
      bonus += 8;
      rerankReasons.push("多步骤编排技能加成(+8)");
    }

    // 同工作区近期成功加分: +5
    if (options?.workspaceId && item.skill.workspaceId === options.workspaceId) {
      const recentHistory = item.skill.history.slice(-5);
      const recentSuccesses = recentHistory.filter(h => h.success).length;
      if (recentSuccesses >= 3) {
        bonus += 5;
        rerankReasons.push(`同工作区近期成功(${recentSuccesses}/5)(+5)`);
      }
    }

    return {
      ...item,
      confidence: clampScore(item.confidence + bonus),
      matchReason: item.matchReason + (rerankReasons.length > 0 ? "；" + rerankReasons.join("；") : ""),
    };
  });

  // 重排后重新排序
  reranked.sort((a, b) => {
    if (a.hasTaskSignal !== b.hasTaskSignal) return Number(b.hasTaskSignal) - Number(a.hasTaskSignal);
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return b.skill.utilityScore - a.skill.utilityScore;
  });

  const recommendations = reranked
    .filter(item => item.hasTaskSignal && item.confidence >= MIN_CONFIDENCE)
    .map(({ hasTaskSignal: _hasTaskSignal, ...item }) => item);

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
    .slice(0, 12);

  const skillList = ranked
    .map(skill => {
      const description = skill.description ? `: ${skill.description}` : "";
      return `  - ${skill.name}(${Math.round(skill.utilityScore)}分)${description}`;
    })
    .join("\n");

  return [
    `技能库: ${total} 个技能 (${builtinCount} 内置)`,
    `可用:\n${skillList || "暂无"}`,
    "",
    "重要行为规则（每次都必须遵守）：",
    "1. 接到任务时，先查看上方技能库摘要。如果有匹配的技能直接使用；如果不确定，调用 pupu_route 获取推荐",
    "2. 完成任务后（无论成功失败），必须调用 pupu_learn 上报任务上下文进行学习",
    "   - pupu_learn 会自动判断是否需要创建新技能或优化已有技能",
    "   - 这是被动学习机制的核心，不需要用户主动要求",
    "3. 如果 pupu_learn 建议创建技能，请立即用 pupu_write 保存",
  ].join("\n");
}
