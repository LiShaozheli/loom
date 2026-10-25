/**
 * 写入闸门：格式（正文）→ 元数据 → 保真 → 编造。
 * 判定只有三档：ACCEPT / REVISE / REJECT。
 * 默认宁可拒绝：拒了还能用原文，放进去就只能等它出错。
 */

import { lintBody, factPresent, identifiers, normalize, ruleTerms, ABBREV } from './aiw.js';

/**
 * @param {{aiw:string, confidence?:string, source?:{eventId?:string}, tier?:string}} draft
 * @param {{original?:string, mustKeep?:string[], minRecall?:number, lintTier?:string}} [opts]
 * @returns {import('./contracts.js').GateResult}
 */
export function gate(draft, opts = {}) {
  const { original, mustKeep, minRecall = 1 } = opts;
  const issues = [];
  const tier = draft.tier ?? 'full';

  // 1) 正文格式
  const bodyIssues = lintBody(draft.aiw, { tier });
  issues.push(...bodyIssues);

  // 2) 元数据（尾部不进正文，但必须存在）
  if (!draft.source?.eventId) issues.push({ level: 'ERROR', code: 'M1', msg: '缺 source.eventId，无法回源' });
  if (!draft.confidence) issues.push({ level: 'ERROR', code: 'M2', msg: '缺 confidence（原 ! ? ~）' });

  // 3) 保真：人工 must_keep 优先，否则用规则版兜底
  let terms = Array.isArray(mustKeep) && mustKeep.length ? mustKeep.slice() : null;
  let from = 'model';
  if (!terms && original) {
    terms = ruleTerms(original).map((t) => t.term);
    from = 'rule';
  }
  let recall = null;
  let missing = [];
  if (original && terms && terms.length) {
    const kept = terms.filter((t) => factPresent(draft.aiw, t));
    recall = kept.length / terms.length;
    missing = terms.filter((t) => !kept.includes(t));
  }

  // 4) 编造：正文里出现原文没有的标识符（缩写按白名单比对全称）
  const fabricated = original
    ? identifiers(draft.aiw).filter((id) => {
        const hay = normalize(original);
        if (hay.includes(normalize(id))) return false;
        return !(ABBREV[id] ?? []).some((full) => hay.includes(normalize(full)));
      })
    : [];

  // 判定
  const errors = issues.filter((i) => i.level === 'ERROR');
  const warns = issues.filter((i) => i.level === 'WARN');
  let verdict = 'ACCEPT';

  if (errors.length) verdict = 'REJECT';
  else if (recall !== null && recall < minRecall - 1e-9) verdict = 'REJECT';
  else if (fabricated.length || warns.length > 2) verdict = 'REVISE';

  return {
    verdict,
    issues,
    mustKeep: (terms ?? []).map((t) => ({ term: t, from })),
    recall,
    missing,
    fabricated,
  };
}
