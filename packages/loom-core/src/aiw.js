/**
 * AI文 编解码：三档尺寸、禁用字、别名、规则版 must_keep。
 * 注意：这里校验的是 body（正文），尾部元数据不在正文里 —— 见 SPEC §8。
 */

export const MAX = {
  title: { chars: 24, cjk: 12 },
  lite: { chars: 90, cjk: 45 },
  full: { chars: 90, cjk: 45 },
};

const BANNED = new Set('焉哉矣兮汝吾尔遂乃亦缮厘亟臻娴'.split(''));
const VAGUE = ['大概', '可能', '一些', '相关', '若干', '等等', '之类', '差不多', '大约', '什么的'];
const FULL_PUNCT = new Set('，。；：、（）「」《》！？·—…“”‘’'.split(''));
const ASCII_PUNCT = new Set('.,;:!?()[]{}<>+-=/%$"\'@#~*_|&\\'.split(''));
const ARROWS = new Set('→←↑↓↔⇒≤≥≈≠×÷'.split(''));

export const isCJK = (ch) => /\p{Script=Han}/u.test(ch);
const isLatinDigit = (ch) => /[A-Za-z0-9]/.test(ch);
export const normalize = (s) => s.normalize('NFKC').toLowerCase().replace(/\s+/g, '');

/** 尾部三元：@时间 #来源 置信。置信既接受符号，也接受「高/中/低」——人写记忆时更自然会写汉字。 */
const CONF_WORD = { '!': 'high', '?': 'medium', '~': 'low', '高': 'high', '中': 'medium', '低': 'low' };
const TAIL_RE = /@([^\s，。；、]+)(?:\s+#([^\s，。、；]+))?(?:\s*([!?~]|高|中|低))?$/;

/** 从作者格式里剥掉 `@时间 #来源 置信` —— 注入前必须做这一步 */
export function stripTail(line) {
  const text = String(line ?? '');
  const m = text.match(TAIL_RE);
  return m ? text.slice(0, m.index).trimEnd() : text;
}

/** 从作者格式里抽出尾部三元；抽不到返回 null */
export function parseTail(line) {
  const m = String(line ?? '').match(TAIL_RE);
  if (!m) return null;
  return {
    date: m[1],
    source: m[2] ?? null,
    confidence: m[3] ? CONF_WORD[m[3]] ?? null : null,
  };
}

/**
 * 校验正文。tail 不在这里查 —— 它是结构化字段，不是正文的一部分。
 * @returns {{level:'ERROR'|'WARN', code:string, msg:string}[]}
 */
export function lintBody(body, { tier = 'full' } = {}) {
  const issues = [];
  const add = (level, code, msg) => issues.push({ level, code, msg });
  const text = (body ?? '').trim();
  if (!text) {
    add('ERROR', 'B0', '空正文');
    return issues;
  }

  const limit = MAX[tier] ?? MAX.full;
  const chars = [...text].length;
  const cjk = [...text].filter(isCJK).length;
  if (chars > limit.chars) add('ERROR', 'B1', `过长：${chars} 字符（${tier} 上限 ${limit.chars}）`);
  if (cjk > limit.cjk) add('ERROR', 'B1b', `汉字过多：${cjk}（${tier} 上限 ${limit.cjk}）`);

  const banned = [...text].filter((c) => BANNED.has(c));
  if (banned.length) add('ERROR', 'B2', `禁字：${[...new Set(banned)].join('')}`);

  const marks = [...text].filter((c) => c === '。').length;
  if (marks > 1) add('ERROR', 'B3', `「。」出现 ${marks} 次：一行一断言`);
  if (marks === 1 && !text.endsWith('。')) add('ERROR', 'B3', '「。」必须在正文末尾');

  for (const w of VAGUE) if (text.includes(w)) add('WARN', 'B4', `歧义词「${w}」：压缩时最先被删的就是消歧信息`);

  const bad = new Set();
  for (const ch of text) {
    if (isCJK(ch) || isLatinDigit(ch) || /\s/.test(ch)) continue;
    if (FULL_PUNCT.has(ch) || ASCII_PUNCT.has(ch) || ARROWS.has(ch)) continue;
    bad.add(ch);
  }
  if (bad.size) add('WARN', 'B5', `非白名单符号：${[...bad].join(' ')}`);

  return issues;
}

/** 校验作者格式的一整行（正文 + 尾部）：给 lint CLI 与人工写作时用 */
export function lintLine(line, { tier = 'full' } = {}) {
  const issues = lintBody(stripTail(line), { tier });
  const tail = parseTail(line);
  if (tier !== 'title') {
    if (!tail) issues.push({ level: 'ERROR', code: 'M1', msg: '缺尾部 @时间 #来源 置信（作者格式）' });
    else {
      if (!tail.source) issues.push({ level: 'ERROR', code: 'M2', msg: '缺 #来源，无法回源' });
      if (!tail.confidence) issues.push({ level: 'WARN', code: 'M3', msg: '缺置信标 ! ? ~' });
    }
  }
  return issues;
}

/* ---------------- 别名：换编码后仍认得出同一事实 ---------------- */
export const ALIASES = {
  鉴权: ['auth'], 回滚: ['rollback'], 备份: ['backup'], 嵌套: ['nest'], 校验: ['validate'],
  超时: ['timeout'], 重试: ['retry'], 依赖: ['dep'], 文档: ['doc'], 注释: ['comment'],
  压缩: ['compress'], 存储: ['store'], 索引: ['index'], 未决: ['open'], 待办: ['todo'],
  对比: ['vs'], 大约: ['approx'], 后四位: ['后4位'],
};

const CANON = (() => {
  const m = new Map();
  for (const [zh, forms] of Object.entries(ALIASES)) {
    m.set(normalize(zh), normalize(zh));
    for (const f of forms) m.set(normalize(f), normalize(zh));
  }
  return m;
})();

/** 单位与数字写法归一：30 分钟 = 30min，5 分钟 = 5min */
const UNIT_CANON = [
  [/毫秒/g, 'ms'],
  [/分钟/g, 'min'],
  [/小时/g, 'h'],
  [/秒/g, 's'],
  [/\s+/g, ''],
];
const canonUnits = (s) => UNIT_CANON.reduce((acc, [re, to]) => acc.replace(re, to), s);

/** 事实是否被保住：逐字命中，或命中登记过的别名 */
export function factPresent(text, fact) {
  const t = canonUnits(normalize(text ?? ''));
  const f = canonUnits(normalize(fact ?? ''));
  if (t.includes(f)) return true;
  const canon = CANON.get(f);
  if (!canon) return false;
  for (const [form, c] of CANON) if (c === canon && t.includes(form)) return true;
  return false;
}

/* ---------------- 规则版 must_keep（最低保真线） ---------------- */
const TERM_RULES = [
  ['id', /[A-Za-z][A-Za-z0-9_./:-]{1,}/g],
  ['version', /\d+\.\d+(?:\.\d+)?/g],
  ['code', /\b[1-5]\d{2}\b/g],
  ['number', /\d+(?:\.\d+)?\s*(?:ms|s|秒|分钟|小时|天|周|月|年|次|行|个|条|%|px|MB|GB|KB|token)/g],
  ['date', /\d{4}-\d{2}-\d{2}|\d{1,2}\s*月\s*\d{1,2}\s*日|\d{1,2}-\d{1,2}/g],
];

export function ruleTerms(text, { max = 10 } = {}) {
  const body = stripTail(text ?? '');
  const found = [];
  const seen = new Set();
  for (const [category, re] of TERM_RULES) {
    for (const m of body.matchAll(re)) {
      const term = m[0].replace(/[./:_-]+$/, '').trim();
      if (!term || term.length < 2) continue;
      if (category === 'id' && !/[A-Z]/.test(term) && term.length < 2) continue;
      const key = normalize(term);
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ term, category });
    }
  }
  const kept = [];
  for (const t of [...found].sort((a, b) => b.term.length - a.term.length)) {
    if (kept.some((k) => normalize(k.term).includes(normalize(t.term)))) continue;
    kept.push(t);
  }
  return kept.slice(0, max);
}

