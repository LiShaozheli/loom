#!/usr/bin/env node
/**
 * LOOM CLI
 *
 *   loom demo                 端到端：写入 → 检索 → 取回 → 冲突 → 删除
 *   loom verify               工程门禁（CI 用）
 *   loom recall "问题…"        三问：要不要查 / 查哪类 / 取多少
 *   loom gate <file.aiw>      校验作者格式
 *   loom export <file>        导出可移植 JSON
 *   loom import <file>        导入（按内容指纹去重）
 *   loom decay [--apply]      遗忘扫描（默认预览）
 *   loom epochs               列出时间片
 *   loom shred <epochId>      销毁一个时间片（密钥销毁，墓碑留链）
 */

import {
  demo, verify, recallCmd, gateFile,
  exportCmd, importCmd, decayCmd, epochsCmd, shredCmd,
  exportZipCmd, importZipCmd, docRevsCmd,
} from './commands.js';

const args = process.argv.slice(2);
const [cmd, arg] = args;

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
  case 'export':
    if (!arg) {
      console.error('用法：loom export <file.json>');
      process.exit(2);
    }
    exportCmd(arg);
    break;
  case 'import':
    if (!arg) {
      console.error('用法：loom import <file.json>');
      process.exit(2);
    }
    importCmd(arg);
    break;
  case 'decay':
    decayCmd(args.includes('--apply'));
    break;
  case 'export-zip':
    if (!arg) { console.error('用法：loom export-zip <file.zip>'); process.exit(2); }
    exportZipCmd(arg);
    break;
  case 'import-zip':
    if (!arg) { console.error('用法：loom import-zip <file.zip>'); process.exit(2); }
    importZipCmd(arg);
    break;
  case 'doc-revs':
    docRevsCmd(arg);
    break;
  case 'epochs':
    epochsCmd();
    break;
  case 'shred':
    if (!arg) {
      console.error('用法：loom shred <epochId> [原因]');
      process.exit(2);
    }
    shredCmd(arg, args[2]);
    break;
  default:
    console.log('用法：loom <demo|verify|recall|gate|export|import|export-zip|import-zip|doc-revs|decay|epochs|shred> [参数]');
    process.exit(cmd ? 2 : 0);
}
