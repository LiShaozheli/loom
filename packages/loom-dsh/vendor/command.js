/**
 * /loom 命令：不开界面也能查记忆。
 *
 * 侧边栏要打包、要数据通道；斜杠命令不用——它的结果直接进对话。
 * 对一个"先把记忆用起来"的插件，这是性价比最高的一层 UI。
 */

const HELP = [
  'LOOM 记忆命令：',
  '  /loom stats     账本概况',
  '  /loom outline   按类型列出条目',
  '  /loom verify    校验哈希链',
  '  /loom hot       看本轮自动注入了什么',
  '  /loom search 词 检索（等同 memory_recall）',
].join('\n');

const pad = (n, w) => String(n).padStart(w);

/**
 * @param {string} rawInput
 * @param {{ledger:any, hot?:()=>{text:string,bytes:number,counts:any}, verify?:()=>any}} deps
 * @returns {{kind:'success'|'error', text:string}}
 */
export function runLoomCommand(rawInput, deps) {
  const { ledger, hot, verify } = deps;
  const argv = String(rawInput ?? '').trim().split(/\s+/).filter(Boolean);
  const sub = argv[0] ?? '';

  try {
    switch (sub) {
      case '':
      case 'help':
        return { kind: 'success', text: HELP };

      case 'stats': {
        const active = ledger.active();
        const byKind = {};
        for (const c of active) byKind[c.kind] = (byKind[c.kind] ?? 0) + 1;
        const rows = Object.entries(byKind)
          .sort((a, b) => b[1] - a[1])
          .map(([k, n]) => `  ${k.padEnd(10)} ${pad(n, 3)}`);
        return {
          kind: 'success',
          text: [`LOOM：${active.length} 条记忆`, ...rows].join('\n') || 'LOOM：还没有记忆',
        };
      }

      case 'outline': {
        const active = ledger.active();
        if (!active.length) return { kind: 'success', text: 'LOOM：还没有记忆' };
        const groups = new Map();
        for (const c of active) {
          if (!groups.has(c.kind)) groups.set(c.kind, []);
          groups.get(c.kind).push(c.title || c.aiw.slice(0, 16));
        }
        const lines = [];
        for (const [kind, titles] of groups) {
          lines.push(`${kind}（${titles.length}）`);
          for (const t of titles.slice(0, 5)) lines.push(`  - ${t}`);
          if (titles.length > 5) lines.push(`  …还有 ${titles.length - 5} 条`);
        }
        return { kind: 'success', text: lines.join('\n') };
      }

      case 'verify': {
        if (typeof verify !== 'function') return { kind: 'error', text: '当前环境没有编年层' };
        const v = verify();
        return {
          kind: v.ok ? 'success' : 'error',
          text: `哈希链：${v.ok ? '完好' : '异常'} · 时间片 ${v.epochs} · 事件 ${v.events}` +
            `\n当前分片：${v.current}`,
        };
      }

      case 'hot': {
        if (typeof hot !== 'function') return { kind: 'error', text: '当前环境没有注入' };
        const h = hot();
        if (!h.text) return { kind: 'success', text: '这一轮没有注入任何记忆' };
        return { kind: 'success', text: `本轮注入 ${h.bytes} 字节：\n${h.text}` };
      }

      case 'search': {
        const q = argv.slice(1).join(' ');
        if (!q) return { kind: 'error', text: '用法：/loom search <关键词>' };
        const hits = ledger.search(q, { limit: 5 });
        if (!hits.length) return { kind: 'success', text: `没找到「${q}」` };
        const lines = hits.map((h, i) => `  ${i + 1}. ${h.aiw}  [${h.id.slice(0, 8)}]`);
        return { kind: 'success', text: `「${q}」命中 ${hits.length} 条：\n${lines.join('\n')}` };
      }

      default:
        return { kind: 'error', text: `不认识的子命令：${sub}\n\n${HELP}` };
    }
  } catch (e) {
    return { kind: 'error', text: `LOOM 命令出错：${e.message}` };
  }
}
