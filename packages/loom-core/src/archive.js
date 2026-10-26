/**
 * 原文归档：一条都不丢。
 *
 * 之前的设计是"判定值不值得记"，那是错的——判定本身就是信息丢失。
 * 寒暄、口癖、粘贴的报错原文，在工程场景像噪声，在陪伴场景就是全部。
 *
 * 所以分两层：
 *   L0 原文   每一条消息原样进编年层（哈希链、可加密、可销毁）
 *   L1 视图   AI文 / claim / 文档 —— 压缩、可检索，是"读法"不是"存法"
 *
 * 压缩只影响读，不影响存。
 */

import { createHash } from 'node:crypto';

/** 把一条消息压成可入库的纯文本（保留结构，不丢内容） */
export function messageText(message) {
  const c = message?.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  const parts = [];
  for (const block of c) {
    if (!block || typeof block !== 'object') continue;
    if (typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'image') parts.push('[图片]');
    else if (block.type === 'file') parts.push(`[文件 ${block.attachment?.name ?? ''}]`);
    else if (block.type === 'tool_use') parts.push(`[调用 ${block.name ?? ''} ${JSON.stringify(block.input ?? {}).slice(0, 200)}]`);
    else if (block.type === 'tool_result') parts.push(`[结果 ${String(block.content ?? '').slice(0, 200)}]`);
    else parts.push(`[${block.type ?? '未知块'}]`);
  }
  return parts.join('\n');
}

/** 内容指纹：同一句话不会因为重复出现被记两遍 */
export function messageKey(message) {
  const text = messageText(message);
  return createHash('sha256').update(`${message?.role ?? ''}|${text}`).digest('hex').slice(0, 16);
}

/**
 * 把还没归档过的消息追加到编年层。
 * @param {{append:Function}} chronicle
 * @param {string} epochId
 * @param {any[]} messages
 * @param {Set<string>} seen 已归档指纹集合（调用方持有，跨轮复用）
 * @param {{now?:number}} [opts]
 * @returns {{archived:number, skipped:number}}
 */
export function archiveMessages(chronicle, epochId, messages, seen, opts = {}) {
  const now = opts.now ?? Date.now();
  let archived = 0;
  let skipped = 0;

  for (const m of messages ?? []) {
    const role = m?.role;
    if (role !== 'user' && role !== 'assistant' && role !== 'system') continue;
    const text = messageText(m);
    if (!text) continue;

    const key = messageKey(m);
    if (seen.has(key)) {
      skipped++;
      continue;
    }
    seen.add(key);

    chronicle.append(epochId, {
      kind: 'msg',
      role,
      text,
      len: text.length,
      at: now,
      key,
    });
    archived++;
  }

  return { archived, skipped };
}
