import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDbPath } from '../src/paths.js';

test('默认全局：落在 DSH_HOME 下', () => {
  const r = resolveDbPath({ home: '/h/.dsh' });
  assert.equal(r.scope, 'global');
  assert.equal(r.dbPath, '/h/.dsh/loom/loom.db');
});

test('工作区作用域：跟着仓库走', () => {
  const r = resolveDbPath({ scope: 'workspace', workspace: 'C:/proj/a' });
  assert.equal(r.scope, 'workspace');
  assert.equal(r.dbPath, 'C:/proj/a/.loom/loom.db');
});

test('环境变量优先于 home', () => {
  const r = resolveDbPath({ env: '/env/dsh', home: '/h/.dsh' });
  assert.equal(r.dbPath, '/env/dsh/loom/loom.db');
});
