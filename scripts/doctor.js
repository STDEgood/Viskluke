'use strict';

/*
 * scripts/doctor.js —— 启动前体检：定位"npm start 无输出、无窗口、直接退出"
 *
 *   node scripts/doctor.js            完整体检（会真的拉起一次 electron 探针）
 *   node scripts/doctor.js --static   只做静态检查（受限环境用这个）
 *
 * 退出码：0 = 环境看起来正常；1 = 发现会导致静默退出的问题
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PROBE = path.join(ROOT, 'scripts', 'probe.js');
const PROBE_REPORT = path.join(os.tmpdir(), 'viskluke-probe.json');
const { isBreakpointExit } = require('./launch.js');
const STATIC_ONLY = process.argv.includes('--static');

const problems = [];
const warnings = [];
const lines = [];

function ok(label, detail = '') {
  lines.push(`  [OK]   ${label}${detail ? `  ${detail}` : ''}`);
}
function bad(label, detail = '') {
  lines.push(`  [FAIL] ${label}${detail ? `  ${detail}` : ''}`);
  problems.push(`${label}${detail ? `：${detail}` : ''}`);
}
function warn(label, detail = '') {
  lines.push(`  [WARN] ${label}${detail ? `  ${detail}` : ''}`);
  warnings.push(`${label}${detail ? `：${detail}` : ''}`);
}
function info(text) {
  lines.push(`         ${text}`);
}

console.log('Viskluke 启动体检');
console.log('='.repeat(64));
console.log(`项目目录 : ${ROOT}`);
console.log(`Node     : ${process.version}`);
console.log(`平台     : ${process.platform} ${process.arch}`);
console.log('');

// ---------------------------------------------------------------------------
// 1. package.json / 入口文件
// ---------------------------------------------------------------------------
lines.push('[1] 项目结构');

let pkg = null;
try {
  pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  ok('package.json 可解析', `name=${pkg.name} version=${pkg.version}`);
} catch (error) {
  bad('package.json 无法解析', error.message);
}

if (pkg) {
  const mainFile = path.join(ROOT, pkg.main || 'index.js');
  if (fs.existsSync(mainFile)) ok('入口文件存在', pkg.main);
  else bad('入口文件不存在', pkg.main);

  const indexHtml = path.join(ROOT, 'renderer', 'index.html');
  if (fs.existsSync(indexHtml)) ok('renderer/index.html 存在');
  else bad('renderer/index.html 缺失', indexHtml);

  const preload = path.join(ROOT, 'preload.js');
  if (fs.existsSync(preload)) ok('preload.js 存在');
  else bad('preload.js 缺失');
}

// ---------------------------------------------------------------------------
// 2. Electron 安装完整性
// ---------------------------------------------------------------------------
lines.push('');
lines.push('[2] Electron 安装');

let electronBin = null;
const electronPkgDir = path.join(ROOT, 'node_modules', 'electron');

try {
  const electronPkg = JSON.parse(fs.readFileSync(path.join(electronPkgDir, 'package.json'), 'utf8'));
  ok('electron 包已安装', `v${electronPkg.version}`);
} catch {
  bad('electron 未安装', '请执行 npm install');
}

const pathTxt = path.join(electronPkgDir, 'path.txt');
if (fs.existsSync(pathTxt)) {
  const rel = fs.readFileSync(pathTxt, 'utf8').trim();
  electronBin = path.join(electronPkgDir, 'dist', rel);
  ok('path.txt 存在', rel);
} else {
  bad('path.txt 缺失', 'Electron 的 postinstall 没跑完，请 npm rebuild electron');
}

if (electronBin && fs.existsSync(electronBin)) {
  const sizeMb = fs.statSync(electronBin).size / 1024 / 1024;
  if (sizeMb > 100) ok('electron 可执行文件存在', `${sizeMb.toFixed(1)} MB`);
  else bad('electron.exe 体积异常，疑似下载/解压不完整', `${sizeMb.toFixed(1)} MB`);
} else {
  bad('electron 可执行文件不存在', String(electronBin || '(未解析)'));
}

const distVersionFile = path.join(electronPkgDir, 'dist', 'version');
if (fs.existsSync(distVersionFile)) {
  const version = fs.readFileSync(distVersionFile, 'utf8').trim();
  ok('dist/version 一致', version);
} else {
  warn('dist/version 缺失', 'Electron 安装可能不完整');
}

const coreFiles = ['icudtl.dat', 'resources.pak', 'snapshot_blob.bin', 'libGLESv2.dll', 'ffmpeg.dll'];
const missingCore = coreFiles.filter((name) => !fs.existsSync(path.join(electronPkgDir, 'dist', name)));
if (missingCore.length === 0) ok('Electron 运行时依赖文件齐全');
else bad('Electron 缺少运行时文件', missingCore.join(', '));

// ---------------------------------------------------------------------------
// 3. 环境变量陷阱
// ---------------------------------------------------------------------------
lines.push('');
lines.push('[3] 环境变量');

if (process.env.ELECTRON_RUN_AS_NODE) {
  bad(
    'ELECTRON_RUN_AS_NODE 已设置',
    '它会强制 electron.exe 以纯 Node 模式运行（无窗口、无 Electron 日志）'
  );
  info('PowerShell : Remove-Item Env:\\ELECTRON_RUN_AS_NODE');
  info('CMD        : set ELECTRON_RUN_AS_NODE=');
} else {
  ok('ELECTRON_RUN_AS_NODE 未设置');
}

if (process.env.NODE_OPTIONS) {
  warn('NODE_OPTIONS 已设置', process.env.NODE_OPTIONS);
} else {
  ok('NODE_OPTIONS 未设置');
}

// ---------------------------------------------------------------------------
// 4. 历史运行痕迹
// ---------------------------------------------------------------------------
lines.push('');
lines.push('[4] 历史运行痕迹');

const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const userDataDir = path.join(appData, pkg && pkg.name ? pkg.name : 'viskluke-launcher');
const logFile = path.join(userDataDir, 'viskluke_error.log');

if (fs.existsSync(userDataDir)) {
  ok('userData 目录存在', userDataDir);
} else {
  warn('userData 目录不存在', '说明 Electron 从未成功初始化过（多半是启动阶段就被拦住了）');
}

if (fs.existsSync(logFile)) {
  ok('崩溃日志已生成');
  const tail = fs.readFileSync(logFile, 'utf8').trim().split(/\r?\n/).slice(-12);
  info(`日志文件：${logFile}`);
  lines.push('  ---- 日志末尾 ----');
  for (const line of tail) lines.push(`  | ${line}`);
  lines.push('  ------------------');
} else {
  warn('没有崩溃日志', '说明 main.js 的第一行都没执行到');
}

// ---------------------------------------------------------------------------
// 5. 真机探针（唯一能定性的检查）
// ---------------------------------------------------------------------------
lines.push('');
lines.push('[5] 实际拉起 Electron 探针');

if (STATIC_ONLY) {
  warn('已跳过', '--static 模式不实际启动 electron');
} else if (!electronBin || !fs.existsSync(electronBin)) {
  bad('无法进行探针测试', 'Electron 可执行文件不可用');
} else {
  try {
    fs.rmSync(PROBE_REPORT, { force: true });
  } catch {
    /* ignore */
  }

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  const result = spawnSync(electronBin, [PROBE], {
    env,
    timeout: 25000,
    windowsHide: true,
    encoding: 'utf8',
  });

  const spawnError = result.error || null;

  if (spawnError) {
    if (spawnError.code === 'EACCES' || spawnError.code === 'EPERM') {
      bad('系统拒绝启动 electron.exe', `错误 ${spawnError.code}`);
      info('常见原因：杀毒软件/EDR 拦截、AppLocker 组策略、受限沙箱环境、文件被标记为不可执行。');
      info('处理：为项目目录与 electron.exe 添加杀软白名单；换一个普通 PowerShell 窗口重试。');
    } else if (spawnError.code === 'ETIMEDOUT') {
      bad('electron.exe 启动后无响应', '25 秒内没有退出');
      info('可尝试：set VISKLUKE_DISABLE_GPU=1 后重新启动，或更新显卡驱动。');
    } else if (spawnError.code === 'ENOENT') {
      bad('找不到 electron.exe', electronBin);
    } else {
      bad('启动 electron.exe 失败', `${spawnError.code || ''} ${spawnError.message}`);
    }
  } else {
    let report = null;
    try {
      report = JSON.parse(fs.readFileSync(PROBE_REPORT, 'utf8'));
    } catch {
      const match = /{[\s\S]*}/.exec(result.stdout || '');
      if (match) {
        try {
          report = JSON.parse(match[0]);
        } catch {
          report = null;
        }
      }
    }

    if (report && report.isElectron) {
      ok('探针运行在 Electron 主进程内', `electron=${report.electron} node=${report.node}`);
    } else if (report && !report.isElectron) {
      bad('探针被当成纯 Node 运行', `node=${report.node}`);
      info('说明 electron.exe 启动时带着 ELECTRON_RUN_AS_NODE，或启动方式不是 electron。');
    } else if (isBreakpointExit(result.status)) {
      // Chromium 沙箱初始化崩溃：已知问题 electron/electron#38216、#51761
      warn(
        'Chromium 沙箱无法初始化',
        `STATUS_BREAKPOINT 0x80000003（退出码 ${result.status}）`
      );
      info('这是 Chromium 在 Windows 上的已知问题，跟项目代码无关。');
      info('复测：加 --no-sandbox 再拉起一次探针…');

      const retry = spawnSync(electronBin, ['--no-sandbox', PROBE], {
        env,
        timeout: 25000,
        windowsHide: true,
        encoding: 'utf8',
      });

      let retryReport = null;
      try {
        retryReport = JSON.parse(fs.readFileSync(PROBE_REPORT, 'utf8'));
      } catch {
        retryReport = null;
      }

      if (retryReport && retryReport.isElectron) {
        ok('加 --no-sandbox 后探针正常运行', `electron=${retryReport.electron}`);
        info('修复：直接 npm start —— scripts/launch.js 会自动检测并降级重试。');
      } else {
        bad('加 --no-sandbox 仍然失败', `退出码=${retry.status}`);
        info('可继续尝试：--disable-gpu-sandbox --disable-gpu --in-process-gpu');
      }
    } else {
      bad('探针没有产出报告', `退出码=${result.status}`);
      if (result.stdout) info(`stdout: ${String(result.stdout).trim().split(/\r?\n/).slice(0, 5).join(' / ')}`);
      if (result.stderr) info(`stderr: ${String(result.stderr).trim().split(/\r?\n/).slice(0, 5).join(' / ')}`);
      info('若退出码为 0xC0000135/-1073741515：缺少运行库或文件被杀软破坏。');
    }
  }
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
console.log(lines.join('\n'));
console.log('');
console.log('='.repeat(64));

if (problems.length === 0) {
  console.log('结论：未发现环境问题。若 npm start 仍然闪退，请查看崩溃日志：');
  console.log(`  ${logFile}`);
  process.exit(0);
}

console.log(`结论：发现 ${problems.length} 个会导致"静默退出"的问题：`);
for (const item of problems) console.log(`  - ${item}`);
if (warnings.length) {
  console.log('');
  console.log(`另有 ${warnings.length} 条提示：`);
  for (const item of warnings) console.log(`  - ${item}`);
}
console.log('');
console.log('最关键的判断依据：终端里执行 `npx electron --version`');
console.log('  · 打印 v33.4.11    → Electron 正常，问题在项目代码/页面');
console.log('  · 打印 v20.x       → 被 ELECTRON_RUN_AS_NODE 劫持成 Node 了');
console.log('  · 退出码 0x80000003 → Chromium 沙箱崩溃，用 npm start 自动降级');
console.log('  · 什么都不打印     → electron.exe 被系统/杀软拦住（与代码无关）');
process.exit(1);
