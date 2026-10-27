/**
 * Decay scheduler：遗忘的执行者。
 *
 * 三档降级，全部可逆：
 *   score ≥ 0.30 keep        —— 不动
 *   score ≥ 0.15 summarize   —— 正文换摘要（这里只标 cold，正文仍留）
 *   score ≥ 0.05 pointerize  —— 只留指针
 *   score < 0.05 archive     —— 移出热表
 *
 * 关键：**事实与规则不衰减**。规则不会因为三个月没用就失效，
 * 事件才会。一刀切衰减会把制度性记忆先冲掉。
 */

const DAY = 86_400_000;

/** 半衰期（天）：Infinity = 不衰减 */
export const HALF_LIFE = {
  rule: Infinity,
  pref: Infinity,
  decision: 365,
  fact: 180,
  relation: 120,
  proc: 90,
  opinion: 60,
  open: 30,
};

export const THRESHOLDS = { summarize: 0.3, pointerize: 0.15, archive: 0.05 };

const clamp01 = (x) => Math.min(1, Math.max(0, x));

/**
 * @param {{kind:string, validFrom?:number, lastUsedAt?:number, useCount?:number, stale?:boolean}} claim
 * @param {{now?:number, stalePenalty?:number}} [opts]
 */
export function decayScore(claim, opts = {}) {
  const { now = Date.now(), stalePenalty = 0.5 } = opts;
  const halfLife = HALF_LIFE[claim.kind] ?? 120;

  if (!Number.isFinite(halfLife)) {
    return { score: 1, halfLife: null, days: 0, boosted: 1 };
  }

  const base = claim.lastUsedAt ?? claim.validFrom ?? now;
  const days = Math.max(0, (now - base) / DAY);
  const decayed = 0.5 ** (days / halfLife);

  // 用进废退：用过 3 次 ≈ ×1.55，用过 10 次 ≈ ×2.2
  const boosted = 1 + Math.log1p(claim.useCount ?? 0) / 2;

  let score = decayed * boosted;
  if (claim.stale) score *= stalePenalty;

  return { score: clamp01(score), halfLife, days, boosted };
}

/** @returns {'keep'|'summarize'|'pointerize'|'archive'} */
export function decide(score) {
  if (score >= THRESHOLDS.summarize) return 'keep';
  if (score >= THRESHOLDS.pointerize) return 'summarize';
  if (score >= THRESHOLDS.archive) return 'pointerize';
  return 'archive';
}

/**
 * 扫一遍账本，给出（或执行）降级建议。
 * @param {{active:Function, setCold?:Function, touch?:Function}} ledger
 * @param {{now?:number, apply?:boolean, kinds?:string[]}} [opts]
 */
export function sweep(ledger, opts = {}) {
  const { now = Date.now(), apply = false, kinds } = opts;
  const rows = [];

  for (const claim of ledger.active()) {
    if (kinds && !kinds.includes(claim.kind)) continue;
    const { score, days, halfLife } = decayScore(claim, { now });
    const action = decide(score);
    rows.push({
      id: claim.id,
      kind: claim.kind,
      title: claim.title,
      score: Number(score.toFixed(3)),
      days: Math.round(days),
      halfLife,
      action,
    });
    if (apply && action !== 'keep') {
      // 只标 cold，不删除；正文与来源都还在
      ledger.touch(claim.id, { cold: true, salience: Number(score.toFixed(3)) });
    }
  }

  const counts = rows.reduce((m, r) => ((m[r.action] = (m[r.action] ?? 0) + 1), m), {});
  return { rows, counts, applied: apply };
}
