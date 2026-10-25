/**
 * must_keep 前移：先定"必须保住什么"，再让生成器照着写。
 *
 * 顺序变了，成本差一个数量级：
 *   旧：生成 → 闸门审判 → 不通过就重跑
 *   新：约束 → 生成 → 校验（几乎总能过）
 */

import { ruleTerms, factPresent } from './aiw.js';

/**
 * 从原文构造简报。模型给的事实与规则给的事实取并集——
 * 规则那条地板永远保留，因为它不可能被生成端影响。
 *
 * @param {string} original
 * @param {{modelTerms?: string[], maxTerms?: number}} [opts]
 * @returns {{original: string, mustKeep: {term:string, from:'rule'|'model'}[], instruction: string}}
 */
export function brief(original, opts = {}) {
  const { modelTerms = [], maxTerms = 8 } = opts;
  const terms = [];
  const seen = new Set();

  for (const t of modelTerms) {
    const k = t.trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    terms.push({ term: k, from: 'model' });
  }
  for (const { term } of ruleTerms(original, { max: maxTerms })) {
    if (seen.has(term)) continue;
    seen.add(term);
    terms.push({ term, from: 'rule' });
  }

  return {
    original,
    mustKeep: terms.slice(0, maxTerms),
    instruction: buildInstruction(terms.slice(0, maxTerms), original),
  };
}

function buildInstruction(terms, original) {
  const list = terms.map((t) => t.term).join(' / ');
  const cap = Math.max(30, Math.ceil((original?.length ?? 120) * 0.45));
  return [
    '把下面这段原文压成一行 AI文。',
    '',
    `必须原样保留这些词（它们只是校验清单，不要在输出里给它们加引号、书名号或任何标记）：${list || '（无）'}`,
    '· 标识符要连标点一起保留：.env.local 开头那个点、path.join 中间的点、X-Tenant-Id 的连字符都属于它',
    '· 否定、数量、条件、因果箭头不能删',
    '· 删掉的只能是不承载信息的虚词',
    '',
    `长度上限：${cap} 个字符。超了就等于没压缩。`,
    '一行一断言，最多一个「。」并在末尾。不要写 @时间 / #来源 / 置信标。只输出这一行。',
  ].join('\n');
}

/** 校验草稿是否守住了简报里的事实（生成后立刻跑，不用等闸门） */
export function checkDraft(aiw, b) {
  const missing = b.mustKeep.filter((t) => !factPresent(aiw, t.term)).map((t) => t.term);
  return { ok: missing.length === 0, missing };
}

const SYS =
  '你是记忆压缩器。把一段对话原文压成一行 AI文：只保留能验证的事实与因果，' +
  '删掉不承载信息的虚词。不要解释，不要编号，不要加时间/来源/置信等标记。';

/**
 * 生成用的 messages。约束在**生成之前**给出，这是 must_keep 前移的落地。
 * @param {ReturnType<typeof brief>} b
 * @param {{feedback?: string[]}} [opts] 重试时把缺的事实回喂
 */
export function generationMessages(b, opts = {}) {
  const { feedback = [] } = opts;
  const retry = feedback.length
    ? `\n\n上一版漏了这些事实：${feedback.map((f) => `「${f}」`).join('、')}。只补这些，不要重写别的。`
    : '';
  return [
    { role: 'system', content: SYS },
    { role: 'user', content: `${b.instruction}\n\n原文：\n${b.original}${retry}` },
  ];
}
