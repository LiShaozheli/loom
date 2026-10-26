/**
 * 第二问：查哪类？
 *
 * 先按意图选池子（偏好问题去 pref 池），再用实体和词面重合度排序。
 * 只用类型不给词面分，会遇到"问的是环境，但条目 kind 叫 env"这种漏召回。
 */

import { identifiers, bigrams, contentBigrams, unigrams } from './aiw.js';

const KIND_HINTS = [
  ['pref', /喜欢|偏好|习惯|不喜欢|倾向|希望/],
  ['rule', /必须|禁止|不能|不要|红线|规矩|务必/],
  ['proc', /步骤|流程|怎么|如何|先.*再|顺序/],
  ['relation', /谁|负责|对接|团队|关系|负责人/],
  ['decision', /决定|定了|拍板|选型|采用/],
  ['open', /未定|待定|还没定|悬而未决/],
  ['fact', /版本|配置|端口|路径|地址|参数|错误|报错/],
];

const TIME_HINT = [
  [/上周|上个?星期/, 7 * 864e5],
  [/上个月/, 30 * 864e5],
  [/三个月|3 个月/, 90 * 864e5],
  [/半年/, 180 * 864e5],
];

const STOP = /是多少|是什么|什么|怎么|为什么|如何|是不是|能不能|有没有|吗|呢|的|了|[?？]/g;

/**
 * @param {string} query
 * @param {{now?:number}} [opts]
 */
export function routeQuery(query, opts = {}) {
  const q = String(query ?? '');
  const hits = KIND_HINTS.filter(([, re]) => re.test(q)).map(([k]) => k);
  const kinds = hits.length ? [...new Set(hits)] : ['fact'];

  const entities = identifiers(q);

  let since;
  const now = opts.now ?? Date.now();
  for (const [re, span] of TIME_HINT) {
    if (re.test(q)) {
      since = now - span;
      break;
    }
  }

  return {
    query: q,
    kinds,
    entities,
    since,
    reason: `kinds=${kinds.join('|')}${entities.length ? ` entities=${entities.join('|')}` : ''}${since ? ' +time' : ''}`,
  };
}

/** 词面重合度：去掉疑问词后再切 bigram，避免"是多少"把分母撑大 */
export function lexicalScore(query, text) {
  const q = new Set(contentBigrams(query).split(' ').filter(Boolean));
  if (!q.size) return 0;
  const t = new Set(bigrams(String(text)).split(' ').filter(Boolean));
  let hit = 0;
  for (const g of q) if (t.has(g)) hit++;
  return hit / q.size;
}

/**
 * 实体比类型更具体：命中 JWT 比"它属于 decision 类"更有说服力。
 * 词面分是底座——没有它，kind 名称与意图对不上时（env vs fact）会整条漏掉。
 */
export function scoreClaim(claim, route) {
  const text = `${claim.aiw ?? ''} ${claim.title ?? ''}`;
  const lex = lexicalScore(route.query ?? '', text);
  const entHits = route.entities.length
    ? route.entities.filter((e) => text.toLowerCase().includes(e.toLowerCase())).length / route.entities.length
    : 0;

  const uni = unigramScore(route.query ?? '', text);

  // 只「类型相同」不算相关：否则问一句 Kubernetes，所有 fact 条目都会被召回。
  if (lex === 0 && entHits === 0 && uni === 0) return 0;

  let score = 0.5 * lex + entHits * 0.5 + 0.15 * uni;
  if (route.kinds.includes(claim.kind)) score += 0.2;
  if (route.since && claim.validFrom >= route.since) score += 0.1;
  return score;
}

/** 单字重合度：bigram 全落空时的兜底信号，权重必须低于词面 */
function unigramScore(query, text) {
  const q = unigrams(query);
  if (!q.length) return 0;
  const t = new Set(unigrams(text));
  let hit = 0;
  for (const ch of q) if (t.has(ch)) hit++;
  return hit / q.length;
}
