#!/usr/bin/env node
/**
 * 去重：把「标点不同但内容相同」的重复条目合成一条。
 *
 *   node tools/dedupe.mjs [--db <path>] [--dry]
 *
 * 规则：内容指纹相同 → 保留最新的一条，其余 supersede（不删除，可回查）。
 * 默认库路径与插件一致：~/.dsh/loom/loom.db
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { contentKey, stripTail } from '../packages/loom-core/src/aiw.js';
import { SqliteLedger } from '../packages/loom-core/src/sqlite-ledger.js';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i < 0 ? d : argv[i + 1];
};

const dbPath = String(
  arg('db', path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'loom', 'loom.db'))
);
const dry = argv.includes('--dry');

if (!fs.existsSync(dbPath)) {
  console.error(`没有这个库：${dbPath}`);
  process.exit(2);
}

// 先备份，再动
if (!dry) {
  const backup = `${dbPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(dbPath, backup);
  console.log(`备份：${backup}`);
}

const ledger = new SqliteLedger(dbPath);
const active = ledger.active();

const groups = new Map();
for (const c of active) {
  const key = contentKey(stripTail(c.aiw));
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(c);
}

const dupes = [...groups.values()].filter((g) => g.length > 1);
console.log(`条目 ${active.length} 条 · 重复组 ${dupes.length} 组`);

let merged = 0;
for (const group of dupes) {
  const sorted = [...group].sort((a, b) => (b.validFrom ?? 0) - (a.validFrom ?? 0));
  const keep = sorted[0];
  for (const c of sorted.slice(1)) {
    console.log(`  ${c.id.slice(0, 8)} → 并入 ${keep.id.slice(0, 8)}：${stripTail(keep.aiw)}`);
    if (!dry) ledger.supersede(c.id, keep.id, '内容相同（仅标点差异）');
    merged++;
  }
}

ledger.close();
console.log(dry ? `\n[dry] 将合并 ${merged} 条` : `\n已合并 ${merged} 条（旧条目失效，不删除）`);