/** 缩写白名单：命中原文里出现的全称即视为同一件事，不算编造 */
export const ABBREV = {
  DB: ['数据库'],
  PR: ['拉取请求', '合并请求'],
  GHA: ['GitHub Actions'],
};

/** 抽出「技术标识符」，用于编造检测。先按分隔符拆开，避免把 admin/editor/viewer 当成一个词 */
export function identifiers(text) {
  const raw = stripTail(text ?? '').match(/[A-Za-z][A-Za-z0-9_./:-]*/g) || [];
  const parts = raw.flatMap((s) => s.split('/')).map((s) => s.replace(/[./:_-]+$/, '')).filter(Boolean);
  const looksLikeId = (s) => {
    const upper = (s.match(/[A-Z]/g) || []).length;
    return (
      /^[A-Z]{2,}$/.test(s) ||           // ENOENT / JWT
      /[0-9_./-]/.test(s) ||             // path.join / X-Tenant-Id
      /^[a-z]+[A-Z]/.test(s) ||          // camelCase
      upper >= 2                          // ESLint / TypeScript / GitHub
    );
  };
  return [...new Set(parts.filter((s) => s.length >= 2 && looksLikeId(s)))];
}
/** 把中文切成 bigram；拉丁/数字整段保留，不切碎（「Kubernetes」切出的 er 会撞上「docker」） */
export function bigrams(text) {
  const raw = String(text ?? '');
  const cleaned = raw.replace(/[^\p{Script=Han}A-Za-z0-9]+/gu, ' ').trim();
  const out = new Set();
  for (const seg of cleaned.split(/\s+/)) {
    if (!seg) continue;
    if (/^[A-Za-z0-9]+$/.test(seg)) {
      out.add(seg.toLowerCase());
      continue;
    }
    const ch = [...seg];
    if (ch.length === 1) out.add(ch[0]);
    for (let i = 0; i < ch.length - 1; i++) out.add(ch[i] + ch[i + 1]);
  }
  // 嵌在中文里的拉丁串（在1Password）也要整段保留
  for (const m of raw.matchAll(/[A-Za-z0-9][A-Za-z0-9_.:-]*/g)) out.add(m[0].toLowerCase());
  return [...out].join(' ');
}
/** 内容指纹：忽略标点与空白，用于去重（「；」和「，」不算两条记忆） */
export function contentKey(text) {
  return String(text ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{Script=Han}A-Za-z0-9]/gu, '');
}