/**
 * 记忆包：把整个库打成可搬运的 ZIP。
 *
 * 为什么不只导 JSON：mnemon 的"项目档案"能导出 ZIP（含结构），
 * 而单一 JSON 装不下"版本历史 + 关系边 + 文档"这些结构。
 *
 * 包内布局：
 *   manifest.json     版本、时间、计数
 *   claims.json       全部记忆（含失效的）
 *   docs.json         全部文档
 *   doc-revs.json     文档历史版本
 *   edges.json        关系边
 */

import fs from 'node:fs';
import { makeZip, readZip } from './zip.js';

export const BUNDLE_VERSION = 'loom-bundle/v1';

/**
 * @param {any} ledger
 * @param {{now?:number}} [opts]
 */
export function exportBundle(ledger, opts = {}) {
  const now = opts.now ?? Date.now();
  const claims = ledger.allClaims();
  const docs = ledger.allDocs();
  const revs = docs.flatMap((d) => ledger.docRevisions(d.id));
  const edges = ledger.allEdges();

  const manifest = {
    version: BUNDLE_VERSION,
    exportedAt: new Date(now).toISOString(),
    counts: {
      claims: claims.length,
      docs: docs.length,
      revisions: revs.length,
      edges: edges.length,
    },
  };

  return { manifest, claims, docs, revs, edges };
}

/** 打包成 ZIP 字节 */
export function bundleToZip(bundle) {
  return makeZip([
    { name: 'manifest.json', data: JSON.stringify(bundle.manifest, null, 2) },
    { name: 'claims.json', data: JSON.stringify(bundle.claims, null, 2) },
    { name: 'docs.json', data: JSON.stringify(bundle.docs, null, 2) },
    { name: 'doc-revs.json', data: JSON.stringify(bundle.revs, null, 2) },
    { name: 'edges.json', data: JSON.stringify(bundle.edges, null, 2) },
  ]);
}

export function exportToZip(ledger, file, opts = {}) {
  const bundle = exportBundle(ledger, opts);
  fs.writeFileSync(file, bundleToZip(bundle));
  return bundle.manifest;
}

/** 从 ZIP 字节还原 bundle 对象 */
export function zipToBundle(buf) {
  const files = readZip(buf);
  const need = ['manifest.json', 'claims.json', 'docs.json'];
  for (const name of need) {
    if (!files.has(name)) throw new Error(`包里缺少 ${name}`);
  }
  const parse = (name) => (files.has(name) ? JSON.parse(files.get(name).toString('utf8')) : []);
  const manifest = JSON.parse(files.get('manifest.json').toString('utf8'));
  if (manifest.version !== BUNDLE_VERSION) throw new Error(`不认识的包版本：${manifest.version}`);
  return {
    manifest,
    claims: parse('claims.json'),
    docs: parse('docs.json'),
    revs: parse('doc-revs.json'),
    edges: parse('edges.json'),
  };
}

/**
 * 导入：默认 merge（已存在的 claim 跳过），replace 则覆盖同 id
 * @param {any} ledger
 * @param {any} bundle
 * @param {{replace?:boolean, now?:number}} [opts]
 */
export function importBundle(ledger, bundle, opts = {}) {
  const { replace = false, now = Date.now() } = opts;
  if (!bundle || bundle.manifest?.version !== BUNDLE_VERSION) {
    throw new Error(`不认识的包版本：${bundle?.manifest?.version ?? '空'}`);
  }
  const counts = { claims: 0, claimsSkipped: 0, docs: 0, edges: 0 };

  for (const c of bundle.claims ?? []) {
    if (!c?.id) continue;
    if (!replace && ledger.get(c.id)) {
      counts.claimsSkipped++;
      continue;
    }
    ledger.put(c);
    counts.claims++;
  }

  for (const d of bundle.docs ?? []) {
    if (!d?.id) continue;
    ledger.putDoc({
      id: d.id,
      title: d.title,
      body: d.body,
      tags: d.tags ?? '',
      now: d.updated_at ?? now,
    });
    counts.docs++;
  }

  for (const r of bundle.revs ?? []) {
    ledger.restoreDocRevision?.(r);
  }

  for (const e of bundle.edges ?? []) {
    if (!e.from || !e.to) continue;
    ledger.link(e.from, e.to, {
      type: e.type ?? 'semantic',
      weight: e.weight ?? 1,
      now: e.createdAt ?? now,
    });
    counts.edges++;
  }

  return counts;
}

export function importFromZip(ledger, file, opts = {}) {
  return importBundle(ledger, zipToBundle(fs.readFileSync(file)), opts);
}
