/**
 * L0 编年层：append-only + 哈希链 + epoch 加密（crypto-shredding）。
 *
 * 两件事同时成立：
 *   1. 记忆没被改写 —— 每条记录带前一条的 hash，链断裂可验
 *   2. 记忆能被删除 —— 每段时间一个随机密钥，删密钥即删内容，墓碑留在链上
 *
 * 密钥用主密钥包裹后落盘；销毁 epoch = 删掉被包裹的那把钥匙。
 *
 * ── 工程约束（都是踩过的坑，改之前先读）──────────────────────────
 * · **追加是 O(1)**：不读整个日志，只在内存里记 {size, seq, headHash}；
 *   换个进程/被外部改过时用「读文件尾部一个 chunk」自愈，绝不整文件 scan。
 *   旧实现每条都 readFileSync 整个 jsonl，6.4MB 的档案写一条付 6.4ms。
 * · **meta.json 原子写**：tmp + rename。它装的是所有 epoch 的包裹密钥，
 *   写到一半崩 = 整个档案永久不可读，这个不能省。
 * · **写锁**：<id>.lock，跨进程互斥。CLI 和插件会同时开同一个目录，
 *   没有锁就会出现两条 seq 相同的记录，链直接分叉。
 * · **销毁不可复活**：#save 是「读磁盘 → 合并 → 写」，墓碑取并集。
 *   拿内存里的旧副本整份覆盖，会把已销毁 epoch 的密钥写回去 —— 删了等于没删。
 * · **截断可检测**：每条记录追加后把 head 锚进 meta；verify 发现文件比锚点短就报错。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ALGO = 'aes-256-gcm';
const META_VERSION = 2;
const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 3_000;
const TAIL_CHUNK = 64 * 1024;

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

/** 同步小睡：锁等待用，不能 await（这层全是同步 API） */
const sleepSync = (ms) => {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* 主线程不支持就忙等 */
  }
};

/** 两个 head 取「更靠后」的那个：seq 大的赢，持平取磁盘那份 */
const pickHead = (diskHead, memHead) => {
  if (!diskHead) return memHead ?? null;
  if (!memHead) return diskHead;
  return (memHead.seq ?? -1) > (diskHead.seq ?? -1) ? memHead : diskHead;
};

export class Chronicle {
  /**
   * @param {string} dir
   * @param {{masterKey?: Buffer, durable?: boolean, lockTimeoutMs?: number}} [opts]
   *   durable=false 时不做 fsync（只给测试用；生产必须为 true）
   */
  constructor(dir, opts = {}) {
    this.dir = dir;
    fs.mkdirSync(path.join(dir, 'epochs'), { recursive: true });
    this.master = opts.masterKey ?? this.#loadMaster();
    this.metaPath = path.join(dir, 'meta.json');
    this.durable = opts.durable !== false;
    this.lockTimeoutMs = opts.lockTimeoutMs ?? LOCK_TIMEOUT_MS;
    /** @type {Map<string, {size:number, seq:number, hash:string}>} 进程内 head 缓存 */
    this.heads = new Map();
    this.meta = this.#readMeta();
    this.metaStat = this.#statMeta();
    this.#migrate();
  }

