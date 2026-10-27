// 设置面板的结构检查：控件形态与分组是否还在
// （「面板上每个键都必须可写」那条由 settings.test.js 负责，
//   它直接读 SETTING_SPECS，比在这里正则抠源码更可靠）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientPath = path.resolve(here, '../../loom-dsh/client.js');

const client = fs.readFileSync(clientPath, 'utf8');

test('设置页用点击式控件，不再要求手打枚举值', () => {
  assert.ok(client.includes('h(Choice'), '应有 Choice 控件');
  assert.ok(client.includes('h(Toggle'), '应有 Toggle 控件');
  // 枚举不该再是一个裸输入框让人手填 session/global
  const settingsBlock = client.slice(client.indexOf("if (tab === '设置')"));
  assert.equal(/value: draft\.memoryScope/.test(settingsBlock), false, 'memoryScope 不该是文本输入');
});

test('分组标题齐全', () => {
  for (const g of ['记忆范围', '每轮注入', '自动记录', '高级', '备份']) {
    assert.ok(client.includes(g), `缺分组：${g}`);
  }
});
