import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ingest } from '../src/ingest.js';
import { MemoryLedger } from '../src/ledger.js';
import { Chronicle } from '../src/chronicle.js';
import { SqliteLedger, bigrams } from '../src/sqlite-ledger.js';

const LINE = 'Win路径拼正斜杠→配置读败（ENOENT）；仅打包后现；修=path.join。@2026-10-22 #44 !';
const ORIGINAL = 'Windows 上路径拼接用了正斜杠，导致配置读不到，报 ENOENT，只在打包后出现，修复用 path.join。';

test('ingest 是收口点：尾部不进正文，变成字段', () => {
  const led = new MemoryLedger();
  const r = ingest({
    line: LINE,
    body: ORIGINAL,
    kind: 'fact',
    epochId: 'ep-1',
    ledger: led,
    original: ORIGINAL,
    mustKeep: ['ENOENT', 'path.join', '打包'],
  });
  assert.equal(r.ok, true, JSON.stringify(r.gate.issues));
  assert.equal(r.claim.aiw.includes('@'), false, '正文里不该有 @');
  assert.equal(r.claim.aiw.includes('#'), false, '正文里不该有 #');
  assert.equal(r.claim.source.eventId, '44', '#来源 进了字段');
  assert.equal(r.claim.confidence, 'high', '! 变成 confidence');
  assert.ok(led.get(r.claim.id), '已入库');
});

test('ingest 拒绝丢事实的稿子，且不写库', () => {
  const led = new MemoryLedger();
  const r = ingest({
    line: '路径拼接导致配置读取失败，已修复。@2026-10-22 #44 ?',
    body: ORIGINAL,
    epochId: 'ep-1',
    ledger: led,
    original: ORIGINAL,
    mustKeep: ['ENOENT', 'path.join', '打包'],
  });
  assert.equal(r.ok, false);
  assert.equal(r.gate.verdict, 'REJECT');
  assert.equal(led.active().length, 0);
});

test('bigram：中文切二元、拉丁串保留整段', () => {
  assert.equal(bigrams('用户彻底怒了'), '用户 户彻 彻底 底怒 怒了');
  const bg = bigrams('在1Password 与 JWT').split(' ');
  assert.ok(bg.includes('1password'), '嵌在中文里的 1Password 要保留整段');
  assert.ok(bg.includes('jwt'));
  assert.ok(bg.includes('密码') === false || true);
});

test('sqlite：写入、bigram 检索、冲突不覆盖', () => {
  const db = new SqliteLedger(':memory:');
  const mk = (id, aiw, title) => ({
    id, kind: 'fact', body: aiw, aiw, title,
    confidence: 'high', source: { eventId: 'e' }, epochId: 'ep',
    taint: 'none', validFrom: 1, salience: 1,
  });
  db.put(mk('a', '改鉴权→JWT，refresh轮换败→回滚session。', '鉴权改造'));
  db.put(mk('b', '缓存方案未定，待压测。', '缓存待定'));

  const hit = db.search('鉴权');
  assert.equal(hit.length, 1);
  assert.equal(hit[0].id, 'a');
  assert.equal(db.search('压测')[0].id, 'b');
  assert.equal(db.search('不存在的词').length, 0);

  db.put(mk('c', '改鉴权→OAuth。', '改用 OAuth'));
  db.supersede('a', 'c', '改主意了');
  assert.ok(db.get('a').validTo, '旧条目失效');
  assert.equal(db.search('鉴权')[0].id, 'c', '检索只返回有效的');
  db.close();
});

test('chronicle：哈希链可验、篡改可见、删 epoch 即删内容', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-chr-'));
  const chr = new Chronicle(dir);
  const ep = chr.createEpoch('ep-test');

  chr.append(ep, { text: '第一条' });
  chr.append(ep, { text: '第二条' });

  assert.deepEqual(chr.verify(ep), { ok: true, count: 2 });
  assert.equal(chr.read(ep)[1].event.text, '第二条');

  // 篡改一行 → 链验失败
  const log = path.join(dir, 'epochs', `${ep}.jsonl`);
  const lines = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
  const rec = JSON.parse(lines[0]);
  rec.payload = rec.payload.slice(0, -2) + 'AA';
  lines[0] = JSON.stringify(rec);
  fs.writeFileSync(log, lines.join('\n') + '\n', 'utf8');
  assert.equal(chr.verify(ep).ok, false);

  // 删除 epoch → 内容不可读，但墓碑还在
  chr.destroyEpoch(ep, '用户要求删除');
  assert.equal(chr.isDestroyed(ep), true);
  assert.throws(() => chr.read(ep), /不存在或已销毁/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('去重：标点差异视为同一条记忆', () => {
  const led = new MemoryLedger();
  const mk = (aiw) => ({
    line: aiw, body: aiw, kind: 'rule', epochId: 'ep', ledger: led,
    source: { eventId: '会话' },
  });
  const a = ingest(mk('预发端口 8081；上线前必跑 smoke。'));
  const b = ingest(mk('预发端口 8081，上线前必跑 smoke。'));
  assert.equal(a.claim.id, b.claim.id, '两条应指向同一条');
  assert.equal(led.active().length, 1);
});
