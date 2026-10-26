/**
 * LOOM 侧边栏面板（Client 侧）。
 *
 * 契约（读 @deepseek-ai/dsh-client-ui-sidebar 的 README 得到）：
 *   图标注册进 sidebar.panellist（list），面板主体注册进 main（keyed），同一个 id 对应。
 *   两边必须成对出现：id 在 main 里缺失时选中会抛错。
 *
 * 数据：页面可能跑在 dsh-app:// 上，绝对不能用相对路径——从 __DSH_TRANSPORT__ 推导宿主 origin。
 * 写入：设置走 POST /loom/config，由宿主用 configEditor 持久化到 profile patch。
 */

window.__ModuleLoader__.load({
  id: 'loom-memory',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const C = {
      wrap: { padding: '16px', font: 'inherit', color: 'inherit', overflow: 'auto', height: '100%', boxSizing: 'border-box' },
      h1: { fontSize: 15, fontWeight: 600, margin: '0 0 4px' },
      tabs: { display: 'flex', gap: 6, margin: '10px 0 12px', flexWrap: 'wrap', alignItems: 'center' },
      tab: { fontSize: 12, padding: '4px 10px', borderRadius: 6, cursor: 'pointer', border: '1px solid rgba(128,128,128,.3)', background: 'transparent', color: 'inherit' },
      tabOn: { fontSize: 12, padding: '4px 10px', borderRadius: 6, cursor: 'pointer', border: '1px solid rgba(128,128,128,.45)', background: 'rgba(37,99,235,.18)', color: 'inherit' },
      card: { padding: '10px 12px', borderRadius: 8, background: 'rgba(128,128,128,.08)', marginBottom: 8 },
      row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 },
      label: { fontSize: 13 },
      meta: { fontSize: 11, opacity: 0.6, marginTop: 3 },
      text: { fontSize: 13, lineHeight: 1.55, wordBreak: 'break-word', whiteSpace: 'pre-wrap' },
      btn: { fontSize: 12, padding: '4px 10px', borderRadius: 6, cursor: 'pointer', border: '1px solid rgba(128,128,128,.35)', background: 'transparent', color: 'inherit' },
      input: { fontSize: 12, padding: '3px 6px', borderRadius: 6, border: '1px solid rgba(128,128,128,.35)', background: 'transparent', color: 'inherit', width: 88 },
      empty: { fontSize: 13, opacity: 0.7, padding: '10px 0' },
      err: { fontSize: 12, color: '#d97706', padding: '6px 0' },
      ok: { fontSize: 12, color: '#16a34a', padding: '6px 0' },
    };

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
        for (const k of ['origin', 'url', 'baseUrl', 'host']) if (typeof boot[k] === 'string') pick.push(boot[k]);
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

    function Icon({ size, active }) {
      const s = size || 18;
      return h(
        'svg',
        { width: s, height: s, viewBox: '0 0 64 64', 'aria-hidden': true, style: { display: 'block' } },
        h('rect', { width: 64, height: 64, rx: 14, fill: active ? '#1e3a8a' : 'rgba(128,128,128,.25)' }),
        h('g', { stroke: active ? '#e0e7ff' : 'currentColor', strokeWidth: 3, strokeLinecap: 'round' },
          h('line', { x1: 16, y1: 14, x2: 16, y2: 50 }),
          h('line', { x1: 26, y1: 14, x2: 26, y2: 50 }),
          h('line', { x1: 36, y1: 14, x2: 36, y2: 50 }),
          h('line', { x1: 46, y1: 14, x2: 46, y2: 50 })),
        h('g', { stroke: '#fbbf24', strokeWidth: 4, strokeLinecap: 'round' },
          h('line', { x1: 12, y1: 24, x2: 52, y2: 24 }),
          h('line', { x1: 12, y1: 40, x2: 52, y2: 40 }))
      );
    }

    const TABS = ['状态', '记忆', '归档', '文档', '设置'];

    const BOOLS = [
      ['hot', '每轮注入热记忆'],
      ['protocol', '注入使用协议'],
      ['autoCapture', '自动从对话里记录'],
    ];
    const ENUMS = [
      ['autoCaptureLevel', '记录强度 normal / strict'],
      ['render', '取回渲染 legend / plain / xml'],
      ['scope', '作用域 global / workspace'],
    ];
    const NUMS = [
      ['hotBytes', '热记忆字节上限'],
      ['budget', '单次召回 token 预算'],
      ['epochDays', '时间片长度（天）'],
    ];

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
      const base = hostOrigin();

      const load = React.useCallback(() => {
        if (!base) {
          setState({ loading: false, data: seed, error: 'desktop-mode' });
          return;
        }
        setState((s) => ({ ...s, loading: true, error: null }));
        fetch(base + '/loom/state', { credentials: 'omit' })
          .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
          .then((data) => setState({ loading: false, data, error: null }))
          .catch((e) => setState({ loading: false, data: seed, error: e.message }));
      }, [base, seed]);

      React.useEffect(() => { load(); }, [load]);

      const openDoc = (id) => {
        if (!base) return;
        if (docOpen === id) { setDocOpen(null); setDocView(null); return; }
        setDocOpen(id);
        setDocView({ loading: true });
        fetch(base + '/loom/doc?id=' + encodeURIComponent(id), { credentials: 'omit' })
          .then((r) => r.json())
          .then((r) => setDocView(r.ok ? r : { error: r.error }))
          .catch((e) => setDocView({ error: e.message }));
      };

      const search = (word) => {
        if (!base) return;
        const text = String(word ?? '').trim();
        if (!text) { setHits(null); return; }
        fetch(base + '/loom/archive?q=' + encodeURIComponent(text), { credentials: 'omit' })
          .then((r) => r.json())
          .then((r) => setHits(r.hits || []))
          .catch(() => setHits([]));
      };

      const save = (key, value) => {
        if (!base) return;
        setSaved(null);
        fetch(base + '/loom/config', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'omit',
          body: JSON.stringify({ key, value }),
        })
          .then((r) => r.json())
          .then((r) => {
            setSaved(r.ok ? '已保存：' + key + '（部分设置需重启生效）' : '保存失败：' + r.error);
            if (r.ok) load();
          })
          .catch((e) => setSaved('保存失败：' + e.message));
      };

      const d = state.data;
      const cfg = (d && d.config) || {};

      const head = h('div', null,
        h('div', { style: C.h1 }, 'LOOM 记忆'),
        h('div', { style: C.meta },
          d
            ? (d.total || 0) + ' 条记忆 · ' + (d.archived || 0) + ' 条对话归档 · ' + ((d.docs && d.docs.length) || 0) + ' 篇文档'
            : state.loading ? '读取中…' : '没有数据')
      );

      const tabbar = h('div', { style: C.tabs },
        TABS.map((name) => h('button', {
          key: name, type: 'button',
          style: tab === name ? C.tabOn : C.tab,
          onClick: () => setTab(name),
        }, name)),
        h('button', { style: C.btn, onClick: load, type: 'button' }, '刷新')
      );

      let body = null;

      if (tab === '状态') {
        body = h('div', null,
          h('div', { style: C.card },
            h('div', { style: C.label }, '本轮注入 ' + ((d && d.hot && d.hot.bytes) || 0) + ' 字节'),
            h('div', { style: C.meta }, '规则 ' + ((d && d.hot && d.hot.rule) || 0) +
              ' · 偏好 ' + ((d && d.hot && d.hot.pref) || 0) +
              ' · 事实 ' + ((d && d.hot && d.hot.fact) || 0))),
          h('div', { style: C.card },
            h('div', { style: C.label }, '编年层'),
            h('div', { style: C.meta }, '时间片 ' + ((d && d.epoch) || '—') +
              ' · 哈希链 ' + ((d && d.verify && d.verify.ok) ? '完好' : '异常') +
              ' · 事件 ' + ((d && d.verify && d.verify.events) || 0) +
              ' · 归档 ' + ((d && d.archived) || 0))),
          h('div', { style: C.card },
            h('div', { style: C.label }, '自动记录'),
            h('div', { style: C.meta }, (cfg.autoCapture ? '开（' + cfg.autoCaptureLevel + '）' : '关') +
              ' · 作用域 ' + (cfg.scope || 'global') +
              ' · 注入上限 ' + (cfg.hotBytes || 0) + ' 字节'))
        );
      }

      if (tab === '记忆') {
        const items = (d && d.items) || [];
        body = items.length
          ? items.map((it) => h('div', { key: it.id, style: C.card },
              h('div', { style: C.text }, it.aiw),
              h('div', { style: C.meta }, it.kind + ' · ' + it.id)))
          : h('div', { style: C.empty }, '还没有记忆。说「记住：…」或直接陈述事实即可。');
      }

      if (tab === '归档') {
        const list = hits || (d && d.recent) || [];
        body = h('div', null,
          h('div', { style: C.row },
            h('input', {
              style: { ...C.input, flex: 1, width: 'auto' },
              placeholder: '在原文里搜…',
              value: q,
              onChange: (e) => setQ(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') search(q); },
            }),
            h('button', { type: 'button', style: C.btn, onClick: () => search(q) }, '搜索')),
          h('div', { style: C.meta }, '原文逐条保存，含寒暄与粘贴；共 ' + ((d && d.archived) || 0) + ' 条' +
            (hits ? ' · 命中 ' + hits.length + ' 条' : '')),
          list.length
            ? list.map((m, i) => h('div', { key: i, style: C.card },
                h('div', { style: C.meta }, m.role),
                h('div', { style: C.text }, m.text)))
            : h('div', { style: C.empty }, q ? '没有匹配的原文。' : '还没有归档。')
        );
      }

      if (tab === '文档') {
        const docs = (d && d.docs) || [];
        body = docs.length
          ? docs.map((doc) => h('div', { key: doc.id, style: C.card },
              h('div', { style: C.row },
                h('span', { style: C.label }, doc.title),
                h('button', { type: 'button', style: C.btn, onClick: () => openDoc(doc.id) },
                  docOpen === doc.id ? '收起' : '查看')),
              h('div', { style: C.meta }, ((doc.tags || '') + ' · ' + doc.id).replace(/^ · /, '')),
              docOpen === doc.id && docView
                ? docView.loading
                  ? h('div', { style: C.meta }, '读取中…')
                  : docView.error
                    ? h('div', { style: C.err }, '读取失败：' + docView.error)
                    : h('div', null,
                        h('div', { style: { ...C.text, marginTop: 8 } }, (docView.doc && docView.doc.body) || ''),
                        (docView.revs || []).length > 1
                          ? h('div', { style: { marginTop: 10 } },
                              h('div', { style: C.meta }, '历史版本（' + docView.revs.length + '）'),
                              docView.revs.slice(1).map((r) => h('div', { key: r.rev, style: { ...C.card, marginTop: 6 } },
                                h('div', { style: C.meta }, 'v' + r.rev + ' · ' + new Date(r.at).toLocaleString()),
                                h('div', { style: C.text }, r.body))))
                          : null)
                : null))
          : h('div', { style: C.empty }, '还没有项目文档。');
      }

      if (tab === '设置') {
        body = h('div', null,
          BOOLS.map(([key, label]) => h('div', { key, style: C.row },
            h('span', { style: C.label }, label),
            h('button', { type: 'button', style: C.btn, onClick: () => save(key, !cfg[key]) },
              cfg[key] ? '已开' : '已关'))),
          ENUMS.map(([key, label]) => h('div', { key, style: C.row },
            h('span', { style: C.label }, label),
            h('input', {
              style: { ...C.input, width: 120 },
              value: draft[key] != null ? draft[key] : (cfg[key] || ''),
              onChange: (e) => setDraft({ ...draft, [key]: e.target.value }),
            }),
            h('button', { type: 'button', style: C.btn, onClick: () => save(key, draft[key] != null ? draft[key] : cfg[key]) }, '保存'))),
          NUMS.map(([key, label]) => h('div', { key, style: C.row },
            h('span', { style: C.label }, label),
            h('input', {
              style: C.input, type: 'number',
              value: draft[key] != null ? draft[key] : (cfg[key] ?? ''),
              onChange: (e) => setDraft({ ...draft, [key]: Number(e.target.value) }),
            }),
            h('button', { type: 'button', style: C.btn, onClick: () => save(key, Number(draft[key] != null ? draft[key] : cfg[key])) }, '保存'))),
          saved ? h('div', { style: String(saved).startsWith('已保存') ? C.ok : C.err }, saved) : null,
          h('div', { style: C.row },
            h('span', { style: C.label }, '备份'),
            h('button', {
              type: 'button', style: C.btn,
              onClick: () => { if (base) window.open(base + '/loom/export.zip', '_blank'); },
            }, '下载记忆包 ZIP')),
          h('div', { style: C.meta }, '包含记忆、文档、文档历史与关系边；不含密钥。'),
          h('div', { style: C.meta }, '改动会写进 profile 的 loom-memory 行；部分键需要重启生效。')
        );
      }

      return h('div', { style: C.wrap },
        head,
        tabbar,
        state.error === 'desktop-mode'
          ? h('div', { style: C.err }, '读不到宿主地址，面板只能显示离线内容。')
          : state.error
            ? h('div', { style: C.err }, '刷新失败：' + state.error)
            : null,
        body
      );
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
        fetch(base + '/loom/state', { credentials: 'omit' })
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
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({ name: 'sidebar.panellist', id: 'loom', order: 40, label: () => 'LOOM 记忆' }, Icon)
        );
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'loom' }, Panel));
        ctx.slots.inject('conversation.chat.turnTail', () =>
          ctx.slots.register({ name: 'conversation.chat.turnTail', id: 'loom-turn', order: 90 }, TurnTail)
        );
      },
    };
  },
});
