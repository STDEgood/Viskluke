'use strict';

/**
 * server.js —— 一键开服 + Viskluke Address 编排层
 *
 * 职责：
 *   1. 在 userData/servers/<serverId> 下准备服务端（下载 jar、eula、server.properties）
 *   2. 用 child_process.spawn 启动 `java -Xmx2G -jar <jar> nogui`
 *   3. 通过 IPC 实时把控制台输出推给渲染进程，并支持回传命令
 *   4. 启动后调用 cloudflare.js 创建 A + SRV，关闭/删除时清理解析
 *
 * 设计约定：
 *   - 所有对外方法都不抛异常（内部 catch 后返回 { ok, error }），避免 IPC 直接 reject
 *   - 运行状态（进程）放在内存 runtimes 里；持久化状态放在 userData/servers.json
 *   - 渲染进程永远拿不到 Java 进程句柄，只能通过 IPC 操作
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const net = require('net');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const axios = require('axios');
const { app, shell } = require('electron');
const cloudflare = require('./cloudflare');
const auth = require('./auth');
const netcheck = require('./netcheck');

const USER_AGENT = 'Viskluke-Launcher/0.5 (+https://viskluke.app)';
const CORES = ['vanilla', 'paper', 'fabric'];
const DEFAULT_PORT = 25565;
const PORT_SCAN_RANGE = 30;
const LOG_LIMIT = 1500;
const DOWNLOAD_RETRIES = 3;
const PLAYER_NAME_RE = /^[A-Za-z0-9_]{3,16}$/;
const WHITELIST_FILE = 'whitelist.json';
const MAX_WHITELIST = 100;

const VANILLA_MANIFEST = 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json';
const PAPER_FILL_API = 'https://fill.papermc.io/v3';
const FABRIC_META = 'https://meta.fabricmc.net/v2';

/** 域名前缀黑名单（避免占用常见子域名） */
const RESERVED_PREFIXES = new Set([
  'www', 'mail', 'smtp', 'pop', 'imap', 'ftp', 'api', 'cdn', 'ns', 'ns1', 'ns2',
  'mx', 'dns', 'admin', 'root', 'test', 'dev', 'staging', 'autodiscover', 'vpn',
]);

/** serverId -> { status, proc, logs: [], startedAt } */
const runtimes = new Map();
let mainWindow = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// 窗口 / 事件推送
// ---------------------------------------------------------------------------

function attachWindow(win) {
  mainWindow = win;
}

function push(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.webContents.send(channel, payload);
  } catch {
    /* 窗口正在关闭，忽略 */
  }
}

function log(serverId, line, level = 'info') {
  const entry = { ts: Date.now(), level, line: String(line) };
  const runtime = runtimes.get(serverId);
  if (runtime) {
    runtime.logs.push(entry);
    if (runtime.logs.length > LOG_LIMIT) runtime.logs.splice(0, runtime.logs.length - LOG_LIMIT);
  }
  push('server:log', { serverId, ...entry });
}

function emitProgress(serverId, stage, info = {}) {
  push('server:progress', { serverId, stage, ...info });
}

function setStatus(serverId, status) {
  const runtime = runtimes.get(serverId);
  if (runtime) runtime.status = status;
  push('server:status', { serverId, status });
}

// ---------------------------------------------------------------------------
// 持久化（userData/servers.json）
// ---------------------------------------------------------------------------

function storeFile() {
  return path.join(app.getPath('userData'), 'servers.json');
}

