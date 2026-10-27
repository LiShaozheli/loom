/**
 * 渲染层：同一份证据包，按不同策略渲染。
 *
 * 实测：加一张符号表能把答对率从 75% 拉到 92%（12 题），
 * 但扩到 200 题后只有 +3pp——说明收益依赖模型与语料，必须可切换、可 A/B。
 */

const LEGEND = '符号：→ 导致；! 红线/高置信；? 未决/中置信；= 等同；@ 时间；# 来源；vs 对比。';

const ID = (claimId) => String(claimId ?? '').slice(0, 8);

/** @param {{items?:any[], pointers?:any[], usedTokens?:number, conflicts?:any[]}} bundle */
function lines(bundle) {
  const items = bundle.items ?? [];
  const pointers = bundle.pointers ?? [];
  return { items, pointers };
}

export function renderLegend(bundle) {
  const { items, pointers } = lines(bundle);
  if (!items.length && !pointers.length) return '';
  const out = [LEGEND];
  for (const it of items)
    out.push(`- ${it.text} [#${ID(it.claimId)}${it.level === 'title' ? ' 仅标题' : ''}]`);
  for (const p of pointers) out.push(`- （指针）${p.title}`);
  return out.join('\n');
}

export function renderPlain(bundle) {
  const { items, pointers } = lines(bundle);
  if (!items.length && !pointers.length) return '';
  const out = [];
  for (const it of items) out.push(`${out.length + 1}. ${it.text}`);
  for (const p of pointers) out.push(`${out.length + 1}. ${p.title}（仅标题，需要时可展开）`);
  return out.join('\n');
}

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export function renderXml(bundle) {
  const { items, pointers } = lines(bundle);
  if (!items.length && !pointers.length) return '';
  const parts = ['<memory>'];
  for (const it of items)
    parts.push(
      `  <item id="${esc(ID(it.claimId))}" level="${esc(it.level)}">${esc(it.text)}</item>`
    );
  for (const p of pointers) parts.push(`  <pointer>${esc(p.title)}</pointer>`);
  parts.push('</memory>');
  return parts.join('\n');
}

export const POLICIES = { legend: renderLegend, plain: renderPlain, xml: renderXml };

/**
 * @param {any} bundle
 * @param {{policy?:'legend'|'plain'|'xml'}} [opts]
 */
export function render(bundle, opts = {}) {
  const { policy = 'legend' } = opts;
  const fn = POLICIES[policy];
  if (!fn) throw new Error(`未知渲染策略：${policy}（可选 ${Object.keys(POLICIES).join('/')}）`);
  return fn(bundle);
}
