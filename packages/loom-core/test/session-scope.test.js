// 会话隔离：写入带 session、召回按会话过滤
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../../loom-dsh/index.js';

function boot(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-iso-'));
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
  apply(ctx, { dbPath: path.join(dir, 'loom.db'), ...extra });
  const call = (name, args, session) =>
    tools.get(name).execute(args, { agent: session ? { id: session } : undefined });
  return { dir, call, listeners, cleanups };
}

test('shared 模式：所有会话看到同一份记忆', async () => {
  const { dir, call, cleanups } = boot();
  await call('memory_write', { line: '会话 A 的事实：端口 8081。', kind: 'fact' }, 'sess-A');
  await call('memory_write', { line: '会话 B 的事实：端口 9090。', kind: 'fact' }, 'sess-B');

  const a = await call('memory_stats', {}, 'sess-A');
  assert.equal(a.total, 2, 'shared 模式下两边都看得到');

  for (const c of cleanups) c();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('session 模式：只看本会话 + 全局', async () => {
  const { dir, call, cleanups } = boot({ memoryScope: 'session' });

  await call('memory_write', { line: '会话 A 的事实：端口 8081。', kind: 'fact' }, 'sess-A');
  await call('memory_write', { line: '会话 B 的事实：端口 9090。', kind: 'fact' }, 'sess-B');
  await call('memory_write', { line: '全局事实：发布走灰度。', kind: 'fact' }, null);

  const a = await call('memory_stats', {}, 'sess-A');
  const b = await call('memory_stats', {}, 'sess-B');
  assert.equal(a.total, 2, 'A 应看到自己 + 全局');
  assert.equal(b.total, 2, 'B 应看到自己 + 全局');

  const aOutline = await call('memory_outline', {}, 'sess-A');
  assert.equal(JSON.stringify(aOutline.groups).includes('9090'), false, 'A 不该看到 B 的条目');

  for (const c of cleanups) c();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('条目确实带上了 sessionId', async () => {
  const { dir, call, cleanups } = boot({ memoryScope: 'session' });
  await call('memory_write', { line: '带会话标记的一条。', kind: 'fact' }, 'sess-X');
  const stats = await call('memory_stats', {}, 'sess-X');
  assert.equal(stats.total, 1);
  for (const c of cleanups) c();
  fs.rmSync(dir, { recursive: true, force: true });
});
