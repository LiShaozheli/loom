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
import crypto from 'node:crypto';

import { ingest } from './vendor/ingest.js';
import { parseTail, makeTitle } from './vendor/aiw.js';
import { recall } from './vendor/recall.js';
import { render } from './vendor/render.js';
import { settleTurn } from './vendor/settle.js';
import { sweep } from './vendor/decay.js';
import { buildHotMemory } from './vendor/hot.js';
import { resolveDbPath } from './vendor/paths.js';
import { detectIntent, stripCue } from './vendor/capture.js';
import { pickDurable, stripRuntimeNoise } from './vendor/autocapture.js';
import { messageText, messageKey } from './vendor/archive.js';
import { runLoomCommand } from './vendor/command.js';
import { Chronicle } from './vendor/chronicle.js';
import { exportBundle, bundleToZip, importBundle, zipToBundle } from './vendor/bundle.js';
import { SqliteLedger } from './vendor/sqlite-ledger.js';
import { SETTING_SPECS, normalizeSetting, validateChange } from './vendor/settings.js';
import { appendRotating } from './vendor/logfile.js';

const text = (s) => [{ type: 'text', text: String(s) }];

// ---- 进程内共享状态 ----
// 宿主重载插件时，模块本身也可能被重新导入一次；模块顶层的变量会各自一份。
// 所以「全进程只能有一份」的东西（打开的库 / 当前实例 / 路由表）必须挂在 globalThis 上，
// 否则新旧两份模块各看到自己的 Map，引用计数和路由去重都会失效。
const SHARED =
  globalThis.__LOOM_SHARED__ ??
  (globalThis.__LOOM_SHARED__ = {
    ledgers: new Map(), // dbPath -> { refs, ledger }
    live: null, // 当前活着的 apply 实例
    routes: new Map(), // path -> 当前实例的 handler
    // 注意：不能用对象键记"这个 webServer 注册过没有"。宿主每次 apply 给的
    // 都是新的服务代理，对象键永远 miss；而按 path 记账又会在 webServer 真被
    // 重建时漏挂。所以不记账：每次照常注册，把 duplicate 当成"已挂上"。
    seedInstalled: false, // 首屏种子只装一次
    log: null, // 当前实例的 hookLog，给全局的兜底用
    // 面板数据的访问令牌。/loom/* 是本地 HTTP 面，任何网页都 fetch 得到，
    // 只靠 CORS 挡不住（allow-origin: * 是我们自己发的）。令牌注入页面里，
    // 跨源页面读不到宿主 HTML，也就拿不到它。
    // 放进程级而不是实例级：保存设置会触发插件重载，实例级令牌一变，
    // 已经打开的页面立刻全部 403 —— 等于用一次设置把自己锁在门外。
    token: crypto.randomBytes(16).toString('hex'),
  });

// 热重载会复用同一个 SHARED 对象，上一版写的字段可能对不上，补齐再用
SHARED.ledgers ??= new Map();
SHARED.routes ??= new Map();
SHARED.live ??= null;
if (typeof SHARED.seedInstalled !== 'boolean') SHARED.seedInstalled = false;
if (typeof SHARED.token !== 'string' || SHARED.token.length < 16) {
  SHARED.token = crypto.randomBytes(16).toString('hex');
}

// ---- 打开的库：按路径去重 + 引用计数 ----
// 宿主重载插件时新旧两个实例会短暂并存，旧实例的 prompt section 可能还活着。
// 各自开一个连接不算错，各自 close 才是灾难：一个关掉，另一个就用不了了。
const OPEN_LEDGERS = SHARED.ledgers;

/** @returns {{ledger: SqliteLedger, release: () => void}} */
function acquireLedger(dbPath) {
  const key = path.resolve(dbPath);
  let rec = OPEN_LEDGERS.get(key);
  if (!rec) {
    rec = { refs: 0, ledger: new SqliteLedger(key) };
    OPEN_LEDGERS.set(key, rec);
  }
  rec.refs += 1;
  let released = false;
  return {
    ledger: rec.ledger,
    release() {
      if (released) return;
      released = true;
      rec.refs -= 1;
      if (rec.refs > 0) return;
      OPEN_LEDGERS.delete(key);
      try {
        rec.ledger.close();
      } catch {
        // 已经关了，或者进程正在退出
      }
    },
  };
}

const OUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => text(JSON.stringify(value, null, 2)),
};

/** 当前活着的实例；插件卸载或正在重载时是 null */
function liveNow() {
  return SHARED.live;
}

/** 热记忆文本：永远读「当前实例」，读不到就给空串。
 *  装 prompt 的时候绝不允许抛——记忆是增强，不是前提。
 *  失败原因（库被关、库损坏、磁盘满……）写进 hook-errors.log，这一轮照常继续。 */
function hotText(sid) {
  try {
    const live = liveNow();
    if (!live) return '';
    const got = live.hotFor(sid);
    return got?.text == null ? '' : String(got.text);
  } catch (err) {
    try {
      SHARED.log?.(err, 'prompt section failed');
    } catch {}
    return '';
  }
}

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
      budget: Schema.number()
        .description('单次 memory_recall 的 token 预算')
        .min(50)
        .max(4000)
        .default(300),
      hot: Schema.boolean().description('每轮自动注入热记忆').default(true),
      hotBytes: Schema.number()
        .description('热记忆字节上限（进每一轮上下文，就是长期成本）')
        .min(0)
        .max(16384)
        .default(2048),
      hotAppendOnly: Schema.boolean()
        .description(
          '热块追加式渲染：新记忆排在尾部而不是插到开头，避免每次写入都把整块往下推（前缀缓存友好）'
        )
        .default(true),
      hotOrder: Schema.number()
        .description('热块的 section 顺序号：越大越靠后。越靠后，块变化时要重付的后缀越短')
        .min(1)
        .max(999)
        .default(95),
      protocol: Schema.boolean()
        .description('是否注入「什么时候该写、该查」的使用协议')
        .default(true),
      autoCapture: Schema.boolean()
        .description('从对话里自动挑值得记的内容（规则判定，不调模型）')
        .default(true),
      memoryScope: Schema.union([Schema.const('shared'), Schema.const('session')])
        .description('默认范围：shared 所有会话共享；session 每个会话只看自己写的 + 公共条目')
        .default('shared'),
      isolatedSessions: Schema.array(Schema.string())
        .description('单独特定的独立记忆会话 id；列在这里的会话只召回自己写的 + 公共条目')
        .default([]),
      autoCaptureLevel: Schema.union([Schema.const('normal'), Schema.const('strict')])
        .description('normal 连偏好与项目陈述一起记；strict 只认标识符与参数')
        .default('normal'),
      epochDays: Schema.number()
        .description('L0 时间片长度（天）；删除权的最小单位')
        .min(1)
        .max(365)
        .default(7),
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

