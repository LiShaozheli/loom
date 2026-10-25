/**
 * LOOM 契约。这三个 typedef 是整套系统的窄腰：
 * 改它们等于改所有下游，所以先定死。
 */

/** @typedef {'fact'|'pref'|'rule'|'proc'|'relation'|'open'|'decision'|'opinion'} ClaimKind */
/** @typedef {'global'|'workspace'} Storage */
/** @typedef {'high'|'medium'|'low'} Confidence */
/** @typedef {'none'|'external'|'unverified'} Taint */

/**
 * @typedef {Object} Source
 * @property {string} eventId     L0 事件 id（回源指针）
 * @property {number} start
 * @property {number} end
 */

/**
 * @typedef {Object} Claim
 * @property {string} id           内容哈希，天然幂等
 * @property {ClaimKind} kind
 * @property {string} body         白话正文（审计、迁移）
 * @property {string} aiw          压缩正文 —— 不含尾部元数据
 * @property {string} title        ≤12 汉字，只做指针
 * @property {Confidence} confidence
 * @property {Source} source
 * @property {string} epochId      删除权的最小单位
 * @property {Taint} taint
 * @property {number} validFrom
 * @property {number} [validTo]
 * @property {string} [supersededBy]
 * @property {number} salience
 * @property {number} useCount
 * @property {number} [lastUsedAt]
 * @property {boolean} cold
 */

/** @typedef {'ACCEPT'|'REVISE'|'REJECT'} Verdict */
/**
 * @typedef {Object} Issue
 * @property {'ERROR'|'WARN'} level
 * @property {string} code
 * @property {string} msg
 */
/**
 * @typedef {Object} GateResult
 * @property {Verdict} verdict
 * @property {Issue[]} issues
 * @property {{term:string, from:'rule'|'model'}[]} mustKeep
 * @property {number|null} recall
 * @property {string[]} missing
 */

/**
 * token 计数器是唯一的计费口径入口：
 * chars4（宿主启发式）/ proxy（本地分词）/ api（真值）都可插。
 * @typedef {{ count(text:string): number, name: string }} TokenCounter
 */

export const CONTRACTS_VERSION = 'loom/v0';
export const CLAIM_KINDS = ['fact', 'pref', 'rule', 'proc', 'relation', 'open', 'decision', 'opinion'];
export const TIERS = ['title', 'lite', 'full'];

/** 默认计数器：与宿主同口径，方便对照 */
export const chars4Counter = Object.freeze({
  name: 'chars4',
  count: (text) => Math.ceil(text.length / 4),
});
