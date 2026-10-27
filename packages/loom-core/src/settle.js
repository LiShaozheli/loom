/**
 * Settle：记忆用完之后结账。
 *
 * 注入的证据有没有被用到？用了之后对不对？把结果记回权重——
 * 这是唯一一条能让记忆"越用越准"的回路，也是所有插件都缺的那一环。
 *
 * 归因是可插拔策略：引用协议最准，词面重合最便宜，两者可叠加。
 */

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/**
 * 引用协议：答案里出现 `[id]` 即认为用了这条。
 * @param {string} answer
 * @param {{claimId:string}[]} items
 */
export function attributeCitation(answer, items) {
  const text = String(answer ?? '');
  const cited = new Set();
  // 允许两种写法：[#abcd1234]（推荐）与 [abcd1234]
  for (const m of text.matchAll(/\[#?([A-Za-z0-9_-]{4,})\]/g)) cited.add(m[1]);
  // 允许只引前几位：只要是被引 token 的前缀匹配（≥4 位），就算这条被用了
  return items
    .filter((it) => [...cited].some((c) => it.claimId.startsWith(c)))
    .map((it) => it.claimId);
}

const gramsOf = (s) => {
  const chars = [...String(s ?? '').replace(/[^\p{Script=Han}A-Za-z0-9]/gu, '')];
  const out = new Set();
  for (let i = 0; i < chars.length - 1; i++) out.add(chars[i] + chars[i + 1]);
  return out;
};

/**
 * 词面重合：答案与证据共享的 bigram 比例够高就算用了。
 * 便宜、无需协议，但会把"复述了同一段背景"误判成用了。
 */
export function attributeOverlap(answer, items, { minOverlap = 0.25 } = {}) {
  const a = gramsOf(answer);
  if (!a.size) return [];
  const used = [];
  for (const it of items) {
    const t = gramsOf(it.text ?? '');
    if (!t.size) continue;
    let hit = 0;
    for (const g of t) if (a.has(g)) hit++;
    // 回答通常很短：按两者较小的一边归一，否则短答永远达不到阈值
    if (hit / Math.min(a.size, t.size) >= minOverlap) used.push(it.claimId);
  }
  return used;
}

/**
 * 结算一条 claim 的权重变化。
 * @param {{salience:number, useCount:number}} claim
 * @param {{used:boolean, correct:boolean|null, now?:number}} outcome
 */
export function nextWeight(claim, outcome) {
  const { used, correct, now = Date.now() } = outcome;
  let salience = claim.salience ?? 1;
  let useCount = claim.useCount ?? 0;

  if (used) {
    useCount += 1;
    if (correct === false)
      salience *= 0.85; // 用了但错了：这条在误导
    else salience *= 1.15; // 用了且对（或未知）：加固
  } else {
    salience *= 0.98; // 没被用：轻微衰减
  }

  return {
    salience: clamp(salience, 0.05, 3),
    useCount,
    lastUsedAt: used ? now : claim.lastUsedAt,
  };
}

/**
 * 一轮结算：归因 → 改权重 → 写回账本。
 * @param {{answer:string, items:{claimId:string,text:string}[], ledger:{get:Function,touch:Function}, strategy?:string, correct?:boolean|null, now?:number}} input
 */
export function settleTurn(input) {
  const {
    answer,
    items,
    ledger,
    strategy = 'citation+overlap',
    correct = null,
    now = Date.now(),
  } = input;

  const cited = strategy.includes('citation') ? attributeCitation(answer, items) : [];
  const overlapped = strategy.includes('overlap') ? attributeOverlap(answer, items) : [];
  const usedIds = [...new Set([...cited, ...overlapped])];

  const updated = [];
  for (const it of items) {
    const claim = ledger.get(it.claimId);
    if (!claim) continue;
    const used = usedIds.includes(it.claimId);
    const next = nextWeight(claim, { used, correct, now });
    ledger.touch(it.claimId, next);
    updated.push({ claimId: it.claimId, used, ...next });
  }

  return { used: usedIds, updated, attribution: { cited, overlapped } };
}
