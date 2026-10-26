import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteLedger } from '../src/sqlite-ledger.js';
import { exportBundle, bundleToZip, zipToBundle, importBundle, exportToZip, importFromZip } from '../src/bundle.js';

const claim = (id, aiw = '正文。') => ({
  id, kind: 'fact', body: aiw, aiw, title: aiw.slice(0, 6),
  confidence: 'high', source: { eventId: 'e' }, epochId: 'ep', taint: 'none',
  validFrom: 1, salience: 1, useCount: 0, cold: false,
});

test('导出结构：claims / docs / revs / edges 都在', () => {
  const db = new SqliteLedger(':memory:');
  db.put(claim('a1'));
  const doc = db.putDoc({ title: '发布流程', body: '第一版内容' });
  db.putDoc({ id: doc.id, title: '发布流程', body: '第二版内容' });
  db.put(claim('a2'));
  db.link('a1', 'a2', { type: 'causal' });

  const b = exportBundle(db);
  assert.equal(b.manifest.version, 'loom-bundle/v1');
  assert.equal(b.claims.length, 2);
  assert.equal(b.docs.length, 1);
  assert.equal(b.revs.length, 2, '两版正文应留两条历史');
  assert.equal(b.edges.length, 1);
  db.close();
});

test('ZIP 往返：结构完整', () => {
  const db = new SqliteLedger(':memory:');
  db.put(claim('a1', '预发端口 8081。'));
  db.putDoc({ title: '文档', body: '内容' });
  const zip = bundleToZip(exportBundle(db));
  const back = zipToBundle(zip);
  assert.equal(back.claims.length, 1);
  assert.equal(back.claims[0].aiw, '预发端口 8081。');
  assert.equal(back.docs.length, 1);
  db.close();
});

test('导入到空库：全部恢复', () => {
  const a = new SqliteLedger(':memory:');
  a.put(claim('a1', '第一条。'));
  a.putDoc({ title: '方案', body: '正文' });
  const bundle = exportBundle(a);

  const b = new SqliteLedger(':memory:');
  const counts = importBundle(b, bundle);
  assert.equal(counts.claims, 1);
  assert.equal(b.get('a1').aiw, '第一条。');
  assert.equal(b.docs().length, 1);
  a.close();
  b.close();
});

test('重复导入是幂等的（merge 模式）', () => {
  const a = new SqliteLedger(':memory:');
  a.put(claim('a1'));
  const bundle = exportBundle(a);
  const b = new SqliteLedger(':memory:');
  importBundle(b, bundle);
  const second = importBundle(b, bundle);
  assert.equal(second.claims, 0);
  assert.equal(second.claimsSkipped, 1);
  assert.equal(b.active().length, 1);
  a.close();
  b.close();
});

test('坏包要报错，不静默', () => {
  const db = new SqliteLedger(':memory:');
  assert.throws(() => importBundle(db, { manifest: { version: 'nope' } }), /不认识的包版本|缺少/);
  db.close();
});

test('文件往返', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-bundle-'));
  const file = path.join(dir, 'memory.zip');
  const a = new SqliteLedger(path.join(dir, 'a.db'));
  a.put(claim('a1', '端口 8081。'));
  exportToZip(a, file);
  assert.ok(fs.statSync(file).size > 0);

  const b = new SqliteLedger(path.join(dir, 'b.db'));
  const counts = importFromZip(b, file);
  assert.equal(counts.claims, 1);
  assert.equal(b.get('a1').aiw, '端口 8081。');

  a.close();
  b.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
