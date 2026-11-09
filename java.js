'use strict';

/**
 * java.js —— Java 运行时：自动检测 + 自动下载
 *
 * 之前的问题：MCLC 默认用 PATH 里的 `java`，用户没配 JAVA_HOME 就直接「启动失败」。
 * 现在：
 *   1. 先按「实例里手填的路径 → 设置里的路径 → 本启动器下载过的 JRE → JAVA_HOME →
 *      PATH → 常见安装目录」顺序探测；
 *   2. 还找不到就按 Minecraft 版本需要的 Java 主版本，从 Adoptium（Eclipse Temurin）
 *      下载官方 JRE 到 <userData>/java/temurin-<major>，之后一直复用；
 *   3. 启动时把确定好的 java.exe 交给 MCLC。
 *
 * 只用 zip（Windows 版），解压用项目里已有的 adm-zip，不依赖系统装 7z。
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const AdmZip = require('adm-zip');
const axios = require('axios');

const settings = require('./settings');

const DOWNLOAD_BASE = 'https://api.adoptium.net/v3/binary/latest';
const MANAGED_ROOT = () => path.join(settings.dataDir(), 'java');
const EXE = process.platform === 'win32' ? 'java.exe' : 'java';

let detectCache = null;
let detectAt = 0;

function describe(error) {
  if (!error) return '未知错误';
  const code = error.code || '';
  const status = error.response && error.response.status;
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') return '下载超时（网络不畅，可换下载源后重试）';
  if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET'].includes(code)) return `网络不可达（${code}）`;
  if (status === 404) return '这个 Java 版本在 Adoptium 上没有对应构建（404）';
  if (status && status >= 500) return `镜像/下载服务异常（${status}）`;
  return error.message || String(error);
}

/** 该 Minecraft 版本需要哪个 Java 主版本 */
function requiredMajor(mcVersion) {
  const value = String(mcVersion || '').trim();
  const match = value.match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return 17;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3] || 0);
  if (major >= 26) return 25; // 未来的大版本（HANDOFF 里记着 26.x 要 Java 25）
  if (major === 1) {
    if (minor >= 21) return 21;
    if (minor === 20 && patch >= 5) return 21;
    if (minor >= 17) return 17;
    return 8;
  }
  return 17;
}

function platformKey() {
  const plat = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux';
  const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'aarch64' : 'x86';
  return { os: plat, arch };
}

function parseJavaMajor(text) {
  const value = String(text || '');
  let match = value.match(/version "(\d+)\.(\d+)/);
  if (match) {
    const first = Number(match[1]);
    return first === 1 ? Number(match[2]) : first;
  }
  match = value.match(/version "(\d+)/);
  return match ? Number(match[1]) : 0;
}

/** 跑一次 `java -version`，成功则返回 { path, major, version } */
function probeJava(javaPath, timeout = 5000) {
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child;
    try {
      child = spawn(javaPath, ['-version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      return done(null);
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      done(null);
    }, timeout);
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('error', () => {
      clearTimeout(timer);
      done(null);
    });
    child.on('close', () => {
      clearTimeout(timer);
      const major = parseJavaMajor(output);
      if (!major) return done(null);
      const versionMatch = output.match(/version "([^"]+)"/);
      done({ path: javaPath, major, version: versionMatch ? versionMatch[1] : `Java ${major}` });
    });
  });
}

/** 扫描常见安装目录（只找 <dir>/bin/java.exe，不递归全盘） */
function scanCommonDirs() {
  const found = [];
  const push = (dir) => {
    if (!dir) return;
    const exe = path.join(dir, 'bin', EXE);
    if (fs.existsSync(exe)) found.push(exe);
  };
  const roots = [
    'C:\\Program Files\\Java',
    'C:\\Program Files\\Eclipse Adoptium',
    'C:\\Program Files\\Microsoft',
    'C:\\Program Files\\Zulu',
    'C:\\Program Files (x86)\\Java',
  ];
  const roaming = process.env.LOCALAPPDATA;
  if (roaming) {
    roots.push(path.join(roaming, 'Programs', 'Eclipse Adoptium'));
    roots.push(path.join(roaming, 'Programs', 'Java'));
  }
  for (const root of roots) {
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory()) push(path.join(root, entry.name));
      }
    } catch {
      /* 没有这个目录 */
    }
  }
  return found;
}

function managedCandidates() {
  const list = [];
  try {
    for (const entry of fs.readdirSync(MANAGED_ROOT(), { withFileTypes: true })) {
      if (entry.isDirectory()) list.push(path.join(MANAGED_ROOT(), entry.name, 'bin', EXE));
    }
  } catch {
    /* 还没下载过 */
  }
  return list.filter((file) => fs.existsSync(file));
}

/** 探测本机可用的 Java（带 60 秒缓存） */
async function detect(options = {}) {
  const { force = false } = options;
  if (!force && detectCache && Date.now() - detectAt < 60_000) return detectCache;

  const candidates = [];
  const pref = settings.read();
  if (pref.javaPath) candidates.push(pref.javaPath);
  candidates.push(...managedCandidates());
  if (process.env.JAVA_HOME) candidates.push(path.join(process.env.JAVA_HOME, 'bin', EXE));
  // PATH
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (dir && fs.existsSync(path.join(dir, EXE))) candidates.push(path.join(dir, EXE));
  }
  candidates.push(...scanCommonDirs());

  const seen = new Set();
  const results = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    if (!fs.existsSync(resolved)) continue;
    const info = await probeJava(resolved);
    if (info) results.push(info);
    if (results.length >= 6) break;
  }

  results.sort((a, b) => b.major - a.major);
  detectCache = results;
  detectAt = Date.now();
  return results;
}

