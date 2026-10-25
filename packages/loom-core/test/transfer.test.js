import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteLedger } from '../src/sqlite-ledger.js';
import { exportBundle, importBundle, exportToFile, importFromFile, EXPORT_VERSION } from '../src/transfer.js';

const seed = (db, id, aiw) =>
  db.put({
    id, kind: 'fact', body: aiw, aiw, title: aiw.slice(0, 8),
    confidence: 'high', source: { eventId: 'e' }, epochId: 'ep', taint: 'none',
    validFrom: 1, salience: 1, useCount: 0, cold: false,
  });

test('导出结构与版本号', () => {
  const db = new SqliteLedger(':memory:');
  seed(db, 'a1', '预发:8081。');
  const b = exportBundle(db, { now: Date.parse('2026-10-26T00:00:00Z') });
  assert.equal(b.version, EXPORT_VERSION);
  assert.equal(b.count, 1);
  assert.equal(b.claims[0].aiw, '预发:8081。');
  assert.ok(b.exportedAt.startsWith('2026-10-26'));
  db.close();
});

test('往返：导出再导入到空库，内容一致', () => {
  const a = new SqliteLedger(':memory:');
  seed(a, 'a1', '预发:8081。');
  seed(a, 'a2', '回滚在右上。');
  const bundle = exportBundle(a);

  const b = new SqliteLedger(':memory:');
  const r = importBundle(b, bundle);
  assert.equal(r.added, 2);
  assert.equal(b.active().length, 2);
  assert.equal(b.get('a1').aiw, '预发:8081。');
  a.close();
  b.close();
});

test('重复导入是幂等的', () => {
  const a = new SqliteLedger(':memory:');
  seed(a, 'a1', '预发:8081。');
  const bundle = exportBundle(a);

  const b = new SqliteLedger(':memory:');
  importBundle(b, bundle);
  const second = importBundle(b, bundle);
  assert.equal(second.skipped, 1);
  assert.equal(b.active().length, 1);
  a.close();
  b.close();
});

test('坏格式要报错，不静默', () => {
  const db = new SqliteLedger(':memory:');
  assert.throws(() => importBundle(db, { version: 'nope' }), /不认识的导出格式/);
  db.close();
});

test('文件往返', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-exp-'));
  const file = path.join(dir, 'dump.json');
  const a = new SqliteLedger(':memory:');
  seed(a, 'a1', '预发:8081。');
  exportToFile(a, file);

  const b = new SqliteLedger(':memory:');
  const r = importFromFile(b, file);
  assert.equal(r.added, 1);
  assert.equal(b.get('a1').aiw, '预发:8081。');

  a.close();
  b.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
