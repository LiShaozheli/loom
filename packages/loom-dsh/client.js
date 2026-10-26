/**
 * LOOM 侧边栏面板（Client 侧）。
 *
 * 契约（读 @deepseek-ai/dsh-client-ui-sidebar 的 README 得到）：
 *   图标注册进 sidebar.panellist（list），面板主体注册进 main（keyed），两者用同一个 id 对应。
 *   id 在 main 里缺失会抛错且不改变当前选中，所以两边必须成对出现。
 *
 * 数据走宿主注册的 /loom/state 路由（webServer.register），不依赖未知的 host.call 契约。
 */

window.__ModuleLoader__.load({
  id: 'loom-memory',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const C = {
      wrap: { padding: '16px', font: 'inherit', color: 'inherit', overflow: 'auto', height: '100%' },
      h1: { fontSize: 15, fontWeight: 600, margin: '0 0 4px' },
      sub: { fontSize: 12, opacity: 0.65, margin: '0 0 14px' },
      row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 10 },
      btn: {
        fontSize: 12, padding: '4px 10px', borderRadius: 6, cursor: 'pointer',
        border: '1px solid rgba(128,128,128,.35)', background: 'transparent', color: 'inherit',
      },
      item: { padding: '8px 10px', borderRadius: 6, background: 'rgba(128,128,128,.08)', marginBottom: 6 },
      itemText: { fontSize: 13, lineHeight: 1.5, wordBreak: 'break-word' },
      meta: { fontSize: 11, opacity: 0.6, marginTop: 2 },
      empty: { fontSize: 13, opacity: 0.7, padding: '12px 0' },
      err: { fontSize: 12, color: '#d97706', padding: '8px 0' },
    };

    function Icon({ size, active }) {
      const s = size || 18;
      return h(
        'svg',
        { width: s, height: s, viewBox: '0 0 64 64', 'aria-hidden': true, style: { display: 'block' } },
        h('rect', { width: 64, height: 64, rx: 14, fill: active ? '#1e3a8a' : 'rgba(128,128,128,.25)' }),
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

    function Panel() {
      // 首屏优先用宿主注入的种子，避免"打开面板先空一下"
      const seed = (typeof window !== 'undefined' && window.__LOOM_SEED__) || null;
      const [state, setState] = React.useState({ loading: !seed, data: seed, error: null });

      const load = React.useCallback(() => {
        setState((s) => ({ ...s, loading: true, error: null }));
        fetch('/loom/state', { credentials: 'same-origin' })
          .then((r) => {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
          })
          .then((data) => setState({ loading: false, data, error: null }))
          .catch((e) => setState({ loading: false, data: null, error: e.message }));
      }, []);

      React.useEffect(() => {
        load();
      }, [load]);

      const d = state.data;
      const items = (d && d.items ? d.items : []).slice(0, 50);

      return h(
        'div',
        { style: C.wrap },
        h('div', { style: C.h1 }, 'LOOM 记忆'),
        h(
          'div',
          { style: C.sub },
          d
            ? `${d.total} 条 · ${Object.entries(d.byKind || {}).map(([k, n]) => k + ' ' + n).join(' / ') || '空'}`
            : state.loading
              ? '读取中…'
              : '没有数据'
        ),
        h(
          'div',
          { style: C.row },
          h('span', { style: { fontSize: 12, opacity: 0.6 } }, d && d.epoch ? '分片 ' + d.epoch : ''),
          h('button', { style: C.btn, onClick: load, type: 'button' }, '刷新')
        ),
        state.error
          ? h(
              'div',
              { style: C.err },
              '刷新失败：' + state.error + (d ? '（下面是上次的数据）' : ''),
              h(
                'button',
                { style: { ...C.btn, marginLeft: 8 }, onClick: () => window.location.reload(), type: 'button' },
                '重新加载页面'
              )
            )
          : null,
        d && d.hot && d.hot.bytes
          ? h(
              'div',
              { style: { ...C.item, background: 'rgba(251,191,36,.12)' } },
              h('div', { style: C.itemText }, '本轮注入 ' + d.hot.bytes + ' 字节'),
              h('div', { style: C.meta }, '规则 ' + d.hot.rule + ' · 偏好 ' + d.hot.pref + ' · 事实 ' + d.hot.fact)
            )
          : null,
        items.length
          ? items.map((it) =>
              h(
                'div',
                { key: it.id, style: C.item },
                h('div', { style: C.itemText }, it.aiw),
                h('div', { style: C.meta }, it.kind + ' · ' + it.id)
              )
            )
          : state.loading
            ? null
            : h('div', { style: C.empty }, '还没有记忆。对助手说「记住：…」即可。'),
        d && d.verify
          ? h('div', { style: C.meta }, '哈希链：' + (d.verify.ok ? '完好' : '异常') + ' · 事件 ' + d.verify.events)
          : null
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({ name: 'sidebar.panellist', id: 'loom', order: 40, label: () => 'LOOM 记忆' }, Icon)
        );
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: 'loom' }, Panel)
        );
      },
    };
  },
});