function managedDirFor(major) {
  return path.join(MANAGED_ROOT(), `temurin-${major}`);
}

async function downloadZip(url, target, onProgress) {
  const response = await axios.get(url, {
    responseType: 'stream',
    timeout: 120000,
    maxRedirects: 8,
    headers: { 'User-Agent': 'Viskluke-Launcher/1.0 (java provisioner)' },
  });
  const total = Number(response.headers['content-length'] || 0);
  let received = 0;
  await new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(target);
    response.data.on('data', (chunk) => {
      received += chunk.length;
      if (onProgress) onProgress({ received, total, percent: total ? Math.round((received / total) * 100) : null });
    });
    response.data.on('error', reject);
    stream.on('error', reject);
    stream.on('finish', resolve);
    response.data.pipe(stream);
  });
}

/** 下载并安装某个 Java 主版本（Windows zip；其他平台只提示手动装） */
async function installMajor(major, hooks = {}) {
  const { onLog = () => {}, onProgress = () => {} } = hooks;
  if (process.platform !== 'win32') {
    throw new Error(`自动下载 Java 目前只支持 Windows；请手动安装 Java ${major} 并在设置里填路径`);
  }
  const target = managedDirFor(major);
  const exe = path.join(target, 'bin', EXE);
  if (fs.existsSync(exe)) {
    const info = await probeJava(exe);
    if (info && info.major === major) return info;
  }

  const { os: osName, arch } = platformKey();
  const url =
    `${DOWNLOAD_BASE}/${major}/ga/${osName}/${arch}/jre/hotspot/normal/eclipse` +
    '?project=jdk&vendor=eclipse';
  onLog(`[Java] 正在下载 Temurin JRE ${major}（约 40–60MB）…`);
  const tmpZip = path.join(os.tmpdir(), `viskluke-java-${major}-${Date.now()}.zip`);
  await downloadZip(url, tmpZip, onProgress);

  onLog('[Java] 下载完成，开始解压…');
  const tempDir = path.join(os.tmpdir(), `viskluke-java-${major}-${Date.now()}`);
  fs.rmSync(tempDir, { recursive: true, force: true });
  const zip = new AdmZip(tmpZip);
  zip.extractAllTo(tempDir, true);
  fs.rmSync(tmpZip, { force: true });

  // zip 里通常是一层 jdk-xx-jre 目录，找到 bin/java.exe 后把这一层搬过去
  const found = findJavaRoot(tempDir);
  if (!found) throw new Error('解压后没有找到 bin/java.exe，可能下载到了错误的内容');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.rmSync(target, { recursive: true, force: true });
  fs.renameSync(found, target);
  fs.rmSync(tempDir, { recursive: true, force: true });

  const info = await probeJava(path.join(target, 'bin', EXE));
  if (!info) throw new Error('Java 装好了但启动失败，可能被杀毒软件拦截');
  onLog(`[Java] 已就绪：${info.path}（${info.version}）`);
  detectCache = null;
  return info;
}

function findJavaRoot(dir) {
  const exe = path.join(dir, 'bin', EXE);
  if (fs.existsSync(exe)) return dir;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const nested = path.join(dir, entry.name);
    if (fs.existsSync(path.join(nested, 'bin', EXE))) return nested;
  }
  return null;
}

/**
 * 确保有能跑这个 Minecraft 版本的 Java。
 * @returns {Promise<{path:string, major:number, version:string, source:string}|null>}
 */
async function ensureForVersion(mcVersion, hooks = {}) {
  const { onLog = () => {}, onProgress = () => {}, allowDownload = true } = hooks;
  const need = requiredMajor(mcVersion);
  const installed = await detect();
  const usable =
    installed.find((item) => item.major === need) ||
    (need >= 17 ? installed.find((item) => item.major > need) : null) ||
    null;
  if (usable) {
    detectCache = installed;
    onLog(`[Java] 使用已安装的 Java ${usable.major}：${usable.path}`);
    return { ...usable, source: 'detected', required: need };
  }
  if (!allowDownload) {
    throw new Error(`本机没有 Java ${need}，也没有可自动下载的平台支持`);
  }
  onLog(`[Java] 本机没有 Java ${need}，准备自动下载…`);
  const info = await installMajor(need, { onLog, onProgress });
  return { ...info, source: 'downloaded', required: need };
}

async function status() {
  const pref = settings.read();
  const list = await detect();
  return {
    configured: pref.javaPath || '',
    detected: list.map((item) => ({ path: item.path, major: item.major, version: item.version })),
    best: list[0] || null,
    managedRoot: MANAGED_ROOT(),
  };
}

module.exports = {
  requiredMajor,
  detect,
  probeJava,
  installMajor,
  ensureForVersion,
  status,
  managedDirFor,
};