function loadAll() {
  try {
    const raw = JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function saveAll(list) {
  const file = storeFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function findOne(id) {
  return loadAll().find((s) => s.id === id) || null;
}

function upsertMeta(meta) {
  const list = loadAll();
  const index = list.findIndex((s) => s.id === meta.id);
  if (index >= 0) list[index] = { ...list[index], ...meta };
  else list.push(meta);
  saveAll(list);
  return findOne(meta.id);
}

function patchMeta(id, changes) {
  const list = loadAll();
  const index = list.findIndex((s) => s.id === id);
  if (index < 0) return null;
  list[index] = { ...list[index], ...changes };
  saveAll(list);
  return list[index];
}

function removeMeta(id) {
  saveAll(loadAll().filter((s) => s.id !== id));
}

function isRunning(serverId) {
  const runtime = runtimes.get(serverId);
  return Boolean(runtime && runtime.proc);
}

function decorate(meta) {
  const runtime = runtimes.get(meta.id);
  return {
    ...meta,
    status: runtime ? runtime.status : 'stopped',
    running: Boolean(runtime && runtime.proc),
    pid: (runtime && runtime.proc && runtime.proc.pid) || null,
    uptimeMs: runtime && runtime.startedAt ? Date.now() - runtime.startedAt : 0,
    lanAddress: lanAddress(meta.port),
    publicAddress: meta.dns && meta.dns.enabled ? meta.address : '',
  };
}

// ---------------------------------------------------------------------------
// 白名单 / 局域网地址
// ---------------------------------------------------------------------------

/** 玩家名列表归一化：去重、去非法项、限长 */
function normalizePlayerList(input) {
  const raw = Array.isArray(input)
    ? input
    : String(input || '')
        .split(/[\s,;，、]+/);
  const seen = new Set();
  const players = [];
  const skipped = [];
  for (const item of raw) {
    const name = String(item || '').trim();
    if (!name) continue;
    if (!PLAYER_NAME_RE.test(name)) {
      skipped.push(name);
      continue;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    players.push(name);
    if (players.length >= MAX_WHITELIST) break;
  }
  return { players, skipped };
}

function whitelistPath(dir) {
  return path.join(dir, WHITELIST_FILE);
}

function readWhitelistFile(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(whitelistPath(dir), 'utf8').replace(/^\uFEFF/, ''));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** 正版模式下查 Mojang 拿真实 UUID；失败返回 null（宁可跳过也不写错 UUID） */
async function lookupMojangUuid(name) {
  try {
    const res = await axios.get(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`, {
      timeout: 8000,
      headers: { 'User-Agent': USER_AGENT },
      validateStatus: (s) => s >= 200 && s < 500,
    });
    const id = res.data && res.data.id;
    if (!id || !/^[0-9a-fA-F]{32}$/.test(id)) return null;
    // Mojang 返回不带中划线，服务器认带中划线的写法
    return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * 把白名单写进 `whitelist.json`。
 * · 离线模式：UUID 用 md5("OfflinePlayer:名字") 推导（和客户端一致）
 * · 正版模式：查 Mojang；查不到就跳过并给提示（写错 UUID 等于白名单失效）
 * · 手动用控制台加过的人不会被冲掉（按名字合并，不认识的保留）
 */
async function ensureWhitelist(dir, meta, options = {}) {
  const { players = meta.whitelistPlayers || [], enabled = meta.whitelist !== false } = options;
  const list = normalizePlayerList(players);
  const target = whitelistPath(dir);

  if (!enabled) {
    return { enabled: false, file: target, written: 0, players: list.players, skipped: list.skipped, warnings: [] };
  }

  const existing = readWhitelistFile(dir);
  const ours = new Set(list.players.map((name) => name.toLowerCase()));
  const merged = existing.filter((entry) => entry && entry.name && !ours.has(String(entry.name).toLowerCase()));
  const warnings = [];
  if (list.skipped.length) {
    warnings.push(`白名单里有 ${list.skipped.length} 个名字不合法，已忽略：${list.skipped.slice(0, 5).join('、')}`);
  }

  for (const name of list.players) {
    let uuid = '';
    if (meta.onlineMode) {
      uuid = (await lookupMojangUuid(name)) || '';
      if (!uuid) {
        warnings.push(
          `「${name}」在正版模式下查不到 Mojang UUID，已跳过 —— 请在服务器控制台用 whitelist add ${name} 添加`
        );
        continue;
      }
    } else {
      try {
        uuid = auth.offlineUuid(name);
      } catch {
        uuid = '';
      }
      if (!uuid) {
        warnings.push(`「${name}」的离线 UUID 推导失败，已跳过`);
        continue;
      }
    }
    merged.push({ uuid, name });
  }

  const dedup = [];
  const seen = new Set();
  for (const entry of merged) {
    const key = String(entry.name || '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    dedup.push({ uuid: entry.uuid || '', name: entry.name });
  }

  await fsp.writeFile(target, `${JSON.stringify(dedup, null, 2)}\n`, 'utf8');
  return {
    enabled: true,
    file: target,
    written: dedup.length,
    players: list.players,
    skipped: list.skipped,
    warnings,
  };
}

/** 本机局域网 IPv4（给"同一 WiFi 的朋友"直接抄）—— 复用 netcheck 的网卡筛选，避免选中 Radmin 这类虚拟网卡 */
let lanCache = { at: 0, ip: '' };
function lanAddress() {
  if (Date.now() - lanCache.at < 30000 && lanCache.ip) return lanCache.ip;
  let found = '';
  try {
    found = netcheck.lanIpv4();
  } catch {
    found = '';
  }
  lanCache = { at: Date.now(), ip: found };
  return found;
}

function list() {
  return loadAll().map(decorate);
}

function getLogs(serverId) {
  const runtime = runtimes.get(serverId);
  return runtime ? runtime.logs.slice() : [];
}

// ---------------------------------------------------------------------------
// 输入校验
// ---------------------------------------------------------------------------

function assertVersion(version) {
  const value = String(version || '').trim();
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,31}$/.test(value)) {
    throw new Error(`游戏版本格式不正确：${version}（示例：1.20.4）`);
  }
  return value;
}

function assertCore(core) {
  const value = String(core || '').trim().toLowerCase();
  if (!CORES.includes(value)) {
    throw new Error(`不支持的服务器核心：${core}（可选：${CORES.join(' / ')}）`);
  }
  return value;
}

function assertMemory(memory) {
  const value = String(memory || '').trim().toUpperCase();
  const match = /^(\d{1,5})([MG])$/.exec(value);
  if (!match) throw new Error(`内存格式不正确：${memory}（示例：2G、2048M）`);
  const amount = Number(match[1]);
  const unit = match[2];
  const megabytes = unit === 'G' ? amount * 1024 : amount;
  if (megabytes < 512) throw new Error('内存不能小于 512M');
  if (megabytes > 65536) throw new Error('内存不能大于 64G');
  return `${amount}${unit}`;
}

function normalizePrefix(prefix) {
  const value = String(prefix || '').trim().toLowerCase();
  if (!value) throw new Error('请填写域名前缀');
  if (!/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(value)) {
    throw new Error('域名前缀只能包含小写字母、数字和连字符，且不能以连字符开头/结尾（1-40 位）');
  }
  if (RESERVED_PREFIXES.has(value)) {
    throw new Error(`前缀 ${value} 是保留字，请换一个`);
  }
  return value;
}

function assertSuffix(suffix) {
  const value = String(suffix || '').trim().toLowerCase();
  // 内置三个 + 用户在「域名管理」里绑定过的自己的域名
  const available = cloudflare.configuredSuffixes();
  if (available.includes(value)) return value;
  if (cloudflare.isDomainName(value)) {
    throw new Error(
      `域名 ${value} 还没有绑定：先在服务器页「域名管理」里添加它（填 Zone ID），再选它`
    );
  }
  throw new Error(`域名后缀不合法：${suffix}（可选：${available.join(' / ')}）`);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// ---------------------------------------------------------------------------
// 目录 / serverId
// ---------------------------------------------------------------------------

function serversRoot() {
  return path.join(app.getPath('userData'), 'servers');
}

/** 严格校验 serverId 必须落在 userData/servers 之内，杜绝路径穿越 */
function serverDir(serverId) {
  const id = String(serverId || '');
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id) || id.includes('..')) {
    throw new Error(`非法的服务器 ID：${serverId}`);
  }
  const root = path.resolve(serversRoot());
  const dir = path.resolve(root, id);
  if (dir !== root && !dir.startsWith(`${root}${path.sep}`)) {
    throw new Error('非法的服务器目录');
  }
  return dir;
}

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'server';
}

function uniqueId(core, version) {
  const base = slugify(`${core}-${version}`);
  const taken = new Set(loadAll().map((s) => s.id));
  if (!taken.has(base)) return base;
  for (let i = 0; i < 20; i++) {
    const candidate = `${base}-${crypto.randomBytes(2).toString('hex')}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

// ---------------------------------------------------------------------------
// 网络工具
// ---------------------------------------------------------------------------

function describeNetError(err) {
  if (!err) return '未知错误';
  const code = err.code || '';
  const status = err.response && err.response.status;
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT' || /timeout/i.test(err.message || '')) {
    return '请求超时（Mojang/Paper 服务偶尔会很慢，请重试或检查网络/代理）';
  }
  if (['ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'ECONNREFUSED', 'ECONNRESET'].includes(code)) {
    return `网络不可达（${code}），请检查网络或代理设置`;
  }
  if (status === 404) return '资源不存在（404），请确认版本号';
  if (status === 403) return '访问被拒绝（403），可能需要代理';
  if (status === 429) return '请求过于频繁（429），请稍后重试';
  if (status && status >= 500) return `远端服务异常（${status}），请稍后重试`;
  return err.message || String(err);
}

async function getJson(url, options = {}) {
  const { timeout = 20000, retries = 3, label = '接口' } = options;
  let lastError = null;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await axios.get(url, {
        timeout,
        maxRedirects: 5,
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      });
      return res.data;
    } catch (err) {
      lastError = err;
      const status = err.response && err.response.status;
      // 4xx（除 429）重试没有意义
      if (status && status < 500 && status !== 429) break;
      if (attempt < retries - 1) await sleep(800 * (attempt + 1));
    }
  }
  throw new Error(`${label}请求失败：${describeNetError(lastError)}`);
}

function hashFile(file, algorithm) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algorithm);
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * 流式下载到 dest（先写 .part 再改名，避免半成品被当成完整文件）。
 */
async function download(url, dest, options = {}) {
  const { onProgress = null, retries = DOWNLOAD_RETRIES, timeout = 30000 } = options;
  const part = `${dest}.part`;
  await fsp.mkdir(path.dirname(dest), { recursive: true });

  let lastError = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await axios.get(url, {
        responseType: 'stream',
        timeout,
        maxRedirects: 5,
        headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
        validateStatus: (s) => s >= 200 && s < 300,
      });

      const total = Number(res.headers['content-length'] || 0);
      let received = 0;
      let lastEmit = 0;

      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(part);
        const fail = (err) => {
          res.data.destroy();
          out.destroy();
          reject(err);
        };
        res.data.on('error', fail);
        out.on('error', fail);
        res.data.on('data', (chunk) => {
          received += chunk.length;
          const now = Date.now();
          if (onProgress && (now - lastEmit > 200 || (total && received >= total))) {
            lastEmit = now;
            onProgress({
              received,
              total,
              percent: total ? Math.min(100, Math.round((received / total) * 100)) : null,
            });
          }
        });
        out.on('finish', resolve);
        res.data.pipe(out);
      });

      const stat = await fsp.stat(part);
      if (!stat.size) throw new Error('下载内容为空');
      if (total && stat.size !== total) {
        throw new Error(`下载不完整（${stat.size}/${total} 字节）`);
      }
      await fsp.rename(part, dest);
      if (onProgress) onProgress({ received: stat.size, total: stat.size, percent: 100 });
      return stat.size;
    } catch (err) {
      lastError = err;
      await fsp.rm(part, { force: true }).catch(() => {});
      if (attempt < retries - 1) await sleep(1000 * (attempt + 1));
    }
  }
  throw new Error(`文件下载失败：${describeNetError(lastError)}`);
}

