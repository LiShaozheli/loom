/**
 * 设置项的取值域。
 *
 * 为什么要把这件事从路由里搬出来：面板写配置走 `configEditor.edit`，
 * 写进去的东西会成为下一次插件启动时的入参。之前这里只校验了 dbPath
 * （因为相对路径会随 cwd 漂移），其他键原样收下——于是 hotBytes 手滑
 * 多打一个零，就是每轮往上下文里塞 400KB；render 拼错，排版静默退回默认；
 * epochDays 写成 0，时间片切分直接除零。这类错误不会当场报错，
 * 而是下一次重启才以「行为怪但没崩」的样子出现，最难查。
 *
 * 所以这里给出每个键的类型、范围、枚举值，写入前逐项校验；
 * 有一项不合规就整次写入拒绝（不留半份配置），旧的可用值原样保留。
 */

/** 每个键的规格：kind 决定怎么校验，其余字段是它的约束。 */
export const SETTING_SPECS = Object.freeze({
  budget: {
    kind: 'int',
    min: 50,
    max: 4000,
    why: '单次取回的 token 预算。下限 50 保证至少能拿到一条断言；上限 4000 是一次查回来的合理体量，再多会挤掉正在做的活。',
  },
  hot: { kind: 'bool', why: '每轮是否把热记忆注入上下文。' },
  hotBytes: {
    kind: 'int',
    min: 256,
    max: 32768,
    why: '注入上限（字节）。它进每一轮上下文，所以上限卡在 32KB——超过这个数，长期成本比遗忘的代价还高。',
  },
  protocol: { kind: 'bool', why: '是否附带使用说明。' },
  autoCapture: { kind: 'bool', why: '是否从对话里自动记录。' },
  autoCaptureLevel: {
    kind: 'enum',
    values: ['normal', 'strict'],
    why: '记录宽窄：宽松连偏好一起记，严格只认硬事实。',
  },
  epochDays: {
    kind: 'int',
    min: 1,
    max: 365,
    why: '时间片长度（天）。必须是正整数：0 会让时间片切分除零，太大则"删掉最近这段时间"变成删掉一整年。',
  },
  render: {
    kind: 'enum',
    values: ['legend', 'plain', 'xml'],
    why: '取回时的排版：带图例是给人看的原始体验，纯文字省 token，结构化是给程序读的。',
  },
  scope: { kind: 'enum', values: ['global', 'workspace'], why: '记忆存在全局还是工作区。' },
  dbPath: {
    kind: 'path',
    why: '库文件路径。只接受空串或绝对路径：相对路径会随 cwd 漂移，换一个目录就换一个库。',
  },
  memoryScope: {
    kind: 'enum',
    values: ['shared', 'session'],
    why: '默认对话共享记忆，还是各自独立。',
  },
  isolatedSessions: {
    kind: 'idList',
    maxItems: 100,
    maxLength: 200,
    why: '要单独隔离的对话 id 列表。',
  },
});

/** 面板允许改的键。顺序无关，仅用于列出。 */
export const SETTING_KEYS = Object.freeze(Object.keys(SETTING_SPECS));

/** 绝对路径：Windows 盘符、UNC、或 POSIX 根。 */
function isAbsolutePath(v) {
  return /^[A-Za-z]:[\\/]/.test(v) || v.startsWith('/') || /^\\\\[^\\]+\\/.test(v);
}

const describe = (spec) => {
  if (spec.kind === 'int') return `${spec.min}~${spec.max} 的整数`;
  if (spec.kind === 'enum') return `以下之一：${spec.values.join(' / ')}`;
  if (spec.kind === 'bool') return 'true 或 false';
  if (spec.kind === 'path') return '绝对路径（或留空用默认位置）';
  if (spec.kind === 'idList')
    return `字符串数组（最多 ${spec.maxItems} 项，每项不超过 ${spec.maxLength} 字）`;
  return '合法取值';
};

/**
 * 校验并「规范化」一个设置值：通过时返回可直接写配置的值，
 * 不通过时返回带人话的 error（面板会把这句话显示给用户）。
 */
