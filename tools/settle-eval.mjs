#!/usr/bin/env node
/**
 * Settle 实测：引用协议靠不靠得住？
 *
 *   给每条证据一个短 id，要求模型在回答末尾引用 [#id]；
 *   再比较「引用归因」和「词面归因」是否一致。
 *
 *   node tools/settle-eval.mjs [--limit 12]
 *
 * 如果引用率低，说明 Settle 不能只靠引用，必须叠加词面归因。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { attributeCitation, attributeOverlap } from '../packages/loom-core/src/settle.js';
import { stripTail } from '../packages/loom-core/src/aiw.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const { loadCorpus, loadQa } = await import('../packages/loom-core/src/eval-data.js');
const corpus = loadCorpus();
const qa = loadQa();

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i < 0 ? d : argv[i + 1];
};
const KEY = process.env.DEEPSEEK_API_KEY;
const limit = Number(arg('limit', 12));

if (!KEY) {
  console.error('缺少 DEEPSEEK_API_KEY');
  process.exit(2);
}

// 每题配一条记忆：用 disc/base 题的 id 去取该记忆的 AI文
const questions = qa.filter((q) => q.type !== 'a');
const picks = [];
for (const q of questions) {
  if (picks.length >= limit) break;
  const item = corpus.items.find((i) => i.id === q.id);
  if (item) picks.push({ q, item });
}

const SYS =
  '你是一个助手。只根据给出的记忆回答问题，回答控制在一句话内。' +
  '回答末尾必须用方括号引用你依据的记忆编号，例如 [abcd1234]。只能引用给出的编号。';

async function ask(item, question) {
  const id8 = item.id.padEnd(8, '0').slice(0, 8);
  const user = `记忆 [#${id8}]：${stripTail(item.aiw)}\n\n问题：${question}\n\n（末尾用 [#${id8}] 标注依据）`;
  const r = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [{ role: 'system', content: SYS }, { role: 'user', content: user }],
      temperature: 0,
      max_tokens: 100,
    }),
  });
  if (!r.ok) throw new Error(`API ${r.status}`);
  return (await r.json()).choices[0].message.content.trim();
}

const rows = [];
for (const { q, item } of picks) {
  const id8 = item.id.padEnd(8, '0').slice(0, 8);
  const answer = await ask(item, q.question);
  const items = [{ claimId: id8, text: stripTail(item.aiw) }];
  const cited = attributeCitation(answer, items);
  const overlap = attributeOverlap(answer, items);
  rows.push({ id: item.id, answer, cited: cited.length > 0, overlap: overlap.length > 0 });
  process.stdout.write(`  ${item.id} cite=${cited.length} overlap=${overlap.length}\n`);
}

const pct = (x) => (x * 100).toFixed(0) + '%';
const citeRate = rows.filter((r) => r.cited).length / rows.length;
const overRate = rows.filter((r) => r.overlap).length / rows.length;
const agree = rows.filter((r) => r.cited === r.overlap).length / rows.length;

console.log(`\n引用率 ${pct(citeRate)} · 词面命中率 ${pct(overRate)} · 两者一致 ${pct(agree)}（${rows.length} 题）`);
const none = rows.filter((r) => !r.cited && !r.overlap);
if (none.length) {
  console.log(`两种归因都判定"没用"：${none.length} 条`);
  for (const r of none.slice(0, 3)) console.log(`  ${r.id}: ${r.answer.replace(/\n/g, ' ').slice(0, 80)}`);
}

fs.writeFileSync(
  path.join(repo, 'loom', 'settle-report.md'),
  [
    '# Settle 归因实测',
    '',
    `- 题数：${rows.length}，每题只注入一条证据`,
    `- 引用率：${pct(citeRate)}　词面命中率：${pct(overRate)}　一致率：${pct(agree)}`,
    '',
    '| 记忆 | 引用 | 词面 | 回答 |',
    '| --- | --- | --- | --- |',
    ...rows.map((r) => `| ${r.id} | ${r.cited ? '✓' : '✗'} | ${r.overlap ? '✓' : '✗'} | ${r.answer.replace(/\n/g, ' ').slice(0, 60)} |`),
    '',
  ].join('\n'),
  'utf8'
);
console.log('\n报告：loom/settle-report.md');
