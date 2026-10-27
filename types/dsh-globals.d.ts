// 宿主（DSH Web GUI）在 window 上塞的东西，以及面板里那个不装包就能用的 react。
// 这个文件是「脚本」而不是模块：没有 import/export，声明直接落在全局上。

interface Window {
  /** 插件加载器，client.js 靠它把自己挂上去 */
  __ModuleLoader__?: { load: (spec: unknown) => void };
  /** 宿主与插件之间的消息通道 */
  __DSH_TRANSPORT__?: { postMessage?: (msg: unknown) => void; onMessage?: (fn: (m: any) => void) => void };
  /** 首屏由服务端注入的启动信息 */
  __DSH_BOOT__?: { origin?: string; base?: string; sessionId?: string };
  /** LOOM 首屏快照（服务端注入，面板不用等一次 fetch） */
  __LOOM_SEED__?: any;
  /** LOOM 的接口令牌（服务端注入，写路由要带上） */
  __LOOM_TOKEN__?: string;
}

/** 面板用宿主提供的 react，仓库里不装它，所以这里给个自由类型 */
declare module 'react';
