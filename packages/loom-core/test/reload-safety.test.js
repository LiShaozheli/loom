// 重载安全：宿主重载插件（改设置、换配置）时，两个实例会短暂并存。
// 历史上这里出过一次事故：旧实例 dispose 时关掉了共享的 SQLite 连接，
// 而挂在 agent 上的热记忆 section 还握着旧连接，于是下一轮装 prompt 时抛
// "database is not open"，整轮在调用模型之前就失败了（账单也没有记录）。
// 这组用例把五类回归钉住：section 跟随当前实例、库坏掉不能抛、
// 路由不因重载重复注册、webServer 的 duplicate 必须被当成"已挂上"、
// 以及卸载期间的请求要给 503 而不是空响应。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../../loom-dsh/index.js';

/** 进程里只有一个 webServer：路由会跨插件重载一直留在它上面，重复注册会抛 */
function makeServer() {
  const routes = new Map();
  const taps = [];
  return {
    routes,
    taps,
    register(spec) {
      if (routes.has(spec.path)) {
        throw new Error(`webserver: duplicate exact route "${spec.path}"`);
      }
      routes.set(spec.path, spec);
      return () => {};
    },
    tapIndex(fn) {
      taps.push(fn);
      return () => {};
    },
  };
}

function boot(dbPath, server = makeServer()) {
  const web = server;
  const tools = new Map();
  const routes = new Map();
  const sections = [];
  const cleanups = [];
  const sp = { section: (spec) => (sections.push(spec), () => {}) };
  const base = {
    tools: { register: (d) => (tools.set(d.name, d), () => {}) },
    effect: (fn) => {
      const d = fn();
      if (typeof d === 'function') cleanups.push(d);
      return d;
    },
    on: () => () => {},
    get: (n) => (n === 'webServer' ? web : n === 'systemPrompt' ? sp : undefined),
    inject: (deps, cb) => cb(base),
  };
  const ctx = new Proxy(base, {
    get(t, k) {
      if (typeof k === 'symbol' || k === 'then') return undefined;
      if (k in t) return t[k];
      throw new Error('no ' + String(k));
    },
  });
  apply(ctx, { dbPath, hot: true });
  return {
    tools,
    routes,
    sections,
    server,
    dispose: () => cleanups.forEach((c) => c()),
    hotText: () => sections.filter((s) => s.name === 'loom-hot-memory').map((s) => s.text()).join(''),
  };
}

/** 起一个假的 res，收集状态码与 body */
function sink() {
  const got = { status: 0, body: '' };
  return {
    got,
    res: { writeHead: (c) => (got.status = c), end: (x) => (got.body = String(x ?? '')) },
  };
}

function withDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-reload-'));
  return Promise.resolve(fn(path.join(dir, 'loom.db'))).finally(() =>
    fs.rmSync(dir, { recursive: true, force: true })
  );
}

test('旧实例 dispose 之后，它的 section 读到的是新实例的热记忆', () =>
  withDb(async (dbPath) => {
    const a = boot(dbPath);
    await a.tools.get('memory_write').execute({ line: '验证：来自实例 A。', kind: 'fact' }, {});
    assert.match(a.hotText(), /来自实例 A/, '实例 A 应该读到自己的热记忆');

    // 模拟宿主重载：新实例接管同一个库
    const b = boot(dbPath);
    await b.tools.get('memory_write').execute({ line: '验证：重载之后新写的一条。', kind: 'fact' }, {});

    a.dispose(); // 引用计数只减不关，连接仍然可用

    assert.doesNotThrow(() => a.hotText(), '旧 section 绝不能抛 database is not open');
    assert.match(a.hotText(), /重载之后新写的一条/, '旧 section 应该读到当前实例的热记忆');

    b.dispose();
  }));

