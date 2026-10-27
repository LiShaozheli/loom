import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripTail, parseTail, lintBody, lintLine, factPresent, ruleTerms } from '../src/aiw.js';

test('stripTail 剥掉 @时间 #来源 置信', () => {
  assert.equal(stripTail('改鉴权→JWT。@2026-10-24 #12 !'), '改鉴权→JWT。');
  assert.equal(stripTail('改鉴权→JWT。'), '改鉴权→JWT。');
});

test('parseTail 拆成结构化字段', () => {
  const t = parseTail('改鉴权→JWT。@2026-10-24 #12 !');
  assert.equal(t.date, '2026-10-24');
  assert.equal(t.source, '12');
  assert.equal(t.confidence, 'high');
});

test('正文校验：一断言、句号在末尾', () => {
  assert.equal(
    lintBody('改鉴权→JWT，refresh轮换败，故回滚。').filter((i) => i.level === 'ERROR').length,
    0
  );
  assert.ok(lintBody('改鉴权。回滚了。').some((i) => i.code === 'B3'));
});

test('标题档放宽长度、但仍查禁字', () => {
  assert.equal(
    lintBody('预发:8081；上线跑smoke', { tier: 'title' }).filter((i) => i.level === 'ERROR').length,
    0
  );
  assert.ok(lintBody('夫天下事有不可为者焉', { tier: 'title' }).some((i) => i.code === 'B2'));
});

test('作者行校验要求来源', () => {
  assert.ok(lintLine('改鉴权→JWT。@2026-10-24 !').some((i) => i.code === 'M2'));
  assert.equal(
    lintLine('改鉴权→JWT。@2026-10-24 #12 !').filter((i) => i.level === 'ERROR').length,
    0
  );
});

test('别名：auth 算保住 鉴权', () => {
  assert.equal(factPresent('改 auth→JWT', '鉴权'), true);
  assert.equal(factPresent('改鉴权→JWT', '鉴权'), true);
  assert.equal(factPresent('改鉴权→JWT', '回滚'), false);
});

test('规则版 must_keep 抓标识符与数字', () => {
  const terms = ruleTerms('Win 路径导致 ENOENT，函数 ≤40 行，修=path.join').map((t) => t.term);
  assert.ok(terms.includes('ENOENT'));
  assert.ok(terms.some((t) => t.includes('path.join')));
  assert.ok(terms.some((t) => t.includes('40')));
});

test('真实会话回归：尾部用「高」而不是 ! 也要能剥掉', () => {
  const line = '预发端口 8081；上线前必跑 smoke。 @2026-10-26 #用户口述 高';
  assert.equal(stripTail(line), '预发端口 8081；上线前必跑 smoke。');
  const t = parseTail(line);
  assert.equal(t.source, '用户口述');
  assert.equal(t.confidence, 'high');
});

test('没有尾部的正文原样返回', () => {
  assert.equal(stripTail('改鉴权→JWT。'), '改鉴权→JWT。');
  assert.equal(parseTail('改鉴权→JWT。'), null);
});
