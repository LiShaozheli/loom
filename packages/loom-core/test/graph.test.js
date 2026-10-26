import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteLedger } from '../src/sqlite-ledger.js';

const seed = (db, id, kind = 'fact') =>
  db.put({
    id, kind, body: `原文 ${id}`, aiw: `正文 ${id}。`, title: `标题 ${id}`,
    confidence: 'high', source: { eventId: 'e' }, epochId: 'ep', taint: 'none',
    validFrom: 1, salience: 1, useCount: 0, cold: false,
  });

test('连边后两边都能查到', () => {
  const db = new SqliteLedger(':memory:');
  seed(db, 'a');
  seed(db, 'b');
  db.link('a', 'b', { type: 'causal' });

  assert.equal(db.edgesOf('a').length, 1);
  assert.equal(db.edgesOf('b').length, 1);
  assert.equal(db.edgesOf('b')[0].other, 'a');
  db.close();
});

test('自环与空值被忽略', () => {
  const db = new SqliteLedger(':memory:');
  seed(db, 'a');
  assert.equal(db.link('a', 'a'), null);
  assert.equal(db.link('a', ''), null);
  assert.equal(db.edgesOf('a').length, 0);
  db.close();
});

test('related 走 BFS，带距离', () => {
  const db = new SqliteLedger(':memory:');
  for (const id of ['a', 'b', 'c']) seed(db, id);
  db.link('a', 'b');
  db.link('b', 'c');

  const one = db.related('a', { depth: 1 });
  assert.deepEqual(one.map((x) => x.id), ['b']);

  const two = db.related('a', { depth: 2 });
  assert.ok(two.some((x) => x.id === 'c' && x.distance === 2));
  db.close();
});

test('related 可按边类型过滤', () => {
  const db = new SqliteLedger(':memory:');
  seed(db, 'a');
  seed(db, 'b');
  seed(db, 'c');
  db.link('a', 'b', { type: 'causal' });
  db.link('a', 'c', { type: 'semantic' });

  const only = db.related('a', { depth: 1, type: 'causal' });
  assert.deepEqual(only.map((x) => x.id), ['b']);
  db.close();
});

test('环不会死循环', () => {
  const db = new SqliteLedger(':memory:');
  seed(db, 'a');
  seed(db, 'b');
  db.link('a', 'b');
  db.link('b', 'a');
  const r = db.related('a', { depth: 3 });
  assert.equal(r.filter((x) => x.id === 'b').length, 1);
  db.close();
});

test('重复连同一条边不会翻倍', () => {
  const db = new SqliteLedger(':memory:');
  seed(db, 'a');
  seed(db, 'b');
  db.link('a', 'b');
  db.link('a', 'b');
  assert.equal(db.edgesOf('a').length, 1);
  db.close();
});
