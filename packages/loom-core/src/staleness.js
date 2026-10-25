/**
 * 外部引用的时效性：记忆不只彼此相连，还要指向世界。
 *
 * 没有它，记忆只能自说自话；有了它，才能发现"这条已经过时了"。
 * 检查器只做事实核对（hash / ETag / sha），不做重新抽取——
 * 重新抽取是拿假设验证假设。
 */

import fs from 'node:fs';
import crypto from 'node:crypto';

/** @typedef {{kind:'file'|'url'|'repo'|'session', target:string, digest?:string, checkedAt?:number, status?:'fresh'|'stale'|'unknown'}} Ref */

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** 给文件建一个可核对的引用 */
export function fileRef(target, digest) {
  const d = digest ?? (fs.existsSync(target) ? sha256(fs.readFileSync(target)) : undefined);
  return { kind: 'file', target, digest: d, status: d ? 'fresh' : 'unknown' };
}

/**
 * 批量核对。任何一项读不到 → unknown（不是 stale：读不到不等于变了）。
 * @param {Ref[]} refs
 * @param {{readFile?: (p:string)=>Buffer, fetchEtag?: (u:string)=>Promise<string|null>, now?: ()=>number}} [io]
 * @returns {Promise<Ref[]>}
 */
export async function checkRefs(refs, io = {}) {
  const readFile = io.readFile ?? ((p) => fs.readFileSync(p));
  const now = io.now ?? (() => Date.now());
  const out = [];

  for (const ref of refs) {
    const base = { ...ref, checkedAt: now() };
    if (ref.kind === 'file') {
      try {
        const actual = sha256(readFile(ref.target));
        out.push({ ...base, status: !ref.digest ? 'unknown' : actual === ref.digest ? 'fresh' : 'stale', digest: ref.digest ?? actual });
      } catch {
        out.push({ ...base, status: 'unknown' });
      }
      continue;
    }
    if (ref.kind === 'url') {
      if (!io.fetchEtag) {
        out.push({ ...base, status: 'unknown' });
        continue;
      }
      try {
        const etag = await io.fetchEtag(ref.target);
        out.push({ ...base, status: !ref.digest || !etag ? 'unknown' : etag === ref.digest ? 'fresh' : 'stale' });
      } catch {
        out.push({ ...base, status: 'unknown' });
      }
      continue;
    }
    // repo / session 需要外部工具，W3 先返回 unknown，不假装知道
    out.push({ ...base, status: 'unknown' });
  }

  return out;
}

/** 过时的记忆在注入时降权，并打上标记 */
export function applyStaleness(score, status) {
  if (status === 'stale') return { score: score * 0.5, flag: '可能过时' };
  if (status === 'unknown') return { score: score * 0.9, flag: null };
  return { score, flag: null };
}
