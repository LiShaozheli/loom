#!/usr/bin/env node
/**
 * 质量门禁：跑 200 题评测，守住 recall@1 不倒退。
 *
 *   node tools/quality-gate.mjs [--min 60]
 *
 * 早先的写法是在 CI 里用 inline node 解析输出，容易受引号和编码影响；
 * 放到脚本里，本地和 CI 跑的是同一段代码。
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i < 0 ? d : argv[i + 1];
};
const min = Number(arg('min', 60));

let out = '';
try {
  out = execFileSync(process.execPath, [path.join(here, 'retrieval-eval.mjs')], {
    cwd: repo,
    encoding: 'utf8',
  });
} catch (e) {
  console.error('评测跑失败了：');
  console.error(e.stdout ?? '');
  console.error(e.stderr ?? '');
  process.exit(1);
}

process.stdout.write(out);

const m = out.match(/recall@1 ([\d.]+)%/);
if (!m) {
  console.error('没能从输出里解析出 recall@1');
  process.exit(1);
}

const value = Number(m[1]);
if (value < min) {
  console.error(`recall@1 = ${value}%，低于门槛 ${min}%`);
  process.exit(1);
}

console.log(`\n质量门禁通过：recall@1 = ${value}%（门槛 ${min}%）`);
