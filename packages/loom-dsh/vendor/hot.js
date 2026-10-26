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
 */

const isRule = (c) => c.kind === 'rule';
const isPref = (c) => c.kind === 'pref';
const bytesOf = (s) => Buffer.byteLength(s, 'utf8');

/**
 * @param {{kind:string, aiw:string, title?:string, validFrom?:number, cold?:boolean}[]} claims
 * @param {{maxBytes?:number, maxRules?:number, maxPrefs?:number, maxFacts?:number}} [opts]
 * @returns {{text:string, counts:{rule:number,pref:number,fact:number}, bytes:number, omitted:number}}
 */
export function buildHotMemory(claims, opts = {}) {
  const { maxBytes = 2048, maxRules = 20, maxPrefs = 10, maxFacts = 8 } = opts;

  const live = claims.filter((c) => !c.cold && c.aiw);
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
    return { text: '', counts: { rule: 0, pref: 0, fact: 0 }, bytes: 0, omitted: 0 };
  }

  const counts = {
    rule: picked.filter(isRule).length,
    pref: picked.filter(isPref).length,
    fact: picked.length - picked.filter(isRule).length - picked.filter(isPref).length,
  };

  const hidden = omitted
    ? `\n（另有 ${omitted} 条未展开，需要时用 memory_recall 取）`
    : '';

  const text = `## LOOM 记忆（本轮自动注入）\n${lines.join('\n')}${hidden}`;
  return { text, counts, bytes: bytesOf(text), omitted };
}

/** 判断注入物是否为空（空就不必注册 section，省一点组装开销） */
export const isEmptyHot = (hot) => !hot || !hot.text;
