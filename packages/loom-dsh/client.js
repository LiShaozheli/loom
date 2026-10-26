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

      const post = (pathname, payload) =>
        fetch(base + pathname, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'omit',
          body: JSON.stringify(payload),
        }).then((r) => r.json());

      const forget = (id) => {
        if (!base) return;
        if (typeof window.confirm === 'function' && !window.confirm('让这条记忆失效？（不物理删除，可回查）')) return;
        post('/loom/forget', { id, reason: '面板删除' })
          .then((r) => { if (r.ok) load(); else window.alert('删除失败：' + r.error); })
          .catch((e) => window.alert('删除失败：' + e.message));
      };

      const saveDoc = () => {
        if (!base || !docForm) return;
        post('/loom/doc-save', { id: docForm.id, title: docForm.title, body: docForm.body, tags: docForm.tags })
          .then((r) => {
            if (!r.ok) { window.alert('保存失败：' + r.error); return; }
            setDocForm(null);
            load();
          })
          .catch((e) => window.alert('保存失败：' + e.message));
      };

      const importZip = (file) => {
        if (!base || !file) return;
        file.arrayBuffer()
          .then((buf) =>
            fetch(base + '/loom/import', {
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
        fetch(base + '/loom/archive?roles=user,assistant&q=' + encodeURIComponent(text), { credentials: 'omit' })
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
              h('div', { style: C.row },
                h('span', { style: C.meta }, it.kind + ' · ' + it.id),
                h('button', { type: 'button', style: C.btn, onClick: () => forget(it.id) }, '遗忘'))))
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
        const form = docForm
          ? h('div', { style: { ...C.card, marginBottom: 12 } },
              h('div', { style: C.row },
                h('input', {
                  style: { ...C.input, flex: 1, width: 'auto' },
                  placeholder: '标题',
                  value: docForm.title,
                  onChange: (e) => setDocForm({ ...docForm, title: e.target.value }),
                }),
                h('input', {
                  style: { ...C.input, width: 100 },
                  placeholder: '标签',
                  value: docForm.tags || '',
                  onChange: (e) => setDocForm({ ...docForm, tags: e.target.value }),
                })),
              h('textarea', {
                style: { width: '100%', minHeight: 90, marginTop: 6, padding: 6, borderRadius: 6, border: '1px solid rgba(128,128,128,.35)', background: 'transparent', color: 'inherit', font: 'inherit' },
                value: docForm.body,
                onChange: (e) => setDocForm({ ...docForm, body: e.target.value }),
              }),
              h('div', { style: C.row },
                h('button', { type: 'button', style: C.btn, onClick: saveDoc }, '保存'),
                h('button', { type: 'button', style: C.btn, onClick: () => setDocForm(null) }, '取消')))
          : h('div', { style: C.row },
              h('span', { style: C.meta }, '共 ' + docs.length + ' 篇'),
              h('button', { type: 'button', style: C.btn, onClick: () => setDocForm({ title: '', body: '', tags: '' }) }, '新建文档'));

        body = h('div', null, form, docs.length
          ? docs.map((doc) => h('div', { key: doc.id, style: C.card },
              h('div', { style: C.row },
                h('span', { style: C.label }, doc.title),
                h('span', null,
                  h('button', { type: 'button', style: C.btn, onClick: () => openDoc(doc.id) },
                    docOpen === doc.id ? '收起' : '查看'),
                  h('button', {
                    type: 'button', style: { ...C.btn, marginLeft: 6 },
                    onClick: () => {
                      if (!base) return;
                      fetch(base + '/loom/doc?id=' + encodeURIComponent(doc.id), { credentials: 'omit' })
                        .then((r) => r.json())
                        .then((r) => setDocForm(r.ok ? { id: doc.id, title: r.doc.title, body: r.doc.body, tags: r.doc.tags || '' } : { title: doc.title, body: '', tags: '' }));
                    },
                  }, '编辑'))),
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
          : h('div', { style: C.empty }, '还没有项目文档。'));
      }

      if (tab === '设置') {
        const savedHint = saved ? h('div', { style: String(saved).startsWith('已保存') ? C.ok : C.err }, saved) : null;

        // 「关 / 开」两态
        const Toggle = ({ k, label, hint }) => {
          const on = !!cfg[k];
          return h('div', { style: C.settingRow },
            h('div', null,
              h('div', { style: C.label }, label),
              hint ? h('div', { style: C.meta }, hint) : null),
            h('button', {
              type: 'button',
              style: on ? C.pillOn : C.pillOff,
              onClick: () => save(k, !on),
            }, on ? '开' : '关'));
        };

        // 多选一：点一下就切，不用打字
        const Choice = ({ k, label, hint, options }) => {
          const cur = cfg[k];
          return h('div', { style: C.settingRow },
            h('div', null,
              h('div', { style: C.label }, label),
              hint ? h('div', { style: C.meta }, hint) : null),
            h('div', { style: { display: 'flex', gap: 6 } },
              options.map((o) => h('button', {
                key: o.value,
                type: 'button',
                style: cur === o.value ? C.pillOn : C.pillOff,
                onClick: () => save(k, o.value),
              }, o.label))));
        };

        // 数字：给几档常用值，也允许手填
        const Amount = ({ k, label, hint, unit, presets }) => {
          const cur = draft[k] != null ? draft[k] : (cfg[k] ?? '');
          return h('div', { style: C.settingRow },
            h('div', null,
              h('div', { style: C.label }, label),
              hint ? h('div', { style: C.meta }, hint) : null),
            h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
              h('input', {
                style: C.input, type: 'number', value: cur,
                onChange: (e) => setDraft({ ...draft, [k]: Number(e.target.value) }),
                onBlur: () => save(k, Number(draft[k] ?? cfg[k])),
              }),
              h('span', { style: C.meta }, unit),
              (presets || []).map((p) => h('button', {
                key: p, type: 'button', style: C.pillOff,
                onClick: () => { setDraft({ ...draft, [k]: p }); save(k, p); },
              }, String(p)))));
        };

        return h('div', null,
          savedHint,

          h('div', { style: C.groupTitle }, '记忆范围'),
          h(Choice, {
            k: 'memoryScope', label: '谁能看到这条记忆',
            hint: '共享：所有会话共用一份。独立：每个会话只看自己写的 + 公共的。',
            options: [{ value: 'shared', label: '共享' }, { value: 'session', label: '独立' }],
          }),
          h(Choice, {
            k: 'scope', label: '记忆存在哪',
            hint: '全局：跟着你走。工作区：只属于当前目录，换个目录就是另一份。',
            options: [{ value: 'global', label: '全局' }, { value: 'workspace', label: '工作区' }],
          }),

          h('div', { style: C.groupTitle }, '每轮注入'),
          h(Toggle, { k: 'hot', label: '每轮带上记忆', hint: '关掉后模型得自己想起来查。' }),
          h(Amount, {
            k: 'hotBytes', label: '注入上限', unit: '字节',
            hint: '它进每一轮上下文，这个数字就是长期成本。约 3 字节 = 1 个汉字。',
            presets: [1024, 2048, 4096],
          }),
          h(Toggle, { k: 'protocol', label: '带上使用说明', hint: '告诉模型什么时候该写、什么时候该查。' }),

          h('div', { style: C.groupTitle }, '自动记录'),
          h(Toggle, { k: 'autoCapture', label: '从对话里自动记', hint: '你说的事实、偏好会自己进记忆，不用特意吩咐。' }),
          h(Choice, {
            k: 'autoCaptureLevel', label: '记多宽',
            hint: '宽松：连偏好和项目习惯一起记。严格：只认端口、路径、版本这类硬事实。',
            options: [{ value: 'normal', label: '宽松' }, { value: 'strict', label: '严格' }],
          }),

          h('div', { style: C.groupTitle }, '存储'),
          h('div', { style: C.settingRow },
            h('div', null,
              h('div', { style: C.label }, '库文件路径'),
              h('div', { style: C.meta }, '留空用默认位置。换路径等于换一个空库，旧数据不会自动搬过去。')),
            h('div', { style: { display: 'flex', gap: 6 } },
              h('input', {
                style: { ...C.input, width: 190 },
                placeholder: '默认',
                value: draft.dbPath != null ? draft.dbPath : '',
                onChange: (e) => setDraft({ ...draft, dbPath: e.target.value }),
              }),
              h('button', { type: 'button', style: C.pillOff, onClick: () => save('dbPath', draft.dbPath || '') }, '保存'))),

          h('div', { style: C.groupTitle }, '高级'),
          h(Choice, {
            k: 'render', label: '取回时的排版',
            hint: '带图例：附一张符号说明。纯文字：不要符号。结构化：给程序读的。',
            options: [{ value: 'legend', label: '带图例' }, { value: 'plain', label: '纯文字' }, { value: 'xml', label: '结构化' }],
          }),
          h(Amount, {
            k: 'budget', label: '单次取回的预算', unit: 'token',
            hint: '模型主动查一次最多拿多少。',
            presets: [200, 300, 600],
          }),
          h(Amount, {
            k: 'epochDays', label: '时间片长度', unit: '天',
            hint: '删除的最小单位：删一段时间片 = 整段不可读，链仍可验。',
            presets: [7, 30],
          }),

          h('div', { style: C.groupTitle }, '备份'),
          h('div', { style: C.settingRow },
            h('div', null,
              h('div', { style: C.label }, '导出 / 导入'),
              h('div', { style: C.meta }, 'ZIP 里是记忆、文档、文档历史、关系边；不含密钥。')),
            h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
              h('button', {
                type: 'button', style: C.pillOff,
                onClick: () => { if (base) window.open(base + '/loom/export.zip', '_blank'); },
              }, '下载'),
              h('input', {
                type: 'file', accept: '.zip', style: { fontSize: 11, width: 150 },
                onChange: (e) => importZip(e.target.files && e.target.files[0]),
              }))),
          importMsg ? h('div', { style: String(importMsg).startsWith('导入完成') ? C.ok : C.err }, importMsg) : null,
          h('div', { style: C.meta }, '改动立即生效并写进配置；带 * 的项需要重启 DSH。'),
        );
      }

      return h('div', { style: C.wrap },
        head,
        tabbar,
        state.error === 'desktop-mode'
          ? h('div', { style: C.err }, '读不到宿主地址，面板只能显示离线内容。')
          : state.error
            ? h('div', { style: C.err },
                '刷新失败：' + state.error +
                '（推导地址 ' + (base || '无') + '；若持续失败，重启 DSH 后看 ~/.dsh/loom/hook-errors.log）')
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
