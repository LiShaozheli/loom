/**
 * 自动捕获判定：从一段用户输入里挑出「值得记」的内容。
 *
 * 保守优先——宁可漏，不可脏。记忆被闲聊污染之后，
 * 注入的每一轮都在付 token，而且会误导模型。
 *
 * 判据（全部是规则，不调模型）：
 *   强线索   「记住 / 以后 / 约定 / 必须 / 不要 / 决定用」——几乎一定是记忆
 *   弱线索   含标识符或参数的断言句（端口 8081、用 pnpm、路径 …）
 *   排除     疑问句、纯指令（帮我改…）、太短、太长、纯寒暄
 */

const STRONG = /记住|记一下|记下|以后都|以后要|以后别|以后不|约定|我们说好|必须|禁止|一律|不要用|决定用|默认用/;
// strict：只认标识符与参数（旧行为）
const WEAK_STRICT = /端口|路径|版本|地址|密码|账号|用\s?[A-Za-z]|改成|换成|固定在|定在|配置/;
// normal：把"关于项目和偏好"的第一人称陈述也算进来——漏记比脏记更让人失望
const WEAK_NORMAL = /喜欢|不喜欢|习惯|偏好|希望|讨厌|受不了|一般|通常|总是|从不|这个项目|本项目|我们|我这边|我的|团队|规范|约定|风格/;
const QUESTION = /[?？]|吗|呢|怎么|如何|为什么|是不是|能不能|有没有|对不对|行不行|好不好|咋回事/;
const PURE_TASK = /^(帮|请|把|改|写|实现|修复|跑|执行|加|删|部署|提交|重跑|生成|整理|格式化|看看|检查)/;
const AFFIRM = /^(好|行|可以|嗯|收到|谢谢|继续|ok)[。！!.~]*$/i;

const KIND_HINT = [
  ['rule', /必须|禁止|不能|不要|一律|红线|务必/],
  ['pref', /喜欢|偏好|习惯|倾向|以后都|以后要/],
  ['proc', /流程|步骤|先.*再|顺序/],
  ['decision', /决定|定了|拍板|改成|换成|采用/],
];

/**
 * @param {string} text
 * @returns {{capture:boolean, kind:string, reason:string, text:string}}
 */

/**
 * 去掉宿主塞进来的运行时上下文。
 *
 * 真实会话里，user 消息常常是「用户原话 + 一大段注入内容」（时间戳、记忆快照、
 * 子代理的 checkpoint）。不剥掉它们，判定就只会看到"一坨多行长文"，
 * 于是全部判成 pasted-block / too-long——记忆一条都长不出来。
 *
 * 归档仍然存原文；这里只影响"要不要记"的判断。
 */
const RUNTIME_NOISE = [
  /^\[dsh-mnemon:/m,
  /^MNEMON RUNTIME MEMORY/m,
  /^\s*Time sampled while preparing turn/m,
  /^\s*Current runtime context\./m,
  /^\s*Tokens prefixed by @/m,
  /^\s*<runtime-memory-file/m,
  /^\s*\[MNEMON\]/m,
  /^\s*Current working directory:/m,
];

export function stripRuntimeNoise(text) {
  const raw = String(text ?? '');
  let cut = raw.length;
  for (const re of RUNTIME_NOISE) {
    const m = raw.match(re);
    if (m && m.index !== undefined && m.index < cut) cut = m.index;
  }
  return raw.slice(0, cut).trim();
}

export function pickDurable(text, { level = 'normal' } = {}) {
  const raw = String(text ?? '').trim();
  if (!raw) return { capture: false, kind: 'fact', reason: 'empty', text: '' };
  if (raw.length < 6) return { capture: false, kind: 'fact', reason: 'too-short', text: raw };
  if (raw.length > 400) return { capture: false, kind: 'fact', reason: 'too-long', text: raw };
  if (AFFIRM.test(raw)) return { capture: false, kind: 'fact', reason: 'affirmation', text: raw };

  // 粘贴块（多行）不自动记：用户贴的是日志/报错/界面文字，不是陈述
  if ((raw.match(/\n/g) || []).length >= 2) {
    return { capture: false, kind: 'fact', reason: 'pasted-block', text: raw };
  }

  // 强线索必须出现在开头：整段话中间冒出个「记住」通常是在引用别处
  const head = raw.slice(0, 20);
  const strong = STRONG.test(head) || (STRONG.test(raw) && raw.length <= 60);
  if (!strong) {
    if (QUESTION.test(raw)) return { capture: false, kind: 'fact', reason: 'question', text: raw };
    if (PURE_TASK.test(raw)) return { capture: false, kind: 'fact', reason: 'pure-task', text: raw };
    const weak = WEAK_STRICT.test(raw) || (level !== 'strict' && WEAK_NORMAL.test(raw));
    if (!weak) return { capture: false, kind: 'fact', reason: 'no-signal', text: raw };
  }

  // 即便命中强线索，整句是个问句也不记——那是在问，不是在交代
  if (QUESTION.test(raw)) return { capture: false, kind: 'fact', reason: 'question', text: raw };

  const hits = KIND_HINT.filter(([, re]) => re.test(raw)).map(([k]) => k);
  return {
    capture: true,
    kind: hits[0] ?? 'fact',
    reason: strong ? 'explicit' : 'weak-signal',
    text: raw,
  };
}
