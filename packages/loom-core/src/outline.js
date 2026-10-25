/**
 * 第三问：取多少？——先给目录，再给条目。
 *
 * 模型看得见"某一类下有几条"，再决定展开哪一支；
 * 而不是一次性把 30 条正文塞进去。
 */

import { chars4Counter } from './contracts.js';

const KIND_LABEL = {
  fact: '事实', pref: '偏好', rule: '红线', proc: '流程',
  relation: '关系', decision: '决策', open: '未决', opinion: '观点',
};

/**
 * @param {{id:string, kind:string, title:string, aiw:string}[]} claims
 * @param {{budget?:number, counter?:import('./contracts.js').TokenCounter, maxNodes?:number}} [opts]
 * @returns {{nodes:{id:string,title:string,kind:string,claims:number,tokens:{self:number,subtree:number}}[], totalClaims:number, usedTokens:number}}
 */
export function buildOutline(claims, opts = {}) {
  const { budget = 120, counter = chars4Counter, maxNodes = 8 } = opts;
  const groups = new Map();
  for (const c of claims) {
    if (!groups.has(c.kind)) groups.set(c.kind, []);
    groups.get(c.kind).push(c);
  }

  const nodes = [...groups.entries()]
    .map(([kind, list]) => {
      const title = `${KIND_LABEL[kind] ?? kind}（${list.length}）`;
      const subtree = list.reduce((s, c) => s + counter.count(c.title || ''), 0);
      return { id: kind, kind, title, claims: list.length, tokens: { self: counter.count(title), subtree } };
    })
    .sort((a, b) => b.claims - a.claims)
    .slice(0, maxNodes);

  // 按预算截断：目录本身也占 token
  const kept = [];
  let used = 0;
  for (const n of nodes) {
    if (used + n.tokens.self > budget) break;
    used += n.tokens.self;
    kept.push(n);
  }

  return { nodes: kept, totalClaims: claims.length, usedTokens: used, budget, counter: counter.name };
}
