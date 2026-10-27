/**
 * 内存版 Ledger —— W1 只用来验证契约与闸门，不落盘。
 * 落盘版（SQLite + FTS5 + epoch）在 W2。
 */

/** @typedef {import('./contracts.js').Claim} Claim */

export class MemoryLedger {
  constructor() {
    /** @type {Map<string, Claim>} */
    this.claims = new Map();
    this.log = [];
  }

  /** 幂等写入：同一 id 重复写入不会产生两条 */
  put(claim) {
    if (!claim?.id) throw new Error('claim.id is required');
    if (this.claims.has(claim.id)) return this.claims.get(claim.id);
    this.claims.set(claim.id, {
      ...claim,
      useCount: claim.useCount ?? 0,
      cold: claim.cold ?? false,
    });
    return this.claims.get(claim.id);
  }

  get(id) {
    return this.claims.get(id) ?? null;
  }

  /** 只返回有效的（未失效、未过期） */
  active(kind) {
    return [...this.claims.values()].filter((c) => !c.validTo && (!kind || c.kind === kind));
  }

  /** 冲突不覆盖：旧条目失效，指向新条目，并记录理由 */
  supersede(oldId, newId, reason) {
    const old = this.claims.get(oldId);
    if (!old) throw new Error(`unknown claim ${oldId}`);
    old.validTo = Date.now();
    old.supersededBy = newId;
    this.log.push({ at: Date.now(), oldId, newId, reason });
    return old;
  }

  /** 结算写回 */
  touch(id, patch) {
    const c = this.claims.get(id);
    if (!c) return null;
    Object.assign(c, patch);
    return c;
  }

  /** 朴素检索：W1 用子串，W2 换 FTS5 bigram */
  search(query) {
    const q = String(query ?? '').trim();
    if (!q) return [];
    const terms = q.split(/\s+/).filter(Boolean);
    return [...this.claims.values()]
      .filter((c) => !c.validTo)
      .map((c) => {
        const hay = `${c.title} ${c.aiw} ${c.body}`.toLowerCase();
        const hits = terms.filter((t) => hay.includes(t.toLowerCase())).length;
        return { claim: c, score: hits / terms.length };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score);
  }
}
