/**
 * L0 编年层：append-only + 哈希链 + epoch 加密（crypto-shredding）。
 *
 * 两件事同时成立：
 *   1. 记忆没被改写 —— 每条记录带前一条的 hash，链断裂可验
 *   2. 记忆能被删除 —— 每段时间一个随机密钥，删密钥即删内容，墓碑留在链上
 *
 * 密钥用主密钥包裹后落盘；销毁 epoch = 删掉被包裹的那把钥匙。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ALGO = 'aes-256-gcm';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function seal(key, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}

function open(key, payload) {
  const buf = Buffer.from(payload, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

const wrap = (master, key) => seal(master, key.toString('base64'));
const unwrap = (master, payload) => Buffer.from(open(master, payload), 'base64');

export class Chronicle {
  /** @param {string} dir @param {{masterKey?: Buffer}} [opts] */
  constructor(dir, opts = {}) {
    this.dir = dir;
    fs.mkdirSync(path.join(dir, 'epochs'), { recursive: true });
    this.master = opts.masterKey ?? this.#loadMaster();
    this.metaPath = path.join(dir, 'meta.json');
    this.meta = fs.existsSync(this.metaPath)
      ? JSON.parse(fs.readFileSync(this.metaPath, 'utf8'))
      : { epochs: {}, tombstones: [] };
  }

  #loadMaster() {
    const p = path.join(this.dir, 'master.key');
    if (fs.existsSync(p)) return Buffer.from(fs.readFileSync(p, 'utf8'), 'base64');
    const key = crypto.randomBytes(32);
    fs.writeFileSync(p, key.toString('base64'), { mode: 0o600 });
    return key;
  }

  #save() {
    fs.writeFileSync(this.metaPath, JSON.stringify(this.meta, null, 2), 'utf8');
  }

  /** 开一个新的时间片；返回 epochId */
  createEpoch(id = `ep-${Date.now()}`) {
    const key = crypto.randomBytes(32);
    this.meta.epochs[id] = { wrapped: wrap(this.master, key), createdAt: Date.now() };
    fs.writeFileSync(this.#logPath(id), '', 'utf8');
    this.#save();
    return id;
  }

  #logPath(epochId) {
    return path.join(this.dir, 'epochs', `${epochId}.jsonl`);
  }

  #keyOf(epochId) {
    const rec = this.meta.epochs[epochId];
    if (!rec) throw new Error(`epoch ${epochId} 不存在或已销毁`);
    return unwrap(this.master, rec.wrapped);
  }

  /** 追加一条事件；返回 {hash, prevHash, seq} */
  append(epochId, event) {
    const key = this.#keyOf(epochId);
    const logPath = this.#logPath(epochId);
    const lines = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean) : [];
    const prevHash = lines.length ? JSON.parse(lines.at(-1)).hash : 'GENESIS';
    const seq = lines.length;
    const record = {
      seq,
      at: Date.now(),
      payload: seal(key, JSON.stringify(event)),
      prevHash,
    };
    record.hash = sha256(JSON.stringify(record));
    fs.appendFileSync(logPath, JSON.stringify(record) + '\n');
    return { hash: record.hash, prevHash, seq };
  }

  /** 读回并解密；已销毁的 epoch 直接抛错 */
  read(epochId) {
    const key = this.#keyOf(epochId); // 已销毁会在这里抛
    const logPath = this.#logPath(epochId);
    if (!fs.existsSync(logPath)) return [];
    return fs
      .readFileSync(logPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const rec = JSON.parse(line);
        return { seq: rec.seq, at: rec.at, event: JSON.parse(open(key, rec.payload)) };
      });
  }

  /** 验链：逐条重算 hash，并确认 prevHash 指向前一条 */
  verify(epochId) {
    const logPath = this.#logPath(epochId);
    if (!fs.existsSync(logPath)) return { ok: true, count: 0 };
    const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
    let prev = 'GENESIS';
    for (const [i, line] of lines.entries()) {
      const rec = JSON.parse(line);
      const { hash, ...rest } = rec;
      if (sha256(JSON.stringify(rest)) !== hash) return { ok: false, at: i, reason: 'hash mismatch' };
      if (rec.prevHash !== prev) return { ok: false, at: i, reason: 'chain broken' };
      prev = hash;
    }
    return { ok: true, count: lines.length };
  }

  /** 销毁一个 epoch：删密钥 + 留墓碑；之后 read 会抛错，但链仍可验 */
  destroyEpoch(epochId, reason) {
    const rec = this.meta.epochs[epochId];
    if (!rec) throw new Error(`epoch ${epochId} 不存在`);
    delete this.meta.epochs[epochId];
    this.meta.tombstones.push({ epochId, reason, at: Date.now() });
    this.#save();
    return { destroyed: true, epochId };
  }

  /** 该 epoch 是否已被销毁 */
  isDestroyed(epochId) {
    return this.meta.tombstones.some((t) => t.epochId === epochId);
  }
}
