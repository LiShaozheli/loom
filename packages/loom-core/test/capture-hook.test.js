import { test } from 'node:test';
import assert from 'node:assert/strict';
// 自动捕获的回归测试：捕获走 session/event（pre-step 在真实宿主里没触发过）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../../loom-dsh/index.js';

function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-cap-'));
  const tools = new Map();
  const listeners = new Map();
  const cleanups = [];
  const base = {
    tools: { register: (d) => tools.set(d.name, d) },
    effect: (fn) => {
      const d = fn();
      if (typeof d === 'function') cleanups.push(d);
      return d;
    },
    on: (e, fn) => {
      listeners.set(e, fn);
      return () => {};
    },
    get: () => undefined,
    inject: () => {},
  };
  const ctx = new Proxy(base, {
    get(t, k) {
      if (typeof k === 'symbol' || k === 'then') return undefined;
      if (k in t) return t[k];
      throw new Error('no ' + String(k));
    },
  });
  apply(ctx, { dbPath: path.join(dir, 'loom.db') });
  return { dir, tools, listeners, cleanups };
}

const emitUser = (listeners, text, seq = 1) =>
  listeners.get('session/event')({}, { type: 'user/message', data: { role: 'user', content: text }, seq, time: Date.now() });

test('用户陈述事实 → 自动写一条 claim', async () => {
  const { dir, tools, listeners, cleanups } = boot();
  const step = listeners.get('session/event');
  assert.ok(step, '应注册 session/event 监听器');

  const before = (await tools.get('memory_stats').execute({}, {})).total;
  emitUser(listeners, '这个项目用 pnpm 管依赖，我不喜欢写太多注释。');
  const after = (await tools.get('memory_stats').execute({}, {})).total;
  assert.equal(after, before + 1, '应新增一条记忆');

  emitUser(listeners, '好的');
  emitUser(listeners, '这个怎么配？');
  const after2 = (await tools.get('memory_stats').execute({}, {})).total;
  assert.equal(after2, after, '寒暄与问句不该写成记忆');

  for (const c of cleanups) c();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('捕获同时把原文归档进去', async () => {
  const { dir, tools, listeners, cleanups } = boot();
  emitUser(listeners, '发布流程是先灰度再全量。');
  const hit = await tools.get('memory_archive_search').execute({ query: '灰度' }, {});
  assert.ok(hit.total >= 1, '原文应可检索');
  for (const c of cleanups) c();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('自动捕获可以关掉', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-capoff-'));
  const tools = new Map();
  const listeners = new Map();
  const cleanups = [];
  const base = {
    tools: { register: (d) => tools.set(d.name, d) },
    effect: (fn) => {
      const d = fn();
      if (typeof d === 'function') cleanups.push(d);
      return d;
    },
    on: (e, fn) => {
      listeners.set(e, fn);
      return () => {};
    },
    get: () => undefined,
    inject: () => {},
  };
  const ctx = new Proxy(base, {
    get(t, k) {
      if (typeof k === 'symbol' || k === 'then') return undefined;
      if (k in t) return t[k];
      throw new Error('no ' + String(k));
    },
  });
  apply(ctx, { dbPath: path.join(dir, 'loom.db'), autoCapture: false });
  const before = (await tools.get('memory_stats').execute({}, {})).total;
  emitUser(listeners, '这个项目用 pnpm 管依赖。');
  const after = (await tools.get('memory_stats').execute({}, {})).total;
  assert.equal(after, before, '关掉后不该写 claim');
  for (const c of cleanups) c();
  fs.rmSync(dir, { recursive: true, force: true });
});
