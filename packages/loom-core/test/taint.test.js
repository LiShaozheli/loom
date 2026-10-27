// taint 的语义：外部内容可以查，但不进每轮自动注入
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHotMemory, isEmptyHot } from '../src/hot.js';
import { importBundle, EXPORT_VERSION } from '../src/transfer.js';

const claim = (over = {}) => ({
  id: 'c1', kind: 'rule', aiw: '红线：先备份再改库', title: 't',
  validFrom: 1, cold: false, taint: 'none', ...over,
});

test('被标为外部的规则不进自动注入，但会被计数报出来', () => {
  const hot = buildHotMemory([claim({ taint: 'external' })], { maxBytes: 2048 });
  assert.equal(hot.text.includes('先备份再改库'), false, '外部内容混进了每轮注入');
  assert.equal(hot.tainted, 1, '被挡下的条数没报出来，用户会以为记忆丢了');
  assert.equal(isEmptyHot(hot), true);
});

test('未标记或 none 的照旧注入（老数据不受影响）', () => {
  const hot = buildHotMemory([claim({ taint: undefined }), claim({ id: 'c2', kind: 'pref', aiw: '喜欢短句' })], {
    maxBytes: 2048,
  });
  assert.equal(hot.counts.rule, 1);
  assert.equal(hot.counts.pref, 1);
  assert.equal(hot.tainted, 0);
  assert.equal(hot.text.includes('先备份再改库'), true);
});

test('unverified 与 external 一视同仁，混在可信条目里只挡它自己', () => {
  const hot = buildHotMemory(
    [
      claim({ id: 'a', aiw: '可信规则' }),
      claim({ id: 'b', kind: 'fact', aiw: '可疑事实', taint: 'unverified' }),
    ],
    { maxBytes: 2048 }
  );
  assert.equal(hot.text.includes('可信规则'), true);
  assert.equal(hot.text.includes('可疑事实'), false);
  assert.equal(hot.tainted, 1);
});

test('导入包：自己导出的 taint 保留，来源不明的降级为外部', () => {
  const store = new Map();
  const ledger = {
    get: (id) => store.get(id) ?? null,
    put: (c) => store.set(c.id, c),
  };
  const bundle = {
    version: EXPORT_VERSION,
    claims: [
      claim({ id: 'own', aiw: '自己导出的' }),                 // 带 taint:'none'
      { id: 'unknown', kind: 'fact', aiw: '来路不明', title: 't', validFrom: 1 }, // 没有 taint
    ],
  };
  importBundle(ledger, bundle);
  assert.equal(store.get('own').taint, 'none', '自己的包被误降级');
  assert.equal(store.get('unknown').taint, 'external', '来路不明的内容被当成可信');
});
