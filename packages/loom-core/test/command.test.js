import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteLedger } from '../src/sqlite-ledger.js';
import { runLoomCommand } from '../src/command.js';

const seed = (db, id, kind, aiw) =>
  db.put({
    id,
    kind,
    body: aiw,
    aiw,
    title: aiw.slice(0, 8),
    confidence: 'high',
    source: { eventId: 'e' },
    epochId: 'ep',
    taint: 'none',
    validFrom: 1,
    salience: 1,
    useCount: 0,
    cold: false,
  });

const mk = () => {
  const db = new SqliteLedger(':memory:');
  seed(db, 'a1', 'rule', '禁止直连生产库。');
  seed(db, 'a2', 'fact', '预发端口 8081。');
  return db;
};

test('/loom 无参数给帮助', () => {
  const db = mk();
  const r = runLoomCommand('', { ledger: db });
  assert.equal(r.kind, 'success');
  assert.ok(r.text.includes('/loom stats'));
  db.close();
});

test('/loom stats 给出计数', () => {
  const db = mk();
  const r = runLoomCommand('stats', { ledger: db });
  assert.ok(r.text.includes('2 条记忆'));
  assert.ok(r.text.includes('rule'));
  db.close();
});

test('/loom outline 按类型分组', () => {
  const db = mk();
  const r = runLoomCommand('outline', { ledger: db });
  assert.ok(r.text.includes('rule（1）'));
  assert.ok(r.text.includes('禁止直连生产库'));
  db.close();
});

test('/loom search 命中并带 id', () => {
  const db = mk();
  const r = runLoomCommand('search 端口', { ledger: db });
  assert.ok(r.text.includes('8081'));
  assert.match(r.text, /\[a2\]|\[a2\w*\]/);
  db.close();
});

test('/loom search 无参报错', () => {
  const db = mk();
  const r = runLoomCommand('search', { ledger: db });
  assert.equal(r.kind, 'error');
  db.close();
});

test('/loom verify 反映链状态', () => {
  const db = mk();
  const r = runLoomCommand('verify', {
    ledger: db,
    verify: () => ({ ok: true, epochs: 1, events: 9, current: 'ep-x' }),
  });
  assert.equal(r.kind, 'success');
  assert.ok(r.text.includes('完好'));
  assert.ok(r.text.includes('ep-x'));
  db.close();
});

test('/loom hot 展示注入内容', () => {
  const db = mk();
  const r = runLoomCommand('hot', {
    ledger: db,
    hot: () => ({ text: '## LOOM 记忆\n- x', bytes: 20, counts: {} }),
  });
  assert.ok(r.text.includes('本轮注入'));
  db.close();
});

test('未知子命令给帮助而不是崩', () => {
  const db = mk();
  const r = runLoomCommand('nope', { ledger: db });
  assert.equal(r.kind, 'error');
  assert.ok(r.text.includes('/loom stats'));
  db.close();
});
