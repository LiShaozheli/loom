import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Client 半的契约测试：不跑浏览器，只验证它按 ModuleLoader 的格式注册了两样东西。
 *
 * 这一层能抓的错：工厂形状不对、slot 名写错、id 与 key 不一致、返回值不是 apply/inject。
 * 抓不到的：真实渲染、真实样式、真实 RPC。那些只能重启看。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const clientPath = path.resolve(here, '../../loom-dsh/client.js');

function loadClient() {
  const source = fs.readFileSync(clientPath, 'utf8');
  let captured = null;

  const fakeReact = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (init) => [init, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
  };

  const g = {
    window: {
      __ModuleLoader__: {
        load(def) {
          captured = def;
        },
      },
    },
  };

  // 用一个独立的函数作用域跑客户端代码，避免污染全局
  const run = new Function('window', 'require', `${source}\n`);
  run(g.window, (name) => {
    if (name === 'react') return fakeReact;
    throw new Error(`unexpected require: ${name}`);
  });

  return captured;
}

test('client.js 用 ModuleLoader.load 注册，且 id 与包名一致', () => {
  const def = loadClient();
  assert.ok(def, '应当调用 window.__ModuleLoader__.load');
  assert.equal(def.id, 'loom-memory');
  assert.equal(typeof def.factory, 'function');
});

test('工厂返回 { inject, apply }，apply 里注册 panellist 图标与 main 面板', () => {
  const def = loadClient();
  const body = def.factory((name) => {
    if (name === 'react') {
      return {
        createElement: (t, p, ...c) => ({ t, p, c }),
        useState: (i) => [i, () => {}],
        useEffect: () => {},
        useCallback: (f) => f,
      };
    }
    throw new Error(`unexpected require: ${name}`);
  });

  assert.deepEqual(body.inject, ['slots']);
  assert.equal(typeof body.apply, 'function');

  const registrations = [];
  const ctx = {
    slots: {
      inject(slot, fn) {
        fn();
      },
      register(options, Component) {
        registrations.push({ options, Component });
      },
    },
  };

  body.apply(ctx);

  const names = registrations.map((r) => r.options.name);
  assert.deepEqual(names, ['sidebar.panellist', 'main']);

  const icon = registrations[0].options;
  const panel = registrations[1].options;
  assert.equal(icon.id, 'loom', 'panellist 用 id');
  assert.equal(typeof icon.label === 'function' || typeof icon.label === 'string', true);
  assert.equal(panel.key, icon.id, 'main 的 key 必须与 panellist 的 id 一致');
  assert.equal(panel.key, 'loom');
});

test('两个组件都是函数（可渲染）', () => {
  const def = loadClient();
  const body = def.factory((name) =>
    name === 'react'
      ? { createElement: () => null, useState: (i) => [i, () => {}], useEffect: () => {}, useCallback: (f) => f }
      : null
  );
  const regs = [];
  body.apply({
    slots: { inject: (_s, fn) => fn(), register: (o, C) => regs.push(C) },
  });
  assert.equal(typeof regs[0], 'function');
  assert.equal(typeof regs[1], 'function');
});