// ---------------------------------------------------------------------------
// 各核心的服务端解析
// ---------------------------------------------------------------------------

async function resolveVanilla(version) {
  const manifest = await getJson(VANILLA_MANIFEST, { label: 'Mojang 版本清单' });
  const entry = (manifest && manifest.versions ? manifest.versions : []).find((v) => v.id === version);
  if (!entry) throw new Error(`Mojang 版本清单里没有 ${version}，请确认版本号是否拼写正确`);

  const detail = await getJson(entry.url, { label: `${version} 版本元数据` });
  const server = detail && detail.downloads && detail.downloads.server;
  if (!server || !server.url) {
    throw new Error(`${version} 没有官方服务端下载（1.2.5 及更早版本需要额外处理），请换用其它版本`);
  }
  return { url: server.url, sha1: server.sha1, size: server.size };
}

async function resolvePaper(version) {
  // PaperMC 旧版 v2 API 已于 2025 年下线（返回 410），统一使用 Fill v3。
  const url = `${PAPER_FILL_API}/projects/paper/versions/${encodeURIComponent(version)}/builds/latest`;
  let build;
  try {
    build = await getJson(url, { label: `Paper ${version} 构建信息`, retries: 3 });
  } catch (err) {
    throw new Error(
      `无法获取 Paper ${version} 的构建：${err.message}。请确认 Paper 支持该版本（可换 Vanilla / Fabric）`
    );
  }

  const downloads = (build && build.downloads) || {};
  const downloadInfo = downloads['server:default'] || Object.values(downloads)[0];
  if (!downloadInfo || !downloadInfo.url) {
    throw new Error(`Paper ${version} 的构建中没有可用的服务端下载地址`);
  }
  return {
    url: downloadInfo.url,
    sha256: downloadInfo.checksums && downloadInfo.checksums.sha256,
    fileName: downloadInfo.name,
    buildId: build.id,
    channel: build.channel,
    size: downloadInfo.size,
  };
}

async function resolveFabric(version) {
  const loaders = await getJson(`${FABRIC_META}/versions/loader/${encodeURIComponent(version)}`, {
    label: `Fabric ${version} Loader 列表`,
  });
  if (!Array.isArray(loaders) || loaders.length === 0) {
    throw new Error(`Fabric 没有 ${version} 对应的 Loader，请确认版本号`);
  }
  const loaderVersion = loaders[0] && loaders[0].loader && loaders[0].loader.version;
  if (!loaderVersion) throw new Error(`Fabric Loader 信息解析失败（${version}）`);

  const installers = await getJson(`${FABRIC_META}/versions/installer`, {
    label: 'Fabric 安装器列表',
  });
  const installer =
    (Array.isArray(installers) ? installers.find((i) => i.stable) : null) ||
    (Array.isArray(installers) ? installers[0] : null);
  if (!installer || !installer.url) throw new Error('无法获取 Fabric 安装器下载地址');

  return { loaderVersion, installerUrl: installer.url, installerVersion: installer.version };
}

// ---------------------------------------------------------------------------
// Java 探测
// ---------------------------------------------------------------------------

function javaExeName() {
  return process.platform === 'win32' ? 'java.exe' : 'java';
}

function existsFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** 扫描常见 JDK 安装目录（主要针对 Windows，其它平台给几个常见路径兜底） */
function scanJavaCandidates() {
  const found = [];
  const push = (dir) => {
    const exe = path.join(dir, 'bin', javaExeName());
    if (existsFile(exe)) found.push(exe);
  };

  const globDirs = (parent, fn) => {
    let entries = [];
    try {
      entries = fs.readdirSync(parent, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) fn(path.join(parent, entry.name));
    }
  };

  if (process.platform === 'win32') {
    const vendors = [
      'C:\\Program Files\\Eclipse Adoptium',
      'C:\\Program Files\\Java',
      'C:\\Program Files\\Microsoft',
      'C:\\Program Files\\BellSoft',
      'C:\\Program Files\\Amazon Corretto',
      'C:\\Program Files\\Zulu',
      'C:\\Program Files\\Semeru',
      'C:\\Program Files (x86)\\Java',
    ];
    for (const vendor of vendors) globDirs(vendor, push);
  } else if (process.platform === 'darwin') {
    globDirs('/Library/Java/JavaVirtualMachines', (dir) => push(path.join(dir, 'Contents', 'Home')));
    push('/opt/homebrew/opt/openjdk');
    push('/usr/local/opt/openjdk');
  } else {
    globDirs('/usr/lib/jvm', push);
  }

  // 版本号高的优先（目录名里通常带版本号）
  return found.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
}

function probeJavaVersion(javaExe) {
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let proc;
    try {
      proc = spawn(javaExe, ['-version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      return done(null);
    }

    const collect = (chunk) => {
      output += chunk.toString();
      if (output.length > 8192) output = output.slice(0, 8192);
    };
    proc.stdout.on('data', collect);
    proc.stderr.on('data', collect); // java -version 输出在 stderr
    proc.on('error', () => done(null));
    proc.on('close', () => done(parseJavaVersion(output)));
    setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
      done(parseJavaVersion(output));
    }, 8000).unref?.();
  });
}

/** 解析 `openjdk version "17.0.20.1"` / `java version "1.8.0_402"` */
function parseJavaVersion(text) {
  const match = /version\s+"(\d+)(?:\.(\d+))?(?:\.([\d_]+))?/.exec(text || '');
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2] || 0);
  if (major === 1) return { major: minor, raw: match[0] };
  return { major, raw: match[0] };
}

/** 粗略推断该 MC 版本所需 Java 主版本，仅用于提示，不阻断启动 */
function requiredJavaMajor(version) {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(version || ''));
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2] || 0);
  const patch = Number((match[3] || '0').replace(/_/g, '')) || 0;
  if (major > 1) return major >= 26 ? 25 : 21; // 新的年份式版本号（26.x 起）
  if (minor >= 21) return 21;
  if (minor === 20 && patch >= 5) return 21;
  if (minor >= 18) return 17;
  if (minor === 17) return 16;
  return 8;
}

