import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, renderLegend, renderPlain, renderXml, POLICIES } from '../src/render.js';

const bundle = {
  items: [
    { claimId: 'aaaa1111bbbb', text: '预发:8081；上线跑smoke。', level: 'full', score: 0.9 },
    { claimId: 'cccc2222dddd', text: '回滚在面板右上', level: 'title', score: 0.4 },
  ],
  pointers: [{ claimId: 'eeee3333', title: '缓存待定' }],
  usedTokens: 24,
};

test('legend：带符号表与 [#id]', () => {
  const s = renderLegend(bundle);
  assert.ok(s.includes('符号：'));
  assert.ok(s.includes('[#aaaa1111]'));
  assert.ok(s.includes('仅标题'));
  assert.ok(s.includes('（指针）缓存待定'));
});

test('plain：不带符号，编号列表', () => {
  const s = renderPlain(bundle);
  assert.equal(s.includes('符号：'), false);
  assert.ok(s.startsWith('1. '));
  assert.ok(s.includes('预发:8081'));
});

test('xml：结构化且转义', () => {
  const s = renderXml({ items: [{ claimId: 'x1', text: 'a & b <c>', level: 'full' }], pointers: [] });
  assert.ok(s.startsWith('<memory>'));
  assert.ok(s.includes('&amp;'));
  assert.ok(s.includes('&lt;c&gt;'));
  assert.equal(s.includes('<c>'), false);
});

test('空层不返回垃圾', () => {
  for (const p of Object.keys(POLICIES)) {
    assert.equal(render({ items: [], pointers: [] }, { policy: p }), '');
  }
});

test('未知策略要报错，不静默降级', () => {
  assert.throws(() => render(bundle, { policy: 'nope' }), /未知渲染策略/);
});

test('render 默认用 legend', () => {
  assert.equal(render(bundle), renderLegend(bundle));
});
