/**
 * 按大小轮转的日志文件。
 *
 * 起因：`~/.dsh/loom/hook-errors.log` 长到 98KB 也没人清过——因为它只会追加。
 * 单看 98KB 不大，但这个文件记的是「每一轮失败的东西」：钩子抛错、路由被拒、
 * 归档扫描失败。加了跨源拒绝日志之后，任何网页都能往它里面灌行，一天就能到几十兆，
 * 而用户真正需要的那一行会沉到几万行之后。
 *
 * 策略刻意保守：超过上限就把当前文件挤到 `.1`、旧的 `.1` 挤到 `.2`，最老的一份丢掉。
 * 只留两代——够回答「刚才为什么失败」，不会变成一个需要自己治理的目录。
 */

import fs from 'node:fs';

/** 默认上限：1MB 大约是一万行堆栈，够翻；两代一共 2MB 封顶。 */
export const LOG_LIMITS = Object.freeze({ maxBytes: 1024 * 1024, keep: 2 });

/**
 * 追加一行；写之前若会越过上限，先把历史挤一代。
 * 返回 `{ bytes, rotated }`，方便调用方在测试里断言。
 */
export function appendRotating(file, text, opts = {}) {
  const maxBytes = Number(opts.maxBytes ?? LOG_LIMITS.maxBytes);
  const keep = Number(opts.keep ?? LOG_LIMITS.keep);
  const line = String(text ?? '');
  if (!line) return { bytes: 0, rotated: false };

  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    size = 0; // 还不存在
  }

  let rotated = false;
  if (size > 0 && size + Buffer.byteLength(line) > maxBytes) {
    rotate(file, keep);
    rotated = true;
    size = 0;
  }

  fs.appendFileSync(file, line);
  return { bytes: size + Buffer.byteLength(line), rotated };
}

/** 把 `file` 挤成 `.1`，原来的 `.1` 变成 `.2`……最老的（第 keep 代）丢掉。 */
export function rotate(file, keep = LOG_LIMITS.keep) {
  for (let i = keep; i >= 1; i--) {
    const from = i === 1 ? file : `${file}.${i - 1}`;
    const to = `${file}.${i}`;
    if (!fs.existsSync(from)) continue;
    // rename 覆盖目标：Windows 上 rename 到已存在文件是允许的，不需要先删
    fs.renameSync(from, to);
  }
}
