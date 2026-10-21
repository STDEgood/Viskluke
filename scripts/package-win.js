'use strict';

/**
 * 打 Windows 安装包（这台机器专用的「开箱即用」封装）
 *
 * 流程：electron-builder --dir 产出 dist\win-unpacked → Inno Setup 6 打成
 *       dist\Viskluke-Setup-<版本>.exe（per-user 安装，不需要管理员权限）。
 *
 * 为什么不用 electron-builder 的 NSIS target：
 *   本机跑 NSIS 3.0.4.1 生成的安装包会在启动阶段直接崩溃
 *   （事件日志：Faulting module System.dll, exception 0xc0000005），
 *   不是脚本问题（去掉自定义 include 也一样），换 Inno Setup 6 立刻就好。
 *
 * 这个脚本顺手解决的几个环境坑：
 *   1. electron-builder 默认往 %LOCALAPPDATA% 下缓存 Electron / 7z 工具，
 *      本机安全软件会拒绝写入；全部指到项目内 .preview\cache。
 *   2. winCodeSign-2.6.0.7z 里有两个 darwin 符号链接（libcrypto.dylib /
 *      libssl.dylib），Windows 普通权限解不开，7za 会整包报错退出。
 *      这里用 7za 解压时排除整个 darwin 目录，再放进缓存目录，
 *      electron-builder 看到缓存命中就不会再下载/解压。
 *   3. 没有代码签名证书：CSC_IDENTITY_AUTO_DISCOVERY=false 跳过签名。
 *   4. 走 npmmirror 镜像（GitHub Releases 在国内经常连不上）。
 *
 * 用法：
 *   node scripts/package-win.js           打安装包（dist\Viskluke-Setup-<版本>.exe）
 *   node scripts/package-win.js --dir     只出免安装目录（dist\win-unpacked）
 *   其余参数原样透传给 electron-builder。
 *
 * 注意：electron-builder 会 spawn app-builder.exe / 7za 并捕获输出，
 * 受限沙箱里这些 spawn 会被 EPERM 拦掉，所以这个脚本要在完整权限下运行。
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CACHE_ROOT = path.join(ROOT, '.preview', 'cache');
const ELECTRON_CACHE = path.join(CACHE_ROOT, 'electron');
const BUILDER_CACHE = path.join(CACHE_ROOT, 'electron-builder');
const WIN_CODE_SIGN = path.join(BUILDER_CACHE, 'winCodeSign', 'winCodeSign-2.6.0');
const WIN_CODE_SIGN_VERSION = '2.6.0';
const MIRROR = (
  process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||
  'https://npmmirror.com/mirrors/electron-builder-binaries/'
).replace(/\/*$/, '/');
const ELECTRON_MIRROR = (process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/').replace(/\/*$/, '/');
const SEVEN_ZIP = path.join(ROOT, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');
const BUILDER_CLI = path.join(ROOT, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');
const INNO_SCRIPT = path.join(ROOT, 'build', 'viskluke.iss');

function log(message) {
  process.stdout.write(`${message}\n`);
}

function fail(message) {
  process.stderr.write(`\n❌ ${message}\n`);
  process.exit(1);
}

function readPackage() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
}

function findIscc() {
  const candidates = [
    process.env.ISCC_PATH,
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Inno Setup 6', 'ISCC.exe'),
    'C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe',
    'C:\\Program Files\\Inno Setup 6\\ISCC.exe',
  ].filter(Boolean);
  return candidates.find((file) => fs.existsSync(file)) || null;
}

async function download(url, output) {
  log(`下载 ${url}`);
  const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!response.ok) fail(`下载失败（HTTP ${response.status}）：${url}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(output, buffer);
  log(`已下载 ${(buffer.length / 1024 / 1024).toFixed(1)} MB`);
}

/** winCodeSign 的 7z 里有 darwin 符号链接，Windows 普通权限解不开；跳过 darwin 即可 */
async function ensureWinCodeSign() {
  if (fs.existsSync(path.join(WIN_CODE_SIGN, 'rcedit-x64.exe'))) {
    log(`winCodeSign 缓存已就绪：${path.relative(ROOT, WIN_CODE_SIGN)}`);
    return;
  }
  if (!fs.existsSync(SEVEN_ZIP)) fail('缺少 node_modules/7zip-bin 里的 7za.exe（先 npm install）');

  const archive = path.join(os.tmpdir(), `winCodeSign-${WIN_CODE_SIGN_VERSION}-${process.pid}.7z`);
  const tempDir = path.join(os.tmpdir(), `winCodeSign-${process.pid}`);
  fs.rmSync(tempDir, { recursive: true, force: true });
  await download(`${MIRROR}winCodeSign-${WIN_CODE_SIGN_VERSION}/winCodeSign-${WIN_CODE_SIGN_VERSION}.7z`, archive);

  log('解压（跳过 darwin 目录里的符号链接）…');
  const unzip = spawnSync(SEVEN_ZIP, ['x', '-bd', '-y', '-x!darwin\\*', archive, `-o${tempDir}`], {
    stdio: 'inherit',
  });
  fs.rmSync(archive, { force: true });
  if (unzip.status !== 0) fail(`解压 winCodeSign 失败（7za 退出码 ${unzip.status}）`);
  if (!fs.existsSync(path.join(tempDir, 'rcedit-x64.exe'))) fail('解压结果里没有 rcedit-x64.exe');

  fs.mkdirSync(path.dirname(WIN_CODE_SIGN), { recursive: true });
  fs.rmSync(WIN_CODE_SIGN, { recursive: true, force: true });
  fs.renameSync(tempDir, WIN_CODE_SIGN);
  log(`已放入缓存：${path.relative(ROOT, WIN_CODE_SIGN)}`);
}

