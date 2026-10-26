import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHotMemory, isEmptyHot } from '../src/hot.js';

const claim = (kind, aiw, extra = {}) => ({ kind, aiw, validFrom: 0, cold: false, ...extra });

test('规则全进，事实只进最近的几条', () => {
  const claims = [
    claim('rule', '禁止直连生产库。'),
    claim('fact', '旧事实', { validFrom: 1 }),
    claim('fact', '新事实', { validFrom: 9 }),
    claim('pref', '文档用中文。'),
  ];
  const hot = buildHotMemory(claims, { maxFacts: 1 });
  assert.ok(hot.text.includes('禁止直连生产库'));
  assert.ok(hot.text.includes('文档用中文'));
  assert.ok(hot.text.includes('新事实'));
  assert.equal(hot.text.includes('旧事实'), false);
  assert.equal(hot.counts.rule, 1);
});

test('字节预算：超了就截断并提示', () => {
  const claims = Array.from({ length: 50 }, (_, i) => claim('rule', `第${i}条规则：这是一句比较长的规则描述${i}。`));
  const hot = buildHotMemory(claims, { maxBytes: 400 });
  assert.ok(hot.bytes <= 460, `bytes=${hot.bytes}`);
  assert.ok(hot.omitted > 0);
  assert.ok(hot.text.includes('memory_recall'));
});

test('冷条目不再注入', () => {
  const hot = buildHotMemory([claim('rule', '已归档的规则。', { cold: true })]);
  assert.equal(hot.text, '');
  assert.equal(isEmptyHot(hot), true);
});

test('空账本 → 空注入（不产生噪音）', () => {
  const hot = buildHotMemory([]);
  assert.equal(hot.text, '');
  assert.equal(isEmptyHot(hot), true);
});

test('注入带标题，模型能分辨这是记忆而不是用户的话', () => {
  const hot = buildHotMemory([claim('rule', '必须走审批。')]);
  assert.ok(hot.text.startsWith('## LOOM 记忆'));
});

test('字节统计按 UTF-8 算，不是字符数', () => {
  const hot = buildHotMemory([claim('rule', '中文四个字。')]);
  assert.ok(hot.bytes > hot.text.length, '中文的字节数应大于字符数');
});
