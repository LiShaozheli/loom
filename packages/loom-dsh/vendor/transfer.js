/**
 * 导出 / 导入：记忆要比模型活得久。
 *
 * 导出是可读 JSON，不是二进制私有格式——这样即使 LOOM 消失，
 * 别人也能用一段脚本读走。导入按内容指纹去重，重复导入是幂等的。
 */

import fs from 'node:fs';

export const EXPORT_VERSION = 'loom-export/v1';

const FIELDS = [
  'id',
  'kind',
  'body',
  'aiw',
  'title',
  'confidence',
  'source',
  'epochId',
  'taint',
  'validFrom',
  'validTo',
  'supersededBy',
  'salience',
  'useCount',
  'lastUsedAt',
  'cold',
];

const pick = (c) =>
  Object.fromEntries(FIELDS.map((f) => [f, c[f]]).filter(([, v]) => v !== undefined));

/**
 * @param {{active:Function, get:Function}} ledger
 * @param {{now?:number, includeSuperseded?:boolean}} [opts]
 */
export function exportBundle(ledger, opts = {}) {
  const { now = Date.now(), includeSuperseded = false } = opts;
  const claims = includeSuperseded
    ? [...ledger.active(), ...supersededOf(ledger)]
    : ledger.active();
  return {
    version: EXPORT_VERSION,
    exportedAt: new Date(now).toISOString(),
    count: claims.length,
    claims: claims.map(pick),
  };
}

function supersededOf(ledger) {
  // Ledger 只暴露 active()；没有全量接口时退化为空（不影响正常导出）
  return typeof ledger.all === 'function' ? ledger.all().filter((c) => c.validTo) : [];
}

/**
 * @param {{put:Function, get:Function}} ledger
 * @param {any} bundle
 * @param {{replace?:boolean}} [opts]
 */
export function importBundle(ledger, bundle, opts = {}) {
  if (!bundle || bundle.version !== EXPORT_VERSION) {
    throw new Error(`不认识的导出格式：${bundle?.version ?? '空'}`);
  }
  let added = 0;
  let skipped = 0;

  for (const c of bundle.claims ?? []) {
    if (!c?.id || !c?.aiw) continue;
    // 缺 taint 的条目来源不明（手工拼的包、第三方导出），按外部内容对待：
    // 照样入库、照样能被 recall 查到，但不进每轮自动注入。
    // LOOM 自己导出的条目带 taint:'none'，来回导不会被降级。
    const claim = c.taint ? c : { ...c, taint: 'external' };
    if (opts.replace) {
      // 覆盖模式：直接重放
      ledger.put(claim);
      added++;
      continue;
    }
    if (ledger.get(c.id)) {
      skipped++;
      continue;
    }
    ledger.put(claim);
    added++;
  }

  return { added, skipped, total: (bundle.claims ?? []).length };
}

/** 导出到文件 */
export function exportToFile(ledger, file, opts = {}) {
  const bundle = exportBundle(ledger, opts);
  fs.writeFileSync(file, JSON.stringify(bundle, null, 2), 'utf8');
  return bundle;
}

/** 从文件导入 */
export function importFromFile(ledger, file, opts = {}) {
  return importBundle(ledger, JSON.parse(fs.readFileSync(file, 'utf8')), opts);
}
