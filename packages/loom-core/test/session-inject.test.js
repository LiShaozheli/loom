// 会话隔离（完整版）：注入按会话、归档按会话
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../../loom-dsh/index.js';

function boot(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-iso2-'));
  const tools = new Map();
  const listeners = new Map();
  const sections = [];
  const cleanups = [];

  const makeSp = () => ({ section: (spec) => (sections.push(spec), () => {}) });

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
    get: (n) => (n === 'systemPrompt' ? makeSp() : undefined),
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

  // 模拟宿主：agent/created 收到一个新 agent
  const createAgent = (id) => {
    const agentSections = [];
    const agent = {
      id,
      ctx: {
        effect: (fn) => fn(),
        get: (n) => (n === 'systemPrompt' ? { section: (spec) => (agentSections.push(spec), () => {}) } : undefined),
      },
    };
    listeners.get('agent/created')?.({ agent });
    return agentSections;
  };

  return { dir, call, createAgent, sections, listeners, cleanups };
}

test('注入按会话过滤：A 看不到 B 的记忆', async () => {
  const { dir, call, createAgent, sections, cleanups } = boot({ memoryScope: 'session' });
  await call('memory_write', { line: '会话 A 的事实：端口 8081。', kind: 'fact' }, 'sess-A');
  await call('memory_write', { line: '会话 B 的事实：端口 9090。', kind: 'fact' }, 'sess-B');

  const aSections = createAgent('sess-A');
  const bSections = createAgent('sess-B');
  assert.equal(aSections.length, 1, 'A 应拿到自己的注入段');
  assert.equal(bSections.length, 1, 'B 应拿到自己的注入段');

  const aText = aSections[0].text();
  const bText = bSections[0].text();
  assert.ok(aText.includes('8081'), 'A 的注入应含自己的记忆');
  assert.equal(aText.includes('9090'), false, 'A 不该看到 B 的记忆');
  assert.ok(bText.includes('9090'));
  assert.equal(bText.includes('8081'), false);

  for (const c of cleanups) c();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('shared 模式下注入仍是共享的', async () => {
  const { dir, call, createAgent, cleanups } = boot();
  await call('memory_write', { line: '会话 A 的事实：端口 8081。', kind: 'fact' }, 'sess-A');
  await call('memory_write', { line: '会话 B 的事实：端口 9090。', kind: 'fact' }, 'sess-B');

  const aSections = createAgent('sess-A');
  const text = aSections[0].text();
  assert.ok(text.includes('8081') && text.includes('9090'), 'shared 下两边都能看到');

  for (const c of cleanups) c();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('归档检索按会话过滤', async () => {
  const { dir, listeners, call, cleanups } = boot({ memoryScope: 'session' });
  const emit = (sessionId, text) =>
    listeners.get('session/event')({ id: sessionId }, { type: 'user/message', data: { role: 'user', content: text }, seq: 1, time: Date.now() });

  emit('sess-A', 'A 说的：灰度 10%');
  emit('sess-B', 'B 说的：灰度 50%');

  const a = await call('memory_archive_search', { query: '灰度' }, 'sess-A');
  const texts = a.hits.map((h) => h.text).join(' ');
  assert.ok(texts.includes('10%'), 'A 应搜到自己的');
  assert.equal(texts.includes('50%'), false, 'A 不该搜到 B 的');

  for (const c of cleanups) c();
  fs.rmSync(dir, { recursive: true, force: true });
});