async function resolveJava(hint) {
  const candidates = [];
  let probed = 0;
  if (hint) candidates.push(String(hint).trim());
  if (process.env.JAVA_HOME) {
    candidates.push(path.join(process.env.JAVA_HOME, 'bin', javaExeName()));
  }
  candidates.push(...scanJavaCandidates());

  for (const candidate of candidates) {
    if (!candidate) continue;
    if (probed >= 6) break; // 机器上装了很多 JDK 时避免逐个探测
    // 用户可能直接填了 java 目录而不是可执行文件
    const looksLikeDir = !/java(\.exe)?$/i.test(candidate);
    const exe = looksLikeDir && fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()
      ? path.join(candidate, 'bin', javaExeName())
      : candidate;
    if (exe !== javaExeName() && !existsFile(exe)) continue;
    probed += 1;
    const version = await probeJavaVersion(exe);
    if (version) return { exe, version };
  }

  // 最后再试试 PATH 里的 java
  const fallback = javaExeName();
  const version = await probeJavaVersion(fallback);
  if (version) return { exe: fallback, version };
  return { exe: null, version: null };
}

// ---------------------------------------------------------------------------
// 端口 / 配置文件
// ---------------------------------------------------------------------------

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    try {
      server.listen(port, '0.0.0.0');
    } catch {
      resolve(false);
    }
  });
}

async function pickFreePort(preferred, serverId) {
  const start = clamp(Number(preferred) || DEFAULT_PORT, 1, 65535);
  if (await isPortFree(start)) return start;
  for (let port = start + 1; port <= Math.min(65535, start + PORT_SCAN_RANGE); port++) {
    if (await isPortFree(port)) {
      if (serverId) log(serverId, `端口 ${start} 已被占用，改用 ${port}`, 'warn');
      return port;
    }
  }
  for (let port = DEFAULT_PORT; port < DEFAULT_PORT + PORT_SCAN_RANGE; port++) {
    if (port !== start && (await isPortFree(port))) {
      if (serverId) log(serverId, `端口 ${start} 已被占用，改用 ${port}`, 'warn');
      return port;
    }
  }
  throw new Error('找不到可用的服务器端口（25565 附近都被占用）');
}

function readProperties(file) {
  const map = {};
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return map;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index < 0) continue;
    map[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1);
  }
  return map;
}

function writeProperties(file, map) {
  const lines = [
    '#Minecraft server properties',
    '#Generated by Viskluke Launcher',
    `#${new Date().toISOString()}`,
  ];
  for (const [key, value] of Object.entries(map)) lines.push(`${key}=${value}`);
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
}

async function ensureEula(dir) {
  await fsp.writeFile(
    path.join(dir, 'eula.txt'),
    [
      '#By changing the setting below to TRUE you are indicating your agreement to Mojang EULA',
      '#https://aka.ms/MinecraftEULA',
      'eula=true',
      '',
    ].join('\n'),
    'utf8'
  );
}

async function ensureProperties(dir, meta) {
  const file = path.join(dir, 'server.properties');
  const existing = readProperties(file);
  const merged = { ...existing };

  // 端口由我们决定（DNS 的 SRV 记录必须与实际端口一致）
  merged['server-port'] = String(meta.port);
  if (merged['online-mode'] === undefined) {
    merged['online-mode'] = meta.onlineMode ? 'true' : 'false';
  }
  // 白名单：每次开服都按界面选择覆盖，避免上次的手改残留
  merged['white-list'] = meta.whitelist === false ? 'false' : 'true';
  if (merged['white-list'] === 'true') merged['enforce-whitelist'] = 'true';
  if (merged['motd'] === undefined) merged.motd = meta.motd;
  if (merged['max-players'] === undefined) merged['max-players'] = String(meta.maxPlayers);
  if (merged['enable-rcon'] === undefined) merged['enable-rcon'] = 'false';
  if (!meta.onlineMode && merged['enforce-secure-profile'] === undefined) {
    // 离线服务器建议关闭，否则部分客户端会被踢出
    merged['enforce-secure-profile'] = 'false';
  }

  writeProperties(file, merged);
  return merged;
}

/** 兼容两种 Fabric 启动器产物，并确保 properties 指向原版 server.jar */
async function ensureFabricLaunchFiles(dir) {
  const launchNames = ['fabric-server-launch.jar', 'fabric-server-launcher.jar'];
  const launcherJar = launchNames.find((name) => existsFile(path.join(dir, name))) || null;
  if (!launcherJar) return null;

  const propsFile = path.join(dir, 'fabric-server-launcher.properties');
  if (existsFile(propsFile)) {
    const props = readProperties(propsFile);
    if (!props.serverJar) {
      props.serverJar = 'server.jar';
      writeProperties(propsFile, props);
    }
  } else {
    writeProperties(propsFile, { serverJar: 'server.jar' });
  }
  return launcherJar;
}

/**
 * Fabric 启动器通过 fabric-server-launcher.properties 里的 serverJar 找原版 jar，
 * 这里按它声明的文件名补齐（缺失时自动下载 Vanilla 服务端）。
 */
async function ensureFabricServerJar(meta, dir) {
  const props = readProperties(path.join(dir, 'fabric-server-launcher.properties'));
  const serverJarName = props.serverJar || 'server.jar';
  const target = path.join(dir, path.basename(serverJarName)); // 只取文件名，避免被篡改出目录穿越
  if (existsFile(target)) return serverJarName;

  const vanilla = await resolveVanilla(meta.version);
  await downloadWithVerify(meta, vanilla.url, target, {
    sha1: vanilla.sha1,
    expectedSize: vanilla.size,
    label: `Vanilla ${meta.version}（Fabric 依赖）`,
  });
  return serverJarName;
}

// ---------------------------------------------------------------------------
// 服务端准备（下载 / 安装）
// ---------------------------------------------------------------------------

function markerFile(dir) {
  return path.join(dir, '.viskluke-setup.json');
}

async function readMarker(dir) {
  try {
    return JSON.parse(await fsp.readFile(markerFile(dir), 'utf8'));
  } catch {
    return null;
  }
}

async function writeMarker(dir, data) {
  await fsp.writeFile(markerFile(dir), JSON.stringify({ ...data, at: new Date().toISOString() }, null, 2));
}

/**
 * 准备 server.jar / fabric-server-launch.jar。
 * 若已准备过（marker 匹配且文件存在）则跳过下载，重启实例时不再重复下载 50MB。
 */
