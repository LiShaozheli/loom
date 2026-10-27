/**
 * 设置项校验的回归测试。
 *
 * 真实故障链：面板把 hotBytes 从 4096 手滑成 40960，旧代码原样写进配置，
 * 下一次启动每轮往上下文里塞 40KB，谁也没发现；epochDays 写成 0 更糟，
 * 时间片切分除零，档案层直接不可用。这些都不在写入那一刻报错，
 * 而是以「行为怪但没崩」的形式出现在下一次重启后。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SETTING_SPECS,
  SETTING_KEYS,
  normalizeSetting,
  pruneInvalid,
  validateChange,
} from '../src/settings.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('枚举拼错会被拒，且错误里列出可选值', () => {
  const r = normalizeSetting('render', 'legand');
  assert.equal(r.ok, false);
  assert.match(r.error, /legend/);
  assert.match(r.error, /plain/);
});

test('整数超过上限被拒（每轮注入不能无限大）', () => {
  const r = normalizeSetting('hotBytes', 409600);
  assert.equal(r.ok, false);
  assert.match(r.error, /256~32768/);
});

test('整数低于下限被拒（预算再小也拿不回东西）', () => {
  assert.equal(normalizeSetting('budget', 10).ok, false);
  assert.equal(normalizeSetting('budget', 50).ok, true);
});

test('小数和非数字都进不来', () => {
  assert.match(normalizeSetting('epochDays', 2.5).error, /整数/);
  assert.equal(normalizeSetting('epochDays', 'abc').ok, false);
  assert.equal(normalizeSetting('epochDays', 0).ok, false);
});

test('数字字符串被规范成数字，写回配置的是真数字', () => {
  const r = normalizeSetting('hotBytes', '4096');
  assert.deepEqual(r, { ok: true, value: 4096 });
});

test('布尔只接受真布尔和配置文件里的字符串写法', () => {
  assert.equal(normalizeSetting('hot', false).value, false);
  assert.equal(normalizeSetting('hot', 'true').value, true);
  assert.equal(normalizeSetting('hot', 'false').value, false);
  assert.equal(normalizeSetting('hot', 1).ok, false);
});

test('库路径只接受绝对路径，相对路径会随 cwd 漂移', () => {
  for (const good of [
    '',
    'C:\\Users\\x\\loom.db',
    'C:/Users/x/loom.db',
    '/var/lib/loom.db',
    '\\\\nas\\share\\loom.db',
  ]) {
    assert.equal(normalizeSetting('dbPath', good).ok, true, good);
  }
  for (const bad of ['loom.db', './loom.db', 'sub/dir/loom.db']) {
    assert.equal(normalizeSetting('dbPath', bad).ok, false, bad);
  }
});

test('隔离列表去重、去空、去空白，且限长限量', () => {
  const r = normalizeSetting('isolatedSessions', [' a ', 'a', '', 'b']);
  assert.deepEqual(r, { ok: true, value: ['a', 'b'] });
  assert.equal(normalizeSetting('isolatedSessions', 'a,b').ok, false);
  assert.equal(normalizeSetting('isolatedSessions', ['x'.repeat(201)]).ok, false);
  assert.equal(
    normalizeSetting(
      'isolatedSessions',
      Array.from({ length: 101 }, (_, i) => 's' + i)
    ).ok,
    false
  );
});

test('不可设置的键一律拒绝', () => {
  const r = normalizeSetting('masterKey', 'whatever');
  assert.equal(r.ok, false);
  assert.match(r.error, /不可设置/);
});

test('坏键被剔除、好键与未知键保留', () => {
  const { config, dropped } = pruneInvalid({
    hotBytes: 4096,
    epochDays: 0,
    render: 'plain',
    未来字段: { a: 1 },
  });
  assert.equal(config.hotBytes, 4096);
  assert.equal(config.render, 'plain');
  assert.deepEqual(config.未来字段, { a: 1 });
  assert.equal(config.epochDays, undefined, '坏值必须消失，回退到默认');
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].key, 'epochDays');
});

test('一次改动只动一个键，并顺手修掉配置里的历史坏值', () => {
  const r = validateChange({ hotBytes: 4096, epochDays: 0, dbPath: 'loom.db' }, 'render', 'xml');
  assert.equal(r.ok, true);
  assert.equal(r.merged.render, 'xml');
  assert.equal(r.merged.hotBytes, 4096);
  assert.deepEqual(r.dropped.map((d) => d.key).sort(), ['dbPath', 'epochDays']);
});

test('不合规的改动整次拒绝，不产生半份配置', () => {
  const r = validateChange({ hotBytes: 4096 }, 'hotBytes', -1);
  assert.equal(r.ok, false);
  assert.equal(r.merged, undefined);
});

test('面板上的每个 k: 字面量都必须在这张表里', () => {
  // 防的是「面板加了控件、校验表没跟上」——那样新控件写进去的值没人管
  const client = fs.readFileSync(path.join(here, '../../loom-dsh/client.js'), 'utf8');
  const keys = new Set();
  for (const m of client.matchAll(/\bk:\s*'([A-Za-z0-9_]+)'/g)) keys.add(m[1]);
  assert.ok(keys.size > 5, '没扫到 k: 字面量，正则或文件位置可能变了');
  const missing = [...keys].filter((k) => !SETTING_KEYS.includes(k));
  assert.deepEqual(missing, [], '这些键在面板上能改，但 SETTING_SPECS 里没有');
});

test('每个规格都写了 why，将来加键不会只剩一个裸类型', () => {
  for (const [k, spec] of Object.entries(SETTING_SPECS)) {
    assert.ok(typeof spec.why === 'string' && spec.why.length > 8, `${k} 缺少 why`);
  }
});
