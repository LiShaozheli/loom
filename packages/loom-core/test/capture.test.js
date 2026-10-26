import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectIntent, stripCue } from '../src/capture.js';

test('明确说"记住"才算捕获', () => {
  assert.equal(detectIntent('记住：预发端口 8081').capture, true);
  assert.equal(detectIntent('记一下，回滚按钮在右上角').capture, true);
  assert.equal(detectIntent('别忘了周五要发版').capture, true);
  assert.equal(detectIntent('这个函数怎么改？').capture, false);
  assert.equal(detectIntent('好的').capture, false);
});

test('粗分类：红线 / 偏好 / 流程', () => {
  assert.equal(detectIntent('记住，禁止直连生产库').kind, 'rule');
  assert.equal(detectIntent('记住我喜欢先看结论').kind, 'pref');
  assert.equal(detectIntent('记住发布流程是先灰度再全量').kind, 'proc');
  assert.equal(detectIntent('记住预发端口是 8081').kind, 'fact');
});

test('「以后再说」识别成待办而不是事实', () => {
  const r = detectIntent('记住这个接口要不要上，以后再说');
  assert.equal(r.capture, true);
  assert.equal(r.due, true);
});

test('剥掉指令词，留下要记的内容', () => {
  assert.equal(stripCue('记住：预发端口 8081'), '预发端口 8081');
  assert.equal(stripCue('帮我记一下，回滚按钮在右上角'), '回滚按钮在右上角');
  assert.equal(stripCue('别忘了周五发版'), '周五发版');
  assert.equal(stripCue('预发端口 8081'), '预发端口 8081');
});

test('空输入不炸', () => {
  assert.equal(detectIntent('').capture, false);
  assert.equal(stripCue('').length >= 0, true);
});
