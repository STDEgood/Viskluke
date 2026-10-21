'use strict';

/*
 * scripts/probe.js —— 判断"当前进程到底是 Electron 还是 Node"
 *
 *   npm run probe        等价于 electron scripts/probe.js
 *   node scripts/probe.js   也会跑，但会明确告诉你"我在 Node 里"
 *
 * 退出码：
 *   0  = 确实运行在 Electron 主进程中
 *   2  = 被当成纯 Node 运行（通常是 ELECTRON_RUN_AS_NODE=1 导致）
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const isElectron = Boolean(process.versions.electron);

const report = {
  isElectron,
  electron: process.versions.electron || null,
  node: process.versions.node,
  chrome: process.versions.chrome || null,
  execPath: process.execPath,
  argv: process.argv,
  cwd: process.cwd(),
  ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE || null,
  checkedAt: new Date().toISOString(),
};

const reportFile = path.join(os.tmpdir(), 'viskluke-probe.json');
try {
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), 'utf8');
} catch {
  /* 临时目录不可写就算了，控制台输出才是主通道 */
}

console.log(JSON.stringify(report, null, 2));
console.log(`\n[probe] 报告文件：${reportFile}`);

if (!isElectron) {
  console.error('\n[probe] 结论：当前进程不是 Electron！');
  console.error('[probe] 原因通常是 ELECTRON_RUN_AS_NODE=1，它会让 electron.exe 以纯 Node 模式运行。');
  console.error('[probe] 修复：PowerShell  Remove-Item Env:\\ELECTRON_RUN_AS_NODE');
  console.error('[probe]       CMD          set ELECTRON_RUN_AS_NODE=');
  process.exit(2);
}

console.log('\n[probe] 结论：Electron 主进程运行正常，1.5 秒后自动退出。');

const { app } = require('electron');
setTimeout(() => {
  app.quit();
}, 1500);