async function prepareServerFiles(meta, dir) {
  const marker = await readMarker(dir);
  const launcherJar = marker && marker.core === meta.core && marker.version === meta.version
    ? marker.launcherJar
    : null;
  if (launcherJar && existsFile(path.join(dir, launcherJar))) {
    log(meta.id, `已存在服务端文件（${launcherJar}），跳过下载`, 'system');
    return { launcherJar, reused: true };
  }

  if (meta.core === 'vanilla') {
    emitProgress(meta.id, 'resolve', { message: '获取 Mojang 版本清单…' });
    const info = await resolveVanilla(meta.version);
    log(meta.id, `Vanilla ${meta.version} 服务端：${formatBytes(info.size)}`, 'system');
    await downloadWithVerify(meta, info.url, path.join(dir, 'server.jar'), {
      sha1: info.sha1,
      expectedSize: info.size,
      label: `Vanilla ${meta.version}`,
    });
    await writeMarker(dir, { core: meta.core, version: meta.version, launcherJar: 'server.jar' });
    return { launcherJar: 'server.jar', reused: false };
  }

  if (meta.core === 'paper') {
    emitProgress(meta.id, 'resolve', { message: `获取 Paper ${meta.version} 构建…` });
    const info = await resolvePaper(meta.version);
    log(meta.id, `Paper ${meta.version} build ${info.buildId}（${info.channel}）：${formatBytes(info.size)}`, 'system');
    await downloadWithVerify(meta, info.url, path.join(dir, 'server.jar'), {
      sha256: info.sha256,
      expectedSize: info.size,
      label: `Paper ${meta.version} build ${info.buildId}`,
    });
    await writeMarker(dir, {
      core: meta.core,
      version: meta.version,
      launcherJar: 'server.jar',
      buildId: info.buildId,
    });
    return { launcherJar: 'server.jar', reused: false };
  }

  // ---------- Fabric ----------
  emitProgress(meta.id, 'resolve', { message: `获取 Fabric Loader（${meta.version}）…` });
  const fabric = await resolveFabric(meta.version);
  log(meta.id, `Fabric Loader ${fabric.loaderVersion} + Installer ${fabric.installerVersion}`, 'system');

  const java = await resolveJava(meta.javaPath);
  if (!java.exe) {
    throw new Error('未检测到 Java：安装 Fabric 需要先用 Java 运行安装器，请安装 Java 17+ 或填写 java 路径');
  }

  const installerJar = path.join(dir, 'fabric-installer.jar');
  emitProgress(meta.id, 'download', { message: '下载 Fabric 安装器…' });
  await download(fabric.installerUrl, installerJar, {
    onProgress: (p) => emitProgress(meta.id, 'download', { ...p, message: '下载 Fabric 安装器…' }),
  });

  emitProgress(meta.id, 'install', { message: '运行 Fabric 安装器…' });
  let code = await runFabricInstaller({
    serverId: meta.id,
    javaExe: java.exe,
    dir,
    installerJar,
    version: meta.version,
    loaderVersion: fabric.loaderVersion,
    downloadMinecraft: true,
  });

  if (code !== 0) {
    log(meta.id, 'Fabric 安装器自动下载原版失败，改为手动准备 server.jar 后重试…', 'warn');
    if (!existsFile(path.join(dir, 'server.jar'))) {
      const vanilla = await resolveVanilla(meta.version);
      await downloadWithVerify(meta, vanilla.url, path.join(dir, 'server.jar'), {
        sha1: vanilla.sha1,
        expectedSize: vanilla.size,
        label: `Vanilla ${meta.version}（Fabric 依赖）`,
      });
    }
    code = await runFabricInstaller({
      serverId: meta.id,
      javaExe: java.exe,
      dir,
      installerJar,
      version: meta.version,
      loaderVersion: fabric.loaderVersion,
      downloadMinecraft: false,
    });
  }

  const launchJar = code === 0 ? await ensureFabricLaunchFiles(dir) : null;
  if (!launchJar) {
    throw new Error('Fabric 安装失败：没有生成 fabric-server-launch.jar（请查看上方日志）');
  }
  await ensureFabricServerJar(meta, dir);
  await fsp.rm(installerJar, { force: true }).catch(() => {});
  await writeMarker(dir, {
    core: meta.core,
    version: meta.version,
    launcherJar: launchJar,
    loaderVersion: fabric.loaderVersion,
  });
  return { launcherJar: launchJar, reused: false };
}

async function downloadWithVerify(meta, url, dest, options) {
  const { sha1, sha256, expectedSize, label } = options;
  log(meta.id, `开始下载 ${label}…`, 'system');
  await download(url, dest, {
    onProgress: (p) => {
      emitProgress(meta.id, 'download', {
        ...p,
        message: `下载 ${label}…`,
        detail: p.percent === null ? formatBytes(p.received) : `${formatBytes(p.received)} / ${formatBytes(p.total)}`,
      });
    },
  });

  emitProgress(meta.id, 'verify', { message: '校验文件完整性…' });
  const stat = await fsp.stat(dest);
  if (expectedSize && stat.size !== expectedSize) {
    await fsp.rm(dest, { force: true }).catch(() => {});
    throw new Error(`${label} 下载大小不一致（${stat.size} != ${expectedSize}），已删除，请重试`);
  }
  if (sha1) {
    const actual = await hashFile(dest, 'sha1');
    if (actual.toLowerCase() !== String(sha1).toLowerCase()) {
      await fsp.rm(dest, { force: true }).catch(() => {});
      throw new Error(`${label} SHA1 校验失败，文件已删除，请重试`);
    }
  }
  if (sha256) {
    const actual = await hashFile(dest, 'sha256');
    if (actual.toLowerCase() !== String(sha256).toLowerCase()) {
      await fsp.rm(dest, { force: true }).catch(() => {});
      throw new Error(`${label} SHA256 校验失败，文件已删除，请重试`);
    }
  }
  log(meta.id, `${label} 下载完成（${formatBytes(stat.size)}）`, 'system');
}

/**
 * 运行 Fabric 安装器：java -jar fabric-installer.jar server -dir <dir> -mcversion <v> -loader <l> [-downloadMinecraft]
 */
function runFabricInstaller(options) {
  const { serverId, javaExe, dir, installerJar, version, loaderVersion, downloadMinecraft } = options;
  const args = [
    '-jar',
    installerJar,
    'server',
    '-dir',
    dir,
    '-mcversion',
    version,
    '-loader',
    loaderVersion,
  ];
  if (downloadMinecraft) args.push('-downloadMinecraft');

  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(javaExe, args, { cwd: dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      log(serverId, `Fabric 安装器启动失败：${err.message}`, 'error');
      return resolve(-1);
    }

    const relay = (stream) => {
      let buffer = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).replace(/\r$/, '');
          buffer = buffer.slice(index + 1);
          if (line.trim()) log(serverId, `[installer] ${line}`, 'system');
        }
      });
    };
    relay(proc.stdout);
    relay(proc.stderr);

    const timer = setTimeout(() => {
      log(serverId, 'Fabric 安装器超时（5 分钟），已终止', 'error');
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
    }, 5 * 60 * 1000);

    proc.on('error', (err) => {
      clearTimeout(timer);
      log(serverId, `Fabric 安装器异常：${err.message}`, 'error');
      resolve(-1);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      log(serverId, `Fabric 安装器退出（code=${code}）`, 'system');
      resolve(code === null ? -1 : code);
    });
  });
}

// ---------------------------------------------------------------------------
// 进程启动 / 日志
// ---------------------------------------------------------------------------

function spawnServerProcess(meta, dir, javaExe, launcherJar) {
  const args = [`-Xmx${meta.maxMemory}`, '-Dfile.encoding=UTF-8', '-XX:+UseG1GC', '-jar', launcherJar, 'nogui'];
  log(meta.id, `启动命令：${javaExe} ${args.join(' ')}`, 'system');

  return spawn(javaExe, args, {
    cwd: dir,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });
}