test('库真的断开时，热记忆 section 降级为空串而不是让整轮失败', () =>
  withDb(async (dbPath) => {
    const a = boot(dbPath);
    await a.tools.get('memory_write').execute({ line: '验证：断库前的一条。', kind: 'fact' }, {});
    assert.match(a.hotText(), /断库前的一条/);

    // 直接掐掉共享连接，等价于"句柄被关掉"的现场
    const rec = globalThis.__LOOM_SHARED__.ledgers.get(path.resolve(dbPath));
    assert.ok(rec, '共享连接应该登记在 SHARED.ledgers 里');
    rec.ledger.close();

    let threw = null;
    try {
      a.hotText();
    } catch (err) {
      threw = err;
    }
    assert.equal(threw, null, '装 prompt 时不允许抛：记忆是增强，不是前提');
    assert.equal(a.hotText(), '', '读不到就给空串');

    a.dispose();
  }));

test('库断开后路由给出可读错误，而不是空响应', () =>
  withDb(async (dbPath) => {
    const a = boot(dbPath);
    const rec = globalThis.__LOOM_SHARED__.ledgers.get(path.resolve(dbPath));
    rec.ledger.close();

    const { got, res } = sink();
    await a.server.routes.get('/loom/state').handler({ method: 'GET', url: '/loom/state' }, res);
    assert.ok(got.status >= 500, `应该是 5xx，实际 ${got.status}`);
    assert.ok(got.body.length > 0, '浏览器绝不能收到 ERR_EMPTY_RESPONSE');
    assert.match(got.body, /database is not open/);

    a.dispose();
  }));

test('重载不会在 webServer 上重复注册，handler 永远指向最新实例', () =>
  withDb(async (dbPath) => {
    const server = makeServer();
    const a = boot(dbPath, server);
    const pathsA = [...server.routes.keys()];
    assert.ok(pathsA.includes('/loom/state'));

    // 第二次 apply 走的是同一个 webServer：注册会被判重复，必须被吞掉而不是抛穿
    let threw = null;
    let b = null;
    try {
      b = boot(dbPath, server);
    } catch (err) {
      threw = err;
    }
    assert.equal(threw, null, `重载不该把 duplicate exact route 抛出来：${threw?.message ?? ''}`);
    assert.deepEqual([...server.routes.keys()].sort(), pathsA.slice().sort(), '路由集合不变，也没有重复');

    // 分发经过 SHARED.routes，所以要落到新实例上
    const { got, res } = sink();
    await server.routes.get('/loom/state').handler({ method: 'GET', url: '/loom/state' }, res);
    assert.equal(got.status, 200, got.body);

    a.dispose();
    // 新实例还活着，路由必须继续可用（不是 503）
    const after = sink();
    await server.routes.get('/loom/state').handler({ method: 'GET', url: '/loom/state' }, after.res);
    assert.equal(after.got.status, 200, after.got.body);

    b.dispose();
  }));

test('插件卸载期间路由给出 503，重新加载后复用旧路由继续服务', () =>
  withDb(async (dbPath) => {
    const server = makeServer();
    const a = boot(dbPath, server);
    assert.equal(server.routes.size, 10);

    // 卸载：SHARED.live 置空，但路由还挂在 webServer 上
    a.dispose();
    const gap = sink();
    await server.routes.get('/loom/state').handler({ method: 'GET', url: '/loom/state' }, gap.res);
    assert.equal(gap.got.status, 503, '卸载期间应该是可读的 503，而不是空响应');
    assert.match(gap.got.body, /停用|重载/);

    // 重新加载：10 条全部撞 duplicate exact route，必须安静吞掉
    let threw = null;
    let b = null;
    try {
      b = boot(dbPath, server);
    } catch (err) {
      threw = err;
    }
    assert.equal(threw, null, `duplicate 不能抛出来：${threw?.message ?? ''}`);
    assert.equal(server.routes.size, 10, '路由集合不变，也没有重复');

    const after = sink();
    await server.routes.get('/loom/state').handler({ method: 'GET', url: '/loom/state' }, after.res);
    assert.equal(after.got.status, 200, after.got.body);

    b.dispose();
  }));
