/**
 * LOOM 的 DSH 插件壳。
 *
 * 两块能力：
 *   1. 自动注入：每轮固定注入一小块热记忆（与"想起来才查"互补）
 *   2. 九个工具：写 / 读 / 目录 / 热记忆 / 结算 / 遗忘扫描 / 校验 / 遗忘单条 / 统计
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { ingest } from './vendor/ingest.js';
import { parseTail, makeTitle } from './vendor/aiw.js';
import { recall } from './vendor/recall.js';
import { render } from './vendor/render.js';
import { settleTurn } from './vendor/settle.js';
import { sweep } from './vendor/decay.js';
import { buildHotMemory } from './vendor/hot.js';
import { resolveDbPath } from './vendor/paths.js';
import { detectIntent, stripCue } from './vendor/capture.js';
import { pickDurable } from './vendor/autocapture.js';
import { archiveMessages, messageText, messageKey } from './vendor/archive.js';
import { runLoomCommand } from './vendor/command.js';
import { Chronicle } from './vendor/chronicle.js';
import { exportBundle, bundleToZip } from './vendor/bundle.js';
import { SqliteLedger } from './vendor/sqlite-ledger.js';

const text = (s) => [{ type: 'text', text: String(s) }];

const OUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => text(JSON.stringify(value, null, 2)),
};


// ---- 配置 schema（设置页据此渲染）----
// schemastery 已 vendor 到本包 node_modules：软链安装时裸模块名解析不到 profile 的依赖。
let Schema = null;
try {
  const mod = await import('@deepseek-ai/schemastery');
  Schema = mod.default ?? mod;
} catch {
  Schema = null;
}

export const Config = Schema
  ? Schema.object({
      dbPath: Schema.string().description('库文件路径；留空用默认位置').default(''),
      scope: Schema.union([Schema.const('global'), Schema.const('workspace')])
        .description('global 跟着用户走；workspace 只属于当前工作区')
        .default('global'),
      budget: Schema.number().description('单次 memory_recall 的 token 预算').min(50).max(4000).default(300),
      hot: Schema.boolean().description('每轮自动注入热记忆').default(true),
      hotBytes: Schema.number().description('热记忆字节上限（进每一轮上下文，就是长期成本）').min(0).max(16384).default(2048),
      protocol: Schema.boolean().description('是否注入「什么时候该写、该查」的使用协议').default(true),
      autoCapture: Schema.boolean().description('从对话里自动挑值得记的内容（规则判定，不调模型）').default(true),
      autoCaptureLevel: Schema.union([Schema.const('normal'), Schema.const('strict')])
        .description('normal 连偏好与项目陈述一起记；strict 只认标识符与参数')
        .default('normal'),
      epochDays: Schema.number().description('L0 时间片长度（天）；删除权的最小单位').min(1).max(365).default(7),
      render: Schema.union([Schema.const('legend'), Schema.const('plain'), Schema.const('xml')])
        .description('取回结果的渲染策略')
        .default('legend'),
    })
  : undefined;

export const inject = ['tools'];

/** 热记忆默认字节上限：它进每一轮上下文，字节数就是长期成本 */
const DEFAULT_HOT_BYTES = 2048;

/** 使用协议：把"什么时候该写、该查"讲清楚，比让模型自己猜便宜得多 */
const PROTOCOL = [
  '## LOOM 记忆规则',
  '- 用户说「记住 / 记一下 / 记着」→ 调 memory_note（原样收下，不会被拒）；要精确格式再用 memory_write。',
  '- 问到过去的事（上次 / 之前 / 我们说 / 当时）→ 先 memory_recall 再回答，不要凭印象。',
  '- 回答里用到记忆时，在末尾标 [#id]；事后可用 memory_settle 结算。',
  '- 不确定有没有记过 → 先 memory_outline 看目录。',
].join('\n');

