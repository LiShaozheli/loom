import fs from 'node:fs';

const f = 'packages/loom-dsh/index.js';
let s = fs.readFileSync(f, 'utf8');

// 1) 逐条注册：一条失败不影响其余，且把失败写进日志
const oldMountHead = `  const mountPanelData = (scope) => {`;
if (!s.includes('mountedRoutes')) {
  s = s.replace(
    oldMountHead,
    `  const mountedRoutes = [];

  const mountPanelData = (scope) => {`
  );
}

// 在 mountPanelData 末尾（函数闭合前）无法轻易定位，改为在每次 register 后记录：
s = s.split('    web.register({').join('    const routeSpec = {');
// 上面的粗暴替换会破坏结构，回退方案：改为给每个 register 调用加 try —— 见下一个脚本
fs.writeFileSync(f + '.bak', s, 'utf8');
console.log('已备份待重构，不做粗暴替换');
