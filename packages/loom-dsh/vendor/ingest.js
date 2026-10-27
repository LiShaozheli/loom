/**
 * 写入路径的唯一入口。
 *
 * 存在的理由：stripTail 必须在**一个**地方发生，否则迟早有人绕过它，
 * 于是尾部又回到正文里、token 又涨回去。所以 ingest() 是收口点：
 *
 *   作者格式（带尾） → ingest → 剥尾 + 拆字段 → 闸门 → 入库
 *
 * 任何想写入 claim 的代码都必须经过这里；直接调 ledger.put 的地方只有测试。
 */

import crypto from 'node:crypto';
import { stripTail, parseTail, contentKey } from './aiw.js';
import { gate } from './gate.js';

/** 内容哈希：天然幂等，同一条记忆重复写入不会产生两条 */
export function claimId(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

/**
 * @param {{
 *   line?: string,            // 作者格式：正文 + @时间 #来源 置信
 *   body: string,             // 白话正文（审计用）
 *   kind?: string,
 *   title?: string,
 *   epochId: string,
 *   ledger: { put(c:any):any },
 *   original?: string,        // 原文，用于保真校验
 *   mustKeep?: string[],
 *   minRecall?: number,
 *   confidence?: 'high'|'medium'|'low',
 *   source?: { eventId?: string },
 *   sessionId?: string|null,
 *   tier?: string,
 *   taint?: string|null,
 *   validFrom?: number,
 *   validUntil?: number|null,
 * }} input
 * @returns {{ ok: boolean, claim?: any, gate: import('./contracts.js').GateResult, stripped: string }}
 */
export function ingest(input) {
  const {
    line,
    body,
    kind = 'fact',
    epochId,
    ledger,
    original,
    mustKeep,
    minRecall,
    title,
  } = input;

  // 1) 剥尾 —— 整个系统里唯一一次
  const aiw = stripTail(line ?? body ?? '');
  const tail = line ? parseTail(line) : null;

  // 2) 尾部变成字段
  const draft = {
    aiw,
    confidence: input.confidence ?? tail?.confidence ?? 'medium',
    source: { eventId: input.source?.eventId ?? tail?.source ?? null },
    tier: input.tier ?? 'full',
  };

  // 3) 闸门（格式 + 元数据 + 保真 + 编造）
  const result = gate(draft, { original, mustKeep, minRecall });

  if (result.verdict === 'REJECT') {
    return { ok: false, gate: result, stripped: aiw };
  }

  // 4) 入库
  const claim = {
    // 内容指纹决定身份：标点、kind 的差异都不该产生第二条记忆
    id: claimId(contentKey(aiw)),
    kind,
    body: body ?? aiw,
    aiw,
    title: title ?? aiw.slice(0, 12),
    confidence: draft.confidence,
    source: draft.source,
    epochId,
    taint: input.taint ?? 'none',
    validFrom: input.validFrom ?? Date.now(),
    salience: 1,
    useCount: 0,
    cold: false,
    sessionId: input.sessionId ?? null,
  };
  ledger.put(claim);

  return { ok: true, claim, gate: result, stripped: aiw };
}
