// 设置面板的结构检查：每个可点项都对应一个真实配置键
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientPath = path.resolve(here, '../../loom-dsh/client.js');
const pluginPath = path.resolve(here, '../../loom-dsh/index.js');

const client = fs.readFileSync(clientPath, 'utf8');
const plugin = fs.readFileSync(pluginPath, 'utf8');

// 面板上出现的配置键
const keys = [...client.matchAll(/k: '([a-zA-Z]+)'/g)].map((m) => m[1]);
const unique = [...new Set(keys)];

// 宿主允许写的白名单
const settable = [...(plugin.match(/const SETTABLE = new Set\(\[([\s\S]*?)\]\)/)?.[1] ?? '').matchAll(/'([a-zA-Z]+)'/g)].map((m) => m[1]);

test('面板上每个设置项都在宿主的可写白名单里', () => {
  assert.ok(unique.length >= 8, '设置项太少：' + unique.join(','));
  for (const k of unique) {
    assert.ok(settable.includes(k), `设置项 ${k} 不在后端白名单里，点了会失败`);
  }
});

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
