/**
 * 日志轮转的回归测试。
 *
 * 真实问题：hook-errors.log 只追加不清理，长到 98KB 没人发现；
 * 加了跨源拒绝日志之后，任何网页都能往里灌行，真正的故障行会被淹掉。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendRotating, rotate, LOG_LIMITS } from '../src/logfile.js';

const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-log-'));
  return { dir, file: path.join(dir, 'hook-errors.log') };
};

test('没到上限就一直追加同一个文件', () => {
  const { file } = tmp();
  appendRotating(file, 'a\n', { maxBytes: 100 });
  const r = appendRotating(file, 'b\n', { maxBytes: 100 });
  assert.equal(r.rotated, false);
  assert.equal(fs.readFileSync(file, 'utf8'), 'a\nb\n');
  assert.equal(fs.existsSync(file + '.1'), false);
});

test('会越过上限时先把历史挤成 .1，新内容写进新文件', () => {
  const { file } = tmp();
  appendRotating(file, 'x'.repeat(60) + '\n', { maxBytes: 80 });
  const r = appendRotating(file, 'y'.repeat(60) + '\n', { maxBytes: 80 });
  assert.equal(r.rotated, true);
  assert.match(fs.readFileSync(file + '.1', 'utf8'), /^x+$/m);
  assert.match(fs.readFileSync(file, 'utf8'), /^y+$/m);
});

test('只保留指定代数，更老的在轮转时被覆盖丢弃', () => {
  const { file } = tmp();
  for (const ch of ['a', 'b', 'c', 'd']) {
    appendRotating(file, ch.repeat(50) + '\n', { maxBytes: 60, keep: 2 });
  }
  assert.match(fs.readFileSync(file, 'utf8'), /^d+$/m, '最新的在正文');
  assert.match(fs.readFileSync(file + '.1', 'utf8'), /^c+$/m, '上一代在 .1');
  assert.match(fs.readFileSync(file + '.2', 'utf8'), /^b+$/m, '再上一代在 .2');
  assert.equal(fs.existsSync(file + '.3'), false, '第三代必须被丢掉，否则目录会自己长大');
});

test('文件不存在时不会因为 stat 失败而丢日志', () => {
  const { file } = tmp();
  const r = appendRotating(file, '第一行\n');
  assert.equal(r.bytes > 0, true);
  assert.equal(fs.readFileSync(file, 'utf8'), '第一行\n');
});

test('超长单行（比如一段堆栈）自己就能触发轮转，不会把上限撑破', () => {
  const { file } = tmp();
  appendRotating(file, 'seed\n', { maxBytes: 200 });
  const r = appendRotating(file, 'e'.repeat(500) + '\n', { maxBytes: 200 });
  assert.equal(r.rotated, true);
  assert.equal(fs.readFileSync(file + '.1', 'utf8'), 'seed\n');
});

test('rotate 对不存在的文件是安全的（并发下可能被别人先转走）', () => {
  const { dir, file } = tmp();
  rotate(file, 2);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('默认上限和代数是有意义的值，而不是 0 或 Infinity', () => {
  assert.equal(LOG_LIMITS.maxBytes, 1024 * 1024);
  assert.equal(LOG_LIMITS.keep, 2);
});
