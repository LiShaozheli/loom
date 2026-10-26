/**
 * L1 账本：SQLite + FTS5 bigram。
 *
 * 为什么不是默认分词器：unicode61 把「用户彻底怒了」当一个词，搜「彻底」命中 0；
 * trigram 要求 ≥3 字，「鉴权」这种 2 字词命中 0（都实测过）。
 * 所以额外存一列 bigram，查询时把 query 也转 bigram。
 */

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { bigrams, contentBigrams, unigrams } from './aiw.js';
export { bigrams };


const DDL = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS claim (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  aiw TEXT NOT NULL,
  bg TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  confidence TEXT NOT NULL DEFAULT 'medium',
  source_event TEXT,
  epoch_id TEXT NOT NULL,
  taint TEXT NOT NULL DEFAULT 'none',
  valid_from INTEGER NOT NULL,
  valid_to INTEGER,
  superseded_by TEXT,
  salience REAL NOT NULL DEFAULT 1,
  use_count INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER,
  cold INTEGER NOT NULL DEFAULT 0,
  session_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_claim_kind ON claim(kind, valid_to);
CREATE INDEX IF NOT EXISTS idx_claim_time ON claim(valid_from, valid_to);

CREATE VIRTUAL TABLE IF NOT EXISTS claim_fts USING fts5(
  aiw, bg, title, content='claim', content_rowid='rowid', tokenize='unicode61'
);

CREATE TABLE IF NOT EXISTS external_ref (
  claim_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  target TEXT NOT NULL,
  digest TEXT,
  checked_at INTEGER,
  status TEXT NOT NULL DEFAULT 'unknown',
  PRIMARY KEY (claim_id, kind, target)
);
CREATE INDEX IF NOT EXISTS idx_ext_status ON external_ref(status);

-- 关系边：记忆之间不再是一堆孤立的句子
CREATE TABLE IF NOT EXISTS edge (
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  type TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (from_id, to_id, type)
);
CREATE INDEX IF NOT EXISTS idx_edge_from ON edge(from_id);
CREATE INDEX IF NOT EXISTS idx_edge_to ON edge(to_id);

-- 项目文档：长文，不受 AI文 的短断言限制
CREATE TABLE IF NOT EXISTS doc (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  bg TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  cold INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_doc_time ON doc(updated_at);
CREATE TABLE IF NOT EXISTS doc_rev (
  doc_id TEXT NOT NULL,
  rev INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (doc_id, rev)
);

CREATE VIRTUAL TABLE IF NOT EXISTS doc_fts USING fts5(
  bg, title, tokenize='unicode61'
);
`;

export class SqliteLedger {
  constructor(file = ':memory:') {
    this.db = new DatabaseSync(file);
    this.db.exec(DDL);

    // 老库迁移：早期没有 session_id 列
    const hasSessionColumn = this.db
      .prepare("SELECT name FROM pragma_table_info('claim')")
      .all()
      .some((c) => c.name === 'session_id');
    if (!hasSessionColumn) {
      this.db.exec('ALTER TABLE claim ADD COLUMN session_id TEXT');
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_claim_session ON claim(session_id)');
  }

  close() {
    this.db.close();
  }

  put(claim) {
    const existing = this.get(claim.id);
    if (existing) return existing;

    // 原文也进索引：AI文 会压掉「报」「说」这类词，只索引压缩文本会漏掉自然问法
    const bg = bigrams(`${claim.aiw} ${claim.title} ${claim.body ?? ''}`);
    this.db
      .prepare(
        `INSERT INTO claim (id,kind,body,aiw,bg,title,confidence,source_event,epoch_id,taint,valid_from,salience,use_count,cold,session_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        claim.id,
        claim.kind,
        claim.body,
        claim.aiw,
        bg,
        claim.title,
        claim.confidence,
        claim.source?.eventId ?? null,
        claim.epochId,
        claim.taint ?? 'none',
        claim.validFrom,
        claim.salience ?? 1,
        claim.useCount ?? 0,
        claim.cold ? 1 : 0,
        claim.sessionId ?? null
      );
    const rowid = this.db.prepare('SELECT rowid FROM claim WHERE id = ?').get(claim.id).rowid;
    this.db.prepare('INSERT INTO claim_fts (rowid, aiw, bg, title) VALUES (?,?,?,?)').run(rowid, claim.aiw, bg, claim.title);
    return claim;
  }

  get(id) {
    const row = this.db.prepare('SELECT * FROM claim WHERE id = ?').get(id);
    return row ? this.#map(row) : null;
  }

  #map(row) {
    return {
      id: row.id,
      kind: row.kind,
      body: row.body,
      aiw: row.aiw,
      title: row.title,
      confidence: row.confidence,
      source: { eventId: row.source_event },
      epochId: row.epoch_id,
      taint: row.taint,
      validFrom: row.valid_from,
      validTo: row.valid_to ?? undefined,
      supersededBy: row.superseded_by ?? undefined,
      salience: row.salience,
      useCount: row.use_count,
      lastUsedAt: row.last_used_at ?? undefined,
      cold: !!row.cold,
      sessionId: row.session_id ?? null,
    };
  }

  /**
   * @param {string} [kind]
   * @param {{session?:string|null}} [opts] 传 session 时只返回「本会话 + 全局」的条目
   */
  active(kind, opts = {}) {
    const where = ['valid_to IS NULL'];
    const args = [];
    if (kind) {
      where.push('kind = ?');
      args.push(kind);
    }
    if (opts.session) {
      where.push('(session_id IS NULL OR session_id = ?)');
      args.push(opts.session);
    }
    const rows = this.db.prepare(`SELECT * FROM claim WHERE ${where.join(' AND ')}`).all(...args);
    return rows.map((r) => this.#map(r));
  }

  /** 冲突不覆盖：旧条目失效、指向新条目、理由进 supersede_log */
  supersede(oldId, newId, reason) {
    this.db
      .prepare('UPDATE claim SET valid_to = ?, superseded_by = ? WHERE id = ?')
      .run(Date.now(), newId, oldId);
    this.db.exec('CREATE TABLE IF NOT EXISTS supersede_log (at INTEGER, old_id TEXT, new_id TEXT, reason TEXT)');
    this.db.prepare('INSERT INTO supersede_log VALUES (?,?,?,?)').run(Date.now(), oldId, newId, reason);
    return this.get(oldId);
  }

  /** bigram 关键词检索：多词之间是 OR（任一命中都进候选），由 bm25 排序 */
  search(query, { limit = 10, kind, session } = {}) {
    const terms = contentBigrams(query).split(' ').filter(Boolean);
    if (!terms.length) return [];

    // FTS5 的裸空格是 AND：用「是多少」这种问句会一条都搜不到。
    // 所以显式写成 OR，让 bm25 按命中数排序。
    const expr = terms.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ');
    const match = `bg:(${expr}) OR title:(${expr}) OR aiw:(${expr})`;

    const sql = kind
      ? `SELECT c.* FROM claim_fts f JOIN claim c ON c.rowid = f.rowid
         WHERE claim_fts MATCH ? AND c.valid_to IS NULL AND c.kind = ?
         ORDER BY bm25(claim_fts) LIMIT ?`
      : `SELECT c.* FROM claim_fts f JOIN claim c ON c.rowid = f.rowid
         WHERE claim_fts MATCH ? AND c.valid_to IS NULL
         ORDER BY bm25(claim_fts) LIMIT ?`;
    const args = kind ? [match, kind, limit] : [match, limit];
    try {
      const rows = this.db.prepare(sql).all(...args);
      if (rows.length) {
        const mapped = rows.map((r) => this.#map(r));
        return session ? mapped.filter((c) => !c.sessionId || c.sessionId === session) : mapped;
      }

      // 零命中兜底：改用单字 OR。宁可多给几条让路由去排序，也不要直接空手。
      const uni = unigrams(query);
      if (!uni.length) return [];
      const uexpr = uni.map((t) => `"${t}"`).join(' OR ');
      const umatch = `bg:(${uexpr}) OR title:(${uexpr})`;
      const uargs = kind ? [umatch, kind, limit] : [umatch, limit];
      return this.db.prepare(sql).all(...uargs).map((r) => this.#map(r));
    } catch {
      // FTS 语法不容错：查询里带特殊字符时退化为子串匹配
      return this.active(kind, { session }).filter((c) => `${c.aiw} ${c.title}`.includes(query)).slice(0, limit);
    }
  }

  /** 结算写回：salience / useCount / lastUsedAt / cold */
  touch(id, patch) {
    const cur = this.get(id);
    if (!cur) return null;
    this.db
      .prepare('UPDATE claim SET salience = ?, use_count = ?, last_used_at = ?, cold = ? WHERE id = ?')
      .run(
        patch.salience ?? cur.salience,
        patch.useCount ?? cur.useCount,
        patch.lastUsedAt ?? cur.lastUsedAt ?? null,
        (patch.cold ?? cur.cold) ? 1 : 0,
        id
      );
    return this.get(id);
  }

  addRef(claimId, ref) {
    this.db
      .prepare('INSERT OR REPLACE INTO external_ref (claim_id,kind,target,digest,checked_at,status) VALUES (?,?,?,?,?,?)')
      .run(claimId, ref.kind, ref.target, ref.digest ?? null, ref.checkedAt ?? null, ref.status ?? 'unknown');
  }

  refsOf(claimId) {
    return this.db.prepare('SELECT * FROM external_ref WHERE claim_id = ?').all(claimId);
  }


  // ---------------- 关系边 ----------------

  link(fromId, toId, { type = 'semantic', weight = 1, now = Date.now() } = {}) {
    if (!fromId || !toId || fromId === toId) return null;
    this.db
      .prepare('INSERT OR REPLACE INTO edge (from_id,to_id,type,weight,created_at) VALUES (?,?,?,?,?)')
      .run(fromId, toId, type, weight, now);
    return { fromId, toId, type, weight };
  }

  edgesOf(id) {
    return this.db
      .prepare('SELECT * FROM edge WHERE from_id = ? OR to_id = ?')
      .all(id, id)
      .map((e) => ({
        from: e.from_id,
        to: e.to_id,
        type: e.type,
        weight: e.weight,
        other: e.from_id === id ? e.to_id : e.from_id,
      }));
  }

  /** 从一条记忆出发做 BFS，返回邻居与距离 */
  related(id, { depth = 1, type } = {}) {
    const seen = new Set([id]);
    const out = [];
    let frontier = [id];
    for (let d = 1; d <= depth; d++) {
      const next = [];
      for (const cur of frontier) {
        for (const e of this.edgesOf(cur)) {
          if (type && e.type !== type) continue;
          if (seen.has(e.other)) continue;
          seen.add(e.other);
          next.push(e.other);
          const c = this.get(e.other);
          out.push({ id: e.other, distance: d, type: e.type, title: c?.title ?? '', kind: c?.kind ?? null });
        }
      }
      frontier = next;
      if (!frontier.length) break;
    }
    return out;
  }

  // ---------------- 项目文档 ----------------

  /** 写一篇文档；同标题视为同一篇（更新而不是堆叠） */
  putDoc({ id, title, body, tags = '' , now = Date.now() }) {
    const docId = id ?? `doc-${this.#hash(title)}`;
    const bg = bigrams(`${title} ${body}`);
    const cur = this.db.prepare('SELECT created_at FROM doc WHERE id = ?').get(docId);
    this.db
      .prepare(
        `INSERT INTO doc (id,title,body,bg,tags,created_at,updated_at,cold) VALUES (?,?,?,?,?,?,?,0)
         ON CONFLICT(id) DO UPDATE SET title=excluded.title, body=excluded.body, bg=excluded.bg, tags=excluded.tags, updated_at=excluded.updated_at`
      )
      .run(docId, title, body, bg, tags, cur?.created_at ?? now, now);
    this.db.prepare('DELETE FROM doc_fts WHERE rowid = (SELECT rowid FROM doc WHERE id = ?)').run(docId);
    const row = this.db.prepare('SELECT rowid FROM doc WHERE id = ?').get(docId);
    this.db.prepare('INSERT INTO doc_fts (rowid, bg, title) VALUES (?,?,?)').run(row.rowid, bg, title);

    // 版本化：正文变了才留一版，同内容重复写不堆版本
    const last = this.db.prepare('SELECT rev, body FROM doc_rev WHERE doc_id = ? ORDER BY rev DESC LIMIT 1').get(docId);
    if (!last || last.body !== body) {
      this.db
        .prepare('INSERT INTO doc_rev (doc_id, rev, title, body, at) VALUES (?,?,?,?,?)')
        .run(docId, (last?.rev ?? 0) + 1, title, body, now);
    }

    return this.getDoc(docId);
  }

  getDoc(id) {
    return this.db.prepare('SELECT * FROM doc WHERE id = ?').get(id) ?? null;
  }

  /** 文档检索：与 claim 同一套 bigram + OR + bm25 */
  searchDocs(query, { limit = 5 } = {}) {
    const terms = contentBigrams(query).split(' ').filter(Boolean);
    if (!terms.length) return [];
    const expr = terms.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ');
    const match = `bg:(${expr}) OR title:(${expr})`;
    try {
      return this.db
        .prepare(
          `SELECT d.* FROM doc_fts f JOIN doc d ON d.rowid = f.rowid
           WHERE doc_fts MATCH ? AND d.cold = 0 ORDER BY bm25(doc_fts) LIMIT ?`
        )
        .all(match, limit)
        .map((r) => ({ id: r.id, title: r.title, body: r.body, tags: r.tags, updatedAt: r.updated_at }));
    } catch {
      return [];
    }
  }

  /** 按正文找文档：遗忘一条记忆时，用它把一起写下的文档也标冷 */
  docsByBody(body) {
    return this.db.prepare('SELECT id,title FROM doc WHERE body = ? AND cold = 0').all(String(body ?? ''));
  }

  setDocCold(id, cold = true) {
    this.db.prepare('UPDATE doc SET cold = ? WHERE id = ?').run(cold ? 1 : 0, id);
    return this.getDoc(id);
  }

  /** 一篇文档的历史版本（新的在前） */
  docRevisions(id) {
    return this.db
      .prepare('SELECT doc_id, rev, title, body, at FROM doc_rev WHERE doc_id = ? ORDER BY rev DESC')
      .all(id);
  }

  /** 全量 claim（含已失效），用于导出 */
  allClaims() {
    return this.db.prepare('SELECT * FROM claim ORDER BY valid_from').all().map((r) => this.#map(r));
  }

  /** 全量边，用于导出 */
  allEdges() {
    return this.db.prepare('SELECT * FROM edge').all().map((e) => ({ from: e.from_id, to: e.to_id, type: e.type, weight: e.weight, createdAt: e.created_at }));
  }

  /** 全量文档（含冷），用于导出 */
  allDocs() {
    return this.db.prepare('SELECT * FROM doc').all();
  }

  docs() {
    return this.db.prepare('SELECT id,title,tags,updated_at FROM doc WHERE cold = 0 ORDER BY updated_at DESC').all();
  }

  #hash(s) {
    return createHash('sha256').update(String(s)).digest('hex').slice(0, 16);
  }
}