  #statMeta() {
    try {
      const st = fs.statSync(this.metaPath);
      return { mtimeMs: st.mtimeMs, size: st.size };
    } catch {
      return null;
    }
  }

  #readMeta() {
    if (!fs.existsSync(this.metaPath)) return { version: META_VERSION, epochs: {}, tombstones: [] };
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.metaPath, 'utf8'));
    } catch (e) {
      // 不静默兜底：meta 里是全部 epoch 的密钥，读不出来就得让人知道
      throw new Error(`meta.json 损坏（${path.join(this.dir, 'meta.json')}）：${e.message}`);
    }
    raw.epochs ??= {};
    raw.tombstones ??= [];
    raw.version ??= 1;
    return raw;
  }

  /** 别的进程改过 meta（新建/销毁 epoch）就重新加载；同时刷新 head 锚点 */
  #refreshMeta() {
    const st = this.#statMeta();
    if (!st) return false;
    if (this.metaStat && st.mtimeMs === this.metaStat.mtimeMs && st.size === this.metaStat.size)
      return false;
    this.meta = this.#readMeta();
    this.metaStat = st;
    return true;
  }

  /**
   * 原子写 meta：同目录 tmp + rename。
   * anchorOnly=true 时不 fsync —— 给「每条追加都锚一次 head」用，
   * 锚点落后一两条不影响截断检测（截断掉的量远大于滞后量）。
   */
  #writeMeta(meta, { anchorOnly = false } = {}) {
    const tmp = `${this.metaPath}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, JSON.stringify(meta, null, 2), 'utf8');
      if (this.durable && !anchorOnly) fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.metaPath);
    this.metaStat = this.#statMeta();
    this.meta = meta;
  }

  /**
   * 读磁盘 → 合并 → 写回。
   *
   * 关键在「合并」而不是覆盖：内存副本可能是陈旧的（另一个进程刚销毁了 epoch），
   * 整份写回去会让包裹密钥复活，被销毁的数据重新可读。
   *
   * anchorOnly=true 是「每条追加都锚一次 head」用的：不 fsync。
   * 锚点允许落后一两条 —— 它防的是断链式删除（删掉末尾一大段），
   * 落后几个字节不影响判定，但每条都 fsync 会让追加从 1.7ms 涨到 3.8ms。
   */
  #save({ anchorOnly = false } = {}) {
    let disk;
    try {
      disk = this.#readMeta();
    } catch {
      disk = { version: META_VERSION, epochs: {}, tombstones: [] };
    }
    const destroyed = new Set([
      ...disk.tombstones.map((t) => t.epochId),
      ...this.meta.tombstones.map((t) => t.epochId),
    ]);

    const epochs = {};
    for (const id of new Set([...Object.keys(disk.epochs), ...Object.keys(this.meta.epochs)])) {
      if (destroyed.has(id)) continue; // 已销毁：任何一方都别想写回来
      const a = disk.epochs[id];
      const b = this.meta.epochs[id];
      if (!a) {
        epochs[id] = b;
        continue;
      }
      if (!b) {
        epochs[id] = a;
        continue;
      }
      epochs[id] = {
        ...b,
        ...a,
        // 密钥以磁盘为准：日志里的记录就是用那把钥匙加的密
        wrapped: a.wrapped ?? b.wrapped,
        createdAt: a.createdAt ?? b.createdAt,
        head: pickHead(a.head, b.head),
      };
    }

    const tombstones = [...disk.tombstones];
    for (const t of this.meta.tombstones) {
      if (!tombstones.some((x) => x.epochId === t.epochId)) tombstones.push(t);
    }

    this.#writeMeta({ version: META_VERSION, epochs, tombstones }, { anchorOnly });
  }

  /** 把某个 epoch 的 head 锚进 meta（截断检测用）；失败不影响写入本身 */
  #anchorHead(epochId) {
    const head = this.heads.get(epochId);
    const rec = this.meta.epochs[epochId];
    if (!head || !rec) return;
    const anchor = { seq: head.seq, hash: head.hash, size: head.size };
    // 分类计数跟着锚点走：面板要显示「多少条原文」时不必解密整个档案
    if (head.kinds) anchor.kinds = head.kinds;
    rec.head = anchor;
    try {
      this.#save({ anchorOnly: true });
      // #save 之后 this.meta 是合并结果，重新取一次引用
      const again = this.meta.epochs[epochId];
      if (again) again.head = anchor;
    } catch {
      // 锚点写不进去不能挡住记忆落盘：链本身仍然有效，只是少了截断检测
    }
  }

  /** 老库升级：给没有 head 的 epoch 补一次锚点（只做一次） */
  #migrate() {
    if (this.meta.version >= META_VERSION) return;
    for (const [id, rec] of Object.entries(this.meta.epochs)) {
      try {
        const logPath = this.#logPath(id);
        const size = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
        if (size === 0) {
          rec.head = { seq: 0, hash: 'GENESIS', size: 0 };
          continue;
        }
        const last = this.#lastRecord(logPath, size);
        rec.head = { seq: (last.seq ?? 0) + 1, hash: last.hash, size };
      } catch {
        // 单个 epoch 补不上就先跳过，等下次 append 自然锚定
      }
    }
    this.meta.version = META_VERSION;
    try {
      this.#save();
    } catch {
      /* 迁移失败不阻塞启动 */
    }
  }

  #loadMaster() {
    const p = path.join(this.dir, 'master.key');
    if (fs.existsSync(p)) return Buffer.from(fs.readFileSync(p, 'utf8'), 'base64');
    const key = crypto.randomBytes(32);
    fs.writeFileSync(p, key.toString('base64'), { mode: 0o600 });
    return key;
  }

  /** 开一个新的时间片；返回 epochId */
  createEpoch(id = `ep-${Date.now()}`, { now = Date.now() } = {}) {
    this.#refreshMeta();
    // 已销毁的 id 不允许重建：否则「删了」可以被一次写操作撤销
    if (this.isDestroyed(id)) throw new Error(`epoch ${id} 已被销毁，不能重建`);
    // 幂等：另一个进程刚建了同一个 id，就沿用它那把钥匙，别覆盖
    if (this.meta.epochs[id]) return id;
    const key = crypto.randomBytes(32);
    this.meta.epochs[id] = {
      wrapped: wrap(this.master, key),
      createdAt: now,
      head: { seq: 0, hash: 'GENESIS', size: 0 },
    };
    const logPath = this.#logPath(id);
    if (!fs.existsSync(logPath)) fs.writeFileSync(logPath, '', 'utf8');
    this.heads.set(id, { size: 0, seq: 0, hash: 'GENESIS' });
    this.#save();
    return id;
  }

  /**
   * 当前该写进哪个时间片。
   *
   * 轮换的意义：删除权的最小单位是 epoch。所有写入都进同一个 epoch 时，
   * "删掉某一周"就变成了"删掉全部"。所以按周期切片，删一片不影响其余。
   */
  currentEpoch({ everyDays = 7, now = Date.now(), prefix = 'ep' } = {}) {
    this.#refreshMeta();
    const newest = Object.entries(this.meta.epochs).sort(
      (a, b) => b[1].createdAt - a[1].createdAt
    )[0];
    if (newest && now - newest[1].createdAt < everyDays * 86_400_000) return newest[0];

    const d = new Date(now);
    const stamp = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
    let id = `${prefix}-${stamp}`;
    let n = 1;
    while (this.meta.epochs[id] || this.isDestroyed(id)) id = `${prefix}-${stamp}-${++n}`;
    return this.createEpoch(id, { now });
  }

  /** 列出所有时间片（含墓碑） */
  epochs() {
    this.#refreshMeta();
    return Object.entries(this.meta.epochs)
      .map(([id, rec]) => ({ id, createdAt: rec.createdAt, destroyed: false }))
      .concat(
        this.meta.tombstones.map((t) => ({
          id: t.epochId,
          createdAt: t.at,
          destroyed: true,
          reason: t.reason,
        }))
      )
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  #logPath(epochId) {
    return path.join(this.dir, 'epochs', `${epochId}.jsonl`);
  }

  #keyOf(epochId) {
    const rec = this.meta.epochs[epochId];
    if (!rec) throw new Error(`epoch ${epochId} 不存在或已销毁`);
    return unwrap(this.master, rec.wrapped);
  }

  /** 跨进程写锁；陈旧锁（持有者崩了）超时后可夺取 */
  #lock(epochId) {
    const lockPath = path.join(this.dir, 'epochs', `${epochId}.lock`);
    const deadline = Date.now() + this.lockTimeoutMs;
    for (;;) {
      try {
        const fd = fs.openSync(lockPath, 'wx');
        try {
          fs.writeSync(fd, `${process.pid} ${Date.now()}`);
        } finally {
          fs.closeSync(fd);
        }
        return {
          release: () => {
            try {
              fs.unlinkSync(lockPath);
            } catch {
              /* 已被夺走 */
            }
          },
        };
      } catch (e) {
        if (e?.code !== 'EEXIST') throw e;
        try {
          const st = fs.statSync(lockPath);
          if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
            fs.unlinkSync(lockPath);
            continue;
          }
        } catch {
          /* 锁刚被释放，重试即可 */
        }
        if (Date.now() > deadline)
          throw new Error(`写入 ${epochId} 超时：另一个进程持有锁（${lockPath}）`);
        sleepSync(5);
      }
    }
  }

  /** 读文件最后一条完整记录（只读尾部 chunk，不整文件 scan） */
  #lastRecord(logPath, size) {
    let chunk = TAIL_CHUNK;
    for (;;) {
      const start = Math.max(0, size - chunk);
      const len = size - start;
      const buf = Buffer.alloc(len);
      const fd = fs.openSync(logPath, 'r');
      try {
        fs.readSync(fd, buf, 0, len, start);
      } finally {
        fs.closeSync(fd);
      }
      const text = buf.toString('utf8');
      const lines = text.split('\n').filter(Boolean);
      // 从文件中间开始时第一条可能是半行，丢掉
      const usable = start === 0 ? lines : lines.slice(1);
      if (usable.length) return JSON.parse(usable[usable.length - 1]);
      if (start === 0) throw new Error(`日志里没有可解析的记录：${logPath}`);
      chunk *= 4;
    }
  }

  /** 当前 head：内存命中 O(1)；文件大小变了才读尾部 */
  #head(epochId, logPath) {
    let size = 0;
    try {
      size = fs.statSync(logPath).size;
    } catch {
      size = 0;
    }
    const cached = this.heads.get(epochId);
    if (cached && cached.size === size) return cached;

    let head;
    if (size === 0) {
      head = { size: 0, seq: 0, hash: 'GENESIS' };
    } else {
      const last = this.#lastRecord(logPath, size);
      // kinds 只能从锚点继承：重建 head 时不想为了分类计数去解密整个档案
      const kinds = this.meta.epochs[epochId]?.head?.kinds;
      head = { size, seq: (last.seq ?? 0) + 1, hash: last.hash, ...(kinds ? { kinds } : {}) };
    }
    this.heads.set(epochId, head);
    return head;
  }

  /** 追加一条事件；返回 {hash, prevHash, seq} */
  append(epochId, event) {
    this.#refreshMeta();
    const key = this.#keyOf(epochId); // 已销毁会在这里抛
    const logPath = this.#logPath(epochId);
    const lock = this.#lock(epochId);
    let out;
    try {
      const head = this.#head(epochId, logPath); // 持锁后再取，避免两个进程拿到同一个 seq
      const kind = typeof event?.kind === 'string' ? event.kind : 'other';
      const kinds = { ...(head.kinds ?? {}) };
      kinds[kind] = (kinds[kind] ?? 0) + 1;
      const record = {
        seq: head.seq,
        at: Date.now(),
        payload: seal(key, JSON.stringify(event)),
        prevHash: head.hash,
      };
      record.hash = sha256(JSON.stringify(record));
      const line = JSON.stringify(record) + '\n';
      const bytes = Buffer.byteLength(line, 'utf8');
      const fd = fs.openSync(logPath, 'a');
      try {
        fs.writeFileSync(fd, line, 'utf8');
        if (this.durable) fs.fsyncSync(fd); // 不然断电丢尾，却已经返回"成功 hash"
      } finally {
        fs.closeSync(fd);
      }
      this.heads.set(epochId, {
        size: head.size + bytes,
        seq: head.seq + 1,
        hash: record.hash,
        kinds,
      });
      out = { hash: record.hash, prevHash: head.hash, seq: head.seq };
    } finally {
      lock.release();
    }
    this.#anchorHead(epochId); // 锚点在锁外写：写锚点失败不该挡住记忆落盘
    return out;
  }

  /** 读回并解密；已销毁的 epoch 直接抛错 */
  read(epochId) {
    this.#refreshMeta();
    const key = this.#keyOf(epochId); // 已销毁会在这里抛
    const logPath = this.#logPath(epochId);
    if (!fs.existsSync(logPath)) return [];
    const text = fs.readFileSync(logPath, 'utf8');
    const lines = text.split('\n').filter(Boolean);
    const out = lines.map((line) => {
      const rec = JSON.parse(line);
      return { seq: rec.seq, at: rec.at, event: JSON.parse(open(key, rec.payload)) };
    });
    const lastRec = lines.length ? JSON.parse(lines[lines.length - 1]) : null;
    let size = 0;
    try {
      size = fs.statSync(logPath).size;
    } catch {
      /* 刚被删 */
    }
    // 顺手把分类计数纠正一遍：这是唯一一次「全量已知」，之后靠 append 自增
    const kinds = {};
    for (const r of out) {
      const k = typeof r.event?.kind === 'string' ? r.event.kind : 'other';
      kinds[k] = (kinds[k] ?? 0) + 1;
    }
    this.heads.set(epochId, {
      size,
      seq: lines.length,
      hash: lastRec ? lastRec.hash : 'GENESIS',
      kinds,
    });
    return out;
  }

  /**
   * 当前 head（O(1)：一次 stat，必要时读尾部 chunk）。
   * 面板要显示规模时用它，别为了一个数字去解密整个档案。
   * @returns {{seq:number, size:number, hash:string, kinds?:Record<string,number>}}
   */
  head(epochId) {
    this.#refreshMeta();
    return this.#head(epochId, this.#logPath(epochId));
  }

  /**
   * 只解密最后 n 条记录。
   * 「最近聊了什么」不需要把 6.7MB 全解一遍；从文件尾部倒着读够 n 条就行。
   */
  tail(epochId, n = 50) {
    this.#refreshMeta();
    const key = this.#keyOf(epochId);
    const logPath = this.#logPath(epochId);
    if (!fs.existsSync(logPath)) return [];
    const size = fs.statSync(logPath).size;
    if (size === 0) return [];
    const want = Math.max(1, n | 0);

    let chunk = TAIL_CHUNK;
    for (;;) {
      const start = Math.max(0, size - chunk);
      const len = size - start;
      const buf = Buffer.alloc(len);
      const fd = fs.openSync(logPath, 'r');
      try {
        fs.readSync(fd, buf, 0, len, start);
      } finally {
        fs.closeSync(fd);
      }
      const lines = buf.toString('utf8').split('\n').filter(Boolean);
      const usable = start === 0 ? lines : lines.slice(1); // 从中间开始的第一行是半行
      if (usable.length >= want || start === 0) {
        return usable.slice(-want).map((line) => {
          const rec = JSON.parse(line);
          return { seq: rec.seq, at: rec.at, event: JSON.parse(open(key, rec.payload)) };
        });
      }
      chunk *= 4;
    }
  }

  /**
   * 规模统计（O(1)）：条数、字节数、按 kind 的计数。
   * kinds 缺失（升级前写的档案）才读一次全量补上，之后靠 append 自增。
   */
  stats(epochId) {
    const head = this.head(epochId);
    if (!head.kinds && head.seq > 0) {
      try {
        this.read(epochId); // read 会把 kinds 纠正进 heads
        const healed = this.heads.get(epochId);
        if (healed) return { records: healed.seq, bytes: healed.size, kinds: healed.kinds ?? {} };
      } catch {
        // 读不出来（密钥丢了/文件坏了）就只报条数
      }
    }
    return { records: head.seq, bytes: head.size, kinds: head.kinds ?? {} };
  }

  /**
   * 增量验链：只校验「上次验过之后新写的那一段」，用于面板的实时指示灯。
   *
   * 为什么不直接 verify：面板每开一次都要全链重算（6.7MB 约 24ms），
   * 而链是追加写的 —— 上次已验证过的前缀，其末尾 hash 就是可信锚点，
   * 从这里往后接着算即可，代价与增量成正比。
   *
   * 代价与边界（诚实记录）：文件**变短**或检查点丢失时才回落到全量 verify；
   * 同尺寸的原位篡改不会被这里发现 —— 审计请用 verify()／CLI `loom verify`。
   */
  verifyFast(epochId) {
    this.#refreshMeta();
    const rec = this.meta.epochs[epochId];
    const anchored = rec?.head;
    const logPath = this.#logPath(epochId);

    let size = 0;
    try {
      size = fs.statSync(logPath).size;
    } catch {
      size = 0;
    }
    if (size === 0) {
      if (anchored && anchored.seq > 0) {
        return { ok: false, reason: `日志文件缺失（锚点记录 ${anchored.seq} 条）` };
      }
      return { ok: true, count: 0 };
    }

    const verified = rec?.verified;
    // 没有检查点，或文件比检查点还短（可能被截断）→ 老老实实全量
    if (!verified || size < verified.size) return this.verify(epochId);

    let prev = verified.hash;
    let seq = verified.seq;
    if (size > verified.size) {
      const len = size - verified.size;
      const buf = Buffer.alloc(len);
      const fd = fs.openSync(logPath, 'r');
      try {
        fs.readSync(fd, buf, 0, len, verified.size);
      } finally {
        fs.closeSync(fd);
      }
      const lines = buf.toString('utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        let r;
        try {
          r = JSON.parse(line);
        } catch {
          return { ok: false, at: seq, reason: '末尾记录不完整' };
        }
        const { hash, ...rest } = r;
        if (sha256(JSON.stringify(rest)) !== hash)
          return { ok: false, at: seq, reason: 'hash mismatch' };
        if (r.prevHash !== prev) return { ok: false, at: seq, reason: 'chain broken' };
        prev = hash;
        seq++;
      }
    }

    if (anchored && seq < anchored.seq) {
      return { ok: false, reason: `尾部被截断：锚点 ${anchored.seq} 条，实际 ${seq} 条` };
    }
    if (anchored && anchored.seq > 0 && prev !== anchored.hash) {
      return { ok: false, reason: '末尾 hash 与锚点不符' };
    }

    // 记下「已验证到哪个字节」，下次只用校验增量
    if (!verified || verified.seq !== seq || verified.size !== size) {
      rec.verified = { seq, hash: prev, size };
      try {
        this.#save({ anchorOnly: true });
      } catch {
        /* 写不进就下次再算 */
      }
    }
    return { ok: true, count: seq };
  }

  /** 验链：逐条重算 hash、确认 prevHash 指向前一条，并与 head 锚点比对（防截断） */
  verify(epochId) {
    this.#refreshMeta();
    const logPath = this.#logPath(epochId);
    const anchored = this.meta.epochs[epochId]?.head;
    if (!fs.existsSync(logPath)) {
      if (anchored && anchored.seq > 0) {
        return { ok: false, reason: `日志文件缺失（锚点记录 ${anchored.seq} 条）` };
      }
      return { ok: true, count: 0 };
    }
    const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
    let prev = 'GENESIS';
    for (const [i, line] of lines.entries()) {
      const rec = JSON.parse(line);
      const { hash, ...rest } = rec;
      if (sha256(JSON.stringify(rest)) !== hash)
        return { ok: false, at: i, reason: 'hash mismatch' };
      if (rec.prevHash !== prev) return { ok: false, at: i, reason: 'chain broken' };
      prev = hash;
    }
    if (anchored && lines.length < anchored.seq) {
      return { ok: false, reason: `尾部被截断：锚点 ${anchored.seq} 条，实际 ${lines.length} 条` };
    }
    if (anchored && anchored.seq > 0 && prev !== anchored.hash) {
      return { ok: false, reason: '末尾 hash 与锚点不符' };
    }
    // 全量验过就落一个检查点，让面板之后的 verifyFast 只算增量
    const rec = this.meta.epochs[epochId];
    if (rec) {
      let size = 0;
      try {
        size = fs.statSync(logPath).size;
      } catch {
        /* 刚被删 */
      }
      rec.verified = { seq: lines.length, hash: prev, size };
      try {
        this.#save({ anchorOnly: true });
      } catch {
        /* 不影响验链结论 */
      }
    }
    return { ok: true, count: lines.length };
  }

  /** 销毁一个 epoch：删密钥 + 留墓碑；之后 read 会抛错，但链仍可验 */
  destroyEpoch(epochId, reason) {
    this.#refreshMeta();
    const rec = this.meta.epochs[epochId];
    if (!rec) throw new Error(`epoch ${epochId} 不存在`);
    delete this.meta.epochs[epochId];
    if (!this.meta.tombstones.some((t) => t.epochId === epochId)) {
      this.meta.tombstones.push({ epochId, reason, at: Date.now() });
    }
    this.heads.delete(epochId);
    this.#save(); // 合并写：别把别的进程刚建的 epoch 覆盖掉，也别让自己复活
    return { destroyed: true, epochId };
  }

  /** 该 epoch 是否已被销毁 */
  isDestroyed(epochId) {
    this.#refreshMeta();
    return this.meta.tombstones.some((t) => t.epochId === epochId);
  }
}
