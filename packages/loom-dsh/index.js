/**
 * LOOM 的 DSH 插件壳（W7 第一版）。
 *
 * 只做两件事，都是"最弱够用"的机制：
 *   1. 注册 memory_recall / memory_write 两个工具（模型自己决定何时读写）
 *   2. 记忆落在本地 SQLite，路径可配
 *
 * 不做自动注入：那需要 agent.inject 与 per-turn 预算，等这一版在真实会话里跑通再加。
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { ingest } from './vendor/ingest.js';
import { parseTail } from './vendor/aiw.js';
import { recall } from './vendor/recall.js';
import { SqliteLedger } from './vendor/sqlite-ledger.js';

const text = (s) => [{ type: 'text', text: String(s) }];

const OUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => text(JSON.stringify(value, null, 2)),
};

export const inject = ['tools'];

/** @param {any} ctx @param {{dbPath?:string, budget?:number}} config */
export function apply(ctx, config = {}) {
  const budget = Number(config.budget ?? 300);
  const dbPath =
    config.dbPath && config.dbPath.trim()
      ? config.dbPath
      : path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'loom', 'loom.db');

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const ledger = new SqliteLedger(dbPath);

  ctx.effect(() => () => ledger.close());

  // ---- 写 ----
  ctx.tools.register({
    name: 'memory_write',
    description:
      '把一条记忆写进 LOOM。line 用 AI文 作者格式：正文 + 可选尾部（@时间 #来源 置信）。' +
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
      '按问题从 LOOM 取回证据。返回正文（AI文）+ 指针 + 用掉的 token。' +
      '预算内先给正文，装不下降级成标题，再装不下只给指针。',
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
        outline: r.outline?.nodes?.map((n) => `${n.title}`) ?? [],
        items: r.items.map((i) => ({ id: i.claimId.slice(0, 8), level: i.level, text: i.text })),
        pointers: r.pointers.map((p) => p.title),
        usedTokens: r.usedTokens,
      };
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
      return { dbPath, total: active.length, byKind };
    },
  });
}
