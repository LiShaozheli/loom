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

/**
 * @param {string} query
 * @param {{now?:number}} [opts]
 */
export function routeQuery(query, opts = {}) {
  const q = String(query ?? '');
  const hits = KIND_HINTS.filter(([, re]) => /** @type {RegExp} */ (re).test(q)).map(([k]) => k);
  const kinds = hits.length ? [...new Set(hits)] : ['fact'];

  const entities = identifiers(q);

  let since;
  const now = opts.now ?? Date.now();
  for (const [re, span] of TIME_HINT) {
    if (/** @type {RegExp} */ (re).test(q)) {
      since = now - Number(span);
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
  // 打分必须看**被索引过的字段**。之前只拼 aiw + title，而 FTS 索引里还有 body（原文），
  // 于是「问 Python 版本」这类题：FTS 靠原文找到了，这里用压缩文本一字不差地打 0 分，
  // 整条被 minScore 滤掉。实测这一处丢了 12.8 个百分点的 recall@1。
  //
  // 但把原文整个塞进词面分又会把 abstain 判空率打下来（64% → 41%）：原文字长、
  // 与任何问题的 bigram 重合都更多，于是"没有答案"的题也能蹭到分。
  // 所以拆开用：**词面重合看压缩文本**（短、稠密、噪声低），
  // **实体命中看原文**（专名与标识符是精确匹配，长的原文只会提高召回，不会提高误召）。
  const core = `${claim.aiw ?? ''} ${claim.title ?? ''}`;
  const full = `${core} ${claim.body ?? ''}`;
  const lexCore = cosineBigram(route.query ?? '', core);
  const entHits = route.entities.length
    ? route.entities.filter((e) => full.toLowerCase().includes(e.toLowerCase())).length /
      route.entities.length
    : 0;

  const uni = unigramScore(route.query ?? '', core);

  //「该不该答」与「排第几」是两个判断，不能用一个分数兼着：
  //   该不该答——压缩文本里要真有重合。用余弦而不是命中率：命中率按问题切词数做分母，
  //             原文越长越容易蹭到，实测判空率会被打下来（64% → 41%）。
  //             余弦在分母里带上了文档长度，长原文自动被折价。
  //   排第几——  可以看原文。FTS 本来就是靠原文找到的，排序不用它等于白找。
  if (lexCore === 0 && entHits === 0 && uni === 0) return 0;

  const lex = Math.max(lexCore, cosineBigram(route.query ?? '', full));

  let score = 0.5 * lex + entHits * 0.5 + 0.15 * uni;
  if (route.kinds.includes(claim.kind)) score += 0.2;
  if (route.since && claim.validFrom >= route.since) score += 0.1;
  return score;
}

/** bigram 余弦：分母带文档长度，长文本不会靠"蹭到得多"取胜 */
function cosineBigram(query, text) {
  const q = contentBigrams(query).split(' ').filter(Boolean);
  if (!q.length) return 0;
  const t = bigrams(String(text)).split(' ').filter(Boolean);
  if (!t.length) return 0;
  const ts = new Set(t);
  let hit = 0;
  for (const g of q) if (ts.has(g)) hit += 1;
  return hit / Math.sqrt(q.length * new Set(t).size);
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
