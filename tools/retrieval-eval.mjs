#!/usr/bin/env node
/**
 * 检索质量评测：用 200 题真数据测「召回对不对」。
 *
 *   node tools/retrieval-eval.mjs [--budget 400]
 *
 * 指标：
 *   recall@k —— 正确答案是否出现在前 k 条
 *   MRR      —— 正确答案排第几（1/rank 的平均）
 *   abstain  —— 语料里没有答案的问题，应返回空
 */


import { ingest } from '../packages/loom-core/src/ingest.js';
import { recall } from '../packages/loom-core/src/recall.js';
import { SqliteLedger } from '../packages/loom-core/src/sqlite-ledger.js';
import { stripTail } from '../packages/loom-core/src/aiw.js';

const { loadCorpus, loadQa } = await import('../packages/loom-core/src/eval-data.js');
const corpus = loadCorpus().items;
const qa = loadQa();

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i < 0 ? d : argv[i + 1];
};
const budget = Number(arg('budget', 400));

const db = new SqliteLedger(':memory:');
for (const item of corpus) {
  ingest({
    line: item.aiw,
    body: item.original,
    kind: item.kind ?? 'fact',
    epochId: 'ep',
    ledger: db,
    source: { eventId: '#语料' },
    title: stripTail(item.aiw3 ?? item.aiw).slice(0, 12),
  });
}

const idOf = (itemId) => {
  // ingest 内部按内容指纹算 id，这里反查
  const hit = db
    .active()
    .find((c) => stripTail(c.aiw) === stripTail(corpus.find((i) => i.id === itemId).aiw));
  return hit?.id;
};

const rows = [];
for (const q of qa) {
  const r = recall({ query: q.question, search: (x) => db.search(x, { limit: 50 }), budget });
  const got = r.items.map((i) => i.claimId).concat(r.pointers.map((p) => p.claimId ?? ''));
  const target = q.type === 'a' ? null : idOf(q.id);
  const rank = target ? got.indexOf(target) + 1 : 0;
  rows.push({ q, rank, target, n: got.length, skipped: r.skipped });
}

const disc = rows.filter((r) => r.target);
const abstain = rows.filter((r) => !r.target);

const at = (k) => disc.filter((r) => r.rank > 0 && r.rank <= k).length / disc.length;
const mrr = disc.reduce((s, r) => s + (r.rank > 0 ? 1 / r.rank : 0), 0) / disc.length;
const empty = rows.filter((r) => r.n === 0).length;
const abstainEmpty = abstain.filter((r) => r.n === 0).length / abstain.length;

const pct = (x) => (x * 100).toFixed(1) + '%';
console.log(`\n检索评测 · ${corpus.length} 条语料 · ${qa.length} 题 · budget ${budget}`);
console.log(
  `recall@1 ${pct(at(1))} · recall@3 ${pct(at(3))} · recall@5 ${pct(at(5))} · MRR ${mrr.toFixed(3)}`
);
console.log(
  `有答案的题 ${disc.length} 条，其中取回为空 ${disc.filter((r) => r.n === 0).length} 条`
);
console.log(
  `abstain ${abstain.length} 条，返回空 ${abstainEmpty ? pct(abstainEmpty) : '0%'}；全库空返回 ${empty}/${rows.length}`
);
console.log(`admission 跳过 ${rows.filter((r) => r.skipped).length} 条（问题不该被跳过）`);

const missed = disc.filter((r) => r.rank === 0).slice(0, 5);
if (missed.length) {
  console.log('\n没命中的例子：');
  for (const m of missed) console.log(`  ${m.q.id} ${m.q.question}  → 取回 ${m.n} 条`);
}

const noisy = abstain.filter((r) => r.n > 0).slice(0, 5);
if (noisy.length) {
  console.log('\nabstain 却召回了东西：');
  for (const m of noisy) console.log(`  ${m.q.id} ${m.q.question}  → ${m.n} 条`);
}

db.close();
