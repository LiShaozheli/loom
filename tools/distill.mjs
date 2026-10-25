#!/usr/bin/env node
/**
 * Distill 实测：约束生成 → 校验 →（必要时）带反馈重试。
 *
 *   $env:DEEPSEEK_API_KEY=...; node tools/distill.mjs [--limit 30] [--modes rule,human]
 *
 * 两种约束口径：
 *   rule   只用规则抽取的事实（生成端不知道人工标注）
 *   human  用人工 must_keep（上界，等于开卷）
 *
 * 判分用人工 must_keep 作为真值 —— rule 模式下生成端从没见过它。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { brief, generationMessages } from '../packages/loom-core/src/constrain.js';
import { lintBody, stripTail, normalize, factPresent, identifiers } from '../packages/loom-core/src/aiw.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const corpus = JSON.parse(fs.readFileSync(path.join(repo, 'aiw', 'corpus.json'), 'utf8'));

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i < 0 ? d : argv[i + 1];
};
const KEY = process.env.DEEPSEEK_API_KEY;
const limit = Number(arg('limit', corpus.items.length));
const modes = String(arg('modes', 'rule,human')).split(',');
const MODEL = arg('model', 'deepseek-chat');

if (!KEY) {
  console.error('缺少 DEEPSEEK_API_KEY');
  process.exit(2);
}

async function chat(messages, maxTokens = 140) {
  const r = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, messages, temperature: 0, max_tokens: maxTokens }),
  });
  if (!r.ok) throw new Error(`API ${r.status}: ${(await r.text()).slice(0, 160)}`);
  const j = await r.json();
  return { text: j.choices[0].message.content.trim().split('\n')[0].trim(), usage: j.usage };
}

function grade(draft, item) {
  const errors = lintBody(draft, { tier: 'full' }).filter((i) => i.level === 'ERROR');
  const missing = item.must_keep.filter((f) => !factPresent(draft, f));
  const fabricated = identifiers(draft).filter((id) => !normalize(item.original).includes(normalize(id)));
  return { ok: !errors.length && !missing.length && !fabricated.length, errors, missing, fabricated };
}

const rows = [];
for (const mode of modes) {
  for (const item of corpus.items.slice(0, limit)) {
    const b = mode === 'human' ? brief(item.original, { modelTerms: item.must_keep }) : brief(item.original);
    let draft = '';
    let g;
    let tries = 0;
    let usage = 0;

    for (tries = 1; tries <= 3; tries++) {
      const res = await chat(generationMessages(b, { feedback: g?.missing ?? [] }));
      usage += res.usage?.total_tokens ?? 0;
      draft = stripTail(res.text);
      g = grade(draft, item);
      if (g.ok) break;
    }

    rows.push({
      mode, id: item.id, draft, ...g, tries, usage,
      len: draft.length,
      humanLen: stripTail(item.aiw).length,
    });
    process.stdout.write(`  ${mode} ${item.id} ${g.ok ? '✓' : '✗'} tries=${tries} len=${draft.length}/${stripTail(item.aiw).length}\n`);
  }
}

const pct = (x) => (x * 100).toFixed(0) + '%';
const avg = (rs, f) => rs.reduce((s, r) => s + f(r), 0) / rs.length;

console.log('\n口径     通过   一次通过  平均尝试  平均字符  人工字符  压缩比');
for (const mode of modes) {
  const rs = rows.filter((r) => r.mode === mode);
  const pass = rs.filter((r) => r.ok).length;
  const first = rs.filter((r) => r.ok && r.tries === 1).length;
  const len = avg(rs, (r) => r.len);
  const hlen = avg(rs, (r) => r.humanLen);
  const ratio = avg(rs, (r) => r.len / r.humanLen);
  console.log(
    `${mode.padEnd(9)}${pct(pass / rs.length).padStart(5)}${pct(first / rs.length).padStart(10)}${avg(rs, (r) => r.tries).toFixed(1).padStart(10)}${len.toFixed(0).padStart(10)}${hlen.toFixed(0).padStart(10)}${(ratio.toFixed(2) + '×').padStart(9)}`
  );
}

const fails = rows.filter((r) => !r.ok);
if (fails.length) {
  console.log('\n失败样本：');
  for (const r of fails.slice(0, 8)) {
    const why = r.missing.length ? `缺 ${r.missing.join(',')}` : r.errors[0]?.msg ?? `编造 ${r.fabricated.join(',')}`;
    console.log(`  ${r.mode} ${r.id}：${why}\n    ${r.draft}`);
  }
}

const out = [
  '# Distill 实测',
  '',
  `- 模型：\`${MODEL}\`，temperature 0，最多 3 次（带缺失反馈重试）`,
  `- 语料：${limit} 条；判分用人工 must_keep 作真值`,
  '',
  '| 约束口径 | 通过 | 一次通过 | 平均尝试 | 平均字符 | 人工字符 | 压缩比 |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
];
for (const mode of modes) {
  const rs = rows.filter((r) => r.mode === mode);
  const ratio = avg(rs, (r) => r.len / r.humanLen);
  out.push(
    `| ${mode} | ${pct(rs.filter((r) => r.ok).length / rs.length)} | ${pct(rs.filter((r) => r.ok && r.tries === 1).length / rs.length)} | ${avg(rs, (r) => r.tries).toFixed(1)} | ${avg(rs, (r) => r.len).toFixed(0)} | ${avg(rs, (r) => r.humanLen).toFixed(0)} | ${ratio.toFixed(2)}× |`
  );
}
out.push('');
out.push('压缩比 > 1 表示生成比人工写得更长。');
fs.writeFileSync(path.join(repo, 'loom', 'distill-report.md'), out.join('\n') + '\n', 'utf8');
console.log('\n报告：loom/distill-report.md');
