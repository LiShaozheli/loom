import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gate } from '../src/gate.js';
import { MemoryLedger } from '../src/ledger.js';
import { allocate } from '../src/allocate.js';

const original =
  'Win 上路径拼接用了正斜杠，导致配置读不到，错误信息是 ENOENT，只在打包后出现；修复是用 path.join。';

test('完整的 AI文 通过闸门', () => {
  const r = gate(
    {
      aiw: 'Win路径拼正斜杠→配置读败（ENOENT）；仅打包后现；修=path.join。',
      confidence: 'high',
      source: { eventId: 'evt-1' },
    },
    { original, mustKeep: ['ENOENT', 'path.join', '打包'] }
  );
  assert.equal(r.verdict, 'ACCEPT');
  assert.equal(r.recall, 1);
});

test('丢了关键事实 → REJECT', () => {
  const r = gate(
    {
      aiw: '路径拼接导致配置读取失败，已修复。',
      confidence: 'medium',
      source: { eventId: 'evt-2' },
    },
    { original, mustKeep: ['ENOENT', 'path.join', '打包'] }
  );
  assert.equal(r.verdict, 'REJECT');
  assert.equal(r.recall, 0);
  assert.deepEqual(r.missing.sort(), ['ENOENT', 'path.join', '打包'].sort());
});

test('缺来源 → REJECT（哪怕正文很好）', () => {
  const r = gate(
    { aiw: 'Win路径拼正斜杠→配置读败（ENOENT）；修=path.join。', confidence: 'high' },
    { original }
  );
  assert.equal(r.verdict, 'REJECT');
  assert.ok(r.issues.some((i) => i.code === 'M1'));
});

test('无人工 must_keep 时用规则版兜底', () => {
  const good = gate(
    {
      aiw: 'Win路径拼正斜杠→配置读败（ENOENT）；修=path.join。',
      confidence: 'high',
      source: { eventId: 'e' },
    },
    { original }
  );
  assert.equal(good.verdict, 'ACCEPT');
  const bad = gate(
    { aiw: '路径拼接导致配置读取失败，已修复。', confidence: 'high', source: { eventId: 'e' } },
    { original }
  );
  assert.equal(bad.verdict, 'REJECT');
  assert.ok(bad.mustKeep.every((m) => m.from === 'rule'));
});

test('编造的标识符 → REVISE', () => {
  const r = gate(
    {
      aiw: 'Win路径拼正斜杠→配置读败（ENOENT）；修=path.join；另加 ESLint 规则。',
      confidence: 'high',
      source: { eventId: 'e' },
    },
    { original, mustKeep: ['ENOENT', 'path.join'] }
  );
  assert.equal(r.verdict, 'REVISE');
  assert.ok(r.fabricated.includes('ESLint'));
});

test('ledger：幂等写入 + 冲突不覆盖', () => {
  const led = new MemoryLedger();
  const c = {
    id: 'a',
    kind: 'fact',
    body: 'b',
    aiw: 'x',
    title: 't',
    confidence: 'high',
    source: { eventId: 'e' },
    epochId: 'ep',
    taint: 'none',
    validFrom: 1,
    salience: 1,
  };
  led.put(c);
  led.put({ ...c, body: 'changed' });
  assert.equal(led.get('a').body, 'b', '同 id 不覆盖');

  led.put({ ...c, id: 'b' });
  led.supersede('a', 'b', '改主意了');
  assert.ok(led.get('a').validTo);
  assert.equal(led.get('a').supersededBy, 'b');
  assert.equal(led.active().length, 1);
});

test('allocate：预算内降级，且不超预算', () => {
  const mk = (id, score) => ({
    claim: { id, aiw: '一二三四五六七八九十'.repeat(3), title: '短标题', score },
    score,
  });
  const candidates = [mk('a', 0.9), mk('b', 0.8), mk('c', 0.7), mk('d', 0.6)];
  const r = allocate({ candidates, budget: 60 });
  assert.ok(r.usedTokens <= 60);
  assert.ok(r.items.length >= 1);
  assert.ok(r.items.every((i) => i.level === 'full' || i.level === 'title'));
});

test('allocate：低于 minScore 直接不占位', () => {
  const r = allocate({
    candidates: [{ claim: { id: 'a', aiw: '正文', title: '标题' }, score: 0.001 }],
    budget: 100,
    minScore: 0.01,
  });
  assert.equal(r.items.length, 0);
  assert.equal(r.pointers.length, 0);
});
