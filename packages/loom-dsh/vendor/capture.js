/**
 * 捕获：判断一句话是不是"要记住"的请求，并粗分类。
 *
 * 为什么需要它：模型不会每句话都调 memory_write。
 * 与其指望它自觉，不如把"用户明确说了要记"这件事识别出来，剩下交给工具。
 *
 * 这里只做判定，不做改写——判定错了顶多多存一条，改写错了会污染记忆。
 */

const CAPTURE = /记住|记一下|记下|记着|别忘了|别忘|以后都|以后要|以后别|约定|我们说好|存档一下/;

const KIND_HINT = [
  ['rule', /必须|禁止|不能|不要|一律|红线|务必/],
  ['pref', /喜欢|偏好|习惯|不喜欢|倾向|希望/],
  ['proc', /步骤|流程|先.*再|顺序|怎么做/],
  ['open', /未定|待定|还没定|以后再说/],
];

/**
 * @param {string} text
 * @returns {{capture:boolean, kind:string, due:boolean, text:string, reason:string}}
 */
export function detectIntent(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { capture: false, kind: 'fact', due: false, text: '', reason: 'empty' };

  if (!CAPTURE.test(raw)) {
    return { capture: false, kind: 'fact', due: false, text: raw, reason: 'no-cue' };
  }

  const hits = KIND_HINT.filter(([, re]) => /** @type {RegExp} */ (re).test(raw)).map(([k]) => k);
  const kind = String(hits[0] ?? 'fact');

  // 「以后再说」「回头再定」这类是待办，不是事实
  const due = /以后再说|回头再|改天|下次再/.test(raw);

  return { capture: true, kind, due, text: raw, reason: 'explicit-cue' };
}

/** 去掉"记住"这类指令词，留下要记的内容本身 */
export function stripCue(text) {
  return String(text ?? '')
    .replace(/^(请|帮我|麻烦)?\s*(记住|记一下|记下|记着)\s*[:：,，]?\s*/u, '')
    .replace(/(别忘了|别忘|记住)\s*[:：,，]?\s*/u, '')
    .trim();
}