function wireConsole(meta, proc) {
  const serverId = meta.id;

  const handleLine = (line, level) => {
    const text = line.replace(/\r$/, '');
    if (!text.trim()) return;

    let lineLevel = level === 'stderr' ? 'error' : 'info';
    if (/^(WARN|\[WARN\])/i.test(text) || / warning:/i.test(text)) lineLevel = 'warn';
    if (/(UnsupportedClassVersionError|OutOfMemoryError|Exception in thread|Unable to access jarfile)/.test(text)) {
      lineLevel = 'error';
    }
    log(serverId, text, lineLevel);

    // 服务器真正就绪的信号
    if (/Done \(|For help, type "help"/i.test(text)) {
      setStatus(serverId, 'online');
      log(serverId, '服务器已就绪，玩家可以进入游戏了', 'system');
      push('server:ready', { serverId, port: meta.port, address: meta.address });
    }
    if (/UnsupportedClassVersionError/.test(text)) {
      log(serverId, `Java 版本过低：该服务端需要 Java ${requiredJavaMajor(meta.version)}+，请在实例里指定更高的 java 路径`, 'error');
    }
  };

  const wire = (stream, level) => {
    let buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        handleLine(line, level);
      }
      if (buffer.length > 8192) {
        handleLine(buffer, level);
        buffer = '';
      }
    });
  };

  wire(proc.stdout, 'stdout');
  wire(proc.stderr, 'stderr');
}

function cleanupDnsAfterStop(serverId) {
  const meta = findOne(serverId);
  if (!meta || !meta.dns || !meta.dns.enabled) return;
  cloudflare
    .remove({
      zoneId: meta.dns.zoneId,
      records: meta.dns.records || {},
      address: meta.address,
      suffix: meta.suffix,
    })
    .then(() => {
      patchMeta(serverId, { dns: { ...meta.dns, enabled: false, records: {} } });
      log(serverId, `已删除解析记录：${meta.address}`, 'system');
      push('server:dns', { serverId, ok: true, removed: true, address: meta.address });
    })
    .catch((err) => {
      log(serverId, `删除解析记录失败：${err.message}`, 'error');
      push('server:dns', { serverId, ok: false, removed: true, error: err.message });
    });
}

function onProcessExit(meta, proc, code, signal) {
  const serverId = meta.id;
  const runtime = runtimes.get(serverId);
  if (runtime && runtime.proc === proc) {
    runtime.proc = null;
    runtime.status = 'stopped';
    runtime.exitedAt = Date.now();
  }

  const abnormal = code !== 0;
  log(
    serverId,
    `服务器进程已退出（code=${code === null ? 'null' : code}${signal ? `, signal=${signal}` : ''}）`,
    abnormal ? 'error' : 'system'
  );
  if (code === 1) {
    log(serverId, '退出码 1 常见原因：Java 未找到 / Java 版本过低 / 端口被占用 / 服务端 jar 损坏', 'warn');
  }

  patchMeta(serverId, {
    status: 'stopped',
    lastExitCode: code === null ? null : code,
    lastStoppedAt: new Date().toISOString(),
  });
  push('server:status', { serverId, status: 'stopped', exitCode: code, signal });

  if (meta.removeDnsOnStop !== false) cleanupDnsAfterStop(serverId);
}

// ---------------------------------------------------------------------------
// 元信息构造 / 校验
// ---------------------------------------------------------------------------

function buildMeta(input) {
  const core = assertCore(input.core);
  const version = assertVersion(input.version);
  const maxMemory = assertMemory(input.maxMemory || '2G');
  const port = clamp(Number(input.port) || DEFAULT_PORT, 1, 65535);
  // 前缀留空 = 本次不绑定域名（纯局域网服务器也能开）
  const rawPrefix = String(input.prefix || '').trim();
  const prefix = rawPrefix ? normalizePrefix(rawPrefix) : '';
  const suffix = assertSuffix(input.suffix || cloudflare.configuredSuffixes()[0]);
  const address = prefix ? `${prefix}.${suffix}` : '';
  const whitelistPlayers = normalizePlayerList(input.whitelistPlayers);
  // 有域名（会暴露到公网）默认开白名单；纯局域网默认沿用界面选择
  const whitelist = input.whitelist === undefined ? Boolean(address) : input.whitelist !== false;

  return {
    id: uniqueId(core, version),
    name: String(input.name || `${input.prefix || core} ${version}`).slice(0, 60),
    core,
    version,
    maxMemory,
    minMemory: input.minMemory ? assertMemory(input.minMemory) : null,
    javaPath: String(input.javaPath || '').trim(),
    port,
    onlineMode: input.onlineMode !== false, // 正版验证默认开
    whitelist,
    whitelistPlayers: whitelistPlayers.players,
    maxPlayers: clamp(Number(input.maxPlayers) || 20, 1, 200),
    motd: String(input.motd || `Viskluke | ${prefix || core}`).slice(0, 59),
    prefix,
    suffix,
    address,
    dns: { enabled: false, zoneId: null, mode: null, records: {}, target: null },
    dnsRequested: Boolean(address) && input.enableDns !== false,
    removeDnsOnStop: input.removeDnsOnStop !== false,
    setup: { launcherJar: null },
    createdAt: new Date().toISOString(),
    lastError: null,
  };
}

function ensureAddressAvailable(meta) {
  if (!meta.address) return;
  const clash = loadAll().find((s) => s.id !== meta.id && s.address === meta.address);
  if (clash) {
    throw new Error(`域名 ${meta.address} 已被服务器「${clash.name || clash.id}」使用，请换一个前缀`);
  }
}

// ---------------------------------------------------------------------------
// 对外：启动 / 停止 / 删除 / 命令
// ---------------------------------------------------------------------------

