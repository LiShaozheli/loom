/**
 * /loom/config 写入路径的回归测试。
 *
 * 真实故障：面板把 hotBytes 手滑成 409600，旧代码原样写进配置，
 * 下一次启动每轮往上下文里塞 400KB；改坏了还没有任何提示。
 * 现在要求：不合规的写入必须整次拒绝，磁盘上那份可用的配置一个字节都不能动。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../../loom-dsh/index.js';

function boot(initial = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-cfg-'));
  const routes = new Map();
  const store = { cfg: initial };
  const web = {
    register: (r) => (routes.set(r.path, r), () => {}),
    tapIndex: () => () => {},
    getOrigin: () => 'http://127.0.0.1:2259',
  };
  const editor = {
    entries: () => [{ options: { id: 'loom-memory' } }],
    edit: async (_entry, fn) => {
      store.cfg = fn(store.cfg); // 抛错则这一行不执行，等于没写盘
    },
  };
  const base = {
    tools: { register: () => {} },
    effect: (fn) => fn(),
    on: () => () => {},
    get: (n) => (n === 'webServer' ? web : n === 'configEditor' ? editor : undefined),
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

  const route = routes.get('/loom/config');
  const set = async (key, value) => {
    let status = 0;
    let body = '';
    const res = {
      writeHead: (c) => {
        status = c;
      },
      end: (x) => {
        body = String(x ?? '');
      },
    };
    const req = {
      method: 'POST',
      url: '/loom/config',
      headers: { 'content-type': 'application/json' },
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(JSON.stringify({ key, value }));
      },
    };
    await route.handler(req, res);
    return { status, json: JSON.parse(body || '{}') };
  };
  return { dir, store, set };
}

test('合法值写进去，并原样回报规范化后的值', async () => {
  const { store, set } = boot({ hotBytes: 1024 });
  const r = await set('render', 'xml');
  assert.equal(r.status, 200);
  assert.equal(store.cfg.render, 'xml');
});

test('数字字符串被规范成真数字，不留字符串在配置里', async () => {
  const { store, set } = boot({});
  const r = await set('hotBytes', '4096');
  assert.equal(r.status, 200);
  assert.equal(store.cfg.hotBytes, 4096);
  assert.equal(typeof store.cfg.hotBytes, 'number');
});

test('越界的注入上限被拒，配置一个字节都没动', async () => {
  const { store, set } = boot({ hotBytes: 4096 });
  const before = JSON.stringify(store.cfg);
  const r = await set('hotBytes', 409600);
  assert.equal(r.status, 400);
  assert.match(r.json.error, /256~32768/);
  assert.equal(JSON.stringify(store.cfg), before, '拒绝的写入不能留下任何痕迹');
});

test('epochDays 写成 0 会被拦下（它会让时间片切分除零）', async () => {
  const { set } = boot({});
  const r = await set('epochDays', 0);
  assert.equal(r.status, 400);
});

test('枚举拼错被拒，错误里列出可选值', async () => {
  const { set } = boot({});
  const r = await set('render', 'legand');
  assert.equal(r.status, 400);
  assert.match(r.json.error, /legend/);
});

test('相对路径的库位置被拒（会随 cwd 漂移）', async () => {
  const { set } = boot({});
  const r = await set('dbPath', 'loom.db');
  assert.equal(r.status, 400);
  assert.match(r.json.error, /绝对路径/);
});

test('白名单外的键一律拒绝', async () => {
  const { store, set } = boot({ masterKey: 'keep' });
  const r = await set('masterKey', 'overwrite');
  assert.equal(r.status, 400);
  assert.equal(store.cfg.masterKey, 'keep');
});

test('一次合法写入顺手清掉配置里遗留的坏值，并在 note 里说明', async () => {
  const { store, set } = boot({ hotBytes: 409600, epochDays: 7 });
  const r = await set('render', 'plain');
  assert.equal(r.status, 200);
  assert.equal(store.cfg.hotBytes, undefined, '坏值必须被剔除，回退默认');
  assert.equal(store.cfg.epochDays, 7, '合规的值原样保留');
  assert.match(r.json.note, /修正了 1 个/);
});
