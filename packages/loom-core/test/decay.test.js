import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decayScore, decide, sweep, HALF_LIFE } from '../src/decay.js';
import { SqliteLedger } from '../src/sqlite-ledger.js';

const DAY = 86_400_000;
const now = Date.parse('2026-10-26T00:00:00Z');

const mk = (over = {}) => ({
  id: 'x',
  kind: 'fact',
  title: 't',
  aiw: 'a',
  validFrom: now,
  useCount: 0,
  ...over,
});

test('规则与偏好永不衰减', () => {
  const old = mk({ kind: 'rule', validFrom: now - 3650 * DAY });
  assert.equal(decayScore(old, { now }).score, 1);
  assert.equal(decayScore(mk({ kind: 'pref', validFrom: now - 3650 * DAY }), { now }).score, 1);
  assert.equal(HALF_LIFE.rule, Infinity);
});

test('事实按半衰期衰减：180 天掉一半', () => {
  const half = decayScore(mk({ kind: 'fact', validFrom: now - 180 * DAY }), { now });
  assert.ok(Math.abs(half.score - 0.5) < 0.02, `score=${half.score}`);
});

test('用进废退：用得多的抗衰减', () => {
  const cold = decayScore(mk({ validFrom: now - 360 * DAY }), { now });
  const hot = decayScore(mk({ validFrom: now - 360 * DAY, useCount: 10 }), { now });
  assert.ok(hot.score > cold.score * 1.5, `${cold.score} vs ${hot.score}`);
});

test('过时（stale）的打折', () => {
  const a = decayScore(mk({ validFrom: now - 90 * DAY }), { now });
  const b = decayScore(mk({ validFrom: now - 90 * DAY, stale: true }), { now });
  assert.ok(b.score < a.score);
});

test('阈值映射到三档动作', () => {
  assert.equal(decide(0.9), 'keep');
  assert.equal(decide(0.2), 'summarize');
  assert.equal(decide(0.08), 'pointerize');
  assert.equal(decide(0.01), 'archive');
});

test('sweep：dry 不动库，apply 只标 cold', () => {
  const db = new SqliteLedger(':memory:');
  const put = (id, kind, validFrom, useCount = 0) =>
    db.put({
      id,
      kind,
      body: 'b',
      aiw: `正文${id}`,
      title: `标题${id}`,
      confidence: 'high',
      source: { eventId: 'e' },
      epochId: 'ep',
      taint: 'none',
      validFrom,
      salience: 1,
      useCount,
      cold: false,
    });

  put('keep', 'rule', now - 1000 * DAY);
  put('old', 'fact', now - 900 * DAY);
  put('mid', 'fact', now - 200 * DAY);

  const dry = sweep(db, { now });
  assert.equal(db.get('old').cold, false, 'dry 不该改库');
  assert.ok(dry.rows.length >= 3);

  const applied = sweep(db, { now, apply: true });
  assert.equal(db.get('keep').cold, false, '规则不该被降级');
  assert.equal(db.get('old').cold, true, '很旧的事实应被降级');
  assert.ok(applied.counts.keep >= 1);
  db.close();
});

test('sweep 可按 kind 过滤', () => {
  const db = new SqliteLedger(':memory:');
  db.put({
    id: 'a',
    kind: 'proc',
    body: 'b',
    aiw: 'x',
    title: 't',
    confidence: 'high',
    source: { eventId: 'e' },
    epochId: 'ep',
    taint: 'none',
    validFrom: now - 500 * DAY,
    salience: 1,
  });
  const r = sweep(db, { now, kinds: ['fact'] });
  assert.equal(r.rows.length, 0);
  db.close();
});
