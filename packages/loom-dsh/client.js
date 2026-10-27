/**
 * LOOM 侧边栏面板（Client 侧）。
 *
 * 契约（读 @deepseek-ai/dsh-client-ui-sidebar 的 README 得到）：
 *   图标注册进 sidebar.panellist（list），面板主体注册进 main（keyed），同一个 id 对应。
 *   两边必须成对出现：id 在 main 里缺失时选中会抛错。
 *
 * 数据：页面可能跑在 dsh-app:// 上，绝对不能用相对路径——从 __DSH_TRANSPORT__ 推导宿主 origin。
 * 写入：设置走 POST /loom/config，会话隔离走 POST /loom/isolate，都由宿主用 configEditor 持久化。
 *
 * 样式：一份注入的 CSS（.lm-*）+ 少量内联。颜色全走宿主主题变量，
 * 所以亮色/暗色跟随宿主，不需要自己做两套。内联样式做不到 hover/focus，
 * 而设置界面好不好用一半靠这两样。
 */

window.__ModuleLoader__.load({
  id: 'loom-memory',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    // ---- 样式表 ----
    const CSS = `
.lm{--lm-fg1:var(--dsw-alias-label-primary,#1a1a1a);--lm-fg2:var(--dsw-alias-label-secondary,#555);--lm-fg3:var(--dsw-alias-label-tertiary,#8a8a8a);
--lm-bg1:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.72));--lm-bg2:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.10));
--lm-bd1:var(--dsw-alias-border-l1,rgba(127,127,127,.22));--lm-bd2:var(--dsw-alias-border-l2,rgba(127,127,127,.42));
--lm-brand:var(--dsw-alias-brand-primary,#2563eb);--lm-ok:var(--dsw-alias-state-success-primary,#16a34a);
--lm-warn:var(--dsw-alias-state-warn-primary,#d97706);--lm-err:var(--dsw-alias-state-error-primary,#dc2626);
--lm-fill:var(--dsw-specific-sidebar-fill,var(--dsw-alias-bg-base,transparent));
container-type:inline-size;
display:flex;flex-direction:column;height:100%;box-sizing:border-box;overflow-y:auto;overflow-x:hidden;
font:inherit;font-size:13px;line-height:1.5;color:var(--lm-fg1);-webkit-font-smoothing:antialiased}
.lm::-webkit-scrollbar{width:9px}.lm::-webkit-scrollbar-thumb{background:var(--lm-bd1);border-radius:9px;border:2px solid transparent;background-clip:content-box}
.lm::-webkit-scrollbar-thumb:hover{background:var(--lm-bd2);background-clip:content-box}
.lm-top{position:sticky;top:0;z-index:3;background:var(--lm-fill);padding:14px 14px 10px;border-bottom:1px solid var(--lm-bd1)}
.lm-title{display:flex;align-items:center;justify-content:space-between;gap:8px}
.lm-title h1{margin:0;font-size:13.5px;font-weight:600;letter-spacing:.2px}
.lm-sub{margin-top:2px;font-size:11px;color:var(--lm-fg3);font-variant-numeric:tabular-nums}
.lm-tabs{display:flex;gap:2px;margin-top:10px;padding:2px;border-radius:9px;background:var(--lm-bg2);border:1px solid var(--lm-bd1)}
.lm-tabs button{flex:1;min-width:0;border:0;background:transparent;color:var(--lm-fg2);font:inherit;font-size:11.5px;
padding:4px 2px;border-radius:7px;cursor:pointer;transition:color .12s,background .12s;white-space:nowrap}
.lm-tabs button:hover{color:var(--lm-fg1)}
.lm-tabs button.on{background:var(--lm-bg1);color:var(--lm-fg1);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.10)}
.lm-body{padding:12px 14px 20px;display:flex;flex-direction:column;gap:10px}
.lm-group{margin-top:6px}
.lm-group>h2{margin:0 0 6px;font-size:10.5px;font-weight:600;letter-spacing:.09em;color:var(--lm-fg3);text-transform:uppercase}
.lm-card{border:1px solid var(--lm-bd1);border-radius:10px;background:var(--lm-bg1);overflow:hidden}
.lm-card.pad{padding:10px 12px}
.lm-row{display:grid;grid-template-columns:minmax(0,1fr) auto;column-gap:10px;row-gap:8px;
align-items:start;padding:11px 12px}
.lm-row+.lm-row{border-top:1px solid var(--lm-bd1)}
.lm-row .txt{min-width:0}
.lm-row.wide{grid-template-columns:minmax(0,1fr)}
.lm-row.wide .lm-ctl{grid-column:1/-1;justify-content:flex-start}
.lm-lab{font-size:12.5px;font-weight:500}
.lm-hint{margin-top:3px;font-size:11.5px;line-height:1.5;color:var(--lm-fg3)}
.lm-ctl{display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end;min-width:0}
.lm-seg{display:inline-flex;padding:2px;gap:2px;border-radius:8px;background:var(--lm-bg2);border:1px solid var(--lm-bd1)}
.lm-seg button{border:0;background:transparent;color:var(--lm-fg2);font:inherit;font-size:11.5px;padding:3px 9px;border-radius:6px;cursor:pointer;
transition:color .12s,background .12s;white-space:nowrap}
.lm-seg button:hover{color:var(--lm-fg1)}
.lm-seg button.on{background:var(--lm-bg1);color:var(--lm-brand);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.10)}
.lm-sw{position:relative;flex:0 0 auto;width:38px;height:21px;padding:0;border-radius:999px;border:1px solid var(--lm-bd2);
background:var(--lm-bg2);cursor:pointer;transition:background .16s,border-color .16s}
.lm-sw i{position:absolute;top:2px;left:2px;width:15px;height:15px;border-radius:50%;background:var(--lm-fg3);transition:left .16s,background .16s}
.lm-sw.on{background:var(--lm-brand);border-color:transparent}
.lm-sw.on i{left:20px;background:#fff}
.lm-sw:focus-visible{outline:2px solid var(--lm-brand);outline-offset:2px}
.lm-selectwrap{position:relative;flex:1 1 150px;min-width:0}
.lm-selectwrap::after{content:'';position:absolute;right:11px;top:50%;width:5px;height:5px;pointer-events:none;
border-right:1.6px solid var(--lm-fg3);border-bottom:1.6px solid var(--lm-fg3);transform:translateY(-70%) rotate(45deg)}
.lm-select{appearance:none;-webkit-appearance:none;width:100%;box-sizing:border-box;font:inherit;font-size:12px;padding:6px 26px 6px 9px;
border-radius:8px;border:1px solid var(--lm-bd1);background:var(--lm-bg1);color:var(--lm-fg1);cursor:pointer}
.lm-select:hover{border-color:var(--lm-bd2)}
.lm-select:focus{outline:none;border-color:var(--lm-brand);box-shadow:0 0 0 3px rgba(37,99,235,.14)}
.lm-btn{font:inherit;font-size:11.5px;padding:5px 11px;border-radius:7px;border:1px solid var(--lm-bd1);
background:var(--lm-bg2);color:var(--lm-fg1);cursor:pointer;transition:background .12s,border-color .12s;white-space:nowrap}
.lm-btn:hover{background:var(--lm-bg1);border-color:var(--lm-bd2)}
.lm-btn.pri{background:var(--lm-brand);border-color:transparent;color:#fff;font-weight:500}
.lm-btn.pri:hover{filter:brightness(1.08)}
.lm-btn:disabled{opacity:.45;cursor:not-allowed}
.lm-sw:disabled,.lm-seg button:disabled{opacity:.45;cursor:not-allowed}
.lm-btn.mini{padding:3px 7px;font-size:11px}
.lm-in{width:100%;box-sizing:border-box;font:inherit;font-size:12px;padding:6px 9px;border-radius:8px;
border:1px solid var(--lm-bd1);background:var(--lm-bg1);color:var(--lm-fg1)}
.lm-in:focus{outline:none;border-color:var(--lm-brand);box-shadow:0 0 0 3px rgba(37,99,235,.14)}
textarea.lm-in{min-height:96px;resize:vertical;line-height:1.55}
.lm-chips{display:flex;flex-direction:column;gap:6px;padding:0 12px 12px}
.lm-chip{display:flex;align-items:center;gap:8px;border:1px solid var(--lm-bd1);background:var(--lm-bg2);
border-radius:8px;padding:6px 6px 6px 10px;min-width:0}
.lm-chip .nm{flex:1;min-width:0;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lm-chip .id{font-size:10px;color:var(--lm-fg3);font-variant-numeric:tabular-nums}
.lm-chip .x{border:0;background:transparent;color:var(--lm-fg3);font:inherit;font-size:14px;line-height:1;
cursor:pointer;padding:0 5px;border-radius:5px}
.lm-chip .x:hover{color:var(--lm-err);background:var(--lm-bg1)}
.lm-tag{display:inline-block;font-size:10px;padding:1px 6px;border-radius:999px;border:1px solid var(--lm-bd1);
color:var(--lm-fg3);white-space:nowrap}
.lm-tag.now{color:var(--lm-brand);border-color:var(--lm-brand)}
.lm-badge{font-size:10px;padding:1px 6px;border-radius:5px;background:var(--lm-bg2);color:var(--lm-fg2);white-space:nowrap}
.lm-stat{display:flex;gap:8px}
.lm-stat>div{flex:1;border:1px solid var(--lm-bd1);border-radius:10px;background:var(--lm-bg1);padding:9px 11px}
.lm-stat .n{font-size:18px;font-weight:600;line-height:1.15;font-variant-numeric:tabular-nums}
.lm-stat .k{font-size:10.5px;color:var(--lm-fg3)}
.lm-meter{height:5px;border-radius:999px;background:var(--lm-bg2);overflow:hidden;margin-top:7px}
.lm-meter i{display:block;height:100%;border-radius:999px;background:var(--lm-brand);transition:width .25s}
.lm-kv{display:flex;justify-content:space-between;gap:10px;font-size:11.5px;padding:3px 0}
.lm-kv .k{color:var(--lm-fg3)}
.lm-kv .v{font-variant-numeric:tabular-nums;text-align:right}
.lm-text{font-size:12.5px;line-height:1.6;word-break:break-word;white-space:pre-wrap}
.lm-meta{font-size:10.5px;color:var(--lm-fg3);font-variant-numeric:tabular-nums}
.lm-note{font-size:11.5px;padding:7px 10px;border-radius:8px;border:1px solid var(--lm-bd1);background:var(--lm-bg2)}
.lm-note.ok{color:var(--lm-ok);border-color:var(--lm-ok)}
.lm-note.err{color:var(--lm-err);border-color:var(--lm-err)}
.lm-note.warn{color:var(--lm-warn);border-color:var(--lm-warn)}
.lm-empty{padding:18px 4px;text-align:center;font-size:12px;color:var(--lm-fg3);line-height:1.7}
.lm-foot{font-size:10.5px;color:var(--lm-fg3);line-height:1.6;padding-top:2px}
.lm-anchor{scroll-margin-top:64px}

/* ---- 设置页 ---- */
/* 控件级保存反馈：每次改动就在控件旁边留一个 1.8s 的小标记，而不是顶部飘一条 */
.lm-flash{display:inline-flex;align-items:center;gap:4px;font-size:10.5px;line-height:1;white-space:nowrap;font-variant-numeric:tabular-nums}
.lm-flash .d{width:5px;height:5px;border-radius:50%;background:currentColor;flex:0 0 auto}
.lm-flash.saving{color:var(--lm-fg3)}
.lm-flash.ok{color:var(--lm-ok)}
.lm-flash.err{color:var(--lm-err)}
@keyframes lm-pulse{0%,100%{opacity:.3}50%{opacity:1}}
.lm-flash.saving .d{animation:lm-pulse .9s ease-in-out infinite}
/* 数字输入：单位贴在框内，预设做成 chip，当前值高亮 */
.lm-field{display:inline-flex;align-items:center;gap:2px;border:1px solid var(--lm-bd1);border-radius:8px;
background:var(--lm-bg1);padding:0 8px;transition:border-color .12s,box-shadow .12s}
.lm-field:hover{border-color:var(--lm-bd2)}
.lm-field:focus-within{border-color:var(--lm-brand);box-shadow:0 0 0 3px rgba(37,99,235,.14)}
.lm-field input{width:54px;border:0;background:transparent;color:inherit;font:inherit;font-size:12px;
padding:6px 0;text-align:right;font-variant-numeric:tabular-nums;appearance:textfield;-moz-appearance:textfield}
.lm-field input::-webkit-outer-spin-button,.lm-field input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
.lm-field input:focus{outline:none}
.lm-field .u{font-size:11px;color:var(--lm-fg3);padding-left:2px}
.lm-picks{display:flex;gap:4px;flex-wrap:wrap}
.lm-pick{font:inherit;font-size:11px;padding:3px 9px;border-radius:999px;border:1px solid var(--lm-bd1);
background:transparent;color:var(--lm-fg2);cursor:pointer;font-variant-numeric:tabular-nums;transition:all .12s}
.lm-pick:hover{color:var(--lm-fg1);border-color:var(--lm-bd2)}
.lm-pick.on{background:var(--lm-brand);border-color:transparent;color:#fff;font-weight:600}
/* 卡片内的子分区标题（例如「单独指定的对话 · 3 个」） */
.lm-sect{display:flex;align-items:baseline;justify-content:space-between;gap:8px;
padding:11px 12px 7px;border-top:1px solid var(--lm-bd1)}
.lm-sect .t{font-size:11px;font-weight:600;letter-spacing:.06em;color:var(--lm-fg2)}
.lm-info{font-size:11.5px;line-height:1.5;color:var(--lm-fg2);background:var(--lm-bg2);
border-radius:8px;padding:7px 10px;margin:0 12px 10px}
/* 骨架屏：设置页首屏读配置时别闪一片空卡片 */
.lm-skel{height:12px;border-radius:6px;margin:10px 12px;
background:linear-gradient(90deg,var(--lm-bg2) 25%,var(--lm-bd1) 37%,var(--lm-bg2) 63%);
background-size:400% 100%;animation:lm-shimmer 1.3s ease-in-out infinite}
.lm-skel.s{width:38%}.lm-skel.m{width:66%}
@keyframes lm-shimmer{from{background-position:100% 0}to{background-position:-100% 0}}
/* 统一的键盘焦点环：内联样式做不到，这也是当初把样式抽出来的原因 */
.lm-btn:focus-visible,.lm-tabs button:focus-visible,.lm-sw:focus-visible,.lm-seg button:focus-visible,
.lm-pick:focus-visible,.lm-chip .x:focus-visible,.lm-select:focus-visible,.lm-in:focus-visible{
outline:2px solid var(--lm-brand);outline-offset:2px}
/* 窄侧栏：标签和控件上下排，别横向挤成两行 */
@container (max-width:320px){
.lm-row{grid-template-columns:minmax(0,1fr)}
.lm-ctl{grid-column:1/-1;justify-content:flex-start}
}
@media (prefers-reduced-motion:reduce){
.lm *{animation:none!important;transition:none!important}
}
`;

    /** 注入样式；拿不到 document（Node 里跑契约测试）就静默跳过 */
    function insertCss(css) {
      try {
        if (typeof document === 'undefined' || !document.head) return () => {};
        const el = document.createElement('style');
        el.setAttribute('data-loom-panel', '1');
        el.textContent = css;
        document.head.appendChild(el);
        return () => {
          try {
            el.remove();
          } catch {
            /* 卸载时文档可能已经没了 */
          }
        };
      } catch {
        return () => {};
      }
    }

    /** 从传输层推导宿主地址：键名叫 streamBaseUrl 这种，猜不完，所以取所有字符串值 */
    function hostOrigin() {
      const pick = [];
      const t = window.__DSH_TRANSPORT__;
      if (typeof t === 'string') pick.push(t);
      if (t && typeof t === 'object') {
        for (const k of Object.keys(t)) if (typeof t[k] === 'string') pick.push(t[k]);
      }
      const boot = window.__DSH_BOOT__;
      if (boot && typeof boot === 'object') {
        for (const k of ['origin', 'url', 'baseUrl', 'host'])
          if (typeof boot[k] === 'string') pick.push(boot[k]);
      }
      for (const raw of pick) {
        try {
          const u = new URL(raw, location.href);
          if (u.protocol === 'http:' || u.protocol === 'https:') return u.origin;
          if (u.protocol === 'ws:') return 'http://' + u.host;
          if (u.protocol === 'wss:') return 'https://' + u.host;
        } catch {}
      }
      return /^https?:$/.test(location.protocol) ? location.origin : null;
    }

    /**
     * 面板数据的访问令牌：宿主把它注入页面（与 __LOOM_SEED__ 一起）。
     * 没拿到也不致命——同源请求服务端会直接放行；只有 dsh-app:// 这类
     * 跨源页面才必须靠它。
     */
    function loomToken() {
      try {
        return (typeof window !== 'undefined' && window.__LOOM_TOKEN__) || '';
      } catch {
        return '';
      }
    }

    /** 所有 /loom/* 请求都走这里，统一带令牌，免得漏掉某一条 */
    function api(url, opts = {}) {
      const headers = { ...(opts.headers || {}) };
      const t = loomToken();
      if (t) headers['x-loom-token'] = t;
      return fetch(url, { ...opts, headers });
    }

    /** 当前页 URL 里往往带着会话 id；带上就能在下拉框里预选「就是这个对话」 */
    function currentSessionId(ids) {
      try {
        const href = String((typeof location !== 'undefined' && location.href) || '');
        if (!href) return null;
        let best = null;
        for (const id of ids) {
          if (!id) continue;
          if (href.includes(id) && (!best || id.length > best.length)) best = id;
        }
        return best;
      } catch {
        return null;
      }
    }

    const KIND_LABEL = {
      rule: '规则',
      pref: '偏好',
      fact: '事实',
      proc: '流程',
      relation: '关系',
      decision: '决定',
      open: '待办',
    };

    const TABS = ['状态', '记忆', '归档', '文档', '设置'];

    function Icon({ size, active }) {
      const s = size || 18;
      return h(
        'svg',
        {
          width: s,
          height: s,
          viewBox: '0 0 64 64',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('rect', {
          width: 64,
          height: 64,
          rx: 14,
          fill: active ? '#1e3a8a' : 'rgba(128,128,128,.25)',
        }),
        h(
          'g',
          { stroke: active ? '#e0e7ff' : 'currentColor', strokeWidth: 3, strokeLinecap: 'round' },
          h('line', { x1: 16, y1: 14, x2: 16, y2: 50 }),
          h('line', { x1: 26, y1: 14, x2: 26, y2: 50 }),
          h('line', { x1: 36, y1: 14, x2: 36, y2: 50 }),
          h('line', { x1: 46, y1: 14, x2: 46, y2: 50 })
        ),
        h(
          'g',
          { stroke: '#fbbf24', strokeWidth: 4, strokeLinecap: 'round' },
          h('line', { x1: 12, y1: 24, x2: 52, y2: 24 }),
          h('line', { x1: 12, y1: 40, x2: 52, y2: 40 })
        )
      );
    }

    // ---- 基础控件 ----

    /** 一行设置：左边说人话，右边是控件。k 用来把 label 与控件绑成 aria-labelledby */
    function Row({ k, label, hint, children, wide }) {
      return h(
        'div',
        { className: 'lm-row' + (wide ? ' wide' : '') },
        h(
          'div',
          { className: 'txt' },
          h('div', { className: 'lm-lab', id: k ? 'lm-lab-' + k : undefined }, label),
          hint ? h('div', { className: 'lm-hint' }, hint) : null
        ),
        h('div', { className: 'lm-ctl' }, children)
      );
    }

    /** 分组：一个标题 + 一张卡 */
    function Group({ title, children }) {
      return h('section', { className: 'lm-group' }, h('h2', null, title), children);
    }

    /** 多选一：radiogroup 语义 + 左右键切换，键盘能完整操作，焦点跟着走 */
    function Seg({ value, options, onChange, labelId, disabled }) {
      const box = React.useRef ? React.useRef(null) : { current: null };
      const step = (dir) => {
        const i = options.findIndex((o) => o.value === value);
        const n = (i + dir + options.length) % options.length;
        onChange(options[n].value);
        const btns = box.current ? box.current.querySelectorAll('button') : [];
        if (btns[n]) btns[n].focus();
      };
      const onKeyDown = (e) => {
        if (disabled) return;
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          e.preventDefault();
          step(1);
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          e.preventDefault();
          step(-1);
        }
      };
      return h(
        'div',
        {
          className: 'lm-seg',
          role: 'radiogroup',
          'aria-labelledby': labelId,
          'aria-disabled': disabled || undefined,
          onKeyDown,
          ref: box,
        },
        options.map((o) =>
          h(
            'button',
            {
              key: o.value,
              type: 'button',
              role: 'radio',
              'aria-checked': value === o.value,
              disabled: !!disabled,
              className: value === o.value ? 'on' : '',
              onClick: () => onChange(o.value),
            },
            o.label
          )
        )
      );
    }

    /** 开关。role=switch 比 aria-pressed 更准确：读屏播报的是「开 / 关」而不是「按下」 */
    function Switch({ on, onChange, labelId, disabled }) {
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': on,
          'aria-labelledby': labelId,
          disabled: !!disabled,
          className: 'lm-sw' + (on ? ' on' : ''),
          title: on ? '已开启，点一下关闭' : '已关闭，点一下开启',
          onClick: () => onChange(!on),
        },
        h('i')
      );
    }

    /** 控件级保存状态：保存中 / 已保存 / 失败，1.8s 后自己消失 */
    function Flash({ k, flash }) {
      const f = flash && flash[k];
      if (!f) return null;
      return h(
        'span',
        { className: 'lm-flash ' + f.state, role: 'status' },
        h('span', { className: 'd' }),
        f.msg || (f.state === 'saving' ? '保存中' : '已保存')
      );
    }

    function Panel() {
      const seed = (typeof window !== 'undefined' && window.__LOOM_SEED__) || null;
      const [state, setState] = React.useState({ loading: !seed, data: seed, error: null });
      const [tab, setTab] = React.useState('状态');
      const [draft, setDraft] = React.useState({});
      const [saved, setSaved] = React.useState(null);
      const [q, setQ] = React.useState('');
      const [hits, setHits] = React.useState(null);
      const [docOpen, setDocOpen] = React.useState(null);
      const [docView, setDocView] = React.useState(null);
      const [docForm, setDocForm] = React.useState(null);
      const [importMsg, setImportMsg] = React.useState(null);
      // 设置页的对话下拉：sessions 是宿主里所有对话，pick 是当前下拉选中的那个
      const [sessions, setSessions] = React.useState(null);
      const [sessErr, setSessErr] = React.useState(null);
      const [pick, setPick] = React.useState('');
      // 每个设置项自己的保存状态：{ key -> { state: 'saving'|'ok'|'err', msg } }
      const [flash, setFlash] = React.useState({});
      const flashTimers = React.useRef ? React.useRef({}) : { current: {} };
      const fileRef = React.useRef ? React.useRef(null) : { current: null };
      const base = hostOrigin();

      const load = React.useCallback(() => {
        if (!base) {
          setState({ loading: false, data: seed, error: 'desktop-mode' });
          return;
        }
        setState((s) => ({ ...s, loading: true, error: null }));
        api(base + '/loom/state', { credentials: 'omit' })
          .then((r) => {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
          })
          .then((data) => setState({ loading: false, data, error: null }))
          .catch((e) => setState({ loading: false, data: seed, error: e.message }));
      }, [base, seed]);

      const loadSessions = React.useCallback(() => {
        if (!base) return;
        setSessErr(null);
        api(base + '/loom/sessions', { credentials: 'omit' })
          .then((r) => r.json())
          .then((r) => {
            if (!r.ok) throw new Error(r.error || 'HTTP');
            const list = r.sessions || [];
            setSessions(list);
            // 默认选中「当前这个对话」，省得人再去一长串里找自己
            const now = currentSessionId(list.map((s) => s.id));
            if (now) setPick((cur) => cur || now);
          })
          .catch((e) => setSessErr(e.message));
      }, [base]);

      React.useEffect(() => {
        load();
      }, [load]);
      React.useEffect(() => {
        if (tab === '设置') loadSessions();
      }, [tab, loadSessions]);

      const post = (pathname, payload) =>
        api(base + pathname, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'omit',
          body: JSON.stringify(payload),
        }).then((r) => r.json());

      const forget = (id) => {
        if (!base) return;
        if (
          typeof window.confirm === 'function' &&
          !window.confirm('让这条记忆失效？（不物理删除，可回查）')
        )
          return;
        post('/loom/forget', { id, reason: '面板删除' })
          .then((r) => {
            if (r.ok) load();
            else window.alert('删除失败：' + r.error);
          })
          .catch((e) => window.alert('删除失败：' + e.message));
      };

      const saveDoc = () => {
        if (!base || !docForm) return;
        post('/loom/doc-save', {
          id: docForm.id,
          title: docForm.title,
          body: docForm.body,
          tags: docForm.tags,
        })
          .then((r) => {
            if (!r.ok) {
              window.alert('保存失败：' + r.error);
              return;
            }
            setDocForm(null);
            load();
          })
          .catch((e) => window.alert('保存失败：' + e.message));
      };

      const importZip = (file) => {
        if (!base || !file) return;
        // 导入会覆盖同 id 的记录，属于不可撤销操作，先确认
        if (
          typeof window.confirm === 'function' &&
          !window.confirm('把「' + file.name + '」合并进当前库？相同 id 的记忆会被覆盖。')
        )
          return;
        file
          .arrayBuffer()
          .then((buf) =>
            api(base + '/loom/import', {
              method: 'POST',
              headers: { 'content-type': 'application/octet-stream' },
              credentials: 'omit',
              body: buf,
            })
          )
          .then((r) => r.json())
          .then((r) => {
            setImportMsg(r.ok ? '导入完成：' + JSON.stringify(r.counts) : '导入失败：' + r.error);
            if (r.ok) load();
          })
          .catch((e) => setImportMsg('导入失败：' + e.message));
      };

      const openDoc = (id) => {
        if (!base) return;
        if (docOpen === id) {
          setDocOpen(null);
          setDocView(null);
          return;
        }
        setDocOpen(id);
        setDocView({ loading: true });
        api(base + '/loom/doc?id=' + encodeURIComponent(id), { credentials: 'omit' })
          .then((r) => r.json())
          .then((r) => setDocView(r.ok ? r : { error: r.error }))
          .catch((e) => setDocView({ error: e.message }));
      };

      const search = (word) => {
        if (!base) return;
        const text = String(word ?? '').trim();
        if (!text) {
          setHits(null);
          return;
        }
        api(base + '/loom/archive?roles=user,assistant&q=' + encodeURIComponent(text), {
          credentials: 'omit',
        })
          .then((r) => r.json())
          .then((r) => setHits(r.hits || []))
          .catch(() => setHits([]));
      };

      /** 把某一项的保存状态挂到控件旁边，1.8s 后自动消失 */
      const markSaved = (key, phase, msg) => {
        setFlash((cur) => ({ ...cur, [key]: { state: phase, msg } }));
        const t = flashTimers.current;
        clearTimeout(t[key]);
        if (state === 'saving') return;
        t[key] = setTimeout(() => {
          setFlash((cur) => {
            if (!cur[key] || cur[key].state === 'saving') return cur;
            const next = { ...cur };
            delete next[key];
            return next;
          });
        }, 1800);
      };

      const save = (key, value) => {
        if (!base) {
          setSaved('没有连上宿主，设置改不了');
          return;
        }
        markSaved(key, 'saving');
        api(base + '/loom/config', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'omit',
          body: JSON.stringify({ key, value }),
        })
          .then((r) => r.json())
          .then((r) => {
            if (r.ok) {
              markSaved(key, 'ok', '已保存');
              load();
            } else {
              markSaved(key, 'err', '保存失败');
              setSaved('保存失败：' + r.error);
            }
          })
          .catch((e) => {
            markSaved(key, 'err', '保存失败');
            setSaved('保存失败：' + e.message);
          });
      };

      /** 把一个对话加进 / 移出独立记忆名单 */
      const isolate = (id, on) => {
        if (!base) return;
        const sid = String(id ?? '').trim();
        if (!sid) return;
        setSaved(null);
        post('/loom/isolate', { id: sid, isolated: on })
          .then((r) => {
            if (!r.ok) {
              setSaved('保存失败：' + r.error);
              return;
            }
            setSaved(
              on
                ? '已把「' + nameOf(sid) + '」设为独立记忆'
                : '「' + nameOf(sid) + '」已回到共享记忆'
            );
            if (on) setPick('');
            load();
            loadSessions();
          })
          .catch((e) => setSaved('保存失败：' + e.message));
      };

      const d = state.data;
      const cfg = (d && d.config) || {};
      const allSessions = sessions || [];
      const nameOf = (id) => {
        const hit = allSessions.find((s) => s.id === id);
        return hit ? hit.title : id.slice(0, 8);
      };

      // 当前对话：URL 里带了哪个 id 就是哪个
      const nowId = currentSessionId(allSessions.map((s) => s.id));
      const isolatedIds = (cfg.isolatedSessions || []).slice();
      const isolatedRows = isolatedIds.map((id) => {
        const hit = allSessions.find((s) => s.id === id);
        return hit || { id, title: '（宿主里找不到这个对话）', short: id.slice(0, 8), messages: 0 };
      });
      // 下拉里只放还没被指定的对话
      const pickable = allSessions.filter((s) => !isolatedIds.includes(s.id));

      const head = h(
        'div',
        { className: 'lm-top' },
        h(
          'div',
          { className: 'lm-title' },
          h('h1', null, 'LOOM 记忆'),
          h(
            'button',
            { type: 'button', className: 'lm-btn mini', onClick: load, title: '重新读取' },
            '刷新'
          )
        ),
        h(
          'div',
          { className: 'lm-sub' },
          d
            ? (d.total || 0) +
                ' 条记忆 · ' +
                (d.archived || 0) +
                ' 条原文 · ' +
                ((d.docs && d.docs.length) || 0) +
                ' 篇文档'
            : state.loading
              ? '读取中…'
              : '没有数据'
        ),
        h(
          'div',
          { className: 'lm-tabs', role: 'tablist' },
          TABS.map((name) =>
            h(
              'button',
              {
                key: name,
                type: 'button',
                role: 'tab',
                className: tab === name ? 'on' : '',
                onClick: () => setTab(name),
              },
              name
            )
          )
        )
      );

      let body = null;

      if (tab === '状态') {
        const hot = (d && d.hot) || { bytes: 0, rule: 0, pref: 0, fact: 0 };
        const cap = Number(cfg.hotBytes || 0) || 1;
        const pct = Math.min(100, Math.round((Number(hot.bytes || 0) / cap) * 100));
        const isolated = isolateSummary(cfg);
        body = h(
          'div',
          { className: 'lm-body' },
          h(
            'div',
            { className: 'lm-stat' },
            h(
              'div',
              null,
              h('div', { className: 'n' }, String((d && d.total) || 0)),
              h('div', { className: 'k' }, '条记忆')
            ),
            h(
              'div',
              null,
              h('div', { className: 'n' }, String((d && d.archived) || 0)),
              h('div', { className: 'k' }, '条原文归档')
            )
          ),

          h(
            'div',
            { className: 'lm-card pad' },
            h(
              'div',
              { className: 'lm-kv' },
              h('span', { className: 'k' }, '本轮注入'),
              h('span', { className: 'v' }, hot.bytes + ' / ' + cap + ' 字节')
            ),
            h('div', { className: 'lm-meter' }, h('i', { style: { width: pct + '%' } })),
            h(
              'div',
              { className: 'lm-meta', style: { marginTop: 6 } },
              '规则 ' + hot.rule + ' · 偏好 ' + hot.pref + ' · 事实 ' + hot.fact
            )
          ),

          h(
            'div',
            { className: 'lm-card pad' },
            h(
              'div',
              { className: 'lm-kv' },
              h('span', { className: 'k' }, '编年层'),
              h('span', { className: 'v' }, String((d && d.epoch) || '—'))
            ),
            h(
              'div',
              { className: 'lm-kv' },
              h('span', { className: 'k' }, '哈希链'),
              h(
                'span',
                {
                  className: 'v',
                  style: { color: d && d.verify && d.verify.ok ? 'var(--lm-ok)' : 'var(--lm-err)' },
                },
                d && d.verify && d.verify.ok ? '完好' : '异常'
              )
            ),
            h(
              'div',
              { className: 'lm-kv' },
              h('span', { className: 'k' }, '事件总数'),
              h('span', { className: 'v' }, String((d && d.verify && d.verify.events) || 0))
            )
          ),

          h(
            'div',
            { className: 'lm-card pad' },
            h(
              'div',
              { className: 'lm-kv' },
              h('span', { className: 'k' }, '自动记录'),
              h(
                'span',
                { className: 'v' },
                cfg.autoCapture
                  ? '开（' + (cfg.autoCaptureLevel === 'strict' ? '严格' : '宽松') + '）'
                  : '关'
              )
            ),
            h(
              'div',
              { className: 'lm-kv' },
              h('span', { className: 'k' }, '记忆范围'),
              h('span', { className: 'v' }, isolated)
            )
          ),

          d && d.recent && d.recent.length
            ? h(
                'div',
                null,
                h('div', { className: 'lm-group' }, h('h2', null, '最近的原文')),
                d.recent
                  .slice(0, 6)
                  .map((m, i) =>
                    h(
                      'div',
                      { key: i, className: 'lm-card pad', style: { marginBottom: 6 } },
                      h('div', { className: 'lm-meta' }, m.role === 'user' ? '你' : '模型'),
                      h(
                        'div',
                        { className: 'lm-text', style: { marginTop: 2 } },
                        String(m.text || '').slice(0, 160) +
                          (String(m.text || '').length > 160 ? '…' : '')
                      )
                    )
                  )
              )
            : null
        );
      }

      if (tab === '记忆') {
        const items = (d && d.items) || [];
        body = h(
          'div',
          { className: 'lm-body' },
          h(
            'div',
            { className: 'lm-meta' },
            isolatedIds.length
              ? '下面是全部记忆（管理视图）。召回时按「记忆范围」过滤。'
              : '每条都能单独遗忘；遗忘不是删除，原文和链还在。'
          ),
          items.length
            ? items.map((it) =>
                h(
                  'div',
                  { key: it.id, className: 'lm-card pad' },
                  h(
                    'div',
                    {
                      style: {
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        marginBottom: 5,
                        flexWrap: 'wrap',
                      },
                    },
                    h('span', { className: 'lm-badge' }, KIND_LABEL[it.kind] || it.kind),
                    h('span', { className: 'lm-meta' }, it.id)
                  ),
                  h('div', { className: 'lm-text' }, it.aiw),
                  h(
                    'div',
                    { style: { display: 'flex', justifyContent: 'flex-end', marginTop: 6 } },
                    h(
                      'button',
                      { type: 'button', className: 'lm-btn mini', onClick: () => forget(it.id) },
                      '遗忘'
                    )
                  )
                )
              )
            : h(
                'div',
                { className: 'lm-empty' },
                '还没有记忆。',
                h('br'),
                '说「记住：…」或直接陈述事实即可。'
              )
        );
      }

      if (tab === '归档') {
        const list = hits || (d && d.recent) || [];
        body = h(
          'div',
          { className: 'lm-body' },
          h(
            'div',
            { style: { display: 'flex', gap: 6 } },
            h('input', {
              className: 'lm-in',
              placeholder: '在原文里搜…',
              value: q,
              onChange: (e) => setQ(e.target.value),
              onKeyDown: (e) => {
                if (e.key === 'Enter') search(q);
              },
            }),
            h('button', { type: 'button', className: 'lm-btn', onClick: () => search(q) }, '搜索')
          ),
          h(
            'div',
            { className: 'lm-meta' },
            '原文逐条保存，含寒暄与粘贴；共 ' +
              ((d && d.archived) || 0) +
              ' 条' +
              (hits ? ' · 命中 ' + hits.length + ' 条' : '')
          ),
          list.length
            ? list.map((m, i) =>
                h(
                  'div',
                  { key: i, className: 'lm-card pad' },
                  h('div', { className: 'lm-meta' }, m.role === 'user' ? '你' : '模型'),
                  h('div', { className: 'lm-text' }, m.text)
                )
              )
            : h('div', { className: 'lm-empty' }, q ? '没有匹配的原文。' : '还没有归档。')
        );
      }

      if (tab === '文档') {
        const docs = (d && d.docs) || [];
        const form = docForm
          ? h(
              'div',
              {
                className: 'lm-card pad',
                style: { display: 'flex', flexDirection: 'column', gap: 6 },
              },
              h('input', {
                className: 'lm-in',
                placeholder: '标题',
                value: docForm.title,
                onChange: (e) => setDocForm({ ...docForm, title: e.target.value }),
              }),
              h('input', {
                className: 'lm-in',
                placeholder: '标签（可空）',
                value: docForm.tags || '',
                onChange: (e) => setDocForm({ ...docForm, tags: e.target.value }),
              }),
              h('textarea', {
                className: 'lm-in',
                placeholder: '正文',
                value: docForm.body,
                onChange: (e) => setDocForm({ ...docForm, body: e.target.value }),
              }),
              h(
                'div',
                { style: { display: 'flex', gap: 6, justifyContent: 'flex-end' } },
                h(
                  'button',
                  { type: 'button', className: 'lm-btn', onClick: () => setDocForm(null) },
                  '取消'
                ),
                h('button', { type: 'button', className: 'lm-btn pri', onClick: saveDoc }, '保存')
              )
            )
          : h(
              'div',
              {
                style: {
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 8,
                },
              },
              h('span', { className: 'lm-meta' }, '共 ' + docs.length + ' 篇'),
              h(
                'button',
                {
                  type: 'button',
                  className: 'lm-btn',
                  onClick: () => setDocForm({ title: '', body: '', tags: '' }),
                },
                '新建文档'
              )
            );

        body = h(
          'div',
          { className: 'lm-body' },
          form,
          docs.length
            ? docs.map((doc) =>
                h(
                  'div',
                  { key: doc.id, className: 'lm-card pad' },
                  h(
                    'div',
                    {
                      style: {
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 8,
                      },
                    },
                    h('span', { className: 'lm-lab', style: { flex: 1, minWidth: 0 } }, doc.title),
                    h(
                      'span',
                      { style: { display: 'flex', gap: 4, flex: '0 0 auto' } },
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'lm-btn mini',
                          onClick: () => openDoc(doc.id),
                        },
                        docOpen === doc.id ? '收起' : '查看'
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'lm-btn mini',
                          onClick: () => {
                            if (!base) return;
                            api(base + '/loom/doc?id=' + encodeURIComponent(doc.id), {
                              credentials: 'omit',
                            })
                              .then((r) => r.json())
                              .then((r) =>
                                setDocForm(
                                  r.ok
                                    ? {
                                        id: doc.id,
                                        title: r.doc.title,
                                        body: r.doc.body,
                                        tags: r.doc.tags || '',
                                      }
                                    : { title: doc.title, body: '', tags: '' }
                                )
                              );
                          },
                        },
                        '编辑'
                      )
                    )
                  ),
                  doc.tags || ''
                    ? h('div', { className: 'lm-meta', style: { marginTop: 3 } }, doc.tags)
                    : null,
                  docOpen === doc.id && docView
                    ? docView.loading
                      ? h('div', { className: 'lm-meta', style: { marginTop: 6 } }, '读取中…')
                      : docView.error
                        ? h(
                            'div',
                            { className: 'lm-note err', style: { marginTop: 6 } },
                            '读取失败：' + docView.error
                          )
                        : h(
                            'div',
                            null,
                            h(
                              'div',
                              { className: 'lm-text', style: { marginTop: 8 } },
                              (docView.doc && docView.doc.body) || ''
                            ),
                            (docView.revs || []).length > 1
                              ? h(
                                  'div',
                                  { style: { marginTop: 10 } },
                                  h(
                                    'div',
                                    { className: 'lm-meta' },
                                    '历史版本（' + docView.revs.length + '）'
                                  ),
                                  docView.revs
                                    .slice(1)
                                    .map((r) =>
                                      h(
                                        'div',
                                        {
                                          key: r.rev,
                                          className: 'lm-card pad',
                                          style: { marginTop: 6, background: 'transparent' },
                                        },
                                        h(
                                          'div',
                                          { className: 'lm-meta' },
                                          'v' + r.rev + ' · ' + new Date(r.at).toLocaleString()
                                        ),
                                        h('div', { className: 'lm-text' }, r.body)
                                      )
                                    )
                                )
                              : null
                          )
                    : null
                )
              )
            : h('div', { className: 'lm-empty' }, '还没有项目文档。')
        );
      }

      if (tab === '设置') {
        // 「开 / 关」——点一下就是开，不需要知道 true/false 怎么写
        const Toggle = ({ k, label, hint }) =>
          h(
            Row,
            { k, label, hint },
            h(Switch, { on: !!cfg[k], labelId: 'lm-lab-' + k, onChange: (v) => save(k, v) }),
            h(Flash, { k, flash })
          );

        // 多选一：点一下就切，不用打字
        const Choice = ({ k, label, hint, options, disabled }) =>
          h(
            Row,
            { k, label, hint },
            h(Seg, {
              value: cfg[k],
              options,
              labelId: 'lm-lab-' + k,
              disabled,
              onChange: (v) => save(k, v),
            }),
            h(Flash, { k, flash })
          );

        // 数字：单位在框里，常用值做成 chip，回车或失焦即保存
        const Amount = ({ k, label, hint, unit, presets, extra }) => {
          const cur = draft[k] != null ? draft[k] : (cfg[k] ?? '');
          const commit = (v) => {
            const n = Number(v);
            if (!Number.isFinite(n) || n < 0) return;
            if (n === Number(cfg[k])) return; // 没变就别写配置，免得触发一次无谓重载
            save(k, n);
          };
          return h(
            Row,
            { k, label, hint, wide: true },
            h(
              'div',
              { className: 'lm-field' },
              h('input', {
                id: 'lm-in-' + k,
                type: 'number',
                inputMode: 'numeric',
                min: 0,
                'aria-labelledby': 'lm-lab-' + k,
                value: String(cur),
                onChange: (e) => setDraft({ ...draft, [k]: e.target.value }),
                onBlur: (e) => commit(e.target.value),
                onKeyDown: (e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                },
              }),
              h('span', { className: 'u' }, unit)
            ),
            extra ? h('span', { className: 'lm-meta' }, extra) : null,
            (presets || []).length
              ? h(
                  'div',
                  { className: 'lm-picks' },
                  presets.map((p) =>
                    h(
                      'button',
                      {
                        key: p,
                        type: 'button',
                        className: 'lm-pick' + (Number(cur) === p ? ' on' : ''),
                        'aria-pressed': Number(cur) === p,
                        onClick: () => {
                          setDraft({ ...draft, [k]: String(p) });
                          save(k, p);
                        },
                      },
                      String(p)
                    )
                  )
                )
              : null,
            h(Flash, { k, flash })
          );
        };

        const note = saved
          ? h(
              'div',
              { className: 'lm-note ' + (String(saved).startsWith('已') ? 'ok' : 'err') },
              saved
            )
          : null;

        // —— 对话下拉 + 添加 ——
        const pickOptions = h(
          'option',
          { value: '' },
          pickable.length ? '选一个对话…' : '没有可选的对话'
        );
        const selectEl = h(
          'div',
          { className: 'lm-selectwrap' },
          h(
            'select',
            {
              className: 'lm-select',
              id: 'lm-pick',
              value: pick,
              disabled: !pickable.length,
              onChange: (e) => setPick(e.target.value),
              'aria-label': '选择要设为独立记忆的对话',
            },
            pickOptions,
            pickable.map((s) =>
              h(
                'option',
                { key: s.id, value: s.id },
                (s.id === nowId ? '当前 · ' : '') +
                  s.title +
                  '（' +
                  s.short +
                  '）' +
                  (s.messages ? ' · ' + s.messages + ' 条' : '')
              )
            )
          )
        );

        const picker = h(
          'div',
          { style: { display: 'flex', gap: 6, padding: '0 12px 10px', alignItems: 'center' } },
          selectEl,
          h(
            'button',
            {
              type: 'button',
              className: 'lm-btn pri',
              disabled: !pick,
              onClick: () => isolate(pick, true),
            },
            '添加'
          )
        );

        const pickerNote = sessErr
          ? h(
              'div',
              { className: 'lm-note warn', style: { margin: '0 12px 10px' } },
              '读不到对话列表（' + sessErr + '）。',
              h(
                'button',
                {
                  type: 'button',
                  className: 'lm-btn mini',
                  style: { marginLeft: 6 },
                  onClick: loadSessions,
                },
                '重试'
              )
            )
          : sessions === null
            ? h('div', { className: 'lm-skel s' })
            : pickable.length
              ? null
              : h(
                  'div',
                  { className: 'lm-meta', style: { padding: '0 12px 10px' } },
                  '所有对话都已经是独立的了。'
                );

        const chipList = isolatedRows.length
          ? h(
              'div',
              { className: 'lm-chips' },
              isolatedRows.map((s) =>
                h(
                  'div',
                  { key: s.id, className: 'lm-chip' },
                  h('span', { className: 'nm', title: s.title }, s.title),
                  h('span', { className: 'id' }, s.short || String(s.id).slice(0, 8)),
                  s.id === nowId ? h('span', { className: 'lm-tag now' }, '当前') : null,
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'x',
                      title: '移出独立记忆',
                      'aria-label': '把「' + s.title + '」移回共享记忆',
                      onClick: () => isolate(s.id, false),
                    },
                    '×'
                  )
                )
              )
            )
          : h('div', { className: 'lm-empty' }, '还没有指定。所有对话共用一份记忆。');

        const nowHint = nowId
          ? '当前对话已预选：' +
            nameOf(nowId) +
            '（' +
            nowId.slice(0, 8) +
            '）。点「添加」就把它设成独立。'
          : null;

        // 换库路径是不可逆的（等于换一个空库），所以先问一句
        const saveDbPath = () => {
          const next = String(draft.dbPath ?? '').trim();
          const cur = String(cfg.dbPath ?? '');
          if (next === cur) return;
          if (
            next &&
            typeof window.confirm === 'function' &&
            !window.confirm(
              '换库路径等于换一个空库：旧记忆不会自动搬过去（可以先用「备份」导出再导入）。确定切换？'
            )
          )
            return;
          save('dbPath', next);
        };

        const dbDraft = String(draft.dbPath != null ? draft.dbPath : (cfg.dbPath ?? ''));
        const hotBytesNow = Number(draft.hotBytes != null ? draft.hotBytes : cfg.hotBytes) || 0;

        // 配置还没读到时先给骨架屏，别闪一排「全关」的空卡片
        if (!d) {
          return h(
            'div',
            { className: 'lm-body' },
            h('div', { className: 'lm-skel s' }),
            h('div', { className: 'lm-skel' }),
            h('div', { className: 'lm-skel m' }),
            h('div', { className: 'lm-skel' }),
            h('div', { className: 'lm-skel s' })
          );
        }

        return h(
          'div',
          { className: 'lm-body' },
          note,

          h(
            Group,
            { title: '记忆范围' },
            h(
              'div',
              { className: 'lm-card' },
              h(Choice, {
                k: 'memoryScope',
                label: '没列出来的对话',
                hint: '共享：所有对话共用一份记忆。独立：每个对话只看自己写的 + 公共的。',
                options: [
                  { value: 'shared', label: '共享' },
                  { value: 'session', label: '独立' },
                ],
              }),
              h(
                'div',
                { className: 'lm-sect' },
                h('span', { className: 't' }, '单独指定的对话'),
                h('span', { className: 'lm-meta' }, isolatedRows.length + ' 个')
              ),
              nowHint ? h('div', { className: 'lm-info' }, nowHint) : null,
              picker,
              pickerNote,
              chipList
            )
          ),

          h(
            Group,
            { title: '每轮注入' },
            h(
              'div',
              { className: 'lm-card' },
              h(Toggle, { k: 'hot', label: '每轮带上记忆', hint: '关掉后模型得自己想起来查。' }),
              h(Amount, {
                k: 'hotBytes',
                label: '注入上限',
                unit: '字节',
                hint: '它进每一轮上下文，这个数字就是长期成本。',
                extra: hotBytesNow ? '≈ ' + Math.round(hotBytesNow / 3) + ' 个汉字' : null,
                presets: [1024, 2048, 4096],
              }),
              h(Toggle, {
                k: 'protocol',
                label: '带上使用说明',
                hint: '告诉模型什么时候该写、什么时候该查。',
              })
            )
          ),

          h(
            Group,
            { title: '自动记录' },
            h(
              'div',
              { className: 'lm-card' },
              h(Toggle, {
                k: 'autoCapture',
                label: '从对话里自动记',
                hint: '你说的事实、偏好会自己进记忆，不用特意吩咐。',
              }),
              h(Choice, {
                k: 'autoCaptureLevel',
                label: '记多宽',
                hint: cfg.autoCapture
                  ? '宽松：连偏好和项目习惯一起记。严格：只认端口、路径、版本这类硬事实。'
                  : '先打开上面的「从对话里自动记」。',
                disabled: !cfg.autoCapture,
                options: [
                  { value: 'normal', label: '宽松' },
                  { value: 'strict', label: '严格' },
                ],
              })
            )
          ),

          h(
            Group,
            { title: '存储' },
            h(
              'div',
              { className: 'lm-card' },
              h(Choice, {
                k: 'scope',
                label: '记忆存在哪',
                hint: '全局：跟着你走。工作区：只属于当前目录，换个目录就是另一份。',
                options: [
                  { value: 'global', label: '全局' },
                  { value: 'workspace', label: '工作区' },
                ],
              }),
              h(
                Row,
                {
                  k: 'dbPath',
                  wide: true,
                  label: '库文件路径',
                  hint: '留空用默认位置。换路径等于换一个空库，旧数据不会自动搬过去。',
                },
                h(
                  'div',
                  { style: { display: 'flex', gap: 6, alignItems: 'center', width: '100%' } },
                  h('input', {
                    className: 'lm-in',
                    id: 'lm-in-dbPath',
                    placeholder: '默认位置',
                    'aria-labelledby': 'lm-lab-dbPath',
                    value: dbDraft,
                    onChange: (e) => setDraft({ ...draft, dbPath: e.target.value }),
                    onKeyDown: (e) => {
                      if (e.key === 'Enter') saveDbPath();
                    },
                  }),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'lm-btn',
                      disabled: dbDraft === String(cfg.dbPath ?? ''),
                      onClick: saveDbPath,
                    },
                    '保存'
                  ),
                  h(Flash, { k: 'dbPath', flash })
                ),
                h(
                  'div',
                  { className: 'lm-meta', style: { marginTop: 6 } },
                  '当前生效：' + (cfg.dbPathEffective || cfg.dbPath || '默认位置')
                )
              )
            )
          ),

          h(
            Group,
            { title: '高级' },
            h(
              'div',
              { className: 'lm-card' },
              h(Choice, {
                k: 'render',
                label: '取回时的排版',
                hint: '带图例：附一张符号说明。纯文字：不要符号。结构化：给程序读的。',
                options: [
                  { value: 'legend', label: '带图例' },
                  { value: 'plain', label: '纯文字' },
                  { value: 'xml', label: '结构化' },
                ],
              }),
              h(Amount, {
                k: 'budget',
                label: '单次取回的预算',
                unit: 'token',
                hint: '模型主动查一次最多拿多少。',
                presets: [200, 300, 600],
              }),
              h(Amount, {
                k: 'epochDays',
                label: '时间片长度',
                unit: '天',
                hint: '删除的最小单位：删一段时间片 = 整段不可读，链仍可验。',
                presets: [7, 30],
              })
            )
          ),

          h(
            Group,
            { title: '备份' },
            h(
              'div',
              { className: 'lm-card' },
              h(
                Row,
                {
                  label: '导出',
                  hint: 'ZIP 里是记忆、文档、文档历史、关系边；不含密钥。',
                },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'lm-btn',
                    onClick: () => {
                      if (!base) return;
                      // window.open 带不了自定义头，所以走查询参数；服务端两种都认
                      const t = loomToken();
                      window.open(
                        base + '/loom/export.zip' + (t ? '?t=' + encodeURIComponent(t) : ''),
                        '_blank'
                      );
                    },
                  },
                  '下载 ZIP'
                )
              ),
              h(
                Row,
                {
                  label: '导入',
                  wide: true,
                  hint: '把导出的 ZIP 合并回来，相同 id 会被覆盖。',
                },
                h('input', {
                  ref: fileRef,
                  type: 'file',
                  accept: '.zip',
                  style: { display: 'none' },
                  onChange: (e) => {
                    const f = e.target.files && e.target.files[0];
                    e.target.value = '';
                    importZip(f);
                  },
                }),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'lm-btn',
                    onClick: () => {
                      if (fileRef.current) fileRef.current.click();
                    },
                  },
                  '选择 ZIP 文件'
                )
              )
            )
          ),

          importMsg
            ? h(
                'div',
                {
                  className: 'lm-note ' + (String(importMsg).startsWith('导入完成') ? 'ok' : 'err'),
                },
                importMsg
              )
            : null,
          h(
            'div',
            { className: 'lm-foot' },
            '改动立即生效并写进配置。注入类的改动要等下一轮才看得到。'
          )
        );
      }

      return h(
        'div',
        { className: 'lm' },
        head,
        state.error === 'desktop-mode'
          ? h(
              'div',
              { className: 'lm-body' },
              h('div', { className: 'lm-note warn' }, '读不到宿主地址，面板只能显示离线内容。')
            )
          : state.error
            ? h(
                'div',
                { className: 'lm-body' },
                h(
                  'div',
                  { className: 'lm-note err' },
                  '刷新失败：' + state.error + '（推导地址 ' + (base || '无') + '）',
                  h('br'),
                  '若持续失败，重启 DSH 后看 ~/.dsh/loom/hook-errors.log'
                )
              )
            : null,
        body
      );
    }

    /** 状态页那句「记忆范围」 */
    function isolateSummary(cfg) {
      const n = (cfg.isolatedSessions || []).length;
      if (cfg.memoryScope === 'session') return '全部独立' + (n ? '（另点名 ' + n + ' 个）' : '');
      return n ? '共享 + ' + n + ' 个独立对话' : '全部共享';
    }

    // 回合尾部：每轮回复下方一行，显示 LOOM 当前体量（每 30 秒最多取一次）
    let tailCache = { at: 0, data: null };

    function TurnTail() {
      const [data, setData] = React.useState(tailCache.data);
      React.useEffect(() => {
        const now = Date.now();
        if (tailCache.data && now - tailCache.at < 30000) {
          setData(tailCache.data);
          return;
        }
        const base = hostOrigin();
        if (!base) return;
        let alive = true;
        api(base + '/loom/state', { credentials: 'omit' })
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => {
            tailCache = { at: Date.now(), data: d };
            if (alive) setData(d);
          })
          .catch(() => {});
        return () => {
          alive = false;
        };
      }, []);

      if (!data) return null;
      const mem = data.total || 0;
      const arc = data.archived || 0;
      if (!mem && !arc) return null;
      return h(
        'div',
        { style: { fontSize: 11, opacity: 0.55, padding: '2px 0' } },
        'LOOM · ' + mem + ' 条记忆 · ' + arc + ' 条原文归档'
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 样式挂在 Client run 的生命周期上，插件卸了就跟着走
        const disposeCss = insertCss(CSS);
        try {
          if (typeof ctx.effect === 'function') ctx.effect(() => disposeCss);
        } catch {
          // 拿不到 effect 就算了，样式已经进去了
        }

        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: 'loom', order: 40, label: () => 'LOOM 记忆' },
            Icon
          )
        );
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'loom' }, Panel));
        ctx.slots.inject('conversation.chat.turnTail', () =>
          ctx.slots.register(
            { name: 'conversation.chat.turnTail', id: 'loom-turn', order: 90 },
            TurnTail
          )
        );
      },
    };
  },
});
