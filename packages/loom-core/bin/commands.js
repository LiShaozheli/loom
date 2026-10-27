/**
 * CLI 命令实现。全部是纯函数 + console 输出，方便单独测试。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ingest } from '../src/ingest.js';
import { allocate } from '../src/allocate.js';
import { recall } from '../src/recall.js';
import { settleTurn } from '../src/settle.js';
import { Chronicle } from '../src/chronicle.js';
import { SqliteLedger } from '../src/sqlite-ledger.js';
import { stripTail, parseTail } from '../src/aiw.js';
import { chars4Counter } from '../src/contracts.js';
import { exportToFile, importFromFile } from '../src/transfer.js';
import { exportToZip, importFromZip } from '../src/bundle.js';
import { sweep } from '../src/decay.js';
import { corpusPath, loadCorpus } from '../src/eval-data.js';

export { corpusPath, loadCorpus };

/** 与插件一致的默认库路径 */
export const liveDbPath = () =>
  path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'loom', 'loom.db');

function seedLedger(ledger, items, epoch) {
  let accepted = 0;
  const rejected = [];
  for (const item of items) {
    const r = ingest({
      line: item.aiw,
      body: item.original,
      kind: item.kind,
      epochId: epoch,
      ledger,
      original: item.original,
      mustKeep: item.must_keep,
      title: stripTail(item.aiw4 ?? '').slice(0, 12),
    });
    if (r.ok) accepted++;
    else {
      const why = r.gate.missing?.length
        ? `缺 ${r.gate.missing.join(',')}`
        : (r.gate.issues.find((i) => i.level === 'ERROR')?.msg ?? r.gate.verdict);
      rejected.push(`${item.id} ${r.gate.verdict}：${why}`);
    }
  }
  return { accepted, rejected };
}

