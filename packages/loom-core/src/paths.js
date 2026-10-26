/**
 * 作用域：这条记忆属于"我"还是"这个工作区"。
 *
 * mnemon 叫 storageScope。区别很实在：
 *   全局   —— 偏好、习惯、口头约定，跨项目都应该带着
 *   工作区 —— 这个仓库的端口、路径、约定，换项目就是噪音
 */

/**
 * @param {{scope?:'global'|'workspace', workspace?:string, home?:string, env?:string}} opts
 * @returns {{dbPath:string, scope:'global'|'workspace'}}
 */
export function resolveDbPath(opts = {}) {
  const { scope = 'global', workspace = process.cwd(), home = process.env.DSH_HOME, env } = opts;
  const base = env ?? home ?? `${workspace}/.dsh-home`;

  if (scope === 'workspace') {
    return { dbPath: `${workspace}/.loom/loom.db`, scope: 'workspace' };
  }
  return { dbPath: `${base}/loom/loom.db`, scope: 'global' };
}
