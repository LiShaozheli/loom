/**
 * /loom/* 的访问门禁。
 *
 * 背景：这些路由能读全量记忆（export.zip）、改配置、删记忆、导入（可投毒），
 * 而它们挂在本机 HTTP 端口上 —— 你随便打开的任何一个网页都能 fetch 到。
 * CORS 只决定「响应能不能被读」，挡不住「请求已经执行」，所以必须有令牌。
 *
 * 这里的用例就是把「网页攻击」的三个方向各打一遍。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../../loom-dsh/index.js';

const OWN_ORIGIN = 'http://127.0.0.1:10182';

function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-auth-'));
  const tools = new Map();
  const routes = new Map();
  const web = {
    register: (r) => (routes.set(r.path, r), () => {}),
    tapIndex: () => () => {},
    getOrigin: () => OWN_ORIGIN,
  };
  const base = {
    tools: { register: (d) => tools.set(d.name, d) },
    effect: (fn) => {
      const d = fn();
      return d;
    },
    on: () => () => {},
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
  return { dir, routes };
}

/** 发一个请求，返回 {status, headers, body} */
async function call(route, { method = 'GET', url = '/', headers = {}, body = '' } = {}) {
  const captured = { status: 0, headers: {}, body: '' };
  const res = {
    headersSent: false,
    writeHead(code, h) {
      captured.status = code;
      captured.headers = h ?? {};
      this.headersSent = true;
    },
    end(chunk) {
      if (chunk) captured.body += String(chunk);
    },
  };
  const req = {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      if (body) yield Buffer.from(body);
    },
  };
  await route.handler(req, res);
  return captured;
}

/** 从首屏种子注入里把令牌捞出来（模拟面板页面自己的视角） */
function extractToken() {
  const src = fs.readFileSync(new URL('../../loom-dsh/index.js', import.meta.url), 'utf8');
  const m = src.match(/__LOOM_TOKEN__=\$\{JSON\.stringify\(SHARED\.token\)\}/);
  assert.ok(m, '首屏注入里必须带上令牌');
  // 真实值只能从运行中的注入回调里拿；这里等价地用 SHARED 暴露的方式取一次
  return globalThis.__LOOM_SHARED__.token;
}

test('跨源网页读不到记忆（没有 Origin 放行、没有令牌 403）', async () => {
  const { routes } = boot();
  const r = await call(routes.get('/loom/export.zip'), {
    headers: { origin: 'https://evil.example' },
  });
  assert.equal(r.status, 403);
  assert.match(r.body, /拒绝访问/);
});

test('跨源网页也改不了配置 / 删不掉记忆（写路由同样 403）', async () => {
  const { routes } = boot();
  for (const p of ['/loom/config', '/loom/forget', '/loom/import', '/loom/isolate']) {
    const r = await call(routes.get(p), {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'budget', value: 999, id: 'x', value_on: true }),
    });
    assert.equal(r.status, 403, p + ' 没被挡住');
  }
});

test('沙箱 iframe（Origin: null）也挡', async () => {
  const { routes } = boot();
  const r = await call(routes.get('/loom/state'), { headers: { origin: 'null' } });
  assert.equal(r.status, 403);
});

test('令牌对了就放行（面板就是这么访问的）', async () => {
  const { routes } = boot();
  const token = extractToken(routes);
  const ok = await call(routes.get('/loom/state'), {
    headers: { origin: 'https://evil.example', 'x-loom-token': token },
  });
  assert.equal(ok.status, 200);
  assert.ok(JSON.parse(ok.body).config, '应当拿到快照');
});

test('令牌也能走查询参数（window.open 下载 zip 用）', async () => {
  const { routes } = boot();
  const token = extractToken(routes);
  const r = await call(routes.get('/loom/export.zip'), {
    url: '/loom/export.zip?t=' + token,
    headers: { origin: 'dsh-app://loom' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'application/zip');
});

test('同源页面不需要令牌（宿主自己的 UI）', async () => {
  const { routes } = boot();
  const r = await call(routes.get('/loom/state'), { headers: { origin: OWN_ORIGIN } });
  assert.equal(r.status, 200);
});

test('没有 Origin 的本地调用照常放行（curl / 服务端）', async () => {
  const { routes } = boot();
  const r = await call(routes.get('/loom/state'), { headers: {} });
  assert.equal(r.status, 200);
});

test('错的令牌不放行', async () => {
  const { routes } = boot();
  const r = await call(routes.get('/loom/state'), {
    headers: { origin: 'https://evil.example', 'x-loom-token': 'deadbeef' },
  });
  assert.equal(r.status, 403);
});

test('预检必须放行，且允许 x-loom-token（否则面板跨源请求直接失败）', async () => {
  const { routes } = boot();
  const r = await call(routes.get('/loom/config'), {
    method: 'OPTIONS',
    headers: { origin: 'dsh-app://loom' },
  });
  assert.equal(r.status, 204);
  assert.match(String(r.headers['access-control-allow-headers']), /x-loom-token/);
});

test('令牌跨插件重载保持不变（否则保存一次设置就把页面锁外面）', async () => {
  const { routes } = boot();
  const before = globalThis.__LOOM_SHARED__.token;
  boot(); // 模拟一次插件重载：重新 apply 一份实例
  const after = globalThis.__LOOM_SHARED__.token;
  assert.equal(after, before, '令牌是实例级的话，重载后所有已打开页面都会 403');

  // 重载后的路由仍然认这个令牌
  const r = await call(routes.get('/loom/state'), {
    headers: { origin: 'https://evil.example', 'x-loom-token': before },
  });
  assert.equal(r.status, 200);
});
