import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brief, generationMessages } from '../src/constrain.js';

const ORIGINAL = 'Win 路径拼接用了正斜杠，导致配置读不到，报 ENOENT；修复用 path.join。';

test('系统提示禁止写尾部元数据', () => {
  const [, ,] = [];
  const [sys] = generationMessages(brief(ORIGINAL));
  assert.ok(sys.content.includes('不要加时间/来源/置信'));
  assert.ok(sys.content.includes('不要解释'));
});

test('事实以纯文本给出，不带「」——否则模型会把引号写进输出', () => {
  const b = brief(ORIGINAL, { modelTerms: ['ENOENT'] });
  const [, user] = generationMessages(b);
  assert.ok(user.content.includes('ENOENT'));
  assert.equal(user.content.includes('「ENOENT」'), false);
});

test('指令含长度上限，防止"压了但没压短"', () => {
  const [, user] = generationMessages(brief(ORIGINAL));
  assert.match(user.content, /长度上限：\d+ 个字符/);
});

test('重试时回喂缺失事实，且要求只补不改写', () => {
  const [, user] = generationMessages(brief(ORIGINAL), { feedback: ['path.join'] });
  assert.ok(user.content.includes('上一版漏了这些事实'));
  assert.ok(user.content.includes('path.join'));
  assert.ok(user.content.includes('只补这些'));
});
