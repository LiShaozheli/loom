import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickDurable } from '../src/autocapture.js';

test('强线索：明确说了要记', () => {
  assert.equal(pickDurable('记住：预发端口 8081').capture, true);
  assert.equal(pickDurable('以后都用 pnpm，不要 npm').capture, true);
  assert.equal(pickDurable('我们约定周五发版').capture, true);
});

test('弱线索：含标识符或参数的断言', () => {
  assert.equal(pickDurable('预发环境端口是 8081，日志在 var/log 下').capture, true);
  assert.equal(pickDurable('这个项目用 pnpm 管理依赖').capture, true);
});

test('疑问句不记', () => {
  assert.equal(pickDurable('预发端口是多少？').capture, false);
  assert.equal(pickDurable('这个怎么配').capture, false);
});

test('纯任务不记', () => {
  assert.equal(pickDurable('帮我把这段代码改成异步的').capture, false);
  assert.equal(pickDurable('跑一下测试看看').capture, false);
});

test('寒暄与短句不记', () => {
  assert.equal(pickDurable('好的').capture, false);
  assert.equal(pickDurable('继续').capture, false);
  assert.equal(pickDurable('嗯').capture, false);
});

test('太长的粘贴不自动记（避免把整段代码塞进记忆）', () => {
  assert.equal(pickDurable('记住：' + 'x'.repeat(500)).capture, false);
});

test('分类猜得合理', () => {
  assert.equal(pickDurable('记住，禁止直连生产库').kind, 'rule');
  assert.equal(pickDurable('以后都先给结论再给理由').kind, 'pref');
  assert.equal(pickDurable('决定用 JWT 而不是 session').kind, 'decision');
});

test('空白输入不炸', () => {
  assert.equal(pickDurable('').capture, false);
  assert.equal(pickDurable(null).capture, false);
});

test('粘贴块与引用不自动记（真实踩到过）', () => {
  const ui = 'LOOM 记忆\n没有数据\n刷新\n刷新失败：Failed to fetch重新加载页面\n还没有记忆。对助手说「记住：…」即可。';
  assert.equal(pickDurable(ui).capture, false);

  const quote = '文档里写着「记住要先备份」，你看对不对';
  assert.equal(pickDurable(quote).capture, false);
});

test('capture level：normal 连偏好陈述也记，strict 不记', () => {
  assert.equal(pickDurable('我不喜欢注释太多').capture, true);
  assert.equal(pickDurable('我不喜欢注释太多', { level: 'strict' }).capture, false);
  assert.equal(pickDurable('这个项目的文档都写中文').capture, true);
  assert.equal(pickDurable('这个项目的文档都写中文', { level: 'strict' }).capture, false);
  // 问句仍然不记，任何级别
  assert.equal(pickDurable('我不喜欢注释太多，对吗？').capture, false);
});
