#!/usr/bin/env node
/**
 * 幂等迁移：把旧版本留下的坏数据修干净。
 *
 *   node tools/migrate.mjs [--db <path>] [--dry]
 *
 * 目前只有一条：早期 memory_forget 会造一个 `tomb-xxxx` 的墓碑 claim，
 * 而墓碑一旦入库就成了"正常记忆"——出现在列表、计数和面板里。
 * 现在的 forgot 不再造墓碑（失效靠 valid_to + supersede_log + L0 事件），
 * 这里把历史遗留的补上失效标记。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

if (!dry) {
  const backup = `${dbPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(dbPath, backup);
  console.log(`备份：${backup}`);
}

const db = new SqliteLedger(dbPath);
const tombstones = db.active().filter((c) => c.id.startsWith('tomb-') || c.aiw === '（已删除）');

if (!tombstones.length) {
  console.log('没有需要清理的墓碑条目');
} else {
  for (const c of tombstones) {
    console.log(`  ${dry ? '[dry] ' : ''}失效墓碑 ${c.id.slice(0, 8)}`);
    if (!dry) db.supersede(c.id, null, '历史遗留的墓碑条目（已改为不入库）');
  }
}

db.close();
console.log(dry ? `\n[dry] 将清理 ${tombstones.length} 条` : `\n已清理 ${tombstones.length} 条`);
