import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brief, generationMessages, checkDraft } from '../src/constrain.js';

const ORIGINAL = 'Win 路径拼接用了正斜杠，导致配置读不到，报 ENOENT；修复用 path.join。';

test('brief：模型给的事实排在规则前面，且去重', () => {
  const b = brief(ORIGINAL, { modelTerms: ['ENOENT', '配置读不到'] });
  assert.equal(b.mustKeep[0].from, 'model');
  assert.equal(b.mustKeep[0].term, 'ENOENT');
  const terms = b.mustKeep.map((t) => t.term);
  assert.equal(new Set(terms).size, terms.length, '不许重复');
  assert.ok(
    terms.some((t) => t.includes('path.join')),
    '规则那条地板还在'
  );
});

test('brief：约束写进指令，且不带装饰符号', () => {
  const b = brief(ORIGINAL);
  assert.ok(b.instruction.includes('ENOENT'), '事实要出现在指令里');
  assert.equal(
    b.instruction.includes('「ENOENT」'),
    false,
    '不要用「」包起来——模型会把引号写进输出'
  );
  assert.ok(b.instruction.includes('不要写 @时间'));
  assert.ok(b.instruction.includes('长度上限'));
});

test('generationMessages：约束在生成之前给出', () => {
  const b = brief(ORIGINAL, { modelTerms: ['ENOENT'] });
  const [sys, user] = generationMessages(b);
  assert.equal(sys.role, 'system');
  assert.ok(sys.content.includes('不要加时间/来源/置信'), '系统提示要禁止写尾部');
  assert.equal(user.role, 'user');
  assert.ok(user.content.includes('ENOENT'));
  assert.ok(user.content.includes(ORIGINAL), '原文要带上');
});

test('generationMessages：重试时把缺的事实回喂', () => {
  const b = brief(ORIGINAL);
  const [, user] = generationMessages(b, { feedback: ['ENOENT', 'path.join'] });
  assert.ok(user.content.includes('上一版漏了这些事实'));
  assert.ok(user.content.includes('ENOENT'));
  assert.ok(user.content.includes('只补这些'));
});

test('checkDraft：丢了事实立刻报', () => {
  const b = brief(ORIGINAL);
  assert.equal(checkDraft('Win路径正斜杠→配置读败（ENOENT）；修=path.join。', b).ok, true);
  const bad = checkDraft('路径拼接导致配置读取失败，已修复。', b);
  assert.equal(bad.ok, false);
  assert.ok(bad.missing.includes('ENOENT'));
});

test('checkDraft：别名算命中', () => {
  const b = brief('把鉴权改成 JWT，失败了就回滚。', { modelTerms: ['鉴权', '回滚'] });
  assert.equal(checkDraft('改 auth→JWT，失败即 rollback。', b).ok, true);
});
