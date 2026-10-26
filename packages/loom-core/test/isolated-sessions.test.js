/**
 * 「把某一个对话设成独立记忆」这条链路。
 *
 * 之前只有一个全局开关 memoryScope，用户找不到"就这一个对话独立"在哪儿设。
 * 现在多了名单 isolatedSessions：面板上一个下拉框选对话，点添加就写进配置。
 *
 * 这里测的是完整链路：列表 -> 点添加 -> configEditor 落盘 -> 立刻按新范围召回。
 * 只测函数不测链路的话，"写进去了但没生效"这种错漏得掉。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../../loom-dsh/index.js';

function boot(extra = {}, services = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-iso2-'));
  const tools = new Map();
  const routes = new Map();
  const listeners = new Map();
  const web = { register: (r) => (routes.set(r.path, r), () => {}), tapIndex: () => () => {} };
  const cleanups = [];
  const base = {
    tools: { register: (d) => tools.set(d.name, d) },
    effect: (fn) => {
      const d = fn();
      if (typeof d === 'function') cleanups.push(d);
      return d;
    },
    // 以前这里直接吞掉 handler，于是归档钩子永远收不到事件，
    // /loom/sessions 数出来的 messages 恒为 0。现在收下来，测试可以真的发事件。
    on: (event, fn) => (listeners.set(event, fn), () => {}),
    get: (n) => (n === 'webServer' ? web : services[n]),
    inject: (deps, cb) => cb(base),
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
  const emit = (event, ...payload) => listeners.get(event)?.(...payload);
  const done = () => {
    for (const c of cleanups) c();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { dir, tools, routes, call, emit, done };
}

/** 起一个假的 res，收集状态码与 body */
function sink() {
  const got = { status: 0, headers: {}, body: '' };
  return {
    got,
    res: {
      writeHead: (code, headers) => {
        got.status = code;
        got.headers = headers ?? {};
      },
      end: (b) => (got.body = String(b ?? '')),
    },
  };
}

function postReq(obj) {
  const payload = Buffer.from(JSON.stringify(obj));
  return { method: 'POST', url: '/', [Symbol.asyncIterator]: async function* () { yield payload; } };
}

function getReq(url) {
  return { method: 'GET', url, [Symbol.asyncIterator]: async function* () {} };
}

/** 假的 configEditor：把内存对象当配置文件 */
function fakeEditor(store = {}) {
  const entry = { options: { id: 'loom-memory' } };
  return {
    store,
    editor: {
      entries: () => [entry],
      edit: async (_entry, change) => Object.assign(store, change({ ...store })),
    },
  };
}

test('名单里的会话独立，名单外的照旧共享', async () => {
  const { call, done } = boot({ isolatedSessions: ['sess-B'] });
  await call('memory_write', { line: '会话 A：端口 8081。', kind: 'fact' }, 'sess-A');
  await call('memory_write', { line: '会话 B：端口 9090。', kind: 'fact' }, 'sess-B');
  await call('memory_write', { line: '公共事实：发布走灰度。', kind: 'fact' }, null);

  assert.equal((await call('memory_stats', {}, 'sess-A')).total, 3, 'A 没被点名，仍是共享');
  assert.equal((await call('memory_stats', {}, 'sess-B')).total, 2, 'B 只该看到自己 + 公共');

  const outline = await call('memory_outline', {}, 'sess-B');
  assert.equal(JSON.stringify(outline.groups).includes('8081'), false, 'B 不该看到 A 的条目');
  done();
});

test('全局 memoryScope=session 仍然管用（老开关不丢）', async () => {
  const { call, done } = boot({ memoryScope: 'session' });
  await call('memory_write', { line: '会话 A：端口 8081。', kind: 'fact' }, 'sess-A');
  await call('memory_write', { line: '会话 B：端口 9090。', kind: 'fact' }, 'sess-B');
  assert.equal((await call('memory_stats', {}, 'sess-A')).total, 1);
  assert.equal((await call('memory_stats', {}, 'sess-B')).total, 1);
  done();
});