async function startServer(input = {}) {
  let meta = input.id ? findOne(input.id) : null;
  if (input.id && !meta) return { ok: false, error: '找不到该服务器记录' };

  try {
    if (meta) {
      // 已存在实例：允许覆盖部分配置
      meta = {
        ...meta,
        maxMemory: input.maxMemory ? assertMemory(input.maxMemory) : meta.maxMemory,
        javaPath: input.javaPath !== undefined ? String(input.javaPath || '').trim() : meta.javaPath,
        onlineMode: input.onlineMode !== undefined ? Boolean(input.onlineMode) : meta.onlineMode,
        whitelist: input.whitelist !== undefined ? input.whitelist !== false : meta.whitelist !== false,
        whitelistPlayers: input.whitelistPlayers !== undefined
          ? normalizePlayerList(input.whitelistPlayers).players
          : meta.whitelistPlayers || [],
      };
    } else {
      meta = buildMeta(input);
    }

    if (isRunning(meta.id)) return { ok: false, error: '该服务器已经在运行中' };
    ensureAddressAvailable(meta);

    const dir = serverDir(meta.id);
    runtimes.set(meta.id, { status: 'starting', proc: null, logs: [], startedAt: 0 });
    push('server:status', { serverId: meta.id, status: 'starting' });
    log(meta.id, `==== 准备 ${meta.core} ${meta.version}（${meta.id}）====`, 'system');

    await fsp.mkdir(dir, { recursive: true });
    await ensureEula(dir);

    // 端口：沿用上次记录，被占用时自动顺延
    meta.port = await pickFreePort(meta.port, meta.id);
    await ensureProperties(dir, meta);
    log(meta.id, `端口 ${meta.port}，最大内存 ${meta.maxMemory}，正版验证 ${meta.onlineMode ? '开' : '关'}`, 'system');

    // 白名单
    try {
      const wl = await ensureWhitelist(dir, meta);
      if (wl.enabled) {
        log(meta.id, `白名单：${wl.written} 人（${wl.file}）`, 'system');
        for (const warning of wl.warnings) log(meta.id, warning, 'warn');
        if (!wl.written) {
          log(
            meta.id,
            '白名单已开启但名单是空的：现在谁都进不来。请在「服务器详情 → 白名单」里添加玩家后重启，或先关掉白名单',
            'error'
          );
        }
      } else {
        log(meta.id, '白名单：关闭（任何知道地址的人都能连）', meta.address ? 'warn' : 'system');
      }
    } catch (err) {
      log(meta.id, `白名单写入失败：${err.message}`, 'warn');
    }

    // Java
    const java = await resolveJava(meta.javaPath);
    if (!java.exe) {
      throw new Error(
        '未检测到 Java 运行环境：请安装 JDK/JRE（1.20.5+ 需要 Java 21，1.18+ 需要 Java 17），或在界面上填写 java 可执行文件路径'
      );
    }
    log(meta.id, `Java：${java.exe}（版本 ${java.version.major}）`, 'system');
    const required = requiredJavaMajor(meta.version);
    if (required && java.version.major < required) {
      log(meta.id, `警告：${meta.version} 建议使用 Java ${required}+，当前为 Java ${java.version.major}，可能启动失败`, 'warn');
    }

    // 下载 / 安装服务端
    const prepared = await prepareServerFiles(meta, dir);

    // 启动进程
    emitProgress(meta.id, 'spawn', { message: '启动 Java 进程…' });
    const proc = spawnServerProcess(meta, dir, java.exe, prepared.launcherJar);

    await new Promise((resolve, reject) => {
      const onSpawn = () => {
        proc.removeListener('error', onError);
        resolve();
      };
      const onError = (err) => {
        proc.removeListener('spawn', onSpawn);
        if (err.code === 'ENOENT') {
          reject(new Error(`无法执行 Java：${java.exe}（路径不存在或没有执行权限）`));
        } else {
          reject(new Error(`无法启动 Java 进程：${err.message}`));
        }
      };
      proc.once('spawn', onSpawn);
      proc.once('error', onError);
    });

    const runtime = runtimes.get(meta.id);
    runtime.proc = proc;
    runtime.startedAt = Date.now();
    runtime.status = 'starting';

    meta = upsertMeta({
      ...meta,
      status: 'running',
      setup: { launcherJar: prepared.launcherJar },
      lastStartedAt: new Date().toISOString(),
      lastError: null,
    });

    log(meta.id, `Java 进程已启动（PID ${proc.pid}）`, 'system');
    wireConsole(meta, proc);

    proc.on('exit', (code, signal) => onProcessExit(meta, proc, code, signal));
    proc.on('error', (err) => log(meta.id, `进程错误：${err.message}`, 'error'));

    emitProgress(meta.id, 'done', { message: '启动完成' });
    push('server:status', { serverId: meta.id, status: 'starting' });

    // 域名解析（失败不影响服务器运行）
    let dnsInfo = null;
    const dnsWanted = input.enableDns === true || meta.dnsRequested !== false;
    if (meta.address && dnsWanted) {
      try {
        dnsInfo = await syncDns(meta.id);
      } catch (err) {
        log(meta.id, `Viskluke Address 创建失败：${err.message}（服务器仍在运行）`, 'error');
        push('server:dns', { serverId: meta.id, ok: false, error: err.message });
      }
    }

    return { ok: true, server: decorate(findOne(meta.id) || meta), dns: dnsInfo, dir };
  } catch (err) {
    const serverId = meta && meta.id;
    if (serverId) {
      log(serverId, `启动失败：${err.message}`, 'error');
      const runtime = runtimes.get(serverId);
      if (runtime && !runtime.proc) runtime.status = 'stopped';
      if (findOne(serverId)) patchMeta(serverId, { lastError: err.message });
      push('server:status', { serverId, status: 'stopped', error: err.message });
      emitProgress(serverId, 'error', { message: err.message });
    }
    return { ok: false, error: err.message };
  }
}

