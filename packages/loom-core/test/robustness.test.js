import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteLedger } from '../src/sqlite-ledger.js';
import { ingest } from '../src/ingest.js';
import { recall } from '../src/recall.js';

test('空库：不抛错、返回空、不跳过', async () => {
  const db = new SqliteLedger(':memory:');
  const r = recall({ query: '预发端口是多少？', search: (q) => db.search(q) });
  assert.equal(r.skipped, false);
  assert.deepEqual(r.items, []);
  assert.deepEqual(r.pointers, []);
  assert.equal(r.usedTokens, 0);

  assert.deepEqual(db.search('任何东西'), []);
  assert.equal(db.get('不存在'), null);
  db.close();
});

test('异常输入：空串、超长、纯符号都不该让闸门崩', async () => {
  const db = new SqliteLedger(':memory:');
  const w = (line) => ingest({ line, body: line, epochId: 'ep', ledger: db, source: { eventId: 'x' } });

  assert.equal(w('').ok, false, '空行应被拒');
  assert.equal(w('   ').ok, false);
  const long = '很长的一句话；'.repeat(40);
  const r = w(long);
  assert.equal(r.ok, false, '超长应被拒');
  assert.ok(r.gate.issues.some((i) => i.code === 'B1' || i.code === 'B1b'));
  db.close();
});

test('重复写入同一内容：只留一条', async () => {
  const db = new SqliteLedger(':memory:');
  const line = '预发端口 8081；上线前必跑 smoke。';
  const a = ingest({ line, body: line, epochId: 'ep', ledger: db, source: { eventId: 'x' } });
  const b = ingest({ line: line.replace('；', '，'), body: line, epochId: 'ep', ledger: db, source: { eventId: 'y' } });
  assert.equal(a.claim.id, b.claim.id);
  assert.equal(db.active().length, 1);
  db.close();
});

test('规模：5000 条下检索仍可用', () => {
  const db = new SqliteLedger(':memory:');
  const insert = db.db.prepare(
    `INSERT INTO claim (id,kind,body,aiw,bg,title,confidence,source_event,epoch_id,taint,valid_from,salience,use_count,cold)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const insFts = db.db.prepare('INSERT INTO claim_fts (rowid, aiw, bg, title) VALUES (?,?,?,?)');

  db.db.exec('BEGIN');
  for (let i = 0; i < 5000; i++) {
    const aiw = `第${i}条：模块${i % 37} 的端口 ${8000 + (i % 1000)}；相关配置见 docs/${i}.md。`;
    const title = `第${i}条`;
    const bg = `${aiw} ${title}`
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[^\p{Script=Han}A-Za-z0-9]+/gu, ' ')
      .trim();
    insert.run(`id${i}`, 'fact', aiw, aiw, bg, title, 'high', 'e', 'ep', 'none', i, 1, 0, 0);
    insFts.run(i + 1, aiw, bg, title);
  }
  db.db.exec('COMMIT');

  const t0 = process.hrtime.bigint();
  let hits = 0;
  for (let i = 0; i < 50; i++) hits += db.search(`模块${i % 37} 端口`, { limit: 5 }).length;
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const p95 = ms / 50;

  console.log(`  5000 条 · 50 次检索共 ${ms.toFixed(1)}ms · 平均 ${p95.toFixed(1)}ms/次 · 命中 ${hits}`);
  assert.ok(hits > 0, '应该有命中');
  assert.ok(p95 < 50, `单次检索 ${p95.toFixed(1)}ms 超预算`);
  db.close();
});
