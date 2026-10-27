// 档案层（L0）的安全与性能契约。
// 这些断言对应的都是审查里抓到的真问题，不是凑覆盖率：
//   · 追加是 O(1)（旧实现每条重读整个 jsonl）
//   · 截断可检测（旧实现删掉末尾仍报 ok）
//   · 销毁不可被别的进程复活（旧实现 #save 整份覆盖会写回密钥）
//   · meta 原子写（旧实现直接覆盖，崩在中间 = 全部密钥不可读）
//   · 跨进程追加不会撞 seq（旧实现没有锁）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const { Chronicle } = await import('../src/chronicle.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'loom-chr-'));
const sha256 = (x) => crypto.createHash('sha256').update(x).digest('hex');

/** 造一个「上一代写的」日志：append 只读尾行，所以内容只要格式对 */
function craftLog(dir, epochId, n, sizePerLine = 2600) {
  const logPath = path.join(dir, 'epochs', `${epochId}.jsonl`);
  let prev = 'GENESIS';
  const lines = [];
  for (let i = 0; i < n; i++) {
    const rec = { seq: i, at: Date.now(), payload: 'x'.repeat(sizePerLine), prevHash: prev };
    rec.hash = sha256(JSON.stringify(rec));
    lines.push(JSON.stringify(rec));
    prev = rec.hash;
  }
  fs.writeFileSync(logPath, lines.join('\n') + '\n');
  return { logPath, size: fs.statSync(logPath).size, head: prev };
}

/** 统计 append 期间从磁盘读了多少字节 */
function measureReadBytes(fn) {
  let bytes = 0;
  const rFS = fs.readFileSync;
  const rS = fs.readSync;
  fs.readFileSync = function (p, ...rest) {
    const out = rFS.call(this, p, ...rest);
    bytes += Buffer.isBuffer(out) ? out.length : Buffer.byteLength(String(out));
    return out;
  };
  /** @type {any} */ (fs).readSync = function (fd, buf, off, len, pos) {
    const n = rS.call(this, fd, buf, off, len, pos);
    bytes += n;
    return n;
  };
  try {
    const result = fn();
    return { result, bytes };
  } finally {
    fs.readFileSync = rFS;
    fs.readSync = rS;
  }
}

test('追加是 O(1)：2MB 档案上追加一条，读盘远小于文件本身', () => {
  const dir = tmp();
  const ch = new Chronicle(dir, { durable: false });
  const ep = ch.createEpoch('ep-big');
  const { size } = craftLog(dir, ep, 800); // ~2.2MB
  ch.heads.delete(ep); // 丢掉缓存，模拟"真实需要自愈"的路径

  const { result, bytes } = measureReadBytes(() =>
    ch.append(ep, { kind: 'msg', text: '一条新记忆' })
  );
  assert.equal(result.seq, 800, 'seq 应当接在 800 条之后');
  assert.ok(bytes < 200 * 1024, `追加读了 ${bytes} 字节，应当只读尾部 chunk（<200KB）`);
  assert.ok(size > 2 * 1024 * 1024);
});

test('截断末尾会被 verify 抓到', () => {
  const dir = tmp();
  const ch = new Chronicle(dir, { durable: false });
  const ep = ch.createEpoch('ep-trunc');
  for (let i = 0; i < 5; i++) ch.append(ep, { kind: 'msg', text: `第 ${i} 条` });
  assert.equal(ch.verify(ep).ok, true);

  const logPath = path.join(dir, 'epochs', `${ep}.jsonl`);
  const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
  fs.writeFileSync(logPath, lines.slice(0, 2).join('\n') + '\n'); // 删掉末尾 3 条

  const v = new Chronicle(dir, { durable: false }).verify(ep);
  assert.equal(v.ok, false, '截断后仍报 ok 就说明锚点没生效');
  assert.match(String(v.reason), /截断/);
});

test('整个日志被删也会被抓到', () => {
  const dir = tmp();
  const ch = new Chronicle(dir, { durable: false });
  const ep = ch.createEpoch('ep-gone');
  ch.append(ep, { kind: 'msg', text: 'x' });
  fs.unlinkSync(path.join(dir, 'epochs', `${ep}.jsonl`));
  const v = new Chronicle(dir, { durable: false }).verify(ep);
  assert.equal(v.ok, false);
  assert.match(String(v.reason), /缺失/);
});

