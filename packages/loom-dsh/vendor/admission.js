/**
 * 第一问：要不要查？
 *
 * 现在所有记忆插件都是"每轮必查"。省下的不是 token，是整轮检索——
 * 一句「好的，继续」不值得跑一次 FTS + 一次预算分配。
 *
 * 判据只用规则和小信号，不调模型：这一问必须比省下的那点工作在量级上更便宜。
 */

const ACK = /^(好|好的|行|可以|嗯+|哦|收到|谢谢|多谢|ok|okay|继续|下一步|开始吧|没问题)[。！!.~]*$/i;
const GREET = /^(你好|hi|hello|在吗|早上好|晚上好)[。！!~]*$/i;
const CUE = /之前|上次|上回|当时|我们说|我说过|记得|那个方案|那时候|以前|前面提过/;
const QUESTION = /[?？]|什么|怎么|为什么|哪|谁|多少|是不是|能不能|有没有|如何/;
const IMPERATIVE = /^(把|帮|给|改|写|实现|修复|跑|执行|加|删|部署|提交|重跑|生成|整理|格式化)/;

/**
 * @param {string} query
 * @param {{alreadyRecalledThisTurn?: boolean, recentQueries?: string[]}} [ctx]
 * @returns {{recall:boolean, reason:string, confidence:'high'|'medium'|'low'}}
 */
export function shouldRecall(query, ctx = {}) {
  const q = String(query ?? '').trim();
  if (!q) return { recall: false, reason: 'empty', confidence: 'high' };

  if (ACK.test(q)) return { recall: false, reason: 'acknowledgement', confidence: 'high' };
  if (GREET.test(q)) return { recall: false, reason: 'greeting', confidence: 'high' };

  // 明确的记忆线索 → 一定查
  if (CUE.test(q)) return { recall: true, reason: 'memory-cue', confidence: 'high' };

  // 这一轮已经查过，且只是短追问 → 不重复查
  if (ctx.alreadyRecalledThisTurn && q.length <= 8 && !QUESTION.test(q)) {
    return { recall: false, reason: 'already-recalled-this-turn', confidence: 'medium' };
  }

  // 提问 → 查；纯命令且无线索 → 不查（命令通常自带上下文）
  if (QUESTION.test(q)) return { recall: true, reason: 'question', confidence: 'medium' };
  if (IMPERATIVE.test(q)) return { recall: false, reason: 'imperative-no-cue', confidence: 'medium' };

  // 其余默认查：真实用户最常见的查询就是「预发端口」这种名词短语，
  // 按长度一刀切会把它们全部漏掉（2026-10-26 实测踩到过）。
  return { recall: true, reason: 'default', confidence: 'low' };
}
