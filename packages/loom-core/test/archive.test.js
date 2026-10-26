import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Chronicle } from '../src/chronicle.js';
import { archiveMessages, messageKey, messageText } from '../src/archive.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'loom-arch-'));

test('寒暄也要归档——原文不筛', () => {
  const dir = tmp();
  const c = new Chronicle(dir);
  const ep = c.createEpoch('ep');
  const seen = new Set();
  const r = archiveMessages(c, ep, [
    { role: 'user', content: '嗯' },
    { role: 'assistant', content: '好的' },
  ], seen);
  assert.equal(r.archived, 2);
  assert.equal(c.read(ep).length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('粘贴的长文本也原样进库', () => {
  const dir = tmp();
  const c = new Chronicle(dir);
  const ep = c.createEpoch('ep');
  const pasted = 'LOOM 记忆\n没有数据\n刷新失败：Failed to fetch\n' + 'x'.repeat(500);
  archiveMessages(c, ep, [{ role: 'user', content: pasted }], new Set());
  const [e] = c.read(ep);
  assert.equal(e.event.text, pasted, '原文必须一字不差');
  assert.equal(e.event.len, pasted.length);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('同一句话重复出现不会记两遍', () => {
  const dir = tmp();
  const c = new Chronicle(dir);
  const ep = c.createEpoch('ep');
  const seen = new Set();
  const msgs = [{ role: 'user', content: '你好' }];
  assert.equal(archiveMessages(c, ep, msgs, seen).archived, 1);
  assert.equal(archiveMessages(c, ep, msgs, seen).archived, 0);
  assert.equal(c.read(ep).length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('结构化的消息内容不会被丢掉', () => {
  const text = messageText({
    role: 'user',
    content: [
      { type: 'text', text: '看看这个' },
      { type: 'image' },
      { type: 'file', attachment: { name: 'a.png' } },
    ],
  });
  assert.ok(text.includes('看看这个'));
  assert.ok(text.includes('[图片]'));
  assert.ok(text.includes('a.png'));
});

test('空内容与非对话角色跳过', () => {
  const dir = tmp();
  const c = new Chronicle(dir);
  const ep = c.createEpoch('ep');
  const r = archiveMessages(c, ep, [
    { role: 'user', content: '' },
    { role: 'tool', content: 'x' },
    { role: 'user', content: [{ type: 'unknown' }] },
  ], new Set());
  assert.equal(r.archived, 1, '未知块也要留个占位，只跳过真正的空内容');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('指纹稳定：同样的角色+内容得到同样的 key', () => {
  assert.equal(messageKey({ role: 'user', content: 'a' }), messageKey({ role: 'user', content: 'a' }));
  assert.notEqual(messageKey({ role: 'user', content: 'a' }), messageKey({ role: 'assistant', content: 'a' }));
});
