/**
 * 评测数据的位置。
 *
 * 早先 corpus.json / qa.json 放在仓库**外面**的兄弟目录（开发时的临时布局），
 * 结果 CI 一 clone 就 ENOENT。现在优先用仓库内的 eval/，
 * 找不到再回退到旧的兄弟目录 layout，保证老工作区还能跑。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** loom 仓库根目录（本文件在 packages/loom-core/src 下） */
export const repoRoot = path.resolve(here, '../../..');

const candidates = [path.join(repoRoot, 'eval'), path.resolve(repoRoot, '..', 'aiw')];

export const evalDir =
  candidates.find((dir) => fs.existsSync(path.join(dir, 'corpus.json'))) ?? candidates[0];

export const corpusPath = path.join(evalDir, 'corpus.json');
export const qaPath = path.join(evalDir, 'qa.json');

export const hasEvalData = fs.existsSync(corpusPath) && fs.existsSync(qaPath);

/** 读语料；缺数据时抛带提示的错误，而不是 ENOENT */
export function loadCorpus() {
  if (!fs.existsSync(corpusPath)) {
    throw new Error(`找不到评测语料：${corpusPath}（需要 eval/corpus.json）`);
  }
  return JSON.parse(fs.readFileSync(corpusPath, 'utf8'));
}

export function loadQa() {
  if (!fs.existsSync(qaPath)) {
    throw new Error(`找不到评测题集：${qaPath}（需要 eval/qa.json）`);
  }
  return JSON.parse(fs.readFileSync(qaPath, 'utf8')).qa;
}
