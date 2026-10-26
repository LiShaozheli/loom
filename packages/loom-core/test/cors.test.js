/**
 * CORS 预检的回归测试。
 *
 * 真实故障：面板在 dsh-app:// 上 POST JSON，浏览器先发 OPTIONS。
 * 204 响应里没有 access-control-allow-headers，预检失败，
 * 于是点了「遗忘」只看到 "Failed to fetch"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../../loom-dsh/index.js';

function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-cors-'));
  const tools = new Map();
  const routes = new Map();
  const web = { register: (r) => (routes.set(r.path, r), () => {}), tapIndex: () => () => {} };
  const cleanups = [];
  const base = {
    tools: { register: (d) => tools.set(d.name, d) },
    effect: (fn) => {
      const d = fn();
      if (typeof d === 'function') cleanups.push(d);
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
  return { dir, tools, routes, cleanups };
}

function preflight(route) {
  const captured = { status: 0, headers: {} };
  const res = {
    writeHead: (code, headers) => {
      captured.status = code;
      captured.headers = headers ?? {};
    },
    end: () => {},
  };
  route.handler({ method: 'OPTIONS', url: '/', headers: {} }, res);
  return captured;
}

test('所有 POST 路由的预检都允许 content-type', () => {
  const { dir, routes, cleanups } = boot();
  const posts = ['/loom/forget', '/loom/doc-save', '/loom/import', '/loom/config'];
  for (const p of posts) {
    const route = routes.get(p);
    assert.ok(route, `${p} 未注册`);
    const r = preflight(route);
    assert.equal(r.status, 204, `${p} 预检状态码`);
    assert.equal(r.headers['access-control-allow-origin'], '*', `${p} 缺 allow-origin`);
    const allowHeaders = String(r.headers['access-control-allow-headers'] ?? '').toLowerCase();
    assert.ok(allowHeaders.includes('content-type'), `${p} 预检缺 allow-headers: content-type`);
    assert.ok(String(r.headers['access-control-allow-methods']).includes('POST'), `${p} 缺 allow-methods`);
  }
  for (const c of cleanups) c();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('实际响应也带 allow-origin', async () => {
  const { dir, routes, tools, cleanups } = boot();
  const w = await tools.get('memory_write').execute({ line: '临时一条。', kind: 'fact' }, {});
  const captured = { status: 0, headers: {}, body: '' };
  const res = {
    writeHead: (code, headers) => {
      captured.status = code;
      captured.headers = headers ?? {};
    },
    end: (b) => (captured.body = b),
  };
  const payload = Buffer.from(JSON.stringify({ id: w.id.slice(0, 8) }));
  const req = { method: 'POST', [Symbol.asyncIterator]: async function* () { yield payload; } };
  await routes.get('/loom/forget').handler(req, res);
  assert.equal(captured.status, 200, captured.body);
  assert.equal(captured.headers['access-control-allow-origin'], '*');
  assert.ok(JSON.parse(captured.body).ok);
  for (const c of cleanups) c();
  fs.rmSync(dir, { recursive: true, force: true });
});
