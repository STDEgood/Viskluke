'use strict';

/*
 * scripts/launch.js —— 带沙箱自愈能力的启动入口（npm start 实际执行它）
 *
 * 背景：部分 Windows 主机上 Chromium 沙箱初始化会触发 CHECK() 失败，
 *       进程以 STATUS_BREAKPOINT（0x80000003 / -2147483645）静默退出：
 *       没有窗口、没有日志、连 --version 都不输出。
 *       该崩溃发生在 main.js 之前，所以只能在"启动命令"这一层兜底。
 *
 * 策略（依次）：
 *   1. 先按正常参数启动，保留完整沙箱；
 *   2. 若退出码命中 0x80000003，写入 fallback 标记并用 --no-sandbox 重试；
 *   3. 标记对同一 Electron 版本粘性生效，后续启动直接走安全模式，不再白等一次崩溃；
 *   4. Electron 升级后自动重新探测；`npm start -- --reset-sandbox` 可手动清除标记。
 *
 * 本文件同时导出纯函数，便于 scripts/selftest.js 做无 GUI 断言。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const APP_DIR_NAME = 'viskluke-launcher';
const MARKER_NAME = 'sandbox-fallback.json';

// Chromium 用 STATUS_BREAKPOINT 表示 CHECK() 失败；
// Node 在 Windows 上可能给出有符号值，也可能给出无符号值，两种都认。
const STATUS_BREAKPOINT_SIGNED = -2147483645;

function isBreakpointExit(code) {
  if (code === null || code === undefined) return false;
  const value = Number(code);
  if (!Number.isFinite(value)) return false;
  return value === STATUS_BREAKPOINT_SIGNED || value >>> 0 === 0x80000003;
}

function withSafeFlags(argv) {
  const args = [...argv];
  if (!args.includes('--no-sandbox')) args.push('--no-sandbox');
  return args;
}

function isExplicitSafe(argv = [], env = process.env) {
  if (argv.includes('--no-sandbox')) return true;
  return /^(1|true|yes|on)$/i.test(String(env.ELECTRON_DISABLE_SANDBOX || '').trim());
}

/**
 * 决定本次用哪套参数启动。
 * 纯函数：不读磁盘、不启动进程，方便测试。
 */
function decideMode(options = {}) {
  const argv = Array.isArray(options.argv) ? options.argv : [];
  const env = options.env || process.env;
  const marker = options.marker || null;
  const electronVersion = String(options.electronVersion || '');

  if (isExplicitSafe(argv, env)) {
    return { mode: 'safe', reason: 'explicit', args: withSafeFlags(argv) };
  }
  if (marker && marker.state === 'fallback' && marker.electron && marker.electron === electronVersion) {
    return { mode: 'safe', reason: 'sticky-fallback', args: withSafeFlags(argv) };
  }
  return { mode: 'normal', reason: 'probe', args: argv };
}

// ---------------------------------------------------------------------------
// 标记文件（记录"这台机器需要 --no-sandbox"）
// ---------------------------------------------------------------------------

function roamingDir() {
  if (process.env.APPDATA) return path.join(process.env.APPDATA, APP_DIR_NAME);
  return path.join(os.homedir(), 'AppData', 'Roaming', APP_DIR_NAME);
}

function markerCandidates() {
  return [path.join(roamingDir(), MARKER_NAME), path.join(ROOT, MARKER_NAME)];
}

function readMarker() {
  for (const file of markerCandidates()) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      /* 下一个候选 */
    }
  }
  return null;
}

function writeMarker(data) {
  const body = `${JSON.stringify({ ...data, at: new Date().toISOString() }, null, 2)}\n`;
  for (const file of markerCandidates()) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body, 'utf8');
      return file;
    } catch {
      /* 下一个候选 */
    }
  }
  return null;
}

function clearMarker() {
  for (const file of markerCandidates()) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* ignore */
    }
  }
}

function readElectronVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
  } catch {
    return '';
  }
}

