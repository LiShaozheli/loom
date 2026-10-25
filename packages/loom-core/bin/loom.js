#!/usr/bin/env node
/**
 * LOOM CLI
 *
 *   loom demo                 端到端：写入 → 检索 → 取回 → 冲突 → 删除
 *   loom verify               工程门禁（CI 用）
 *   loom recall "问题…"        三问：要不要查 / 查哪类 / 取多少
 *   loom gate <file.aiw>      校验作者格式
 */

import { demo, verify, recallCmd, gateFile } from './commands.js';

const [cmd, arg] = process.argv.slice(2);

switch (cmd) {
  case 'demo':
    demo();
    break;
  case 'verify':
    verify();
    break;
  case 'recall':
    recallCmd(arg ?? '上次那个方案为什么回滚？');
    break;
  case 'gate':
    if (!arg) {
      console.error('用法：loom gate <file.aiw>');
      process.exit(2);
    }
    gateFile(arg);
    break;
  default:
    console.log('用法：loom <demo|verify|recall|gate> [参数]');
    process.exit(cmd ? 2 : 0);
}