function runBuilder(args) {
  if (!fs.existsSync(BUILDER_CLI)) fail('没装 electron-builder：先 npm install');
  // NSIS 的 !tempfile 依赖 TEMP，固定到项目内最稳（顺带避免沙箱临时目录被清）
  const buildTemp = path.join(CACHE_ROOT, 'tmp');
  fs.mkdirSync(buildTemp, { recursive: true });
  log(`\n运行 electron-builder ${args.join(' ')}`);
  const result = spawnSync(process.execPath, [BUILDER_CLI, ...args], {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      ELECTRON_CACHE,
      ELECTRON_BUILDER_CACHE: BUILDER_CACHE,
      ELECTRON_MIRROR,
      ELECTRON_BUILDER_BINARIES_MIRROR: MIRROR,
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
      TEMP: buildTemp,
      TMP: buildTemp,
    },
  });
  if (result.error) fail(`electron-builder 启动失败：${result.error.message}`);
  if (result.status !== 0) fail(`electron-builder 退出码 ${result.status}`);
}

function runInno(version) {
  const iscc = findIscc();
  if (!iscc) {
    fail(
      '没找到 Inno Setup 6 的 ISCC.exe。\n' +
        '  装一个：https://jrsoftware.org/isdl.php（免费），或用环境变量 ISCC_PATH 指向 ISCC.exe。\n' +
        '  为什么不用 electron-builder 的 NSIS：本机 NSIS 生成的安装包启动即崩溃（System.dll 0xc0000005）。'
    );
  }
  if (!fs.existsSync(INNO_SCRIPT)) fail(`缺少安装脚本：${INNO_SCRIPT}`);
  // 清掉上一次 NSIS 留下的中间产物，避免混淆
  const dist = path.join(ROOT, 'dist');
  for (const name of fs.existsSync(dist) ? fs.readdirSync(dist) : []) {
    if (name.endsWith('.blockmap') || name.endsWith('.nsis.7z')) {
      fs.rmSync(path.join(dist, name), { force: true });
    }
  }
  log(`\n打包安装包（Inno Setup）：${path.relative(ROOT, iscc)}`);
  const result = spawnSync(iscc, [`/DAppVersion=${version}`, INNO_SCRIPT], { cwd: ROOT, stdio: 'inherit' });
  if (result.error) fail(`ISCC 启动失败：${result.error.message}`);
  if (result.status !== 0) fail(`ISCC 退出码 ${result.status}`);
}

const PORTABLE_LAUNCHER = [
  '@echo off',
  'rem Launch with --no-sandbox: Chromium sandbox init crashes on some machines (STATUS_BREAKPOINT).',
  'rem Also clear ELECTRON_RUN_AS_NODE, otherwise the exe runs in Node mode and exits silently.',
  'set ELECTRON_RUN_AS_NODE=',
  'start "" "%~dp0Viskluke.exe" --no-sandbox',
  '',
].join('\r\n');

/** 免安装包：win-unpacked + 一个带 --no-sandbox 的启动 cmd，压成 zip */
function buildPortable(version) {
  const unpacked = path.join(ROOT, 'dist', 'win-unpacked');
  if (!fs.existsSync(path.join(unpacked, 'Viskluke.exe'))) return;
  fs.writeFileSync(path.join(unpacked, '启动 Viskluke.cmd'), PORTABLE_LAUNCHER, 'utf8');
  const AdmZip = require('adm-zip');
  const zipFile = path.join(ROOT, 'dist', `Viskluke-${version}-portable.zip`);
  fs.rmSync(zipFile, { force: true });
  const zip = new AdmZip();
  zip.addLocalFolder(unpacked);
  zip.writeZip(zipFile);
  log(`\n✅ 免安装压缩包：dist\\Viskluke-${version}-portable.zip（${(fs.statSync(zipFile).size / 1024 / 1024).toFixed(1)} MB）`);
}

function summarize() {
  const pkg = readPackage();
  const installer = path.join(ROOT, 'dist', `Viskluke-Setup-${pkg.version}.exe`);
  const unpacked = path.join(ROOT, 'dist', 'win-unpacked', 'Viskluke.exe');
  if (fs.existsSync(installer)) {
    const size = fs.statSync(installer).size;
    log(`\n✅ 安装包：dist\\Viskluke-Setup-${pkg.version}.exe（${(size / 1024 / 1024).toFixed(1)} MB）`);
  }
  if (fs.existsSync(unpacked)) {
    log('✅ 免安装：dist\\win-unpacked\\Viskluke.exe');
  }
  if (!fs.existsSync(installer) && !fs.existsSync(unpacked)) {
    fail('打包结束但没有找到产物');
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dirOnly = args.includes('--dir');
  const pkg = readPackage();

  fs.mkdirSync(ELECTRON_CACHE, { recursive: true });
  fs.mkdirSync(BUILDER_CACHE, { recursive: true });
  log(`Electron 缓存：${path.relative(ROOT, ELECTRON_CACHE)}`);
  log(`electron-builder 缓存：${path.relative(ROOT, BUILDER_CACHE)}`);
  log(`镜像：${MIRROR}`);

  await ensureWinCodeSign();
  runBuilder(['--dir', ...args.filter((arg) => arg !== '--dir')]);
  if (!dirOnly) runInno(pkg.version);
  buildPortable(pkg.version);
  summarize();
}

main().catch((error) => fail(error && (error.stack || error.message || String(error))));