test('/loom/sessions 用宿主的会话列表和标题', async () => {
  const sessionQuery = {
    async listSessions() {
      return [
        { header: { id: 'sess-A', createdAt: 100 }, live: true, persisted: true },
        { header: { id: 'sess-B', createdAt: 200 }, live: false, persisted: true },
        { header: { id: 'sub-1', createdAt: 300, parentSession: 'sess-A', origin: 'subagent' }, live: false, persisted: true },
      ];
    },
    async readTitleSnapshots(ids) {
      return ids.map((id) => ({
        sessionId: id,
        status: 'fulfilled',
        value: { session: { id }, title: { title: '标题-' + id, eventSeq: 1, updatedAt: 1, messageSeqs: [], source: { kind: 'user' } } },
      }));
    },
  };
  const { routes, call, emit, done } = boot({ isolatedSessions: ['sess-B'] }, { sessionQuery });
  await call('memory_write', { line: '来自 A 的一条。', kind: 'fact' }, 'sess-A');
  // 归档计数只来自 session/event：发一条真实的用户消息，sess-A 才该数出 1 条
  emit('session/event', { id: 'sess-A' }, { type: 'user/message', data: { content: '来自 A 的一条。' } });

  const { got, res } = sink();
  await routes.get('/loom/sessions').handler(getReq('/loom/sessions'), res);
  assert.equal(got.status, 200, got.body);
  const data = JSON.parse(got.body);
  assert.equal(data.ok, true);
  assert.equal(data.source, 'sessionQuery');
  const ids = data.sessions.map((s) => s.id);
  assert.deepEqual(ids.sort(), ['sess-A', 'sess-B'], '子代理会话不该出现在可选的列表里');
  const b = data.sessions.find((s) => s.id === 'sess-B');
  assert.equal(b.title, '标题-sess-B', '有真标题就用真标题');
  assert.equal(b.isolated, true, '名单里的要标成独立');
  const a = data.sessions.find((s) => s.id === 'sess-A');
  assert.equal(a.isolated, false);
  assert.equal(a.messages, 1, '归档里能数出这个会话有几条');
  done();
});

test('/loom/sessions 没有 sessionQuery 时退回归档里的会话', async () => {
  const { routes, call, done } = boot();
  await call('memory_write', { line: '随便一条。', kind: 'fact' }, 'sess-Z');
  // 归档只由 session/event 写入，这里没经过事件流，所以列表应为空但不报错
  const { got, res } = sink();
  await routes.get('/loom/sessions').handler(getReq('/loom/sessions'), res);
  assert.equal(got.status, 200);
  const data = JSON.parse(got.body);
  assert.equal(data.ok, true);
  assert.equal(data.source, 'archive', '没有 sessionQuery 就该走退路');
  assert.ok(Array.isArray(data.sessions));
  done();
});

test('/loom/isolate 写进配置、并且立刻生效', async () => {
  const { editor, store } = fakeEditor();
  const { routes, call, done } = boot({}, { configEditor: editor });
  await call('memory_write', { line: '会话 A：端口 8081。', kind: 'fact' }, 'sess-A');
  await call('memory_write', { line: '会话 B：端口 9090。', kind: 'fact' }, 'sess-B');

  assert.equal((await call('memory_stats', {}, 'sess-B')).total, 2, '一开始是共享的');

  let { got, res } = sink();
  await routes.get('/loom/isolate').handler(postReq({ id: 'sess-B', isolated: true }), res);
  assert.equal(got.status, 200, got.body);
  assert.deepEqual(JSON.parse(got.body).isolatedSessions, ['sess-B']);
  assert.deepEqual(store.isolatedSessions, ['sess-B'], '要落盘到配置里，不是只存在内存');

  // 不等重启：同一次 apply 里就该按新范围过滤
  assert.equal((await call('memory_stats', {}, 'sess-B')).total, 1, 'B 立刻只看自己');
  assert.equal((await call('memory_stats', {}, 'sess-A')).total, 2, 'A 不受影响');

  ({ got, res } = sink());
  await routes.get('/loom/isolate').handler(postReq({ id: 'sess-B', isolated: false }), res);
  assert.equal(got.status, 200, got.body);
  assert.deepEqual(store.isolatedSessions, [], '移出后数组要空');
  assert.equal((await call('memory_stats', {}, 'sess-B')).total, 2, '回到共享');

  done();
});

test('/loom/isolate 不会把已有的名单冲掉', async () => {
  const { editor, store } = fakeEditor({ isolatedSessions: ['old-1'] });
  const { routes, done } = boot({}, { configEditor: editor });
  const { got, res } = sink();
  await routes.get('/loom/isolate').handler(postReq({ id: 'new-2', isolated: true }), res);
  assert.equal(got.status, 200, got.body);
  assert.deepEqual(store.isolatedSessions.sort(), ['new-2', 'old-1'], '要在现有数组上增删，不是覆盖');
  done();
});

test('/loom/isolate 拒绝空 id，也不在没有 configEditor 时静默成功', async () => {
  const { editor } = fakeEditor();
  const { routes, done } = boot({}, { configEditor: editor });
  let { got, res } = sink();
  await routes.get('/loom/isolate').handler(postReq({ id: '   ' }), res);
  assert.equal(got.status, 400);
  assert.equal(JSON.parse(got.body).ok, false);
  done();

  const bare = boot();
  ({ got, res } = sink());
  await bare.routes.get('/loom/isolate').handler(postReq({ id: 'x', isolated: true }), bare.res ? bare.res : res);
  assert.equal(got.status, 503, '没有 configEditor 必须明确报错，不能假装成功');
  bare.done();
});