/** 端到端演示 */
export function demo() {
  const corpus = loadCorpus();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-demo-'));
  const chronicle = new Chronicle(dir);
  const epoch = chronicle.createEpoch('ep-demo');
  const ledger = new SqliteLedger(path.join(dir, 'loom.db'));

  const { accepted, rejected } = seedLedger(ledger, corpus.items, epoch);
  for (const r of rejected.slice(0, 5)) console.log('   ' + r);

  console.log(
    `\n① 写入：ACCEPT ${accepted} · 拒绝 ${rejected.length}（共 ${corpus.items.length}）`
  );

  let fragPass = 0;
  for (const item of corpus.items) {
    const probe = new SqliteLedger(':memory:');
    const r = ingest({
      line: `${item.fragment}@1970-01-01 #x ?`,
      body: item.original,
      epochId: epoch,
      ledger: probe,
      original: item.original,
      mustKeep: item.must_keep,
    });
    if (r.ok) fragPass++;
    probe.close();
  }
  console.log(`\n② 碎片过闸门：${fragPass}/${corpus.items.length}（应为 0）`);

  for (const q of ['鉴权', '压测', '1Password']) {
    const hits = ledger.search(q, { limit: 3 });
    console.log(`\n③ 检索「${q}」→ ${hits.length} 条 ${hits.map((h) => h.title).join(' / ')}`);
  }

  const candidates = ledger.active().map((c, i) => ({ claim: c, score: 1 - i * 0.01 }));
  for (const budget of [100, 400]) {
    const r = allocate({ candidates, budget });
    console.log(
      `\n④ 预算 ${budget}（${chars4Counter.name}）：正文 ${r.items.filter((i) => i.level === 'full').length} · ` +
        `标题 ${r.items.filter((i) => i.level === 'title').length} · 指针 ${r.pointers.length} · 用掉 ${r.usedTokens}`
    );
  }

  const first = ledger.active()[0];
  ledger.put({ ...first, id: 'demo-new', aiw: `${first.aiw}（修订）` });
  ledger.supersede(first.id, 'demo-new', '演示：改主意了');
  console.log(`\n⑤ 冲突：${first.id} 失效 → demo-new；旧条目仍在，可回查`);

  console.log(`\n⑥ 哈希链：${JSON.stringify(chronicle.verify(epoch))}`);
  const before = chronicle.read(epoch).length;
  chronicle.destroyEpoch(epoch, '演示：用户要求删除这段时间');
  let after;
  try {
    chronicle.read(epoch);
    after = '仍可读';
  } catch (e) {
    after = e.message;
  }
  console.log(
    `   删除 epoch：事件 ${before} 条 → ${after}；墓碑 ${chronicle.isDestroyed(epoch) ? '已留' : '缺失'}`
  );
  console.log(`   链仍可验：${JSON.stringify(chronicle.verify(epoch))}`);

  ledger.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n临时目录已清理：${dir}`);
}

/** 工程门禁 */
export function verify() {
  const corpus = loadCorpus();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-verify-'));
  const chronicle = new Chronicle(dir);
  const epoch = chronicle.createEpoch('ep-verify');
  const ledger = new SqliteLedger(path.join(dir, 'verify.db'));

  const checks = [];
  const ok = (name, cond, extra = '') => checks.push({ name, pass: !!cond, extra });

  const { accepted } = seedLedger(ledger, corpus.items, epoch);
  for (const c of ledger.active()) chronicle.append(epoch, { claimId: c.id });

  ok('AI文 全过闸门', accepted === corpus.items.length, `${accepted}/${corpus.items.length}`);
  ok('正文不含尾部元数据', !ledger.active().some((c) => parseTail(c.aiw) !== null));

  let fragPass = 0;
  for (const item of corpus.items) {
    const probe = new SqliteLedger(':memory:');
    const r = ingest({
      line: `${item.fragment}@1970-01-01 #x ?`,
      body: item.original,
      epochId: epoch,
      ledger: probe,
      original: item.original,
      mustKeep: item.must_keep,
    });
    if (r.ok) fragPass++;
    probe.close();
  }
  ok('碎片全被拒', fragPass === 0, `${fragPass} 通过`);

  ok('检索「鉴权」有结果', ledger.search('鉴权').length > 0);
  ok('检索「1Password」有结果', ledger.search('1Password').length > 0);

  const cands = ledger.active().map((c, i) => ({ claim: c, score: 1 - i * 0.01 }));
  const alloc = allocate({ candidates: cands, budget: 200 });
  ok('取回不超预算', alloc.usedTokens <= 200, `${alloc.usedTokens}/200`);

  const v = chronicle.verify(epoch);
  ok('哈希链可验', v.ok && v.count === accepted, JSON.stringify(v));

  chronicle.destroyEpoch(epoch, 'verify');
  let destroyed = false;
  try {
    chronicle.read(epoch);
  } catch {
    destroyed = true;
  }
  ok('销毁后内容不可读', destroyed);
  ok('销毁后链仍可验', chronicle.verify(epoch).ok);

  // 三问：应答短路 + 提问命中
  const skip = recall({ query: '好的', claims: ledger.active() });
  ok('三问：应答短路', skip.skipped === true);
  const hit = recall({
    query: '上次 JWT 那个方案为什么回滚？',
    claims: ledger.active(),
    budget: 200,
  });
  ok(
    '三问：提问命中鉴权条目',
    hit.items.some((i) => (i.text || '').includes('JWT'))
  );

  // Settle：被引用的条目涨权，没被引用的降权
  const target = ledger.active().find((c) => c.aiw.includes('JWT'));
  const before = target.salience;
  settleTurn({
    answer: `改鉴权→JWT 失败就回滚了 [#${target.id.slice(0, 8)}]`,
    items: [{ claimId: target.id, text: target.aiw }],
    ledger,
  });
  const after = ledger.get(target.id).salience;
  ok('Settle：被引用则涨权', after > before, `${before.toFixed(2)}→${after.toFixed(2)}`);

  ledger.close();
  fs.rmSync(dir, { recursive: true, force: true });

  for (const c of checks)
    console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.extra ? '  ' + c.extra : ''}`);
  const failed = checks.filter((c) => !c.pass).length;
  console.log(`\nverify: ${checks.length - failed}/${checks.length} 通过`);
  process.exit(failed ? 1 : 0);
}

/** 三问演示 */
export function recallCmd(query) {
  const corpus = loadCorpus();
  const ledger = new SqliteLedger(':memory:');
  seedLedger(ledger, corpus.items, 'ep');

  const r = recall({ query, search: (q) => ledger.search(q, { limit: 50 }), budget: 200 });
  console.log(`\n问题：${query}`);
  console.log(`① 要不要查：${r.admission.recall ? '查' : '不查'}（${r.admission.reason}）`);
  if (r.skipped) {
    ledger.close();
    return;
  }

  console.log(`② 查哪类：${r.route.reason}`);
  console.log(`③ 取多少：目录 ${r.outline.nodes.length} 个节点 / ${r.outline.usedTokens} token`);
  for (const n of r.outline.nodes) console.log(`   ${n.title}　子树 ${n.tokens.subtree} token`);
  console.log(
    `   取回 ${r.items.length} 条正文 + ${r.pointers.length} 条指针 · 用掉 ${r.usedTokens}/200`
  );
  for (const it of r.items) console.log(`   [${it.level}] ${it.claimId.slice(0, 8)} ${it.text}`);
  for (const p of r.pointers) console.log(`   [ptr] ${p.title}`);
  ledger.close();
}

/** 校验作者格式的文件 */
export function gateFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('//'));
  const probe = new SqliteLedger(':memory:');
  let rej = 0;
  for (const [i, l] of lines.entries()) {
    const r = ingest({ line: l, body: l, epochId: 'ep', ledger: probe });
    if (!r.ok) {
      rej++;
      console.log(`  ${i + 1}: ${r.gate.verdict} ${r.gate.issues.map((x) => x.code).join(',')}`);
    }
  }
  probe.close();
  console.log(`${file}: ${lines.length} 行 · 通过 ${lines.length - rej} · 拒绝 ${rej}`);
  process.exit(rej ? 1 : 0);
}

/** 导出到文件 */
export function exportCmd(file) {
  const db = new SqliteLedger(liveDbPath());
  const bundle = exportToFile(db, file);
  db.close();
  console.log(`已导出 ${bundle.count} 条 → ${file}`);
}

/** 从文件导入 */
export function importCmd(file) {
  const db = new SqliteLedger(liveDbPath());
  const r = importFromFile(db, file);
  db.close();
  console.log(`导入完成：新增 ${r.added} · 跳过（已存在）${r.skipped} · 共 ${r.total}`);
}

/** 遗忘扫描 */
export function decayCmd(apply) {
  const db = new SqliteLedger(liveDbPath());
  const r = sweep(db, { apply });
  for (const row of r.rows.slice(0, 20)) {
    console.log(
      `  ${row.action.padEnd(10)} ${row.id.slice(0, 8)} ${row.kind.padEnd(9)} score=${row.score} ${row.title}`
    );
  }
  console.log(`\n${apply ? '已执行' : '预览'}：${JSON.stringify(r.counts)}`);
  db.close();
}

/** 列出编年层的时间片 */
export function epochsCmd() {
  const chron = new Chronicle(path.join(path.dirname(liveDbPath()), 'chronicle'));
  for (const e of chron.epochs()) {
    console.log(
      `  ${e.id.padEnd(16)} ${e.destroyed ? '已销毁' : '在'} ${new Date(e.createdAt).toISOString().slice(0, 10)}${e.reason ? '  ' + e.reason : ''}`
    );
  }
}

/** 销毁一个时间片（crypto-shredding：密钥销毁，正文不可再读，墓碑留在链上） */
export function shredCmd(epochId, reason = '用户要求') {
  const chron = new Chronicle(path.join(path.dirname(liveDbPath()), 'chronicle'));
  if (!chron.meta.epochs[epochId]) {
    console.error(`没有这个时间片：${epochId}`);
    process.exit(2);
  }
  chron.destroyEpoch(epochId, reason);
  const v = chron.verify(epochId);
  console.log(`已销毁 ${epochId}：内容不可读，墓碑已留，链仍可验（${v.ok ? '是' : '否'}）`);
}

/** 导出 ZIP 记忆包（含文档版本与关系边） */
export function exportZipCmd(file) {
  const db = new SqliteLedger(liveDbPath());
  const manifest = exportToZip(db, file);
  db.close();
  console.log(`已打包 → ${file}`);
  console.log(`  ${JSON.stringify(manifest.counts)}`);
}

/** 导入 ZIP 记忆包 */
export function importZipCmd(file) {
  const db = new SqliteLedger(liveDbPath());
  const counts = importFromZip(db, file);
  db.close();
  console.log(`导入完成：${JSON.stringify(counts)}`);
}

/** 看某篇文档的历史版本 */
export function docRevsCmd(keyword) {
  const db = new SqliteLedger(liveDbPath());
  const docs = db.docs().filter((d) => !keyword || String(d.title).includes(keyword));
  for (const d of docs) {
    const revs = db.docRevisions(d.id);
    console.log(`${d.title}（${d.id}）· ${revs.length} 版`);
    for (const r of revs)
      console.log(
        `  v${r.rev} ${new Date(r.at).toISOString().slice(0, 16)} ${r.body.slice(0, 40)}`
      );
  }
  if (!docs.length) console.log('没有匹配的文档');
  db.close();
}
