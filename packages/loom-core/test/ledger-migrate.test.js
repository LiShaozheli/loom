// 账本表结构版本：迁移要能跑、能重入、不静默降级
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteLedger, SCHEMA_VERSION } from '../src/sqlite-ledger.js';

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'loom-migrate-'));

/** 造一份「老库」：claim 表没有 session_id，user_version 停在 0 */
function legacyDb(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE claim (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, body TEXT NOT NULL, aiw TEXT NOT NULL,
      bg TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '',
      confidence TEXT NOT NULL DEFAULT 'medium', source_event TEXT,
      epoch_id TEXT NOT NULL, taint TEXT NOT NULL DEFAULT 'none',
      valid_from INTEGER NOT NULL, valid_to INTEGER, superseded_by TEXT,
      salience REAL NOT NULL DEFAULT 1, use_count INTEGER NOT NULL DEFAULT 0,
      last_used_at INTEGER, cold INTEGER NOT NULL DEFAULT 0
    );
  `);
  db.prepare('INSERT INTO claim (id,kind,body,aiw,epoch_id,valid_from) VALUES (?,?,?,?,?,?)').run(
    'old-1',
    'fact',
    '旧库里的记忆',
    '旧库里的记忆',
    'ep-1',
    1
  );
  db.close();
}

const columns = (db) =>
  db
    .prepare("SELECT name FROM pragma_table_info('claim')")
    .all()
    .map((c) => c.name);

test('新库直接建到当前版本', () => {
  const dir = tmpdir();
  const led = new SqliteLedger(path.join(dir, 'new.db'));
  try {
    assert.equal(led.schemaVersion(), SCHEMA_VERSION);
    assert.ok(columns(led.db).includes('session_id'));
  } finally {
    led.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('老库打开后自动补齐列，数据一条不丢', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'legacy.db');
  legacyDb(file);

  const led = new SqliteLedger(file);
  try {
    assert.equal(led.schemaVersion(), SCHEMA_VERSION, '版本没涨，下次打开还会重复迁移');
    assert.ok(columns(led.db).includes('session_id'), '迁移没加列');
    const row = led.get('old-1');
    assert.equal(row?.aiw, '旧库里的记忆');
    assert.equal(row?.taint, 'none');
  } finally {
    led.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('重复打开是幂等的：不重复加列、版本不变、数据还在', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'legacy.db');
  legacyDb(file);

  for (let i = 0; i < 3; i++) {
    const led = new SqliteLedger(file);
    try {
      assert.equal(led.schemaVersion(), SCHEMA_VERSION);
      assert.equal(columns(led.db).filter((c) => c === 'session_id').length, 1);
      assert.ok(led.get('old-1'));
    } finally {
      led.close();
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('库比代码新就报错，不静默降级', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'future.db');
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 5}`);
  db.close();

  try {
    assert.throws(() => new SqliteLedger(file), /比当前代码支持的/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