function resolveElectronPath() {
  const electron = require('electron'); // 纯 Node 下返回可执行文件绝对路径
  if (typeof electron !== 'string') {
    throw new Error('require("electron") 没有返回可执行文件路径，请在项目目录下运行');
  }
  return electron;
}

/** 启动 Electron 并等待退出，stdio 用 inherit 以保留控制台输出 */
function runElectron(electronPath, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(electronPath, args, { cwd: ROOT, stdio: 'inherit', windowsHide: false });
    } catch (error) {
      return resolve({ code: null, error });
    }
    child.once('error', (error) => resolve({ code: null, error }));
    child.once('exit', (code, signal) => resolve({ code, signal, error: null }));
  });
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const rawArgs = process.argv.slice(2);
  const resetRequested = rawArgs.includes('--reset-sandbox');
  const userArgs = rawArgs.filter((arg) => arg !== '--reset-sandbox');

  if (resetRequested) {
    clearMarker();
    console.log('[launch] 已清除沙箱降级标记，本次重新探测');
  }

  let electronPath;
  try {
    electronPath = resolveElectronPath();
  } catch (error) {
    console.error('[launch] 找不到 Electron 可执行文件：', error.message);
    console.error('[launch] 请先执行：npm install  （或 npm rebuild electron）');
    process.exit(1);
  }

  const electronVersion = readElectronVersion();
  const marker = resetRequested ? null : readMarker();
  const decision = decideMode({ argv: userArgs, env: process.env, marker, electronVersion });
  const appArgs = [ROOT, ...decision.args];

  console.log(`[launch] Electron ${electronVersion || '(未知版本)'} · 模式=${decision.mode}（${decision.reason}）`);

  let result = await runElectron(electronPath, appArgs);

  // 沙箱崩溃 → 自动降级重试（仅一次，且只在尚未降级时）
  if (decision.mode === 'normal' && result.error === null && isBreakpointExit(result.code)) {
    console.warn('[launch] 检测到 Chromium 沙箱崩溃（STATUS_BREAKPOINT 0x80000003）');
    console.warn('[launch] 本机无法初始化 Chromium 沙箱，自动改用 --no-sandbox 重试…');

    writeMarker({
      state: 'fallback',
      reason: 'sandbox-breakpoint',
      electron: electronVersion,
      exitCode: result.code,
    });

    result = await runElectron(electronPath, [ROOT, ...withSafeFlags(decision.args)]);
  }

  if (result.error) {
    const code = result.error.code || '';
    console.error(`[launch] 无法启动 Electron：${code} ${result.error.message}`);
    if (code === 'EACCES' || code === 'EPERM') {
      console.error('[launch] 这通常是安全软件/组策略拦截：请把 node_modules\\electron\\dist 加入白名单。');
    }
    if (code === 'ENOENT') {
      console.error('[launch] 可执行文件不存在：请执行 npm rebuild electron。');
    }
    process.exit(1);
  }

  if (isBreakpointExit(result.code)) {
    console.error('[launch] 即使加了 --no-sandbox 仍然崩溃。');
    console.error('[launch] 请把以下信息反馈给开发者：');
    console.error(`[launch]   electron=${electronVersion} exit=${result.code} (0x${(Number(result.code) >>> 0).toString(16)})`);
    console.error('[launch] 可继续尝试：--disable-gpu --disable-gpu-sandbox --in-process-gpu');
    process.exit(1);
  }

  // 正常模式成功退出：确保不残留 fallback 标记（例如换机器/系统更新后）
  if (decision.mode === 'normal' && result.code === 0 && marker && marker.state === 'fallback') {
    clearMarker();
  }

  process.exit(typeof result.code === 'number' ? result.code : 0);
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[launch] 未捕获的启动异常：', error && error.stack ? error.stack : error);
    process.exit(1);
  });
}

module.exports = {
  STATUS_BREAKPOINT_SIGNED,
  isBreakpointExit,
  isExplicitSafe,
  withSafeFlags,
  decideMode,
  readMarker,
  writeMarker,
  clearMarker,
  readElectronVersion,
};
