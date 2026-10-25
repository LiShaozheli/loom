/**
 * LOOM 的 DSH 插件壳。
 *
 * 五个工具：写 / 读 / 结算 / 遗忘扫描 / 统计。
 * 全部走"最弱够用"的机制：模型自己决定何时调用，不做自动注入。
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { ingest } from './vendor/ingest.js';
import { parseTail } from './vendor/aiw.js';
import { recall } from './vendor/recall.js';
import { render } from './vendor/render.js';
import { settleTurn } from './vendor/settle.js';
import { sweep } from './vendor/decay.js';
import { Chronicle } from './vendor/chronicle.js';
import { SqliteLedger } from './vendor/sqlite-ledger.js';

const text = (s) => [{ type: 'text', text: String(s) }];

const OUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => text(JSON.stringify(value, null, 2)),
};

export const inject = ['tools'];

/** @param {any} ctx @param {{dbPath?:string, budget?:number, render?:'legend'|'plain'|'xml'}} config */
export function apply(ctx, config = {}) {
  const budget = Number(config.budget ?? 300);
  const policy = config.render ?? 'legend';
  const dbPath =
    config.dbPath && config.dbPath.trim()
      ? config.dbPath
      : path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'loom', 'loom.db');

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const ledger = new SqliteLedger(dbPath);

  // L0：编年层。每次写入都追加到哈希链，账本可从链重建、可验未篡改。
  const chronicle = new Chronicle(path.join(path.dirname(dbPath), 'chronicle'));
  const epoch = chronicle.meta.epochs?.['ep-live'] ? 'ep-live' : chronicle.createEpoch('ep-live');

  ctx.effect(() => () => ledger.close());

  // ---- 写 ----
  ctx.tools.register({
    name: 'memory_write',
    description:
      '把一条记忆写进 LOOM。line 用 AI文 正文，可选尾部（@时间 #来源 置信，置信可写 ! ? ~ 或 高 中 低）。' +
      '不传 original 时只做格式校验；传了 original 会做保真与编造校验，不合格会被拒。',
    parameters: {
      type: 'object',
      properties: {
        line: { type: 'string', description: 'AI文 正文，可选 @时间 #来源 置信 尾部' },
        body: { type: 'string', description: '白话正文，用于审计（可省略）' },
        kind: { type: 'string', description: 'fact/pref/rule/proc/relation/decision/open' },
        original: { type: 'string', description: '原文，用于保真校验' },
      },
      required: ['line'],
    },
    output: OUT,
    async execute(args) {
      const r = ingest({
        line: args.line,
        body: args.body ?? args.original ?? args.line,
        kind: args.kind ?? 'fact',
        epochId: 'ep-live',
        ledger,
        original: args.original,
        title: args.line.slice(0, 12),
        // 没写 #来源 时默认记成「会话」：工具调用天然来自当前对话，
        // 让使用者为了过校验去编一个来源，是把结构信息推给人填。
        source: { eventId: parseTail(args.line)?.source ?? '#会话' },
      });
      if (r.ok) {
        chronicle.append(epoch, { claimId: r.claim.id, kind: r.claim.kind, aiw: r.claim.aiw, at: Date.now() });
      }
      return {
        ok: r.ok,
        verdict: r.gate.verdict,
        id: r.claim?.id ?? null,
        missing: r.gate.missing ?? [],
        issues: r.gate.issues.map((i) => i.code),
      };
    },
  });

  // ---- 读 ----
  ctx.tools.register({
    name: 'memory_recall',
    description:
      '按问题从 LOOM 取回证据。预算内先给正文，装不下降级成标题，再装不下只给指针。' +
      '返回里既有结构化字段，也有可直接拼进上下文的 rendered 文本。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '当前问题或检索线索' },
        budget: { type: 'number', description: 'token 预算，默认取插件配置' },
      },
      required: ['query'],
    },
    output: OUT,
    async execute(args) {
      const r = recall({
        query: args.query,
        search: (q) => ledger.search(q, { limit: 50 }),
        budget: Number(args.budget ?? budget),
      });
      return {
        skipped: r.skipped,
        reason: r.admission?.reason,
        route: r.route?.reason ?? null,
        outline: r.outline?.nodes?.map((n) => n.title) ?? [],
        items: r.items.map((i) => ({ id: i.claimId.slice(0, 8), level: i.level, text: i.text })),
        pointers: r.pointers.map((p) => p.title),
        usedTokens: r.usedTokens,
        rendered: render(r, { policy }),
      };
    },
  });

  // ---- 结算 ----
  ctx.tools.register({
    name: 'memory_settle',
    description:
      '给这一轮用到的记忆结账：哪些被用到了、结果对不对。' +
      '被用到且正确的涨权，用到但错的降权，没用到的轻微衰减。',
    parameters: {
      type: 'object',
      properties: {
        used: { type: 'array', items: { type: 'string' }, description: '被引用的记忆 id（可只给前 8 位）' },
        correct: { type: 'boolean', description: '这轮结果是否正确；未知可省略' },
        answer: { type: 'string', description: '模型回答，用于自动归因（与 used 二选一或并用）' },
        items: { type: 'array', items: { type: 'string' }, description: '本轮注入的记忆 id 列表' },
      },
      required: ['used'],
    },
    output: OUT,
    async execute(args) {
      const ids = [...new Set([...(args.items ?? []), ...(args.used ?? [])])];
      const active = ledger.active();
      const items = ids
        .map((id) => {
          if (!id) return null;
          const claim = ledger.get(id) ?? active.find((c) => c.id.startsWith(id));
          return claim ? { claimId: claim.id, text: claim.aiw } : null;
        })
        .filter(Boolean);

      if (!items.length) return { ok: false, reason: '没有可结算的条目' };

      // used 里只给前缀时，补成全 id
      const usedFull = (args.used ?? []).map((u) => items.find((i) => i.claimId.startsWith(u))?.claimId ?? u);
      const answer = args.answer ?? usedFull.map((u) => `[#${u.slice(0, 8)}]`).join(' ');

      const r = settleTurn({ answer, items, ledger, correct: args.correct ?? null });
      return { ok: true, used: r.used.map((u) => u.slice(0, 8)), updated: r.updated.length };
    },
  });

  // ---- 遗忘扫描 ----
  ctx.tools.register({
    name: 'memory_decay',
    description: '按时间与使用频次扫描记忆，给出降级建议（keep/summarize/pointerize/archive）。默认只预览。',
    parameters: {
      type: 'object',
      properties: { apply: { type: 'boolean', description: 'true 才真的标 cold' } },
    },
    output: OUT,
    async execute(args = {}) {
      const r = sweep(ledger, { apply: args.apply === true });
      return { applied: r.applied, counts: r.counts, rows: r.rows.slice(0, 20) };
    },
  });

  // ---- 目录 ----
  ctx.tools.register({
    name: 'memory_outline',
    description:
      '先看目录再决定查什么：按类型列出分组与条目标题，可选只看某一类。' +
      '适合「我不确定自己记过什么」的场景。',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: '只看这一类，例如 rule / fact / pref' },
        limit: { type: 'number', description: '每组最多列出几条标题，默认 5' },
      },
    },
    output: OUT,
    async execute(args = {}) {
      const limit = Number(args.limit ?? 5);
      const active = ledger.active(args.kind);
      const groups = {};
      for (const c of active) {
        groups[c.kind] ??= { count: 0, titles: [] };
        groups[c.kind].count++;
        if (groups[c.kind].titles.length < limit) groups[c.kind].titles.push(c.title);
      }
      return { total: active.length, groups };
    },
  });

  // ---- 观测 ----
  ctx.tools.register({
    name: 'memory_stats',
    description: 'LOOM 账本概况：条目数、按类型分布、数据库路径。',
    parameters: { type: 'object', properties: {} },
    output: OUT,
    async execute() {
      const active = ledger.active();
      const byKind = {};
      for (const c of active) byKind[c.kind] = (byKind[c.kind] ?? 0) + 1;
      return { dbPath, total: active.length, byKind, render: policy, epoch };
    },
  });

  // ---- 编年层校验 ----
  ctx.tools.register({
    name: 'memory_verify',
    description: '校验 L0 哈希链：条目数、链是否连续、有没有被改写。',
    parameters: { type: 'object', properties: {} },
    output: OUT,
    async execute() {
      const v = chronicle.verify(epoch);
      let events = 0;
      try {
        events = chronicle.read(epoch).length;
      } catch {
        events = -1;
      }
      return { ...v, events, epoch, destroyed: chronicle.isDestroyed(epoch) };
    },
  });

  // ---- 遗忘单条 ----
  ctx.tools.register({
    name: 'memory_forget',
    description:
      '让一条记忆失效（不物理删除）：标 validTo、指向一条墓碑，并在 L0 记一笔。' +
      '整段销毁要用 CLI 的 epoch 删除（crypto-shredding），这里只处理单条。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '记忆 id（可只给前 8 位）' },
        reason: { type: 'string', description: '为什么删，会留档' },
      },
      required: ['id'],
    },
    output: OUT,
    async execute(args) {
      const id = String(args.id ?? '').trim();
      const claim = ledger.get(id) ?? ledger.active().find((c) => c.id.startsWith(id));
      if (!claim) return { ok: false, reason: '找不到这条记忆' };

      const tomb = { id: `tomb-${claim.id.slice(0, 8)}`, kind: claim.kind, body: '（已删除）', aiw: '（已删除）', title: '（已删除）', confidence: 'high', source: { eventId: '#forget' }, epochId: claim.epochId, taint: 'none', validFrom: Date.now(), salience: 0, useCount: 0, cold: true };
      ledger.put(tomb);
      ledger.supersede(claim.id, tomb.id, args.reason ?? '用户要求');
      chronicle.append(epoch, { forget: claim.id, reason: args.reason ?? '用户要求', at: Date.now() });

      return { ok: true, id: claim.id.slice(0, 8), supersededBy: tomb.id.slice(0, 8) };
    },
  });
}
