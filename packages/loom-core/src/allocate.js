/**
 * 预算驱动的取回：不是「取 top-k」，而是「在预算内取多少」。
 * 三级降级：正文 → 标题 → 指针。低于 minScore 直接不占位。
 */

import { chars4Counter } from './contracts.js';

/**
 * @param {{candidates:{claim:any, score:number}[], budget:number, counter?:import('./contracts.js').TokenCounter, minScore?:number}} input
 */
export function allocate({ candidates, budget, counter = chars4Counter, minScore = 0.01 }) {
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const items = [];
  const pointers = [];
  let used = 0;

  for (const cand of sorted) {
    if (cand.score < minScore) continue;
    const { claim } = cand;
    const fullCost = counter.count(claim.aiw ?? '');
    const titleCost = counter.count(claim.title ?? '');

    if (used + fullCost <= budget) {
      used += fullCost;
      items.push({
        claimId: claim.id,
        text: claim.aiw,
        level: 'full',
        score: cand.score,
        tokens: fullCost,
      });
      continue;
    }
    if (used + titleCost <= budget) {
      used += titleCost;
      items.push({
        claimId: claim.id,
        text: claim.title,
        level: 'title',
        score: cand.score,
        tokens: titleCost,
      });
      continue;
    }
    // 装不下正文也装不下标题：降级成指针（不占 token）
    pointers.push({ claimId: claim.id, title: claim.title, score: cand.score });
  }

  return { items, pointers, usedTokens: used, budget, counter: counter.name };
}