export function normalizeSetting(key, value) {
  const spec = SETTING_SPECS[key];
  if (!spec) return { ok: false, error: `不可设置的键：${key}` };

  if (spec.kind === 'bool') {
    if (typeof value === 'boolean') return { ok: true, value };
    // 手改配置文件时常见 "true"/"false" 字符串，收下而不是让人对着报错发呆
    if (value === 'true') return { ok: true, value: true };
    if (value === 'false') return { ok: true, value: false };
    return { ok: false, error: `${key} 应该是 ${describe(spec)}，收到 ${JSON.stringify(value)}` };
  }

  if (spec.kind === 'int') {
    const n = Number(value);
    if (!Number.isFinite(n)) {
      return { ok: false, error: `${key} 应该是 ${describe(spec)}，收到 ${JSON.stringify(value)}` };
    }
    if (!Number.isInteger(n)) {
      return { ok: false, error: `${key} 必须是整数，收到 ${n}` };
    }
    if (n < spec.min || n > spec.max) {
      return { ok: false, error: `${key} 应该在 ${describe(spec)}，收到 ${n}` };
    }
    return { ok: true, value: n };
  }

  if (spec.kind === 'enum') {
    const s = String(value ?? '');
    if (!spec.values.includes(s)) {
      return { ok: false, error: `${key} 应该是 ${describe(spec)}，收到 ${JSON.stringify(value)}` };
    }
    return { ok: true, value: s };
  }

  if (spec.kind === 'path') {
    const s = String(value ?? '').trim();
    if (s !== '' && !isAbsolutePath(s)) {
      return { ok: false, error: `${key} 应该是 ${describe(spec)}，收到 ${JSON.stringify(value)}` };
    }
    return { ok: true, value: s };
  }

  if (spec.kind === 'idList') {
    if (!Array.isArray(value)) {
      return { ok: false, error: `${key} 应该是 ${describe(spec)}，收到 ${JSON.stringify(value)}` };
    }
    const out = [];
    for (const raw of value) {
      const s = String(raw ?? '').trim();
      if (!s) continue; // 空串是噪声，不是错误
      if (s.length > spec.maxLength) {
        return { ok: false, error: `${key} 里有一项超过 ${spec.maxLength} 字：${s.slice(0, 20)}…` };
      }
      if (!out.includes(s)) out.push(s); // 去重：同一个对话不必列两遍
    }
    if (out.length > spec.maxItems) {
      return { ok: false, error: `${key} 最多 ${spec.maxItems} 项，收到 ${out.length} 项` };
    }
    return { ok: true, value: out };
  }

  return { ok: false, error: `${key} 的校验规则缺失（kind=${spec.kind}）` };
}

/**
 * 把一份完整配置里「不合规的已知键」剔掉，只留能安全使用的部分。
 *
 * 为什么不是在启动时直接报错：插件启动失败会让整个记忆功能消失，
 * 而错的往往只是一个手滑的数字。剔除 + 回退到默认值，功能还在，
 * 面板上把那几个键标成默认值，用户看得见也就改得回来。
 * 未知键原样保留，避免误删别的版本的字段。
 */
export function pruneInvalid(config) {
  const src = config && typeof config === 'object' ? config : {};
  const out = {};
  const dropped = [];
  for (const [k, v] of Object.entries(src)) {
    if (!SETTING_SPECS[k]) {
      out[k] = v;
      continue;
    }
    const r = normalizeSetting(k, v);
    if (r.ok) out[k] = r.value;
    else dropped.push({ key: k, value: v, error: r.error });
  }
  return { config: out, dropped };
}

/**
 * 校验「当前配置 + 本次改动」后的整份配置。
 * 返回 ok 时 patch 是规范化后的单个键值，merged 是写回去的完整对象。
 */
export function validateChange(current, key, value) {
  const one = normalizeSetting(key, value);
  if (!one.ok) return { ok: false, error: one.error };
  const { config, dropped } = pruneInvalid(current);
  const merged = { ...config, [key]: one.value };
  return { ok: true, key, value: one.value, merged, dropped };
}
