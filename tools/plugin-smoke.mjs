#!/usr/bin/env node
/**
 * 插件冒烟测试：不起宿主，直接给 apply() 一个假 ctx，验证工具契约。
 *
 *   node tools/plugin-smoke.mjs
 *
 * 这不是"插件在真实会话里能用"，只证明工具定义、参数、返回、落库都通。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../packages/loom-dsh/index.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-plugin-'));
const registered = [];
const cleanups = [];

const ctx = {
  tools: {
    register(def) {
      registered.push(def);
      return () => {};
    },
  },
  effect(fn) {
    const d = fn();
    if (typeof d === 'function') cleanups.push(d);
    return d;
  },
};

apply(ctx, { dbPath: path.join(dir, 'loom.db'), budget: 200 });

console.log('注册的工具：', registered.map((t) => t.name).join(', '));

const call = (name, args) => registered.find((t) => t.name === name).execute(args, {});

const w1 = await call('memory_write', {
  line: '改鉴权→JWT，refresh轮换→登录失败，故回滚session。@2026-10-24 #12 !',
  body: '登录接口改造试过 JWT，因 refresh 轮换失败回滚。',
  kind: 'decision',
});
console.log('\nmemory_write →', JSON.stringify(w1));

const w2 = await call('memory_write', {
  line: '路径拼接导致配置读取失败，已修复。@2026-10-22 #44 ?',
  original: 'Win 上路径拼接用正斜杠导致 ENOENT，修复用 path.join。',
});
console.log('memory_write（碎片稿）→', JSON.stringify(w2));

const w3 = await call('memory_write', {
  line: '预发端口 8081；上线前必跑 smoke。 @2026-10-26 #用户口述 高',
});
console.log('memory_write（汉字置信）→', JSON.stringify(w3));

const r = await call('memory_recall', { query: '上次 JWT 那个方案为什么回滚？' });
console.log('\nmemory_recall →', JSON.stringify(r, null, 2));

const s = await call('memory_stats', {});
console.log('\nmemory_stats →', JSON.stringify(s));

const ok =
  w1.ok === true &&
  w2.ok === false &&
  w3.ok === true &&
  r.items.some((i) => i.text.includes('JWT'));
for (const c of cleanups) c();
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n冒烟：${ok ? 'PASS' : 'FAIL'}`);
process.exit(ok ? 0 : 1);
