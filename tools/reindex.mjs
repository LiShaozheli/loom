#!/usr/bin/env node
/**
 * 重建索引：bigram 分词规则变了以后，bg 列与 FTS 都要重算。
 *
 *   node tools/reindex.mjs [--db <path>] [--dry]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { bigrams } from '../packages/loom-core/src/aiw.js';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i < 0 ? d : argv[i + 1];
};
const dbPath = String(dbPathOf());
function dbPathOf() {
  return arg(
    'db',
    path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'loom', 'loom.db')
  );
}
const dry = argv.includes('--dry');

if (!fs.existsSync(dbPath)) {
  console.error(`没有这个库：${dbPath}`);
  process.exit(2);
}
if (!dry) {
  const backup = `${dbPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(dbPath, backup);
  console.log(`备份：${backup}`);
}

const db = new DatabaseSync(dbPath);
const rows = db.prepare('SELECT rowid, id, aiw, title, body FROM claim').all();
console.log(`条目 ${rows.length} 条`);

if (!dry) {
  const upd = db.prepare('UPDATE claim SET bg = ? WHERE id = ?');
  for (const r of rows) upd.run(bigrams(`${r.aiw} ${r.title}`), r.id);

  db.exec('DELETE FROM claim_fts');
  const ins = db.prepare('INSERT INTO claim_fts (rowid, aiw, bg, title) VALUES (?,?,?,?)');
  for (const r of db.prepare('SELECT rowid, aiw, bg, title FROM claim').all()) {
    ins.run(r.rowid, r.aiw, r.bg, r.title);
  }
}

db.close();
console.log(dry ? '[dry] 未改动' : '索引已重建');
