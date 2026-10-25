import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attributeCitation, attributeOverlap, nextWeight, settleTurn } from '../src/settle.js';
import { MemoryLedger } from '../src/ledger.js';

const items = [
  { claimId: 'aaaa1111', text: 'Win路径斜杠→ENOENT；修=path.join。' },
  { claimId: 'bbbb2222', text: '预发:8081；上线跑smoke。' },
];

test('引用归因：认出 [id]，也认 8 位前缀', () => {
  assert.deepEqual(attributeCitation('答案是 ENOENT [aaaa1111]', items), ['aaaa1111']);
  assert.deepEqual(attributeCitation('见 [aaaa]', items), ['aaaa1111']);
  assert.deepEqual(attributeCitation('没有引用', items), []);
});

test('词面归因：复述够多才算用了', () => {
  const used = attributeOverlap('Windows 路径斜杠导致 ENOENT，修复用 path.join。', items);
  assert.deepEqual(used, ['aaaa1111']);
  assert.deepEqual(attributeOverlap('完全无关的回答。', items), []);
});

test('权重：用了且对 → 加固；用了但错 → 减权；没用 → 轻微衰减', () => {
  const base = { salience: 1, useCount: 0 };
  const up = nextWeight(base, { used: true, correct: true });
  assert.ok(up.salience > 1);
  assert.equal(up.useCount, 1);

  const down = nextWeight(base, { used: true, correct: false });
  assert.ok(down.salience < 1);

  const idle = nextWeight(base, { used: false, correct: null });
  assert.ok(idle.salience < 1 && idle.salience > 0.95);
  assert.equal(idle.useCount, 0);
});

test('权重有上下界，不会涨到无穷或掉到 0', () => {
  let w = { salience: 1, useCount: 0 };
  for (let i = 0; i < 50; i++) w = nextWeight(w, { used: true, correct: true });
  assert.ok(w.salience <= 3);

  let d = { salience: 1, useCount: 0 };
  for (let i = 0; i < 200; i++) d = nextWeight(d, { used: true, correct: false });
  assert.ok(d.salience >= 0.05);
});

test('settleTurn：把结果写回账本', () => {
  const led = new MemoryLedger();
  led.put({
    id: 'aaaa1111', kind: 'fact', body: 'b', aiw: items[0].text, title: 't',
    confidence: 'high', source: { eventId: 'e' }, epochId: 'ep', taint: 'none',
    validFrom: 1, salience: 1, useCount: 0,
  });
  led.touch = (id, patch) => {
    const c = led.get(id);
    if (c) Object.assign(c, patch);
  };

  const r = settleTurn({ answer: 'ENOENT，修 path.join [aaaa1111]', items, ledger: led });
  assert.deepEqual(r.used, ['aaaa1111']);
  assert.ok(led.get('aaaa1111').salience > 1);
  assert.equal(led.get('aaaa1111').useCount, 1);
});

test('settleTurn：没被用到的条目不涨权重', () => {
  const led = new MemoryLedger();
  for (const it of items) {
    led.put({
      id: it.claimId, kind: 'fact', body: 'b', aiw: it.text, title: 't',
      confidence: 'high', source: { eventId: 'e' }, epochId: 'ep', taint: 'none',
      validFrom: 1, salience: 1, useCount: 0,
    });
  }
  led.touch = (id, patch) => Object.assign(led.get(id), patch);

  settleTurn({ answer: 'ENOENT [aaaa1111]', items, ledger: led });
  assert.ok(led.get('aaaa1111').salience > 1);
  assert.ok(led.get('bbbb2222').salience < 1, '没被用的应该轻微衰减');
});
