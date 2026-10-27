/**
 * 热记忆：每轮固定注入的那一小块。
 *
 * 这是 mnemon 做得最对的一件事——记忆不该等模型想起来才查。
 * 但注入物必须**有界**：它能进每一轮上下文，所以字节数就是长期成本。
 *
 * 取舍：
 *   规则（红线）全进 —— 制度性记忆漏一条代价最大
 *   偏好次之
 *   事实只进最近几条 —— 旧事实靠 memory_recall 按需取
 *
 * taint 在这里第一次真正起作用：带 external / unverified 标记的内容来自外部
 * （导入的包、抓来的网页），而注入物会进**每一轮**上下文，等于把不可信来源
 * 的话放到和用户亲口说的一样高的位置。所以自动注入只吃 taint='none'，
 * 被污染的仍能被 memory_recall 显式取到——要看得见，但不该被静默相信。
 */

const isRule = (c) => c.kind === 'rule';
const isPref = (c) => c.kind === 'pref';
const isTrusted = (c) => !c.taint || c.taint === 'none';
const bytesOf = (s) => Buffer.byteLength(s, 'utf8');

/**
 * @param {{kind:string, aiw:string, title?:string, validFrom?:number, cold?:boolean, taint?:string}[]} claims
 * @param {{maxBytes?:number, maxRules?:number, maxPrefs?:number, maxFacts?:number}} [opts]
 * @returns {{text:string, counts:{rule:number,pref:number,fact:number}, bytes:number, omitted:number, tainted:number}}
 */
export function buildHotMemory(claims, opts = {}) {
  const { maxBytes = 2048, maxRules = 20, maxPrefs = 10, maxFacts = 8 } = opts;

  const usable = claims.filter((c) => c.aiw);
  const live = usable.filter((c) => !c.cold && isTrusted(c));
  // 被挡在外面的条数要报出去，否则「记忆变少了」看起来像 bug
  const tainted = usable.filter((c) => !c.cold && !isTrusted(c)).length;

  const rules = live.filter(isRule).slice(0, maxRules);
  const prefs = live.filter(isPref).slice(0, maxPrefs);
  const facts = live
    .filter((c) => !isRule(c) && !isPref(c))
    .sort((a, b) => (b.validFrom ?? 0) - (a.validFrom ?? 0))
    .slice(0, maxFacts);

  const picked = [...rules, ...prefs, ...facts];
  const lines = [];
  let used = 0;
  let omitted = 0;

  for (const c of picked) {
    const line = `- ${c.aiw}`;
    const cost = bytesOf(line) + 1;
    if (used + cost > maxBytes) {
      omitted++;
      continue;
    }
    lines.push(line);
    used += cost;
  }

  if (!lines.length) {
    return { text: '', counts: { rule: 0, pref: 0, fact: 0 }, bytes: 0, omitted: 0, tainted };
  }

  const counts = {
    rule: picked.filter(isRule).length,
    pref: picked.filter(isPref).length,
    fact: picked.length - picked.filter(isRule).length - picked.filter(isPref).length,
  };

  const hidden = omitted ? `\n（另有 ${omitted} 条未展开，需要时用 memory_recall 取）` : '';

  const text = `## LOOM 记忆（本轮自动注入）\n${lines.join('\n')}${hidden}`;
  return { text, counts, bytes: bytesOf(text), omitted, tainted };
}

/** 判断注入物是否为空（空就不必注册 section，省一点组装开销） */
export const isEmptyHot = (hot) => !hot || !hot.text;