/** @param {any} ctx @param {{dbPath?:string, budget?:number, render?:'legend'|'plain'|'xml', epochDays?:number, hotBytes?:number, hot?:boolean}} config */
export function apply(ctx, config = {}) {
  const budget = Number(config.budget ?? 300);
  const policy = config.render ?? 'legend';
  const hotBytes = Number(config.hotBytes ?? DEFAULT_HOT_BYTES);
  const autoCaptureLevel = config.autoCaptureLevel === 'strict' ? 'strict' : 'normal';
  const dbPath =
    config.dbPath && config.dbPath.trim()
      ? config.dbPath
      : config.scope === 'workspace'
        ? resolveDbPath({ scope: 'workspace', workspace: process.cwd() }).dbPath
        : path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'loom', 'loom.db');

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const ledger = new SqliteLedger(dbPath);

  // L0：编年层。每次写入都追加到哈希链，账本可从链重建、可验未篡改。
  const chronicle = new Chronicle(path.join(path.dirname(dbPath), 'chronicle'));
  // L0 按周期切片：删除权的最小单位是 epoch，"删掉某一周"要能独立成立。
  const epochDays = Number(config.epochDays ?? 7);
  let epoch = chronicle.currentEpoch({ everyDays: epochDays });

  ctx.effect(() => () => ledger.close());

  const hotNow = () => buildHotMemory(ledger.active(), { maxBytes: hotBytes });

  /** 面板允许改的配置键（白名单，避免任意写配置） */
  const SETTABLE = new Set([
    'budget', 'hot', 'hotBytes', 'protocol', 'autoCapture', 'autoCaptureLevel', 'epochDays', 'render', 'scope',
  ]);

  // Cordis 的服务代理对未声明 inject 的属性访问会抛错（?. 挡不住），
  // 所以一律走 ctx.get()，并且整体兜底：注入失败不影响工具注册。
  const promptSvc = () => {
    try {
      return typeof ctx.get === 'function' ? ctx.get('systemPrompt') : undefined;
    } catch {
      return undefined;
    }
  };

  // ---- 自动注入：每轮都带一小块热记忆 ----
  // 这是"替代 mnemon"的关键一块：记忆不该等模型想起来才查。
  if (config.hot !== false) {
    try {
      const sp = promptSvc();
      if (!sp?.section) throw new Error('no systemPrompt');
      const dispose = sp.section({
        name: 'loom-hot-memory',
        order: 90,
        text: () => hotNow().text,
      });
      if (typeof dispose === 'function') ctx.effect(() => dispose);
    } catch {
      // 注入失败不能连累工具：宁可这轮没热记忆，也不能让记忆功能整个失效
    }
  }

  // ---- 使用协议：告诉模型什么时候该写、该查 ----
  if (config.protocol !== false) {
    try {
      const sp = promptSvc();
      if (!sp?.section) throw new Error('no systemPrompt');
      const dispose = sp.section({
        name: 'loom-memory-protocol',
        order: 91,
        text: PROTOCOL,
      });
      if (typeof dispose === 'function') ctx.effect(() => dispose);
    } catch {
      // 同上：注入是增强，不是前提
    }
  }


  /** 收下一条内容：文档一定留，claim 能过闸门才留 */
  const saveCaptured = (text, kind) => {
    const content = String(text ?? '').trim();
    if (!content) return null;
    const doc = ledger.putDoc({ title: makeTitle(content, { max: 24 }), body: content, tags: kind });
    chronicle.append(epoch, { doc: doc.id, title: doc.title, at: Date.now() });
    const r = ingest({
      line: content,
      body: content,
      kind,
      epochId: 'ep-live',
      ledger,
      title: makeTitle(content),
      source: { eventId: '#对话' },
    });
    let claimId = null;
    if (r.ok) {
      claimId = r.claim.id;
      epoch = chronicle.currentEpoch({ everyDays: epochDays });
      chronicle.append(epoch, { claimId, kind, aiw: r.claim.aiw, at: Date.now() });
    }
    return { docId: doc.id, claimId, rejected: r.ok ? null : r.gate.verdict, kind };
  };

  // ---- 原文归档：一条都不丢 ----
  // 先把已归档的指纹读回来，重启后不会重复写
  const archivedKeys = new Set();
  try {
    for (const ev of chronicle.read(epoch)) {
      if (ev?.event?.kind === 'msg' && ev.event.key) archivedKeys.add(ev.event.key);
    }
  } catch {
    // 读不到就当空集合
  }

  // ---- 原文归档（正式通道）：session/event ----
  // agent/pre-step 只带用户消息，且是 waterfall；session/event 是提交后的追加流，
  // user / assistant / tool 全在，这才是"一条都不丢"的地方。
  const hookLog = (err) => {
    try {
      fs.appendFileSync(path.join(path.dirname(dbPath), 'hook-errors.log'), `${new Date().toISOString()} ${err?.stack ?? err}\n`);
    } catch {}
  };

  try {
    if (typeof ctx.on === 'function') {
      ctx.on('session/event', (session, event) => {
        try {
          const type = event?.type;
          let role = null;
          let msg = null;
          if (type === 'user/message') {
            role = 'user';
            msg = event.data;
          } else if (type === 'assistant/message') {
            role = 'assistant';
            msg = event.data?.message;
          } else if (type === 'tool/result') {
            role = 'tool';
            msg = event.data?.message;
          }
          if (!role || !msg) return;

          const text = messageText(msg);
          if (!text) return;
          const key = messageKey({ role, content: text });
          if (archivedKeys.has(key)) return;
          archivedKeys.add(key);

          chronicle.append(chronicle.currentEpoch({ everyDays: epochDays }), {
            kind: 'msg',
            role,
            text,
            len: text.length,
            at: event?.time ?? Date.now(),
            seq: event?.seq,
            key,
          });
        } catch (err) {
          hookLog(err);
        }
      });
    }
  } catch (err) {
    hookLog(err);
  }

  // ---- 自动捕获：每轮从用户输入里挑值得记的 ----
  // 保守规则，不调模型；宁可漏，不可脏。
  if (config.autoCapture !== false) {
    try {
      if (typeof ctx.on === 'function') {
        ctx.on('agent/pre-step', (decision, next) => {
          try {
            const msgs = decision?.messages ?? [];
            // 原文归档由 session/event 负责；这里只抽可检索的视图
            const lastUser = [...msgs].reverse().find((m) => m?.role === 'user');
            const text = typeof lastUser?.content === 'string'
              ? lastUser.content
              : Array.isArray(lastUser?.content)
                ? lastUser.content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join(' ')
                : '';
            const pick = pickDurable(text, { level: autoCaptureLevel });
            if (pick.capture) saveCaptured(pick.text, pick.kind);
          } catch {
            // 捕获失败绝不能影响这一轮
          }
          return typeof next === 'function' ? next() : undefined;
        });
      }
    } catch {
      // 没有 pre-step 事件就不自动捕获，工具照常
    }
  }

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
        title: makeTitle(args.line),
        // 没写 #来源 时默认记成「会话」：工具调用天然来自当前对话，
        // 让使用者为了过校验去编一个来源，是把结构信息推给人填。
        source: { eventId: parseTail(args.line)?.source ?? '#会话' },
      });
      if (r.ok) {
        epoch = chronicle.currentEpoch({ everyDays: epochDays });
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



  // ---- 面板数据：/loom/state 路由 + 首屏种子 ----
  // webServer 不是启动即有：Cordis 文档明确说依赖它的注册要"服务就绪时"才发生。
  // 所以用 ctx.inject 等它，而不是在 apply 里 get() 一次（那样拿到 undefined，静默失败）。
  const snapshotForPanel = () => {
    const active = ledger.active();
    const byKind = {};
    for (const c of active) byKind[c.kind] = (byKind[c.kind] ?? 0) + 1;
    const rows = chronicle.epochs().map((e) => {
      if (e.destroyed) return { ok: true, events: 0 };
      const v = chronicle.verify(e.id);
      let n = 0;
      try { n = chronicle.read(e.id).length; } catch { n = 0; }
      return { ok: v.ok, events: n };
    });
    const hot = hotNow();
    let archived = 0;
    try {
      for (const ev of chronicle.read(epoch)) if (ev?.event?.kind === 'msg') archived++;
    } catch {}
    return {
      total: active.length,
      archived,
      byKind,
      epoch,
      hot: { bytes: hot.bytes, rule: hot.counts.rule, pref: hot.counts.pref, fact: hot.counts.fact },
      verify: { ok: rows.every((r) => r.ok), events: rows.reduce((n, r) => n + r.events, 0) },
      items: active
        .slice()
        .sort((a, b) => (b.validFrom ?? 0) - (a.validFrom ?? 0))
        .slice(0, 50)
        .map((c) => ({ id: c.id.slice(0, 8), kind: c.kind, aiw: c.aiw })),
      docs: (() => {
        try {
          return ledger.docs().slice(0, 30).map((d) => ({ id: d.id, title: d.title, tags: d.tags, updatedAt: d.updated_at }));
        } catch {
          return [];
        }
      })(),
      recent: (() => {
        try {
          return chronicle
            .read(epoch)
            .filter((ev) => ev?.event?.kind === 'msg')
            .slice(-30)
            .map((ev) => ({ role: ev.event.role, text: String(ev.event.text ?? '').slice(0, 240), at: ev.event.at }))
            .reverse();
        } catch {
          return [];
        }
      })(),
      config: {
        budget,
        hot: config.hot !== false,
        hotBytes,
        protocol: config.protocol !== false,
        autoCapture: config.autoCapture !== false,
        autoCaptureLevel,
        epochDays,
        render: policy,
        scope: config.scope === 'workspace' ? 'workspace' : 'global',
      },
    };
  };

  const mountPanelData = (scope) => {
    // Cordis 的服务代理对未 inject 的属性访问会抛错，所以每条路都单独兜
    let web;
    try { web = scope?.webServer; } catch { web = undefined; }
    if (!web) {
      try { web = typeof scope?.get === 'function' ? scope.get('webServer') : undefined; } catch { web = undefined; }
    }
    if (!web?.register) return;
    // 设置写入：面板表单 -> 宿主 configEditor 持久化
    web.register({
      kind: 'exact',
      path: '/loom/config',
      handler: async (req, res) => {
        const cors = { 'access-control-allow-origin': '*', 'content-type': 'application/json; charset=utf-8' };
        if (req?.method === 'OPTIONS') {
          res.writeHead(204, { ...cors, 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-max-age': '600' });
          res.end();
          return;
        }
        const reply = (code, obj) => {
          res.writeHead(code, cors);
          res.end(JSON.stringify(obj));
        };
        try {
          let raw = '';
          for await (const chunk of req) raw += chunk;
          const body = JSON.parse(raw || '{}');
          const key = String(body.key ?? '');
          if (!SETTABLE.has(key)) return reply(400, { ok: false, error: '不可设置的键：' + key });

          const editor = typeof ctx.get === 'function' ? ctx.get('configEditor') : undefined;
          if (!editor?.edit || !editor?.entries) return reply(503, { ok: false, error: '本宿主没有 configEditor' });

          const list = editor.entries();
          const entry =
            list.find((e) => e?.options?.id === 'loom-memory') ??
            list.find((e) => e?.id === 'loom-memory') ??
            list.find((e) => e?.name === 'loom-memory');
          if (!entry) return reply(404, { ok: false, error: '找不到 loom-memory 这一行配置' });

          const value = body.value;
          await editor.edit(entry, (current) => ({ ...current, [key]: value }));
          return reply(200, { ok: true, key, value, note: '已保存；部分设置需要重启或刷新页面生效' });
        } catch (e) {
          return reply(500, { ok: false, error: String(e?.message ?? e) });
        }
      },
    });

    // 打包下载：/loom/export.zip
    web.register({
      kind: 'exact',
      path: '/loom/export.zip',
      handler: async (req, res) => {
        try {
          const zip = bundleToZip(exportBundle(ledger));
          res.writeHead(200, {
            'content-type': 'application/zip',
            'content-disposition': 'attachment; filename="loom-memory.zip"',
            'access-control-allow-origin': '*',
            'cache-control': 'no-store',
          });
          res.end(zip);
        } catch (e) {
          res.writeHead(500, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
          res.end(JSON.stringify({ ok: false, error: String(e?.message ?? e) }));
        }
      },
    });

    // 原文检索：/loom/archive?q=关键词
    web.register({
      kind: 'exact',
      path: '/loom/archive',
      handler: async (req, res) => {
        const cors = { 'access-control-allow-origin': '*', 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
        try {
          const url = new URL(req?.url ?? '/', 'http://localhost');
          const q = String(url.searchParams.get('q') ?? '').trim();
          const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 200);
          const hits = [];
          for (const e of chronicle.epochs()) {
            if (e.destroyed) continue;
            let events = [];
            try { events = chronicle.read(e.id); } catch { continue; }
            for (const ev of events) {
              const m = ev?.event;
              if (m?.kind !== 'msg') continue;
              if (q && !String(m.text ?? '').includes(q)) continue;
              hits.push({ role: m.role, text: String(m.text ?? '').slice(0, 500), at: m.at });
              if (hits.length >= limit) break;
            }
            if (hits.length >= limit) break;
          }
          res.writeHead(200, cors);
          res.end(JSON.stringify({ ok: true, q, total: hits.length, hits }));
        } catch (e) {
          res.writeHead(500, cors);
          res.end(JSON.stringify({ ok: false, error: String(e?.message ?? e) }));
        }
      },
    });

    web.register({
      kind: 'exact',
      path: '/loom/state',
      handler: async (req, res) => {
        // 页面可能来自 dsh-app:// 这类自定义协议，属于跨源：要显式允许
        if (req?.method === 'OPTIONS') {
          res.writeHead(204, {
            'access-control-allow-origin': '*',
            'access-control-allow-methods': 'GET, OPTIONS',
            'access-control-max-age': '600',
          });
          res.end();
          return;
        }
        try {
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            'access-control-allow-origin': '*',
          });
          res.end(JSON.stringify(snapshotForPanel()));
        } catch (e) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      },
    });
    // 首屏种子：路由万一被鉴权挡住，面板也先有数据可看
    if (typeof web.tapIndex === 'function') {
      web.tapIndex((html) => {
        let json = '{}';
        try {
          json = JSON.stringify(snapshotForPanel()).replace(/</g, '\\u003c');
        } catch {}
        const tag = `<script>window.__LOOM_SEED__=${json};</script></head>`;
        return html.includes('</head>') ? html.replace('</head>', tag) : html + tag;
      });
    }
  };

  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (inner) => mountPanelData(inner));
    } else {
      mountPanelData(ctx);
    }
  } catch {
    // 没有 webServer 就不提供面板数据，工具照常可用
  }

  // ---- 斜杠命令：不开界面也能查 ----
  ctx.effect(() => {
    let dispose = () => {};
    try {
      const commands = typeof ctx.get === 'function' ? ctx.get('commands') : undefined;
      if (commands?.register) {
        dispose = commands.register({
          name: 'loom',
          description: 'LOOM 记忆：stats / outline / verify / hot / search',
          input: { hint: 'stats | outline | verify | hot | search <关键词>' },
          handler: (invocation) =>
            runLoomCommand(invocation?.rawInput ?? '', {
              ledger,
              hot: hotNow,
              verify: () => {
                const rows = chronicle.epochs().map((e) => {
                  if (e.destroyed) return { ok: true, events: 0 };
                  const v = chronicle.verify(e.id);
                  let n = 0;
                  try { n = chronicle.read(e.id).length; } catch { n = 0; }
                  return { ok: v.ok, events: n };
                });
                return {
                  ok: rows.every((r) => r.ok),
                  epochs: rows.length,
                  events: rows.reduce((n, r) => n + r.events, 0),
                  current: epoch,
                };
              },
            }),
        });
      }
    } catch {
      // 命令注册失败不影响工具
    }
    return dispose;
  });

  // ---- 关系边 ----
  ctx.tools.register({
    name: 'memory_link',
    description: '给两条记忆连一条边（temporal/semantic/causal/entity）。关系本身也是记忆。',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: '起点 id（可给前 8 位）' },
        to: { type: 'string', description: '终点 id（可给前 8 位）' },
        type: { type: 'string', description: 'temporal | semantic | causal | entity' },
      },
      required: ['from', 'to'],
    },
    output: OUT,
    async execute(args) {
      const a = ledger.get(args.from) ?? ledger.active().find((c) => c.id.startsWith(args.from));
      const b = ledger.get(args.to) ?? ledger.active().find((c) => c.id.startsWith(args.to));
      if (!a || !b) return { ok: false, reason: '端点不存在' };
      const e = ledger.link(a.id, b.id, { type: args.type ?? 'semantic' });
      return { ok: true, from: a.id.slice(0, 8), to: b.id.slice(0, 8), type: e.type };
    },
  });

  ctx.tools.register({
    name: 'memory_related',
    description: '顺着边找相邻的记忆（BFS），返回距离与类型。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '起点 id（可给前 8 位）' },
        depth: { type: 'number', description: '深度，默认 1' },
        type: { type: 'string', description: '只看某类边' },
      },
      required: ['id'],
    },
    output: OUT,
    async execute(args) {
      const c = ledger.get(args.id) ?? ledger.active().find((x) => x.id.startsWith(args.id));
      if (!c) return { ok: false, reason: '找不到这条记忆' };
      const rows = ledger.related(c.id, { depth: Number(args.depth ?? 1), type: args.type });
      return { ok: true, from: c.id.slice(0, 8), found: rows.length, related: rows };
    },
  });

  // ---- 原样捕获（不会拒绝） ----
  ctx.tools.register({
    name: 'memory_note',
    description:
      '把用户一句话原样收下：先存成文档，短的话再顺手提炼成一条记忆。' +
      '与 memory_write 的区别是它**不会拒绝**——格式不对、太长都只是不进 claim，文档一定留下。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '用户原话，可以带「记住」这类指令词' },
        kind: { type: 'string', description: '强制指定类型，省略则按内容猜' },
        title: { type: 'string', description: '文档标题，省略取前 16 字' },
      },
      required: ['text'],
    },
    output: OUT,
    async execute(args) {
      const intent = detectIntent(args.text);
      const content = stripCue(args.text) || String(args.text ?? '');
      const kind = args.kind ?? intent.kind;

      const doc = ledger.putDoc({
        title: args.title ?? makeTitle(content, { max: 24 }),
        body: content,
        tags: kind,
      });
      chronicle.append(epoch, { doc: doc.id, title: doc.title, at: Date.now() });

      let claimId = null;
      let rejected = null;
      const r = ingest({
        line: content,
        body: content,
        kind,
        epochId: 'ep-live',
        ledger,
        title: makeTitle(content),
        source: { eventId: '#会话' },
      });
      if (r.ok) {
        claimId = r.claim.id;
        epoch = chronicle.currentEpoch({ everyDays: epochDays });
        chronicle.append(epoch, { claimId, kind, aiw: r.claim.aiw, at: Date.now() });
      } else {
        rejected = r.gate.verdict;
      }

      return { ok: true, docId: doc.id, claimId: claimId ? claimId.slice(0, 8) : null, kind, due: intent.due, rejected };
    },
  });

  // ---- 项目文档 ----
  ctx.tools.register({
    name: 'memory_doc_write',
    description: '写一篇项目文档（长文，不受 AI文 短断言限制）。同标题视为同一篇，会更新而不是堆叠。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '文档标题（也是身份）' },
        body: { type: 'string', description: '正文，可以很长' },
        tags: { type: 'string', description: '逗号分隔的标签，可省略' },
      },
      required: ['title', 'body'],
    },
    output: OUT,
    async execute(args) {
      const d = ledger.putDoc({ title: args.title, body: args.body, tags: args.tags ?? '' });
      chronicle.append(epoch, { doc: d.id, title: d.title, at: Date.now() });
      return { ok: true, id: d.id, title: d.title, chars: d.body.length };
    },
  });

  ctx.tools.register({
    name: 'memory_doc_search',
    description: '在项目文档里检索（bigram + bm25），返回标题与正文片段。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索词' },
        limit: { type: 'number', description: '默认 5' },
      },
      required: ['query'],
    },
    output: OUT,
    async execute(args) {
      const hits = ledger.searchDocs(args.query, { limit: Number(args.limit ?? 5) });
      return {
        hits: hits.map((h) => ({ id: h.id, title: h.title, excerpt: h.body.slice(0, 160) })),
        total: hits.length,
      };
    },
  });

  // ---- 热记忆预览 ----
  ctx.tools.register({
    name: 'memory_hot',
    description: '看这一轮被自动注入了什么（热记忆原文 + 统计），用来调 hotBytes 或验证注入是否生效。',
    parameters: { type: 'object', properties: {} },
    output: OUT,
    async execute() {
      const hot = hotNow();
      return { injected: config.hot !== false, budgetBytes: hotBytes, bytes: hot.bytes, counts: hot.counts, omitted: hot.omitted, text: hot.text };
    },
  });

  // ---- 原文检索：从归档里把上下文捞回来 ----
  ctx.tools.register({
    name: 'memory_archive_search',
    description:
      '在原文归档里检索（逐字，不过滤寒暄与粘贴）。返回命中的对话片段，用于还原上下文。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要找回的字词' },
        limit: { type: 'number', description: '默认 10' },
        role: { type: 'string', description: '只看 user / assistant / system' },
      },
      required: ['query'],
    },
    output: OUT,
    async execute(args) {
      const q = String(args.query ?? '').trim();
      const limit = Number(args.limit ?? 10);
      if (!q) return { ok: false, reason: '给个关键词' };
      const hits = [];
      for (const e of chronicle.epochs()) {
        if (e.destroyed) continue;
        let events = [];
        try { events = chronicle.read(e.id); } catch { continue; }
        for (const ev of events) {
          const m = ev.event;
          if (m?.kind !== 'msg') continue;
          if (args.role && m.role !== args.role) continue;
          if (!String(m.text ?? '').includes(q)) continue;
          hits.push({ role: m.role, at: m.at, text: String(m.text).slice(0, 300), epoch: e.id });
          if (hits.length >= limit) break;
        }
        if (hits.length >= limit) break;
      }
      return { ok: true, hits, total: hits.length };
    },
  });

  // ---- 自检：这个宿主里哪些服务可用 ----
  ctx.tools.register({
    name: 'memory_diag',
    description: '插件自检：本宿主里 systemPrompt / webServer / commands 是否可用，以及注入与面板的挂载状态。',
    parameters: { type: 'object', properties: {} },
    output: OUT,
    async execute() {
      const has = (name) => {
        try {
          const v = typeof ctx.get === 'function' ? ctx.get(name) : undefined;
          return !!v;
        } catch {
          return false;
        }
      };
      const hot = hotNow();
      return {
        services: {
          systemPrompt: has('systemPrompt'),
          webServer: has('webServer'),
          commands: has('commands'),
        },
        injection: { enabled: config.hot !== false && config.protocol !== false, bytes: hot.bytes },
        dbPath,
        epoch,
        total: ledger.active().length,
      };
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
      const epochs = chronicle.epochs();
      const rows = epochs.map((e) => {
        if (e.destroyed) return { id: e.id, destroyed: true, events: 0, ok: true };
        const v = chronicle.verify(e.id);
        let events = 0;
        try { events = chronicle.read(e.id).length; } catch { events = -1; }
        return { id: e.id, destroyed: false, events, ok: v.ok };
      });
      const events = rows.reduce((n, r) => n + Math.max(0, r.events), 0);
      return { ok: rows.every((r) => r.ok), events, epochs: rows.length, current: epoch, detail: rows };
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

      // 不要造墓碑条目：墓碑一旦入库就成了"正常记忆"，会出现在列表和计数里。
      // 失效信息已经由 valid_to + supersede_log + L0 事件三处记录，足够回查。
      ledger.supersede(claim.id, null, args.reason ?? '用户要求');
      // 一起写下的文档也要失活，否则记忆能靠文档检索"复活"
      const docs = ledger.docsByBody(claim.body);
      for (const d of docs) ledger.setDocCold(d.id, true);
      chronicle.append(epoch, { forget: claim.id, reason: args.reason ?? '用户要求', at: Date.now() });

      return { ok: true, id: claim.id.slice(0, 8), supersededBy: null };
    },
  });
}