async function stopServer(serverId, options = {}) {
  const { force = false, timeoutMs = 25000, removeDns = true } = options;
  const runtime = runtimes.get(serverId);
  const meta = findOne(serverId);

  if (!runtime || !runtime.proc) {
    if (removeDns && meta) {
      try {
        await removeDnsFor(serverId);
      } catch (err) {
        return { ok: false, error: err.message, alreadyStopped: true };
      }
    }
    return { ok: true, alreadyStopped: true };
  }

  const proc = runtime.proc;
  setStatus(serverId, 'stopping');
  const exited = new Promise((resolve) => proc.once('exit', () => resolve('exit')));

  if (force) {
    log(serverId, '强制结束 Java 进程', 'warn');
    try {
      proc.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  } else {
    log(serverId, '向服务器发送 stop 指令，等待保存世界…', 'system');
    try {
      proc.stdin.write('stop\n');
    } catch {
      log(serverId, '无法写入服务器 stdin，改用强制结束', 'warn');
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
    }
  }

  const timeout = sleep(timeoutMs).then(() => 'timeout');
  const result = await Promise.race([exited, timeout]);

  if (result === 'timeout') {
    log(serverId, `${Math.round(timeoutMs / 1000)} 秒内未退出，强制结束进程`, 'warn');
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
    await Promise.race([exited, sleep(5000)]);
  }

  // 进程退出后 onProcessExit 会自动清理 DNS；这里再兜底一次（幂等）
  if (removeDns && meta && meta.dns && meta.dns.enabled && result === 'timeout') {
    try {
      await removeDnsFor(serverId);
    } catch {
      /* 已在 onProcessExit 记录 */
    }
  }
  return { ok: true };
}

async function deleteServer(serverId, options = {}) {
  const { deleteFiles = true, removeDns = true } = options;
  const meta = findOne(serverId);
  if (!meta) return { ok: false, error: '找不到该服务器记录' };

  try {
    if (isRunning(serverId)) {
      await stopServer(serverId, { removeDns: false });
    }
    if (removeDns) {
      try {
        await removeDnsFor(serverId);
      } catch (err) {
        log(serverId, `删除解析记录失败：${err.message}`, 'warn');
      }
    }
    if (deleteFiles) {
      const dir = serverDir(serverId); // 内含路径穿越校验
      const root = path.resolve(serversRoot());
      if (path.resolve(dir) !== root && path.resolve(dir).startsWith(`${root}${path.sep}`)) {
        await fsp.rm(dir, { recursive: true, force: true });
      }
    }
    removeMeta(serverId);
    runtimes.delete(serverId);
    push('server:status', { serverId, status: 'deleted' });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function sendCommand(serverId, command) {
  const runtime = runtimes.get(serverId);
  if (!runtime || !runtime.proc) return { ok: false, error: '该服务器没有在运行' };
  const text = String(command || '').replace(/[\r\n]+/g, ' ').trim();
  if (!text) return { ok: false, error: '命令不能为空' };
  if (text.length > 512) return { ok: false, error: '命令过长' };
  try {
    runtime.proc.stdin.write(`${text}\n`);
    log(serverId, `> ${text}`, 'cmd');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `命令发送失败：${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// 域名解析
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 白名单（运行时改，不用重启）
// ---------------------------------------------------------------------------

/**
 * 修改某台服务器的白名单。
 * 服务器在跑就同时发控制台命令（立即生效），不在跑就只落盘。
 * @param {{ id: string, players?: string[], whitelist?: boolean }} input
 */
async function setWhitelist(input = {}) {
  const meta = findOne(input.id);
  if (!meta) throw new Error('找不到该服务器记录');

  const list = input.players !== undefined
    ? normalizePlayerList(input.players)
    : { players: meta.whitelistPlayers || [], skipped: [] };
  const enabled = input.whitelist !== undefined ? input.whitelist !== false : meta.whitelist !== false;

  const dir = serverDir(meta.id);
  await fsp.mkdir(dir, { recursive: true });

  const next = { ...meta, whitelist: enabled, whitelistPlayers: list.players };
  const result = await ensureWhitelist(dir, next, { players: list.players, enabled });
  patchMeta(meta.id, { whitelist: enabled, whitelistPlayers: list.players });

  const running = isRunning(meta.id);
  const commands = [];
  if (running) {
    commands.push(enabled ? 'whitelist on' : 'whitelist off');
    const before = new Set((meta.whitelistPlayers || []).map((name) => name.toLowerCase()));
    const after = new Set(list.players.map((name) => name.toLowerCase()));
    for (const name of list.players) {
      if (!before.has(name.toLowerCase())) commands.push(`whitelist add ${name}`);
    }
    for (const name of meta.whitelistPlayers || []) {
      if (!after.has(name.toLowerCase())) commands.push(`whitelist remove ${name}`);
    }
    if (enabled) commands.push('whitelist reload');
    for (const command of commands) {
      // 逐条下发：服务器没就绪时 sendCommand 会返回失败，不能整批丢
      await sendCommand(meta.id, command).catch(() => {});
      await sleep(120);
    }
    log(meta.id, `白名单已更新：${enabled ? '开' : '关'}，${list.players.length} 人（已下发 ${commands.length} 条命令）`, 'system');
  } else {
    log(meta.id, `白名单已保存：${enabled ? '开' : '关'}，${list.players.length} 人（下次开服生效）`, 'system');
  }

  for (const warning of result.warnings || []) log(meta.id, warning, 'warn');

  return {
    ok: true,
    applied: running ? 'live' : 'file',
    whitelist: enabled,
    players: list.players,
    skipped: list.skipped,
    written: result.written,
    commands,
    warnings: result.warnings || [],
    file: result.file,
  };
}

async function syncDns(serverId) {
  const meta = findOne(serverId);
  if (!meta) throw new Error('找不到该服务器记录');
  if (!meta.prefix) throw new Error('该服务器没有设置域名前缀');

  // 手动解析：DNS 不在 Cloudflare（注册商可能是 GNAME / 阿里云），我们只算好该填什么
  if (cloudflare.transportFor(meta.suffix) === 'manual') {
    const manual = await cloudflare.manualRecords({
      prefix: meta.prefix,
      suffix: meta.suffix,
      port: meta.port || DEFAULT_PORT,
      ipv6: netcheck.globalIpv6(),
    });
    const dns = {
      enabled: false,
      manual: true,
      address: manual.address,
      targetIp: manual.ip,
      privateIp: manual.privateIp,
      records: manual.records,
      updatedAt: new Date().toISOString(),
    };
    patchMeta(serverId, { dns: { ...dns, records: [] }, address: manual.address, dnsRequested: true });

    log(serverId, `Viskluke Address（手动解析）：${manual.address} 需要在你的 DNS 后台添加 ${manual.records.length} 条记录`, 'warn');
    for (const record of manual.records) {
      log(serverId, `  ${record.type}  ${record.name}  →  ${record.value}    （${record.note}）`, 'warn');
    }
    if (manual.privateIp) {
      log(serverId, `提示：当前探测到的 IP ${manual.ip} 是内网/CGNAT 地址，外面的人连不进来，需要端口映射或隧道`, 'warn');
    }

    push('server:dns', { serverId, ok: true, manual: true, dns });
    return dns;
  }

  const info = await cloudflare.sync({
    prefix: meta.prefix,
    suffix: meta.suffix,
    port: meta.port || DEFAULT_PORT,
    ttl: meta.dns && meta.dns.ttl,
    previous: meta.dns || {},
    // 有原生公网 IPv6 就顺手建 AAAA → 双栈，IPv6 玩家不用端口映射也能直连
    ipv6: netcheck.globalIpv6(),
  });

  const dns = {
    enabled: true,
    zoneId: info.zoneId,
    mode: info.mode,
    address: info.address,
    srvName: info.srvName,
    srvTarget: info.srvTarget,
    targetIp: info.targetIp,
    targetIpv6: info.targetIpv6 || null,
    targetHost: info.targetHost,
    ttl: info.ttl,
    port: info.port,
    records: info.records,
    updatedAt: new Date().toISOString(),
  };
  patchMeta(serverId, { dns, address: info.address, dnsRequested: true });

  const targetParts = [];
  if (info.targetIpv6) targetParts.push(`${info.targetIpv6}（AAAA）`);
  if (info.targetIp) targetParts.push(`${info.targetIp}（A）`);
  if (info.targetHost) targetParts.push(`${info.targetHost}（CNAME）`);
  const target = targetParts.join(' + ') || '(无)';
  log(serverId, `Viskluke Address 已生效：${info.address} → ${target}，SRV 端口 ${info.port}`, 'system');
  if (info.targetIpv6 && !info.targetIp) {
    log(serverId, '提示：只建了 AAAA，纯 IPv4 的玩家连不上；要让所有人都能进还需要 IPv4 端口映射', 'warn');
  }
  for (const warning of info.warnings || []) log(serverId, `提示：${warning}`, 'warn');

  push('server:dns', { serverId, ok: true, dns });
  return dns;
}

async function removeDnsFor(serverId) {
  const meta = findOne(serverId);
  if (!meta) throw new Error('找不到该服务器记录');
  if (!meta.dns || !meta.dns.enabled) return { ok: true, skipped: true };

  await cloudflare.remove({
    zoneId: meta.dns.zoneId,
    records: meta.dns.records || {},
    address: meta.address,
    suffix: meta.suffix,
  });

  patchMeta(serverId, { dns: { ...meta.dns, enabled: false, records: {} } });
  log(serverId, `已删除解析记录：${meta.address}`, 'system');
  push('server:dns', { serverId, ok: true, removed: true, address: meta.address });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 其它
// ---------------------------------------------------------------------------

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!value || value < 0) return '未知大小';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

async function openFolder(serverId) {
  const dir = serverDir(serverId);
  const error = await shell.openPath(dir);
  return error ? { ok: false, error } : { ok: true, dir };
}

function javaInfo() {
  return resolveJava('');
}

/** 应用退出时优雅关闭所有服务器（每个最多等 8 秒） */
async function shutdownAll() {
  const ids = [...runtimes.entries()].filter(([, rt]) => rt.proc).map(([id]) => id);
  await Promise.allSettled(ids.map((id) => stopServer(id, { timeoutMs: 8000 })));
}

module.exports = {
  CORES,
  DEFAULT_PORT,
  attachWindow,
  list,
  getLogs,
  startServer,
  stopServer,
  deleteServer,
  sendCommand,
  setWhitelist,
  syncDns,
  removeDnsFor,
  openFolder,
  shutdownAll,
  javaInfo,
  lanAddress,
  // 供测试/复用
  _internal: {
    buildMeta,
    serverDir,
    serversRoot,
    parseJavaVersion,
    requiredJavaMajor,
    isPortFree,
    pickFreePort,
    readProperties,
    writeProperties,
    ensureProperties,
    resolveVanilla,
    resolvePaper,
    resolveFabric,
    normalizePrefix,
    normalizePlayerList,
    ensureWhitelist,
    readWhitelistFile,
    whitelistPath,
    lanAddress,
    assertMemory,
    formatBytes,
  },
};
