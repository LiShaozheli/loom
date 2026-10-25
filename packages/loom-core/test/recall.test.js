import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRecall } from '../src/admission.js';
import { routeQuery, scoreClaim } from '../src/router.js';
import { buildOutline } from '../src/outline.js';
import { recall } from '../src/recall.js';

// ---------------- 第一问 ----------------
test('admission：应答与寒暄不查', () => {
  assert.equal(shouldRecall('好的').recall, false);
  assert.equal(shouldRecall('继续').recall, false);
  assert.equal(shouldRecall('谢谢！').recall, false);
  assert.equal(shouldRecall('你好').recall, false);
});

test('admission：记忆线索一定查', () => {
  for (const q of ['上次那个方案叫什么', '我们之前定的端口是多少', '还记得那个报错吗']) {
    const r = shouldRecall(q);
    assert.equal(r.recall, true, q);
    assert.equal(r.reason, 'memory-cue');
  }
});

test('admission：提问查，纯命令不查', () => {
  assert.equal(shouldRecall('预发环境端口是多少？').recall, true);
  assert.equal(shouldRecall('把这个函数改短一点').recall, false);
});

test('admission：同一轮已查过，短追问不重复查', () => {
  const r = shouldRecall('然后呢', { alreadyRecalledThisTurn: true });
  assert.equal(r.recall, false);
  assert.equal(r.reason, 'already-recalled-this-turn');
});

// ---------------- 第二问 ----------------
test('router：偏好问题进 pref 池', () => {
  const r = routeQuery('用户喜欢什么样的汇报方式？');
  assert.ok(r.kinds.includes('pref'));
});

test('router：责任人问题进 relation 池', () => {
  assert.ok(routeQuery('接口变更谁负责？').kinds.includes('relation'));
});

test('router：时间线索转成 since', () => {
  const now = Date.parse('2026-10-30T00:00:00Z');
  const r = routeQuery('上周改了什么', { now });
  assert.equal(r.since, now - 7 * 864e5);
});

test('router：实体抽取 + 打分', () => {
  const r = routeQuery('JWT 鉴权是怎么失败的？');
  assert.ok(r.entities.includes('JWT'));

  const claim = { kind: 'decision', aiw: '改鉴权→JWT，refresh轮换→失败。', title: 'JWT失败' };
  assert.ok(scoreClaim(claim, r) > 0.5);

  const off = { kind: 'pref', aiw: '文档用中文。', title: '偏好' };
  assert.ok(scoreClaim(off, r) < scoreClaim(claim, r));
});

// ---------------- 第三问 ----------------
test('outline：按类型分组、带数量、受预算约束', () => {
  const claims = [
    { id: '1', kind: 'fact', title: '端口', aiw: 'x' },
    { id: '2', kind: 'fact', title: '路径', aiw: 'x' },
    { id: '3', kind: 'pref', title: '偏好', aiw: 'x' },
  ];
  const o = buildOutline(claims, { budget: 120 });
  assert.equal(o.totalClaims, 3);
  const fact = o.nodes.find((n) => n.kind === 'fact');
  assert.equal(fact.claims, 2);
  assert.ok(o.usedTokens <= 120);
});

test('outline：预算极小时只剩一个节点或空', () => {
  const claims = Array.from({ length: 30 }, (_, i) => ({ id: `${i}`, kind: i % 2 ? 'fact' : 'pref', title: '标题', aiw: 'x' }));
  const o = buildOutline(claims, { budget: 4 });
  assert.ok(o.nodes.length <= 2);
  assert.ok(o.usedTokens <= 4);
});

// ---------------- 合成 ----------------
test('recall：应答直接短路，不进检索', () => {
  const r = recall({ query: '好的', claims: [] });
  assert.equal(r.skipped, true);
  assert.equal(r.items.length, 0);
});

test('recall：提问走完整管道，预算内取回', () => {
  const claims = [
    { id: 'a', kind: 'decision', title: '鉴权改造', aiw: '改鉴权→JWT，refresh轮换→失败→回滚session。', validFrom: 1 },
    { id: 'b', kind: 'pref', title: '文档语言', aiw: '代码注英文，文档中文。', validFrom: 1 },
    { id: 'c', kind: 'fact', title: '端口', aiw: '预发:8081。', validFrom: 1 },
  ];
  const r = recall({ query: '上次 JWT 那个方案为什么回滚？', claims, budget: 100 });
  assert.equal(r.skipped, false);
  assert.equal(r.items[0].claimId, 'a', '最相关的排第一');
  assert.ok(r.usedTokens <= 100);
  assert.ok(r.outline.nodes.length > 0);
});

test('admission：短名词短语也要查（真实会话踩到过）', () => {
  const r = shouldRecall('预发端口');
  assert.equal(r.recall, true);
  assert.equal(r.reason, 'default');
});