test('已销毁的 epoch 不会被另一个陈旧进程复活', () => {
  const dir = tmp();
  const a = new Chronicle(dir, { durable: false });
  const ep = a.createEpoch('ep-doom');
  a.append(ep, { kind: 'msg', text: '要被销毁的记忆' });

  const b = new Chronicle(dir, { durable: false });
  const staleMeta = JSON.parse(JSON.stringify(b.meta)); // b 内存里的旧副本（还带着这把钥匙）
  assert.ok(staleMeta.epochs[ep]);

  a.destroyEpoch(ep, '测试');

  // 强行让 b 认为自己的内存副本是最新的（模拟 mtime 记账碰巧一致）
  const st = fs.statSync(path.join(dir, 'meta.json'));
  b.meta = staleMeta;
  b.metaStat = { mtimeMs: st.mtimeMs, size: st.size };

  b.createEpoch('ep-other'); // 触发 #save：旧实现在这里把 ep 的密钥写回去了

  const c = new Chronicle(dir, { durable: false });
  assert.equal(c.isDestroyed(ep), true, '销毁状态被复活的进程撤销了');
  assert.equal(
    c.epochs().some((e) => e.id === ep && !e.destroyed),
    false
  );
  assert.throws(() => c.read(ep), /不存在或已销毁/);
  assert.throws(() => c.createEpoch(ep), /已被销毁/);
});

test('多进程交替追加：seq 不重复、链仍然连续', () => {
  const dir = tmp();
  const a = new Chronicle(dir, { durable: false });
  const ep = a.createEpoch('ep-race');
  const b = new Chronicle(dir, { durable: false });

  const seqs = [];
  for (let i = 0; i < 10; i++) {
    seqs.push((i % 2 ? a : b).append(ep, { kind: 'msg', text: `第 ${i} 条` }).seq);
  }
  assert.deepEqual(seqs, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 'seq 被两个进程撞了');
  assert.equal(new Chronicle(dir, { durable: false }).verify(ep).ok, true);
});

test('锁被别的进程持有时，追加会超时而不是写坏链', () => {
  const dir = tmp();
  const ch = new Chronicle(dir, { durable: false, lockTimeoutMs: 120 });
  const ep = ch.createEpoch('ep-lock');
  const lockPath = path.join(dir, 'epochs', `${ep}.lock`);
  fs.writeFileSync(lockPath, 'other-process');

  assert.throws(() => ch.append(ep, { kind: 'msg', text: 'x' }), /超时/);
  fs.unlinkSync(lockPath); // 对方释放
  assert.equal(ch.append(ep, { kind: 'msg', text: 'x' }).seq, 0);
});

test('meta 原子写：不留 tmp 文件，内容始终可解析', () => {
  const dir = tmp();
  const ch = new Chronicle(dir, { durable: false });
  const ep = ch.createEpoch('ep-atomic');
  for (let i = 0; i < 20; i++) ch.append(ep, { kind: 'msg', text: 'x'.repeat(50) });

  const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], 'tmp 文件没清干净，说明不是原子写');
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  assert.ok(meta.epochs[ep].head, 'head 锚点应当写进 meta');
  assert.equal(meta.epochs[ep].head.seq, 20);
});

test('重建实例后 head 自愈：不需要整文件扫描也能接上', () => {
  const dir = tmp();
  const a = new Chronicle(dir, { durable: false });
  const ep = a.createEpoch('ep-heal');
  for (let i = 0; i < 3; i++) a.append(ep, { kind: 'msg', text: `第 ${i} 条` });

  const b = new Chronicle(dir, { durable: false }); // 全新进程：head 缓存空
  assert.equal(b.append(ep, { kind: 'msg', text: '第 3 条' }).seq, 3);
  assert.equal(new Chronicle(dir, { durable: false }).verify(ep).count, 4);
  assert.deepEqual(
    new Chronicle(dir, { durable: false }).read(ep).map((r) => r.seq),
    [0, 1, 2, 3]
  );
});
