// 检索过滤的回归：默认不返回 tool，显式传 roles 才给
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../../loom-dsh/index.js';

function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-role-'));
  const tools = new Map();
  const listeners = new Map();
  const routes = new Map();
  const cleanups = [];
  const web = { register: (r) => (routes.set(r.path, r), () => {}), tapIndex: () => () => {} };
  const base = {
    tools: { register: (d) => tools.set(d.name, d) },
    effect: (fn) => {
      const d = fn();
      if (typeof d === 'function') cleanups.push(d);
      return d;
    },
    on: (e, fn) => (listeners.set(e, fn), () => {}),
    get: (n) => (n === 'webServer' ? web : undefined),
    inject: (deps, cb) => cb(base),
  };
  const ctx = new Proxy(base, {
    get(t, k) {
      if (typeof k === 'symbol' || k === 'then') return undefined;
      if (k in t) return t[k];
      throw new Error('no ' + String(k));
    },
  });
  apply(ctx, { dbPath: path.join(dir, 'loom.db') });
  return { dir, tools, listeners, routes, cleanups };
}

const ask = async (routes, url) => {
  let out = '';
  await routes.get('/loom/archive').handler({ url }, { writeHead: () => {}, end: (b) => (out = b) });
  return JSON.parse(out);
};

test('默认检索排除 tool 输出，显式可要回', async () => {
  const { dir, listeners, routes, cleanups } = boot();
  const emit = (type, data) => listeners.get('session/event')({}, { type, data, seq: 1, time: Date.now() });

  emit('user/message', { role: 'user', content: '发布流程是先灰度再全量。' });
  emit('tool/result', { message: { role: 'tool', content: [{ type: 'text', text: '灰度 的搜索结果：一堆日志' }] } });

  const def = await ask(routes, '/loom/archive?q=灰度');
  assert.equal(def.hits.every((h) => h.role !== 'tool'), true, '默认不该返回 tool');
  assert.ok(def.hits.some((h) => h.role === 'user'), '应返回对话原文');

  const all = await ask(routes, '/loom/archive?q=灰度&roles=user,assistant,tool');
  assert.ok(all.hits.some((h) => h.role === 'tool'), '显式要 tool 时应返回');

  for (const c of cleanups) c();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('存储没变：tool 输出仍然在归档里', async () => {
  const { dir, tools, listeners, cleanups } = boot();
  listeners.get('session/event')({}, {
    type: 'tool/result',
    data: { message: { role: 'tool', content: [{ type: 'text', text: '工具输出内容' }] } },
    seq: 1,
    time: Date.now(),
  });
  const hit = await tools.get('memory_archive_search').execute({ query: '工具输出内容' }, {});
  assert.ok(hit.total >= 1, '底层检索应能拿到 tool 内容（存储不变）');
  for (const c of cleanups) c();
  fs.rmSync(dir, { recursive: true, force: true });
});
