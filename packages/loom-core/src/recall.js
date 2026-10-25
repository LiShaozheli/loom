/**
 * 三问合成一条召回管道：
 *   要不要查 → 查哪类 → 取多少
 *
 * 候选池优先用账本的 FTS（bigram + bm25），路由只负责**重排**；
 * 没有 FTS 时退化为在传入的 claims 上做词面打分（测试与纯函数场景）。
 */

import { shouldRecall } from './admission.js';
import { routeQuery, scoreClaim } from './router.js';
import { buildOutline } from './outline.js';
import { allocate } from './allocate.js';
import { chars4Counter } from './contracts.js';

/**
 * @param {{
 *   query: string,
 *   claims?: any[],
 *   search?: (q: string) => any[],
 *   ctx?: object,
 *   budget?: number,
 *   outlineBudget?: number,
 *   counter?: import('./contracts.js').TokenCounter,
 *   minScore?: number,
 * }} input
 */
export function recall(input) {
  const {
    query, claims = [], search,
    ctx = {},
    budget = 400, outlineBudget = 120,
    counter = chars4Counter, minScore = 0.05,
  } = input;

  const admission = shouldRecall(query, ctx);
  if (!admission.recall) {
    return { skipped: true, admission, items: [], pointers: [], usedTokens: 0, outline: null, route: null };
  }

  const route = routeQuery(query);
  const pool = search ? search(query) : claims;

  const scored = pool
    .filter((c) => !c.validTo)
    .map((claim) => ({ claim, score: scoreClaim(claim, route) }))
    .filter((x) => x.score >= minScore)
    .sort((a, b) => b.score - a.score);

  const outline = buildOutline(scored.map((x) => x.claim), { budget: outlineBudget, counter });
  const alloc = allocate({ candidates: scored, budget, counter, minScore });

  return {
    skipped: false,
    admission,
    route,
    outline,
    items: alloc.items,
    pointers: alloc.pointers,
    usedTokens: alloc.usedTokens,
  };
}
