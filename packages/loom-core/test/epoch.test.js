import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Chronicle } from '../src/chronicle.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'loom-ep-'));

test('currentEpoch：新建的片会被复用', () => {
  const dir = tmp();
  const c = new Chronicle(dir);
  const a = c.currentEpoch({ everyDays: 7 });
  const b = c.currentEpoch({ everyDays: 7 });
  assert.equal(a, b);
  assert.equal(c.epochs().length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('currentEpoch：超过周期就轮换', () => {
  const dir = tmp();
  const c = new Chronicle(dir);
  const day = 86_400_000;
  const old = c.createEpoch('ep-old', { now: Date.now() - 30 * day });
  assert.equal(c.currentEpoch({ everyDays: 7 }), c.epochs().at(-1).id);
  assert.notEqual(c.epochs().at(-1).id, old);
  assert.equal(c.epochs().length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('同一天轮换两次：id 不撞车', () => {
  const dir = tmp();
  const c = new Chronicle(dir);
  const day = 86_400_000;
  c.createEpoch('ep-x', { now: Date.now() - 30 * day });
  const a = c.currentEpoch({ everyDays: 7 });
  // 再把它变旧，强制第二次轮换
  c.meta.epochs[a].createdAt -= 30 * day;
  c['#save'];
  const b = c.currentEpoch({ everyDays: 7 });
  assert.notEqual(a, b);
  assert.ok(b.startsWith('ep-'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('epochs 列表包含墓碑', () => {
  const dir = tmp();
  const c = new Chronicle(dir);
  const id = c.createEpoch('ep-a');
  c.destroyEpoch(id, '用户要求');
  const list = c.epochs();
  assert.equal(list.length, 1);
  assert.equal(list[0].destroyed, true);
  assert.equal(list[0].reason, '用户要求');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('销毁一片不影响另一片', () => {
  const dir = tmp();
  const c = new Chronicle(dir);
  const a = c.createEpoch('ep-a');
  const b = c.createEpoch('ep-b');
  c.append(a, { text: 'A 的事' });
  c.append(b, { text: 'B 的事' });

  c.destroyEpoch(a, '删掉第一段');
  assert.throws(() => c.read(a), /不存在或已销毁/);
  assert.equal(c.read(b)[0].event.text, 'B 的事');
  assert.equal(c.verify(b).ok, true);
  fs.rmSync(dir, { recursive: true, force: true });
});