/** @param {any} ctx @param {{dbPath?:string, budget?:number, render?:'legend'|'plain'|'xml', epochDays?:number, hotBytes?:number, hotAppendOnly?:boolean, hotOrder?:number, hot?:boolean}} config */
export function apply(ctx, config = {}) {
  const budget = Number(config.budget ?? 300);
  const policy = config.render ?? 'legend';
  const hotBytes = Number(config.hotBytes ?? DEFAULT_HOT_BYTES);
  const hotAppendOnly = config.hotAppendOnly !== false;
  const hotOrder = Number(config.hotOrder ?? 95);
  const autoCaptureLevel = config.autoCaptureLevel === 'strict' ? 'strict' : 'normal';
  // 谁能看到谁的记忆：
  //   memoryScope=session      默认就把每个会话隔开（老开关，保留）
  //   isolatedSessions=[...]   只隔开名单里的会话，其余共享（面板上那个下拉框选的就是它）
  // 两种同时存在时取并集：名单内的会话一定独立。
  const isolateAll = config.memoryScope === 'session';
  const isolatedSet = new Set(
    (Array.isArray(config.isolatedSessions) ? config.isolatedSessions : [])
      .map(String)
      .filter(Boolean)
  );
  const isIsolated = (sid) => !!sid && (isolateAll || isolatedSet.has(String(sid)));
  const scopeFilter = (sid) => (isIsolated(sid) ? { session: sid } : {});
  const dbPath =
    config.dbPath && config.dbPath.trim()
      ? config.dbPath
      : config.scope === 'workspace'
        ? resolveDbPath({ scope: 'workspace', workspace: process.cwd() }).dbPath
        : path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'loom', 'loom.db');

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  // 失败留痕。必须定义在 apply 最前面：下面装 prompt section 时就要用到它。
  // （以前它在 300 行开外，谁想在 section 里引用就先撞 TDZ，于是只能裸调用，一抛就整轮完蛋）
  // 带级别、并且按大小轮转：这个文件原来只追加不清理，长到 98KB 也没人发现。
  // 级别只是个固定词，方便 `grep ERROR hook-errors.log` 跳过正常流水。
  const hookLog = (err, note) => {
    if (!err && !note) return;
    try {
      const level = err ? 'ERROR' : 'NOTE';
      const body = err ? String(err?.stack ?? err) : String(note);
      appendRotating(
        path.join(path.dirname(dbPath), 'hook-errors.log'),
        `${new Date().toISOString()} ${level} ${body}\n`
      );
    } catch {}
  };
  SHARED.log = hookLog;

  // 一个库路径只留一个打开的连接。
  // 起因是一个真实事故：改任何设置都会让宿主机重载这个插件——旧实例 dispose 时把库关了，
  // 而挂在各 agent 上的热记忆 section（生命周期跟着 agent，不跟着插件）还握着旧连接，
  // 于是下一轮装 prompt 时抛 "database is not open"，整轮失败。
  // 引用计数解决它：新实例拿到的是同一个连接，旧闭包读到的也是活的。
  const conn = acquireLedger(dbPath);
  const ledger = conn.ledger;

  // L0：编年层。每次写入都追加到哈希链，账本可从链重建、可验未篡改。
  const chronicle = new Chronicle(path.join(path.dirname(dbPath), 'chronicle'));
  // L0 按周期切片：删除权的最小单位是 epoch，"删掉某一周"要能独立成立。
  const epochDays = Number(config.epochDays ?? 7);
  let epoch = chronicle.currentEpoch({ everyDays: epochDays });

  /** 热记忆；传 sid 且该会话被划成独立时只看本会话 + 全局 */
  const hotFor = (sid) =>
    buildHotMemory(ledger.active(undefined, scopeFilter(sid)), {
      maxBytes: hotBytes,
      appendOnly: hotAppendOnly,
    });
  const hotNow = () => hotFor(null);

  // 把自己登记成「当前实例」：上一代实例遗留的 prompt section 和路由，取到的都是这一份。
  const myLive = { hotFor, snapshot: null };
  SHARED.live = myLive;

  // 卸载时：先摘掉自己的登记（别让旧闭包再被当成活的），再减引用。
  // 连接不直接 close——别的实例可能还在用。
  ctx.effect(() => () => {
    if (SHARED.live === myLive) SHARED.live = null;
    conn.release();
  });

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
  // 同一作用域下，注册在同名 scoped section 会覆盖 global 的那个：
  // 全局那份当兜底（共享视图），每个 agent 再注册一份按会话过滤的。
  if (config.hot !== false) {
    try {
      const sp = promptSvc();
      if (sp?.section) {
        const dispose = sp.section({
          name: 'loom-hot-memory',
          order: hotOrder,
          // hotText 读「当前实例」且永不抛：插件重载后旧 section 也能读到新实例的热记忆
          text: () => hotText(null),
        });
        if (typeof dispose === 'function') ctx.effect(() => dispose);
      }
    } catch (err) {
      hookLog(err, 'global hot section failed');
    }

    try {
      if (typeof ctx.on === 'function') {
        ctx.on('agent/created', ({ agent }) => {
          try {
            const sid = agent?.id;
            if (!sid) return;
            const resolveSp = (from) => {
              let got;
              try {
                got = from?.systemPrompt;
              } catch {
                got = undefined;
              }
              if (!got) {
                try {
                  got = typeof from?.get === 'function' ? from.get('systemPrompt') : undefined;
                } catch {
                  got = undefined;
                }
              }
              return got;
            };
            const sp = resolveSp(agent.ctx);
            if (!sp?.section) return;
            agent.ctx.effect(() =>
              sp.section({
                name: 'loom-hot-memory',
                order: hotOrder,
                text: () => hotText(sid),
              })
            );
          } catch (err) {
            hookLog(err, 'per-agent hot section failed');
          }
        });
      }
    } catch (err) {
      hookLog(err, 'agent/created listener failed');
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
  const saveCaptured = (raw, kind, sessionId) => {
    const content = String(raw ?? '').trim();
    if (!content) return null;
    const doc = ledger.putDoc({
      title: makeTitle(content, { max: 24 }),
      body: content,
      tags: kind,
    });
    chronicle.append(epoch, { doc: doc.id, title: doc.title, at: Date.now() });
    const r = ingest({
      line: content,
      body: content,
      kind,
      epochId: 'ep-live',
      ledger,
      title: makeTitle(content),
      source: { eventId: sessionId ? `#会话:${String(sessionId).slice(0, 8)}` : '#对话' },
      sessionId: sessionId ?? null,
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
  // （hookLog 在本函数开头就定义了，底下各处直接用）
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

          const body = messageText(msg);
          if (!body) return;
          const key = messageKey({ role, content: body });
          if (archivedKeys.has(key)) return;
          archivedKeys.add(key);

          chronicle.append(chronicle.currentEpoch({ everyDays: epochDays }), {
            kind: 'msg',
            role,
            text: body,
            len: body.length,
            at: event?.time ?? Date.now(),
            seq: event?.seq,
            session: session?.id ?? null,
            key,
          });

          // 自动捕获也挂在这里：pre-step 那条路在真实宿主里没触发过，
          // 而 session/event 是确定会来的（归档一直是好的）。
          if (role === 'user' && config.autoCapture !== false) {
            try {
              // 先剥掉宿主塞进来的运行时上下文，否则只会看到"一坨多行长文"
              const human = stripRuntimeNoise(body);
              const pick = pickDurable(human, { level: autoCaptureLevel });
              if (pick.capture) {
                const saved = saveCaptured(pick.text, pick.kind, session?.id);
                if (saved) hookLog(null, `captured ${pick.kind} ${saved.claimId ?? saved.docId}`);
              }
            } catch (err) {
              hookLog(err);
            }
          }
        } catch (err) {
          hookLog(err);
        }
      });
    }
  } catch (err) {
    hookLog(err);
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
    async execute(args, exec = {}) {
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
        sessionId: exec?.agent?.id ?? null,
      });
      if (r.ok) {
        epoch = chronicle.currentEpoch({ everyDays: epochDays });
        chronicle.append(epoch, {
          claimId: r.claim.id,
          kind: r.claim.kind,
          aiw: r.claim.aiw,
          at: Date.now(),
        });
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
    async execute(args, exec) {
      const r = recall({
        query: args.query,
        search: (q) => ledger.search(q, { limit: 50, ...scopeFilter(exec?.agent?.id) }),
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
        used: {
          type: 'array',
          items: { type: 'string' },
          description: '被引用的记忆 id（可只给前 8 位）',
        },
        correct: { type: 'boolean', description: '这轮结果是否正确；未知可省略' },
        answer: { type: 'string', description: '模型回答，用于自动归因（与 used 二选一或并用）' },
        items: { type: 'array', items: { type: 'string' }, description: '本轮注入的记忆 id 列表' },
      },
      required: ['used'],
    },
    output: OUT,
    async execute(args, _exec = {}) {
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
      const usedFull = (args.used ?? []).map(
        (u) => items.find((i) => i.claimId.startsWith(u))?.claimId ?? u
      );
      const answer = args.answer ?? usedFull.map((u) => `[#${u.slice(0, 8)}]`).join(' ');

      const r = settleTurn({ answer, items, ledger, correct: args.correct ?? null });
      return { ok: true, used: r.used.map((u) => u.slice(0, 8)), updated: r.updated.length };
    },
  });

  // ---- 遗忘扫描 ----
  ctx.tools.register({
    name: 'memory_decay',
    description:
      '按时间与使用频次扫描记忆，给出降级建议（keep/summarize/pointerize/archive）。默认只预览。',
    parameters: {
      type: 'object',
      properties: { apply: { type: 'boolean', description: 'true 才真的标 cold' } },
    },
    output: OUT,
    async execute(args = {}, _exec = {}) {
      const r = sweep(ledger, { apply: args.apply === true });
      return { applied: r.applied, counts: r.counts, rows: r.rows.slice(0, 20) };
    },
  });

  // ---- 面板数据：/loom/state 路由 + 首屏种子 ----
  // webServer 不是启动即有：Cordis 文档明确说依赖它的注册要"服务就绪时"才发生。
  // 所以用 ctx.inject 等它，而不是在 apply 里 get() 一次（那样拿到 undefined，静默失败）。
  //
  // 读取成本必须和「打开面板」这件事相称。原来这里每次都要：
  // hydrate 全部 active 条目、把 6.7MB 档案解密 3 遍、再全链重算一遍 —— 一次 100ms+。
  // 现在换成 O(1) 或增量，理由分别是：
  //   · 总数/分类   → SQL 聚合，不把正文搬进内存（ledger.stats）
  //   · 档案规模   → 读 meta 锚点里的计数（chronicle.stats），不解密
  //   · 最近消息   → 只解密尾部若干条，并按文件大小缓存（chronicle.tail）
  //   · 链状态     → 只算上次验过之后的增量（chronicle.verifyFast）

  // 「最近消息」缓存：键是文件大小 —— 没新写入就直接复用，不必再读尾部
  let recentCache = { epoch: null, size: -1, items: [] };

  const recentMessages = (want = 30) => {
    try {
      const head = chronicle.head(epoch); // O(1)
      if (recentCache.epoch === epoch && recentCache.size === head.size) return recentCache.items;

      // msg 事件和 doc/claim/forget 事件混在同一条链里，所以多取一些尾部再筛
      const pick = (recs) =>
        recs.filter((ev) => ev?.event?.kind === 'msg' && ev.event.role !== 'tool');
      let recs = chronicle.tail(epoch, Math.max(want * 4, 120));
      let msgs = pick(recs);
      // 尾部大多是事件、凑不够 30 条消息：放大窗口再取一次（读的都是尾部字节，仍很便宜）
      if (msgs.length < want && head.seq > recs.length) {
        recs = chronicle.tail(epoch, Math.min(head.seq, recs.length * 8));
        msgs = pick(recs);
      }
      const items = msgs
        .slice(-want)
        .map((ev) => ({
          role: ev.event.role,
          text: String(ev.event.text ?? '').slice(0, 240),
          at: ev.event.at,
        }))
        .reverse();
      recentCache = { epoch, size: head.size, items };
      return items;
    } catch {
      return [];
    }
  };

  const snapshotForPanel = () => {
    const counts = (() => {
      try {
        return ledger.stats();
      } catch {
        return { total: 0, byKind: {} };
      }
    })();

    const rows = chronicle.epochs().map((e) => {
      if (e.destroyed) return { ok: true, events: 0 };
      try {
        return { ok: chronicle.verifyFast(e.id).ok, events: chronicle.stats(e.id).records };
      } catch {
        return { ok: false, events: 0 };
      }
    });

    const hot = hotNow();
    // archived = 当前 epoch 里归档的原文条数：读锚点计数，不为了一个数字解密整个档案
    const archived = (() => {
      try {
        return chronicle.stats(epoch).kinds?.msg ?? 0;
      } catch {
        return 0;
      }
    })();

    return {
      total: counts.total,
      archived,
      byKind: counts.byKind,
      epoch,
      hot: {
        bytes: hot.bytes,
        rule: hot.counts.rule,
        pref: hot.counts.pref,
        fact: hot.counts.fact,
      },
      verify: { ok: rows.every((r) => r.ok), events: rows.reduce((n, r) => n + r.events, 0) },
      items: (() => {
        try {
          return ledger.recent(50).map((c) => ({ id: c.id.slice(0, 8), kind: c.kind, aiw: c.aiw }));
        } catch {
          return [];
        }
      })(),
      docs: (() => {
        try {
          return ledger
            .docs(30)
            .map((d) => ({ id: d.id, title: d.title, tags: d.tags, updatedAt: d.updated_at }));
        } catch {
          return [];
        }
      })(),
      recent: recentMessages(30),
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
        memoryScope: isolateAll ? 'session' : 'shared',
        isolatedSessions: [...isolatedSet],
        // 面板要显示「当前真正用哪个库」：配置里可能是空串（用默认位置），
        // 直接回显空串的话，用户看不出到底落在哪，换路径时也没有对照。
        dbPath: String(config.dbPath ?? ''),
        dbPathEffective: dbPath,
      },
    };
  };

  // 面板快照挂到「当前实例」上：首屏种子和路由都经由它取，重载后自动指向新实例
  myLive.snapshot = snapshotForPanel;

  const mountedRoutes = [];

  const mountPanelData = (scope) => {
    // 跨源 POST 会先发预检；allow-headers 少一个 content-type，浏览器就直接拒绝。
    const CORS_JSON = {
      'access-control-allow-origin': '*',
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    };
    const CORS_PREFLIGHT = {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      // 少一个自定义头，浏览器就直接拒发真正的请求（预检失败 = Failed to fetch）
      'access-control-allow-headers': 'content-type, x-loom-token',
      'access-control-max-age': '600',
    };
    // Cordis 的服务代理对未 inject 的属性访问会抛错，所以每条路都单独兜
    const resolveWeb = (from) => {
      let got;
      try {
        got = from?.webServer;
      } catch {
        got = undefined;
      }
      if (!got) {
        try {
          got = typeof from?.get === 'function' ? from.get('webServer') : undefined;
        } catch {
          got = undefined;
        }
      }
      return got;
    };
    // ctx.inject 给的子上下文若取不到服务，退回插件自身的 ctx 再试一次
    const web = resolveWeb(scope) ?? resolveWeb(ctx);
    if (!web?.register) return;

    // 宿主自己的 origin：同源请求（面板、地址栏、curl）直接放行，不需要令牌
    const ownOrigin = (() => {
      try {
        return typeof web.getOrigin === 'function' ? String(web.getOrigin() ?? '') : '';
      } catch {
        return '';
      }
    })();

    /**
     * 访问门禁。所有路由共用这一个判断（在 dispatch 里），不各写一遍。
     *
     * 为什么必须有：这些路由能读全量记忆、能改配置、能删、能导入 ——
     * 而它们是本机 HTTP 端口上的，任何网页都能 fetch 到。
     * CORS 只决定「能不能读响应」，挡不住「请求已经执行」：
     *   POST /loom/forget 是简单请求之外的 JSON POST，会先预检，
     *   但预检我们自己发了 allow-origin: * —— 等于自己把门开开。
     *
     * 放行条件（满足其一）：
     *   1. 带对令牌（面板从页面里拿；跨源页面读不到宿主 HTML，拿不到）
     *   2. 没有 Origin 头（curl、服务端调用；跨源 fetch 一定带 Origin）
     *   3. Origin 就是宿主自己（同源页面）
     * OPTIONS 直接放行：预检不带自定义头，真正的请求还会再过一次这里。
     */
    const denied = (req) => {
      if (req?.method === 'OPTIONS') return null;
      let url;
      try {
        url = new URL(req?.url ?? '/', 'http://localhost');
      } catch {
        return 'bad-url';
      }
      const token = req?.headers?.['x-loom-token'] || url.searchParams.get('t');
      if (token && token === SHARED.token) return null;
      const origin = req?.headers?.origin;
      if (!origin) return null;
      if (ownOrigin && origin === ownOrigin) return null;
      return 'cross-origin';
    };

    // 逐条注册：一条失败不该带走其余，而且失败必须留痕
    // （之前整块 try 包住 8 条 register，任何一条抛错其余全部静默失踪）
    //
    // 每条路在本进程里只向 webServer 注册一次，之后重载只替换 handler：
    //   - 不然每次重载都撞 "duplicate exact route"，而且被拒的是新实例，
    //     浏览器那边一直连着上一代实例 → 请求空响应
    //   - 分发时取 SHARED.routes 里的当前 handler，所以路由永远服务最新实例
    //   - 已注册的路由不重复注册，只更新 SHARED.routes 里那一项
    const safeRegister = (spec) => {
      const p = spec.path;
      SHARED.routes.set(p, spec.handler);
      mountedRoutes.push(p);

      const dispatch = async (req, res) => {
        const handler = SHARED.routes.get(p);
        // 插件被卸载/正在重载：给一个能看懂的答案，别让浏览器等到超时
        const bail = (code, error) => {
          try {
            if (!res.headersSent) res.writeHead(code, CORS_JSON);
            res.end(JSON.stringify({ ok: false, error }));
          } catch {}
        };
        if (!SHARED.live) return bail(503, 'loom 插件已停用或正在重载，稍后再试');
        const blocked = denied(req);
        if (blocked) {
          hookLog(
            new Error(`denied(${blocked}) ${req?.method ?? '?'} ${String(req?.url ?? '')}`),
            'route denied'
          );
          return bail(403, '拒绝访问：跨源请求没有携带 x-loom-token');
        }
        if (typeof handler !== 'function') return bail(503, 'loom 路由还没有就绪');
        try {
          return await handler(req, res);
        } catch (err) {
          // handler 自己没兜住的异常，绝不能变成"空响应"（浏览器只会报 ERR_EMPTY_RESPONSE）
          hookLog(err, `route crashed: ${p}`);
          return bail(500, String(err?.message ?? err));
        }
      };

      try {
        web.register({ ...spec, handler: dispatch });
      } catch (err) {
        // "已存在"不是失败：那一定是上一代实例挂的同一个 dispatch，
        // 它也走 SHARED.routes，功能完全等价，安静复用即可。
        // 不预先记账（宿主的服务代理每次 apply 都是新对象，记不住），
        // 而是每次都试注册、把 duplicate 当成功——万一 webServer 真被重建，也能自动补挂。
        if (!String(err?.message ?? err).includes('duplicate exact route')) {
          hookLog(err, `route failed: ${p}`);
        }
      }
    };
    // 设置写入：面板表单 -> 宿主 configEditor 持久化
    safeRegister({
      kind: 'exact',
      path: '/loom/config',
      handler: async (req, res) => {
        const cors = CORS_JSON;
        if (req?.method === 'OPTIONS') {
          res.writeHead(204, CORS_PREFLIGHT);
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
          // 白名单以 SETTING_SPECS 为唯一来源：加一个设置项只改那张表
          if (!SETTING_SPECS[key]) return reply(400, { ok: false, error: '不可设置的键：' + key });

          const editor = typeof ctx.get === 'function' ? ctx.get('configEditor') : undefined;
          if (!editor?.edit || !editor?.entries)
            return reply(503, { ok: false, error: '本宿主没有 configEditor' });

          const list = editor.entries();
          const entry =
            list.find((e) => e?.options?.id === 'loom-memory') ??
            list.find((e) => e?.id === 'loom-memory') ??
            list.find((e) => e?.name === 'loom-memory');
          if (!entry) return reply(404, { ok: false, error: '找不到 loom-memory 这一行配置' });

          const value = body.value;
          // 校验放在写之前，并且校验的是「当前配置 + 本次改动」后的整份配置：
          // 一项不合规就整次拒绝，磁盘上那份能用的配置原样保留。
          const pre = normalizeSetting(key, value);
          if (!pre.ok) return reply(400, { ok: false, error: pre.error });

          let applied = null;
          try {
            await editor.edit(entry, (current) => {
              const check = validateChange(current, key, pre.value);
              // 在 updater 里抛，等于「还没落盘就中止」——不会写出半份配置
              if (!check.ok) throw Object.assign(new Error(check.error), { invalidSetting: true });
              applied = check;
              // 整份写回：顺手把配置里历史遗留的坏值剔掉，回退到默认
              return check.merged;
            });
          } catch (e) {
            if (e?.invalidSetting) return reply(400, { ok: false, error: String(e.message) });
            throw e;
          }

          const dropped = applied?.dropped ?? [];
          if (dropped.length) {
            hookLog(
              new Error(
                `config 里这些键不合规，已回退默认：${dropped.map((d) => d.key).join(', ')}`
              ),
              'config pruned'
            );
          }
          return reply(200, {
            ok: true,
            key,
            value: applied?.value ?? pre.value,
            note: dropped.length
              ? `已保存；顺手修正了 ${dropped.length} 个不合规的旧值（${dropped.map((d) => d.key).join(', ')}）`
              : '已保存；部分设置需要重启或刷新页面生效',
          });
        } catch (e) {
          return reply(500, { ok: false, error: String(e?.message ?? e) });
        }
      },
    });

    // 写操作统一入口：/loom/forget、/loom/doc-save、/loom/import
    const readBody = async (req) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      return Buffer.concat(chunks);
    };

    safeRegister({
      kind: 'exact',
      path: '/loom/forget',
      handler: async (req, res) => {
        const cors = CORS_JSON;
        if (req?.method === 'OPTIONS') {
          res.writeHead(204, CORS_PREFLIGHT);
          res.end();
          return;
        }
        const reply = (code, obj) => {
          res.writeHead(code, cors);
          res.end(JSON.stringify(obj));
        };
        try {
          const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
          const key = String(body.id ?? '').trim();
          const claim = ledger.get(key) ?? ledger.active().find((c) => c.id.startsWith(key));
          if (!claim) return reply(404, { ok: false, error: '找不到这条记忆' });
          ledger.supersede(claim.id, null, body.reason ?? '面板删除');
          for (const d of ledger.docsByBody(claim.body)) ledger.setDocCold(d.id, true);
          chronicle.append(epoch, {
            forget: claim.id,
            reason: body.reason ?? '面板删除',
            at: Date.now(),
          });
          return reply(200, { ok: true, id: claim.id.slice(0, 8) });
        } catch (e) {
          return reply(500, { ok: false, error: String(e?.message ?? e) });
        }
      },
    });

    safeRegister({
      kind: 'exact',
      path: '/loom/doc-save',
      handler: async (req, res) => {
        const cors = CORS_JSON;
        if (req?.method === 'OPTIONS') {
          res.writeHead(204, CORS_PREFLIGHT);
          res.end();
          return;
        }
        const reply = (code, obj) => {
          res.writeHead(code, cors);
          res.end(JSON.stringify(obj));
        };
        try {
          const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
          const title = String(body.title ?? '').trim();
          const docText = String(body.body ?? '');
          if (!title) return reply(400, { ok: false, error: '标题不能为空' });
          if (!docText.trim()) return reply(400, { ok: false, error: '正文不能为空' });
          const doc = ledger.putDoc({
            id: body.id || undefined,
            title,
            body: docText,
            tags: body.tags ?? '',
          });
          chronicle.append(epoch, { doc: doc.id, title: doc.title, at: Date.now() });
          return reply(200, { ok: true, id: doc.id, title: doc.title, chars: doc.body.length });
        } catch (e) {
          return reply(500, { ok: false, error: String(e?.message ?? e) });
        }
      },
    });

    safeRegister({
      kind: 'exact',
      path: '/loom/import',
      handler: async (req, res) => {
        const cors = CORS_JSON;
        if (req?.method === 'OPTIONS') {
          res.writeHead(204, CORS_PREFLIGHT);
          res.end();
          return;
        }
        const reply = (code, obj) => {
          res.writeHead(code, cors);
          res.end(JSON.stringify(obj));
        };
        try {
          const buf = await readBody(req);
          if (!buf.length) return reply(400, { ok: false, error: '空文件' });
          const counts = importBundle(ledger, zipToBundle(buf));
          return reply(200, { ok: true, counts });
        } catch (e) {
          return reply(400, { ok: false, error: String(e?.message ?? e) });
        }
      },
    });

    // 文档详情：/loom/doc?id=xxx（含历史版本）
    safeRegister({
      kind: 'exact',
      path: '/loom/doc',
      handler: async (req, res) => {
        const cors = CORS_JSON;
        try {
          const url = new URL(req?.url ?? '/', 'http://localhost');
          const id = String(url.searchParams.get('id') ?? '').trim();
          if (!id) {
            res.writeHead(400, cors);
            res.end(JSON.stringify({ ok: false, error: '缺少 id' }));
            return;
          }
          const doc = ledger.getDoc(id);
          if (!doc) {
            res.writeHead(404, cors);
            res.end(JSON.stringify({ ok: false, error: '找不到这篇文档' }));
            return;
          }
          const revs = (ledger.docRevisions?.(id) ?? []).map((r) => ({
            rev: r.rev,
            at: r.at,
            title: r.title,
            body: String(r.body ?? '').slice(0, 4000),
          }));
          res.writeHead(200, cors);
          res.end(
            JSON.stringify({
              ok: true,
              doc: {
                id: doc.id,
                title: doc.title,
                body: doc.body,
                tags: doc.tags,
                updatedAt: doc.updated_at,
              },
              revs,
            })
          );
        } catch (e) {
          res.writeHead(500, cors);
          res.end(JSON.stringify({ ok: false, error: String(e?.message ?? e) }));
        }
      },
    });

    // 打包下载：/loom/export.zip
    safeRegister({
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
          res.writeHead(500, {
            'content-type': 'application/json',
            'access-control-allow-origin': '*',
          });
          res.end(JSON.stringify({ ok: false, error: String(e?.message ?? e) }));
        }
      },
    });

    // 原文检索：/loom/archive?q=关键词
    safeRegister({
      kind: 'exact',
      path: '/loom/archive',
      handler: async (req, res) => {
        const cors = CORS_JSON;
        try {
          const url = new URL(req?.url ?? '/', 'http://localhost');
          const q = String(url.searchParams.get('q') ?? '').trim();
          const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 200);
          // 默认只看对话（user/assistant）；要工具输出显式传 roles=user,assistant,tool
          const rolesParam = String(url.searchParams.get('roles') ?? 'user,assistant');
          const sessionFilter = String(url.searchParams.get('session') ?? '').trim() || null;
          const roles = new Set(
            rolesParam
              .split(',')
              .map((r) => r.trim())
              .filter(Boolean)
          );
          const hits = [];
          for (const e of chronicle.epochs()) {
            if (e.destroyed) continue;
            let events = [];
            try {
              events = chronicle.read(e.id);
            } catch {
              continue;
            }
            for (const ev of events) {
              const m = ev?.event;
              if (m?.kind !== 'msg') continue;
              if (sessionFilter && m.session && m.session !== sessionFilter) continue;
              if (roles.size && !roles.has(m.role)) continue;
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

    // ---- 对话列表：给「把某个对话设成独立记忆」那个下拉框用 ----
    // 优先问宿主的 sessionQuery（有真标题），拿不到就退回归档里见过的会话 id。
    // 退路很重要：精简组合里没有 sessionQuery，面板不该因此打不开。
    const listConversations = async () => {
      const counts = new Map();
      const firstText = new Map();
      try {
        for (const e of chronicle.epochs()) {
          if (e.destroyed) continue;
          let events = [];
          try {
            events = chronicle.read(e.id);
          } catch {
            continue;
          }
          for (const ev of events) {
            const m = ev?.event;
            if (m?.kind !== 'msg' || !m.session) continue;
            const k = String(m.session);
            counts.set(k, (counts.get(k) || 0) + 1);
            if (m.role === 'user' && !firstText.has(k)) firstText.set(k, String(m.text ?? ''));
          }
        }
      } catch (err) {
        hookLog(err, 'archive scan failed');
      }

      let rows = [];
      let source = 'archive';
      try {
        const sq = typeof ctx.get === 'function' ? ctx.get('sessionQuery') : undefined;
        if (sq?.listSessions) {
          const records = (await sq.listSessions()) || [];
          source = 'sessionQuery';
          // 子代理会话是实现细节，不进给人选的列表
          const roots = records.filter(
            (r) => r?.header?.id && !r.header.parentSession && r.header.origin !== 'subagent'
          );
          const titles = new Map();
          try {
            if (sq.readTitleSnapshots && roots.length) {
              const got = await sq.readTitleSnapshots(roots.map((r) => r.header.id));
              for (const one of got || []) {
                const t = one?.status === 'fulfilled' ? one.value?.title?.title : '';
                if (t) titles.set(String(one.sessionId), String(t));
              }
            }
          } catch (err) {
            hookLog(err, 'readTitleSnapshots failed');
          }
          rows = roots.map((r) => {
            const id = String(r.header.id);
            return {
              id,
              title: titles.get(id) || '',
              createdAt: Number(r.header.createdAt ?? 0),
              cwd: r.header.cwd ?? '',
              live: !!r.live,
              messages: counts.get(id) || 0,
            };
          });
        }
      } catch (err) {
        hookLog(err, 'sessionQuery unavailable, falling back to archive');
      }

      if (!rows.length) {
        rows = [...counts.keys()].map((id) => ({
          id,
          title: '',
          createdAt: 0,
          cwd: '',
          live: false,
          messages: counts.get(id) || 0,
        }));
      }

      for (const r of rows) {
        if (!r.title) {
          const t = String(firstText.get(r.id) ?? '')
            .replace(/\s+/g, ' ')
            .trim();
          r.title = t ? (t.length > 20 ? t.slice(0, 20) + '…' : t) : '未命名对话';
        }
        r.isolated = isIsolated(r.id);
        r.short = r.id.slice(0, 8);
      }
      return {
        source,
        sessions: rows
          // 保留：在线会话、归档里有消息的会话、以及被划成「独立记忆」的会话。
          // 第三条是为了让人能把它从名单里取出来——离线且没归档过消息的独立会话，
          // 一旦被这里的 liveness 过滤掉，面板上就再也选不到它，等于单向门。
          .filter((r) => r.isolated || r.live || r.messages > 0)
          .sort(
            (a, b) =>
              (b.live ? 1 : 0) - (a.live ? 1 : 0) ||
              b.createdAt - a.createdAt ||
              b.messages - a.messages
          )
          .slice(0, 80),
      };
    };

    const CONFIG_ENTRY = (editor) => {
      const list = editor.entries();
      return (
        list.find((e) => e?.options?.id === 'loom-memory') ??
        list.find((e) => e?.id === 'loom-memory') ??
        list.find((e) => e?.name === 'loom-memory')
      );
    };

    safeRegister({
      kind: 'exact',
      path: '/loom/sessions',
      handler: async (req, res) => {
        const cors = CORS_JSON;
        if (req?.method === 'OPTIONS') {
          res.writeHead(204, CORS_PREFLIGHT);
          res.end();
          return;
        }
        try {
          const data = await listConversations();
          res.writeHead(200, cors);
          res.end(JSON.stringify({ ok: true, ...data }));
        } catch (e) {
          res.writeHead(500, cors);
          res.end(JSON.stringify({ ok: false, error: String(e?.message ?? e) }));
        }
      },
    });

    // 把一个会话加进/移出「独立记忆」名单。
    // 走 configEditor 的 read-modify-write，不做前端算全量数组再覆盖——那是竞态。
    safeRegister({
      kind: 'exact',
      path: '/loom/isolate',
      handler: async (req, res) => {
        const cors = CORS_JSON;
        if (req?.method === 'OPTIONS') {
          res.writeHead(204, CORS_PREFLIGHT);
          res.end();
          return;
        }
        const reply = (code, obj) => {
          res.writeHead(code, cors);
          res.end(JSON.stringify(obj));
        };
        try {
          const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
          const id = String(body.id ?? '').trim();
          const on = body.isolated !== false;
          if (!id) return reply(400, { ok: false, error: '缺少会话 id' });

          const editor = typeof ctx.get === 'function' ? ctx.get('configEditor') : undefined;
          if (!editor?.edit || !editor?.entries)
            return reply(503, { ok: false, error: '本宿主没有 configEditor' });
          const entry = CONFIG_ENTRY(editor);
          if (!entry) return reply(404, { ok: false, error: '找不到 loom-memory 这一行配置' });

          let next = [];
          await editor.edit(entry, (current) => {
            const set = new Set(
              (Array.isArray(current.isolatedSessions) ? current.isolatedSessions : [])
                .map(String)
                .filter(Boolean)
            );
            if (on) set.add(id);
            else set.delete(id);
            next = [...set];
            return { ...current, isolatedSessions: next };
          });
          // 本次 apply 内部的缓存也要立刻跟着变，否则要等重启才生效
          if (on) isolatedSet.add(id);
          else isolatedSet.delete(id);
          return reply(200, {
            ok: true,
            id,
            isolated: on,
            isolatedSessions: next,
            note: '已保存；新的召回与注入立即按新范围走',
          });
        } catch (e) {
          return reply(500, { ok: false, error: String(e?.message ?? e) });
        }
      },
    });

    safeRegister({
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
    // 同一个理由：只装一次，取当前实例的快照（否则每次重载都往 </head> 里多插一段）
    if (typeof web.tapIndex === 'function' && !SHARED.seedInstalled) {
      SHARED.seedInstalled = true;
      web.tapIndex((html) => {
        let json = '{}';
        try {
          const snap = SHARED.live?.snapshot?.();
          if (snap) json = JSON.stringify(snap).replace(/</g, '\\u003c');
        } catch {}
        const tag = `<script>window.__LOOM_SEED__=${json};window.__LOOM_TOKEN__=${JSON.stringify(SHARED.token)};</script></head>`;
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
                  try {
                    n = chronicle.read(e.id).length;
                  } catch {
                    n = 0;
                  }
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
    async execute(args, _exec = {}) {
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
    async execute(args, _exec = {}) {
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
    async execute(args, _exec = {}) {
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

      return {
        ok: true,
        docId: doc.id,
        claimId: claimId ? claimId.slice(0, 8) : null,
        kind,
        due: intent.due,
        rejected,
      };
    },
  });

  // ---- 项目文档 ----
  ctx.tools.register({
    name: 'memory_doc_write',
    description:
      '写一篇项目文档（长文，不受 AI文 短断言限制）。同标题视为同一篇，会更新而不是堆叠。',
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
    async execute(args, _exec = {}) {
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
    async execute(args, _exec = {}) {
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
    description:
      '看这一轮被自动注入了什么（热记忆原文 + 统计），用来调 hotBytes 或验证注入是否生效。',
    parameters: { type: 'object', properties: {} },
    output: OUT,
    async execute(args, _exec = {}) {
      const hot = hotNow();
      return {
        injected: config.hot !== false,
        budgetBytes: hotBytes,
        // 这两个字段兼作「补丁是否已加载」的探针：老模块不返回它们
        appendOnly: hotAppendOnly,
        sectionOrder: hotOrder,
        bytes: hot.bytes,
        counts: hot.counts,
        omitted: hot.omitted,
        text: hot.text,
      };
    },
  });

  // ---- 原文检索：从归档里把上下文捞回来 ----
  ctx.tools.register({
    name: 'memory_archive_search',
    description: '在原文归档里检索（逐字，不过滤寒暄与粘贴）。返回命中的对话片段，用于还原上下文。',
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
    async execute(args, exec = {}) {
      const q = String(args.query ?? '').trim();
      const sid = exec?.agent?.id ?? null;
      const onlySession = isIsolated(sid) ? sid : null;
      const limit = Number(args.limit ?? 10);
      if (!q) return { ok: false, reason: '给个关键词' };
      const hits = [];
      for (const e of chronicle.epochs()) {
        if (e.destroyed) continue;
        let events = [];
        try {
          events = chronicle.read(e.id);
        } catch {
          continue;
        }
        for (const ev of events) {
          const m = ev.event;
          if (m?.kind !== 'msg') continue;
          if (onlySession && m.session && m.session !== onlySession) continue;
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
    description:
      '插件自检：本宿主里 systemPrompt / webServer / commands 是否可用，以及注入与面板的挂载状态。',
    parameters: { type: 'object', properties: {} },
    output: OUT,
    async execute(args, _exec = {}) {
      const has = (name) => {
        try {
          const v = typeof ctx.get === 'function' ? ctx.get(name) : undefined;
          return !!v;
        } catch {
          return false;
        }
      };
      const hot = hotNow();
      let origin = null;
      try {
        const web = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined;
        if (web?.getOrigin) origin = web.getOrigin();
      } catch {}
      return {
        origin,
        routes: mountedRoutes,
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
    async execute(args = {}, exec = {}) {
      const limit = Number(args.limit ?? 5);
      const active = ledger.active(args.kind, scopeFilter(exec?.agent?.id));
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
    async execute(args, exec = {}) {
      const active = ledger.active(undefined, scopeFilter(exec?.agent?.id));
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
    async execute(args, _exec = {}) {
      const epochs = chronicle.epochs();
      const rows = epochs.map((e) => {
        if (e.destroyed) return { id: e.id, destroyed: true, events: 0, ok: true };
        const v = chronicle.verify(e.id);
        let events = 0;
        try {
          events = chronicle.read(e.id).length;
        } catch {
          events = -1;
        }
        return { id: e.id, destroyed: false, events, ok: v.ok };
      });
      const events = rows.reduce((n, r) => n + Math.max(0, r.events), 0);
      return {
        ok: rows.every((r) => r.ok),
        events,
        epochs: rows.length,
        current: epoch,
        detail: rows,
      };
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
    async execute(args, _exec = {}) {
      const id = String(args.id ?? '').trim();
      const claim = ledger.get(id) ?? ledger.active().find((c) => c.id.startsWith(id));
      if (!claim) return { ok: false, reason: '找不到这条记忆' };

      // 不要造墓碑条目：墓碑一旦入库就成了"正常记忆"，会出现在列表和计数里。
      // 失效信息已经由 valid_to + supersede_log + L0 事件三处记录，足够回查。
      ledger.supersede(claim.id, null, args.reason ?? '用户要求');
      // 一起写下的文档也要失活，否则记忆能靠文档检索"复活"
      const docs = ledger.docsByBody(claim.body);
      for (const d of docs) ledger.setDocCold(d.id, true);
      chronicle.append(epoch, {
        forget: claim.id,
        reason: args.reason ?? '用户要求',
        at: Date.now(),
      });

      return { ok: true, id: claim.id.slice(0, 8), supersededBy: null };
    },
  });
}
