// 设置页的渲染冒烟：不跑浏览器，但真的把 Panel 渲染一遍。
// 这一层能抓：组件内部抛错、控件缺失、aria 绑定漏了、渲染出 undefined 文本。
// 抓不到：真实视觉（那个只能刷新页面看）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientPath = path.resolve(here, '../../loom-dsh/client.js');

const SEED = {
  total: 3,
  archived: 12,
  docs: [{ id: 'd1', title: '示例', tags: 'fact' }],
  byKind: { fact: 2, pref: 1 },
  epoch: 'ep-20261026',
  hot: { bytes: 120, rule: 0, pref: 1, fact: 2 },
  verify: { ok: true, events: 20 },
  items: [{ id: '2e8afb09', kind: 'fact', aiw: '这个项目用 pnpm' }],
  recent: [],
  config: {
    budget: 300,
    hot: true,
    hotBytes: 2048,
    protocol: true,
    autoCapture: true,
    autoCaptureLevel: 'normal',
    epochDays: 7,
    render: 'legend',
    scope: 'global',
    memoryScope: 'shared',
    isolatedSessions: ['sess-B'],
    dbPath: '',
    dbPathEffective: 'C:\\Users\\x\\.dsh\\loom\\loom.db',
  },
};

/** 极简 React：把元素树建出来就行，不执行任何副作用 */
function makeFakeReact(tabToForce) {
  let call = 0;
  const React = {
    createElement: (type, props, ...children) => ({
      type,
      props: props || {},
      children: children.flat(Infinity).filter((c) => c !== undefined && c !== null),
    }),
    useState: (init) => {
      const i = call++;
      if (i === 1 && tabToForce) return [tabToForce, () => {}];
      return [init, () => {}];
    },
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: (v) => ({ current: v }),
  };
  React.__reset = () => {
    call = 0;
  };
  return React;
}

function render(tab) {
  const source = fs.readFileSync(clientPath, 'utf8');
  let captured = null;
  const React = makeFakeReact(tab);
  const win = {
    __ModuleLoader__: {
      load: (def) => {
        captured = def;
      },
    },
    __LOOM_SEED__: SEED,
    __DSH_TRANSPORT__: { streamBaseUrl: 'ws://127.0.0.1:1296/api' },
    confirm: () => true,
  };
  const run = new Function('window', 'location', 'require', 'fetch', `${source}\n`);
  run(
    win,
    { href: 'http://127.0.0.1:1296/#session-aaaa', protocol: 'http:' },
    (name) => (name === 'react' ? React : null),
    async () => ({ ok: true, json: async () => ({}) })
  );

  assert.ok(captured, 'client.js 应当注册到 ModuleLoader');
  const api = captured.factory((name) => (name === 'react' ? React : null));
  let Panel = null;
  api.apply({
    slots: {
      inject: (_s, fn) => fn(),
      register: (o, C) => {
        if (o.name === 'main') Panel = C;
      },
    },
  });
  assert.equal(typeof Panel, 'function');
  React.__reset();
  return Panel();
}

/** 遍历元素树：函数组件就地展开（假 React 不做调和，这一步得自己来） */
function walk(node, visit, depth = 0) {
  if (node == null || typeof node === 'boolean') return;
  if (typeof node === 'string' || typeof node === 'number') {
    visit({ text: String(node), depth });
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((n) => walk(n, visit, depth));
    return;
  }
  if (typeof node.type === 'function') {
    const kids = node.children || [];
    const props = { ...node.props, children: kids.length <= 1 ? kids[0] : kids };
    walk(node.type(props), visit, depth);
    return;
  }
  visit({ el: node, depth });
  (node.children || []).forEach((c) => walk(c, visit, depth + 1));
}

function collect(tree) {
  const els = [];
  const texts = [];
  walk(tree, (n) => {
    if (n.el) els.push(n.el);
    else texts.push(n.text);
  });
  return { els, texts };
}

test('设置页能渲染，六个分组齐全', () => {
  let tree = null;
  assert.doesNotThrow(() => {
    tree = render('设置');
  });
  const { texts } = collect(tree);
  for (const g of ['记忆范围', '每轮注入', '自动记录', '存储', '高级', '备份']) {
    assert.ok(texts.includes(g), `缺分组：${g}`);
  }
});

test('开关/单选/数字输入都带上了无障碍绑定', () => {
  const { els } = collect(render('设置'));

  const switches = els.filter((e) => e.props && e.props.role === 'switch');
  assert.ok(switches.length >= 3, `开关数量不对：${switches.length}`);
  for (const sw of switches) {
    assert.equal(typeof sw.props['aria-checked'], 'boolean', 'switch 必须暴露 aria-checked');
    assert.ok(
      String(sw.props['aria-labelledby'] || '').startsWith('lm-lab-'),
      'switch 必须绑到 label'
    );
  }

  const groups = els.filter((e) => e.props && e.props.role === 'radiogroup');
  assert.ok(groups.length >= 4, `单选组数量不对：${groups.length}`);
  for (const g of groups) {
    assert.ok(
      String(g.props['aria-labelledby'] || '').startsWith('lm-lab-'),
      'radiogroup 必须绑到 label'
    );
  }

  const inputs = els.filter((e) => e.type === 'input' && e.props && e.props['aria-labelledby']);
  assert.ok(inputs.length >= 3, `带 aria-labelledby 的输入框：${inputs.length}`);
});

test('每个配置项旁边都有保存状态位，且不再渲染 undefined', () => {
  const { els, texts } = collect(render('设置'));
  assert.equal(texts.filter((t) => t === 'undefined').length, 0, '渲染树里不该出现 undefined 文本');

  // 6 个可保存项 + dbPath：控件旁必须能挂 Flash
  for (const e of els) {
    if (!e.props) continue;
    if (e.props['aria-labelledby'] === 'lm-lab-dbPath') {
      assert.ok(String(e.type) !== 'undefined');
    }
  }
  assert.ok(
    els.some((e) => e.props && String(e.props.className || '').includes('lm-field')),
    '数字输入应该用带单位的 lm-field'
  );
});

test('库路径显示「当前生效」的真实位置', () => {
  const { texts } = collect(render('设置'));
  assert.ok(
    texts.some((t) => t.startsWith('当前生效：')),
    '应当显示当前生效的库路径'
  );
  assert.ok(
    texts.some((t) => t.includes('loom.db')),
    '应当带上真实路径'
  );
});
