import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { apply } from '../../loom-dsh/index.js';

/**
 * 会话级自测：走插件真实的工具入口，不碰内核。
 *
 * 这两种视角不同：内核测试证明"函数对"，这里证明"模型按自然方式调用时也对"。
 * 2026-10-26 的两个线上缺陷（短查询被跳过、标点差异去重失效）都只在后者暴露。
 */

function boot(dbPath) {
  const tools = new Map();
  const cleanups = [];
  const ctx = {
    tools: { register: (d) => (tools.set(d.name, d), () => tools.delete(d.name)) },
    effect(fn) {
      const d = fn();
      if (typeof d === 'function') cleanups.push(d);
      return d;
    },
  };
  apply(ctx, { dbPath, budget: 200 });
  const call = (name, args = {}) => tools.get(name).execute(args, {});
  return { call, cleanups, names: [...tools.keys()] };
}

test('会话自测：13 轮真实用法', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-conv-'));
  const { call, cleanups, names } = boot(path.join(dir, 'loom.db'));

  try {
    await t.test('0. 八个工具都在', () => {
      assert.deepEqual(names.sort(), [
        'memory_decay', 'memory_forget', 'memory_outline', 'memory_recall', 'memory_settle', 'memory_stats', 'memory_verify', 'memory_write',
      ]);
    });

    await t.test('1. 写一条：汉字置信 + 无尾也接受', async () => {
      const a = await call('memory_write', {
        line: '预发端口 8081；上线前必跑 smoke。 @2026-10-26 #用户口述 高',
        kind: 'rule',
      });
      assert.equal(a.ok, true, JSON.stringify(a));

      // 完全不带尾部：来源应由插件补成「会话」
      const b = await call('memory_write', { line: '预发环境用 docker compose 起。' });
      assert.equal(b.ok, true, JSON.stringify(b));
    });

    await t.test('2. 短名词短语查询：不能被跳过', async () => {
      const r = await call('memory_recall', { query: '预发端口' });
      assert.equal(r.skipped, false, '短查询被跳过 = 线上不可用');
      assert.ok(r.items.length >= 1);
      assert.ok(r.items.some((i) => i.text.includes('8081')));
    });

    await t.test('3. 同一内容、不同标点：合并成一条', async () => {
      const before = (await call('memory_stats')).total;
      const dup = await call('memory_write', { line: '预发端口 8081，上线前必跑 smoke。' });
      const after = (await call('memory_stats')).total;
      assert.equal(dup.ok, true);
      assert.equal(after, before, '标点差异不该新增条目');
    });

    await t.test('4. 完整问句：命中且给出正文', async () => {
      const r = await call('memory_recall', { query: '预发端口是多少？' });
      assert.equal(r.skipped, false);
      const hit = r.items.find((i) => i.text.includes('8081'));
      assert.ok(hit, '应有正文级结果');
      assert.equal(hit.level, 'full');
    });

    await t.test('5. 碎片稿：被闸门拒绝且不入库', async () => {
      const before = (await call('memory_stats')).total;
      const bad = await call('memory_write', {
        line: '路径拼接导致配置读取失败，已修复。',
        original: 'Win 上路径拼接用正斜杠导致 ENOENT，修复用 path.join。',
      });
      const after = (await call('memory_stats')).total;
      assert.equal(bad.ok, false);
      assert.equal(after, before);
    });

    await t.test('6. 应答类输入：跳过检索', async () => {
      const r = await call('memory_recall', { query: '好的' });
      assert.equal(r.skipped, true);
      assert.equal(r.items.length, 0);
    });

    await t.test('7. 查不到时：不跳过、也不编', async () => {
      const r = await call('memory_recall', { query: 'Kubernetes 集群是什么版本？' });
      assert.equal(r.skipped, false);
      assert.equal(r.items.length, 0);
    });

    await t.test('8. 第二条不同内容：独立入库', async () => {
      const r = await call('memory_write', { line: '回滚按钮在发布面板右上角。' });
      assert.equal(r.ok, true);
      const stats = await call('memory_stats');
      assert.ok(stats.total >= 3, JSON.stringify(stats));
    });

    await t.test('9. 统计与类型分布对得上', async () => {
      const stats = await call('memory_stats');
      const sum = Object.values(stats.byKind).reduce((a, b) => a + b, 0);
      assert.equal(sum, stats.total);
      assert.ok(stats.byKind.rule >= 1);
    });

    await t.test('10. 预算约束：取回不超预算', async () => {
      const r = await call('memory_recall', { query: '预发环境怎么起？', budget: 20 });
      const used = r.usedTokens ?? 0;
      assert.ok(used <= 20, `用了 ${used}/20`);
      assert.ok(r.items.length + r.pointers.length > 0, '至少给点东西');
    });
    await t.test('11. 取回带渲染层（默认 legend）', async () => {
      const r = await call('memory_recall', { query: '预发端口' });
      assert.ok(r.rendered.includes('符号：'), '应带符号表');
      assert.ok(r.rendered.includes('[#'), '应带引用编号');
    });

    await t.test('12. 结算：被引用的条目涨权', async () => {
      const w = await call('memory_write', { line: '结算测试条目：发布前跑 smoke。', kind: 'proc' });
      const r = await call('memory_settle', { used: [w.id.slice(0, 8)], correct: true });
      assert.equal(r.ok, true);
      assert.equal(r.used.length, 1);
      assert.ok(r.updated >= 1);
    });

    await t.test('13. L0 哈希链可验', async () => {
      const v = await call('memory_verify', {});
      assert.equal(v.ok, true, JSON.stringify(v));
      assert.ok(v.events >= 3, '事件数 ' + v.events);
    });

    await t.test('14. 遗忘：失效但不物理删除', async () => {
      const w = await call('memory_write', { line: '待删条目：临时实验用的开关。', kind: 'fact' });
      const f2 = await call('memory_forget', { id: w.id.slice(0, 8), reason: '测试' });
      assert.equal(f2.ok, true);
      const v = await call('memory_verify', {});
      assert.equal(v.ok, true, '遗忘后链仍可验');
    });

    await t.test('15. 遗忘扫描：默认只预览', async () => {
      const r = await call('memory_decay', {});
      assert.equal(r.applied, false);
      assert.ok(r.counts.keep >= 1);
    });
  } finally {
    for (const c of cleanups) c();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
