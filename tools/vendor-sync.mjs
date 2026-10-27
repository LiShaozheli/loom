#!/usr/bin/env node
/**
 * 核心代码只有一个真身：packages/loom-core/src。
 * packages/loom-dsh/vendor 是给插件用的副本（插件不能相对引用包外文件）。
 *
 *   node tools/vendor-sync.mjs          # 把 src 覆盖到 vendor
 *   node tools/vendor-sync.mjs --check  # 只校验，漂移则退出 1（CI 用）
 *
 * 为什么要这个脚本：过去 26 个文件是手工复制的，改 src 不会影响线上，
 * 而 index.js 是从 ./vendor 里 import 的 —— 修 bug 修在不会执行的那份上，
 * 是最难发现的一类错误。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'packages', 'loom-core', 'src');
const dstDir = path.join(root, 'packages', 'loom-dsh', 'vendor');
const checkOnly = process.argv.includes('--check');

// eval-data.js 是离线评测语料，插件不需要，不进 vendor
const SKIP = new Set(['eval-data.js']);

const files = fs.readdirSync(srcDir).filter((f) => f.endsWith('.js') && !SKIP.has(f)).sort();
if (!files.length) {
  console.error('源码目录是空的：' + srcDir);
  process.exit(1);
}

const same = (a, b) => {
  try { return fs.readFileSync(a).equals(fs.readFileSync(b)); } catch { return false; }
};

const drifted = [];
for (const f of files) {
  const src = path.join(srcDir, f);
  const dst = path.join(dstDir, f);
  if (checkOnly) {
    if (!same(src, dst)) drifted.push(f);
    continue;
  }
  fs.mkdirSync(dstDir, { recursive: true });
  fs.copyFileSync(src, dst);
}

// vendor 里多出来的文件也算漂移：删了源码还留着旧副本，同样会骗人
const extra = fs.readdirSync(dstDir)
  .filter((f) => f.endsWith('.js') && !files.includes(f));

if (checkOnly) {
  if (drifted.length || extra.length) {
    if (drifted.length) console.error('vendor 与 src 不一致：\n  ' + drifted.join('\n  '));
    if (extra.length) console.error('vendor 多出（源码里已不存在）：\n  ' + extra.join('\n  '));
    console.error('\n修复：node tools/vendor-sync.mjs');
    process.exit(1);
  }
  console.log(`vendor 一致：${files.length} 个文件`);
  process.exit(0);
}

console.log(`已同步 ${files.length} 个文件 -> ${path.relative(root, dstDir)}`);
if (extra.length) console.log('注意：vendor 里多出（未删除，请人工确认）：' + extra.join(', '));
