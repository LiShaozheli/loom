#!/usr/bin/env node
/**
 * 第一问的收益核算：拿真实问题 + 应答混跑，看跳过率与误杀率。
 *
 *   node tools/admission-eval.mjs
 *
 * 判据：
 *   真实问题 → 必须「查」（误杀 = 把该查的跳过了，最贵）
 *   应答/寒暄 → 应该「不查」（这才是收益）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shouldRecall } from '../packages/loom-core/src/admission.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const qa = JSON.parse(fs.readFileSync(path.join(repo, 'aiw', 'qa.json'), 'utf8')).qa;

const ACKS = [
  '好的', '继续', '谢谢', '嗯', '收到', 'ok', '下一步', '没问题', '行', '可以',
  '好的，继续', '嗯嗯', '谢谢！', '收到，我看看', 'OK', '继续吧', '辛苦了', '明白了',
  '好', '知道了', '可以可以', '不错', '对', '就这样', '先这样', '稍等', '等我一下',
];

const IMPERATIVES = [
  '改一下这个函数', '跑一下测试', '提交代码', '删掉那行', '把日志加上', '部署到预发',
  '重跑一遍', '格式化一下', '生成一个报告', '整理下目录',
];

const QUESTIONS = qa.filter((q) => q.type !== 'a').map((q) => q.question);
const ABSTAINS = qa.filter((q) => q.type === 'a').map((q) => q.question);

const rate = (arr) => {
  const recalled = arr.filter((q) => shouldRecall(q).recall).length;
  return { total: arr.length, recalled, rate: recalled / arr.length };
};

const q1 = rate(QUESTIONS);
const q2 = rate(ABSTAINS);
const a1 = rate(ACKS);
const i1 = rate(IMPERATIVES);

const pct = (x) => (x * 100).toFixed(0) + '%';

console.log('\n输入类型            数量   触发检索   比例');
console.log(`真实问题（disc/base） ${String(q1.total).padStart(4)}   ${String(q1.recalled).padStart(6)}   ${pct(q1.rate).padStart(5)}`);
console.log(`abstain 问题          ${String(q2.total).padStart(4)}   ${String(q2.recalled).padStart(6)}   ${pct(q2.rate).padStart(5)}`);
console.log(`应答/寒暄             ${String(a1.total).padStart(4)}   ${String(a1.recalled).padStart(6)}   ${pct(a1.rate).padStart(5)}`);
console.log(`纯命令                ${String(i1.total).padStart(4)}   ${String(i1.recalled).padStart(6)}   ${pct(i1.rate).padStart(5)}`);

const missed = QUESTIONS.filter((q) => !shouldRecall(q).recall);
console.log(`\n误杀（该查却没查）：${missed.length} 条`);
for (const m of missed.slice(0, 8)) console.log(`  - ${m}`);

const over = ACKS.filter((q) => shouldRecall(q).recall);
console.log(`\n该跳过却没跳：${over.length}/${ACKS.length}`);
for (const m of over.slice(0, 5)) console.log(`  - ${m}`);

const skipped = ACKS.filter((q) => !shouldRecall(q).recall).length + IMPERATIVES.filter((q) => !shouldRecall(q).recall).length;
console.log(`\n结论：${QUESTIONS.length} 个真实问题误杀 ${missed.length} 条；应答与命令跳过 ${skipped}/${ACKS.length + IMPERATIVES.length}。`);
