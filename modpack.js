'use strict';

/**
 * modpack.js —— Modrinth 整合包（.mrpack）解包安装
 *
 * .mrpack 本质是一个 zip：
 *   modrinth.index.json   ← 清单：game / dependencies / files[]
 *   overrides/            ← 客户端与服务端都要的覆盖文件（config、resourcepacks…）
 *   client-overrides/     ← 只有客户端要（本启动器是客户端，需要解压）
 *   server-overrides/     ← 服务端专用（客户端忽略）
 *
 * 安装流程：
 *   1. 读清单并校验（game 必须是 minecraft，formatVersion 不能高于支持值）
 *   2. files[] 逐个下载到实例目录（path 相对实例根，通常 mods/xxx.jar）
 *      · env.client === 'unsupported' 的文件跳过（服务端专用模组）
 *      · 已存在且大小一致的文件跳过 → 重复安装等于"续传修复"
 *      · 有 sha512 就校验，校验失败删除并记为失败项
 *      · 并发 2，单文件最多重试 3 次，避免 EMFILE
 *   3. 解压 overrides/ 与 client-overrides/（zip-slip 防护）
 *   4. 写 .viskluke-modpack.json 标记，界面据此显示"整合包"
 *
 * 失败不会整体中断：下不完的文件记进 stats.failed，界面提示可以再点一次续传。
 */

const AdmZip = require('adm-zip');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');

const USER_AGENT = 'Viskluke-Launcher/0.4 (github.com/viskluke)';
const INDEX_NAME = 'modrinth.index.json';
const MARKER_NAME = '.viskluke-modpack.json';
const SUPPORTED_FORMAT = 1;
const CLIENT_OVERRIDE_DIRS = ['overrides', 'client-overrides'];
const DEFAULT_CONCURRENCY = 2;
const MAX_ATTEMPTS = 3;

/** dependencies 里的加载器键 → 启动器内部加载器名 */
const LOADER_KEYS = {
  'fabric-loader': 'fabric',
  'quilt-loader': 'quilt',
  forge: 'forge',
  neoforge: 'neoforge',
};

class ModpackError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'ModpackError';
    Object.assign(this, extra);
  }
}

// ---------------------------------------------------------------------------
// 路径安全
// ---------------------------------------------------------------------------

/**
 * 把整合包内相对路径解析到实例目录内，任何越界（../、绝对路径、盘符）都拒绝。
 * @returns {string} 绝对路径
 */
function safeJoin(root, relative) {
  const raw = String(relative || '').trim();
  if (!raw) throw new ModpackError('整合包里出现了空路径');
  if (raw.includes('\0')) throw new ModpackError(`整合包里出现了非法路径：${JSON.stringify(raw)}`);
  const unified = raw.replace(/\\/g, '/');
  if (/^[a-zA-Z]:/.test(unified) || unified.startsWith('/') || unified.startsWith('~')) {
    throw new ModpackError(`整合包里出现了绝对路径：${raw}`);
  }
  const normalized = path.posix.normalize(unified);
  if (normalized === '.' || normalized.startsWith('..') || path.posix.isAbsolute(normalized)) {
    throw new ModpackError(`整合包里的路径越界：${raw}`);
  }
  const base = path.resolve(root);
  const target = path.resolve(base, normalized);
  const relativeOut = path.relative(base, target);
  if (!relativeOut || relativeOut.startsWith('..') || path.isAbsolute(relativeOut)) {
    throw new ModpackError(`整合包里的路径越界：${raw}`);
  }
  return target;
}

// ---------------------------------------------------------------------------
// 清单解析
// ---------------------------------------------------------------------------

/** 从 dependencies 推断加载器 */
function detectLoader(dependencies = {}) {
  const deps = dependencies || {};
  for (const [key, loader] of Object.entries(LOADER_KEYS)) {
    const value = deps[key];
    if (typeof value === 'string' && value.trim()) {
      return { loader, loaderVersion: value.trim() };
    }
  }
  // 少数整合包把加载器版本写成数字
  for (const [key, loader] of Object.entries(LOADER_KEYS)) {
    if (deps[key] != null && String(deps[key]).trim()) {
      return { loader, loaderVersion: String(deps[key]).trim() };
    }
  }
  return { loader: '', loaderVersion: '' };
}

/**
 * 校验并规范化 modrinth.index.json
 * @param {object} index
 */
function parseIndex(index) {
  if (!index || typeof index !== 'object' || Array.isArray(index)) {
    throw new ModpackError('modrinth.index.json 内容格式不正确');
  }

  const game = String(index.game || '').trim();
  if (game && game !== 'minecraft') {
    throw new ModpackError(`这个整合包不是 Minecraft 的（game=${game}）`);
  }

  const formatVersion = Number(index.formatVersion == null ? SUPPORTED_FORMAT : index.formatVersion);
  if (!Number.isFinite(formatVersion) || formatVersion < 1) {
    throw new ModpackError(`整合包格式版本不合法：${index.formatVersion}`);
  }
  if (formatVersion > SUPPORTED_FORMAT) {
    throw new ModpackError(
      `整合包格式版本 ${formatVersion} 高于本启动器支持的 ${SUPPORTED_FORMAT}，请更新启动器后再安装`
    );
  }

  const dependencies = index.dependencies && typeof index.dependencies === 'object' ? index.dependencies : {};
  const minecraftVersion = String(dependencies.minecraft || '').trim();
  const { loader, loaderVersion } = detectLoader(dependencies);
  const files = Array.isArray(index.files) ? index.files : [];

  return {
    formatVersion,
    name: String(index.name || '').trim(),
    versionId: String(index.versionId || '').trim(),
    summary: String(index.summary || '').trim(),
    minecraftVersion,
    loader,
    loaderVersion,
    dependencies,
    files,
    totalFiles: files.length,
  };
}

/** 只保留客户端需要下载的文件 */
function clientFiles(files) {
  return (Array.isArray(files) ? files : []).filter((file) => {
    if (!file || typeof file !== 'object') return false;
    if (typeof file.path !== 'string' || !file.path.trim()) return false;
    const env = file.env || {};
    if (String(env.client || '').toLowerCase() === 'unsupported') return false;
    const downloads = Array.isArray(file.downloads) ? file.downloads.filter((u) => typeof u === 'string' && u) : [];
    return downloads.length > 0;
  }).map((file) => ({
    path: file.path.trim(),
    downloads: file.downloads.filter((u) => typeof u === 'string' && u),
    hashes: file.hashes && typeof file.hashes === 'object' ? file.hashes : {},
    fileSize: Number(file.fileSize || 0) || 0,
  }));
}

function readIndex(mrpackPath) {
  if (!mrpackPath || !fs.existsSync(mrpackPath)) {
    throw new ModpackError(`整合包文件不存在：${mrpackPath || '(空)'}`);
  }
  const zip = new AdmZip(mrpackPath);
  const entry = zip.getEntry(INDEX_NAME);
  if (!entry) {
    throw new ModpackError(`这不是有效的 Modrinth 整合包：缺少 ${INDEX_NAME}`);
  }
  let raw;
  try {
    raw = JSON.parse(zip.readAsText(entry));
  } catch (error) {
    throw new ModpackError(`${INDEX_NAME} 不是合法 JSON：${(error && error.message) || error}`);
  }
  return { zip, index: parseIndex(raw), raw };
}

// ---------------------------------------------------------------------------
// 下载
// ---------------------------------------------------------------------------

function describeNetError(error) {
  if (!error) return '未知错误';
  const code = error.code || '';
  const status = error.response && error.response.status;
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') return '请求超时';
  if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED'].includes(code)) return `网络不可达（${code}）`;
  if (status === 404) return '文件不存在（404）';
  if (status === 403) return '没有下载权限（403）';
  if (status && status >= 500) return `远端服务异常（${status}）`;
  return (error && error.message) || String(error);
}

/** 下载单个文件到 dest（先写 .part，成功后再改名） */
async function downloadOnce(url, dest, options = {}) {
  const { sha512 = '', timeout = 60000, onProgress = null } = options;
  await fsp.mkdir(path.dirname(dest), { recursive: true });

  const part = `${dest}.part`;
  const res = await axios.get(url, {
    responseType: 'stream',
    timeout,
    maxRedirects: 5,
    headers: { 'User-Agent': USER_AGENT },
    validateStatus: (status) => status >= 200 && status < 300,
  });

  const total = Number((res.headers && res.headers['content-length']) || 0) || 0;
  const hash = sha512 ? crypto.createHash('sha512') : null;
  let received = 0;

  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(part);
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      try {
        res.data.destroy();
      } catch {
        /* ignore */
      }
      out.destroy();
      reject(error);
    };
    res.data.on('error', fail);
    out.on('error', fail);
    res.data.on('data', (chunk) => {
      received += chunk.length;
      if (hash) hash.update(chunk);
      if (onProgress) onProgress({ received, total });
    });
    out.on('finish', () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    res.data.pipe(out);
  });

  if (hash) {
    const actual = hash.digest('hex').toLowerCase();
    if (actual !== String(sha512).toLowerCase()) {
      await fsp.rm(part, { force: true });
      throw new ModpackError(`文件校验失败（sha512 不匹配）：${path.basename(dest)}`);
    }
  }

  await fsp.rm(dest, { force: true });
  await fsp.rename(part, dest);
  return received;
}

/** 下载 + 重试；多个候选地址按顺序尝试 */
async function downloadFile(file, dest, options = {}) {
  const urls = Array.isArray(file.downloads) ? file.downloads : [];
  if (!urls.length) throw new ModpackError(`文件没有下载地址：${file.path}`);
  const sha512 = (file.hashes && file.hashes.sha512) || '';

  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const url = urls[Math.min(attempt - 1, urls.length - 1)];
    try {
      return await downloadOnce(url, dest, { ...options, sha512 });
    } catch (error) {
      lastError = error;
      const status = error && error.response && error.response.status;
      // 4xx 是"这个地址就是拿不到"，重试没意义；校验失败也一样
      const hopeless =
        (status && status >= 400 && status < 500) &&
        ![408, 429].includes(status);
      const hashFailed = error instanceof ModpackError && /校验失败/.test(error.message);
      if (attempt >= MAX_ATTEMPTS || hopeless || hashFailed) break;
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
  throw lastError || new ModpackError(`下载失败：${file.path}`);
}

/** 已有文件是否可以直接跳过（大小一致即认为已下完） */
async function isAlreadyInstalled(dest, file) {
  try {
    const stat = await fsp.stat(dest);
    if (!stat.isFile()) return false;
    if (file.fileSize > 0) return stat.size === file.fileSize;
    return stat.size > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 覆盖层解压
// ---------------------------------------------------------------------------

function extractOverrides(zip, root, dirs = CLIENT_OVERRIDE_DIRS) {
  const prefixes = dirs.map((dir) => `${dir}/`);
  const written = [];
  const skipped = [];

  for (const entry of zip.getEntries()) {
    const name = String(entry.entryName || '').replace(/\\/g, '/');
    const prefix = prefixes.find((p) => name.startsWith(p));
    if (!prefix) continue;

    const relative = name.slice(prefix.length);
    if (!relative) continue;

    try {
      const target = safeJoin(root, relative);
      if (entry.isDirectory || name.endsWith('/')) {
        fs.mkdirSync(target, { recursive: true });
        continue;
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, entry.getData());
      written.push(relative);
    } catch (error) {
      skipped.push({ path: name, error: (error && error.message) || String(error) });
    }
  }

  return { written, skipped };
}

// ---------------------------------------------------------------------------
// 标记文件
// ---------------------------------------------------------------------------

function markerPath(root) {
  return path.join(root, MARKER_NAME);
}

function readMarker(root) {
  try {
    return JSON.parse(fs.readFileSync(markerPath(root), 'utf8'));
  } catch {
    return null;
  }
}

function writeMarker(root, data) {
  const target = markerPath(root);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, target);
  return target;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/**
 * 把一个 .mrpack 装进实例目录。
 * @param {{ mrpackPath: string, root: string, onProgress?: Function, concurrency?: number,
 *           source?: object, extractOverrides?: boolean }} options
 */
async function install(options = {}) {
  const {
    mrpackPath,
    root,
    onProgress = () => {},
    concurrency = DEFAULT_CONCURRENCY,
    source = {},
  } = options;

  if (!root) throw new ModpackError('缺少实例目录，无法安装整合包');
  const { zip, index, raw } = readIndex(mrpackPath);
  if (!index.minecraftVersion) {
    throw new ModpackError('整合包没有声明 Minecraft 版本（dependencies.minecraft 为空）');
  }
  if (!/^\d+(\.[0-9A-Za-z._-]+)*$/.test(index.minecraftVersion)) {
    throw new ModpackError(`整合包声明的 Minecraft 版本不合法：${index.minecraftVersion}`);
  }

  const files = clientFiles(index.files);
  const stats = {
    total: index.totalFiles,
    selected: files.length,
    downloaded: 0,
    skipped: 0,
    failed: [],
    bytes: 0,
  };

  onProgress({
    stage: 'read',
    message: `读取整合包清单：${files.length} 个文件需要安装`,
    percent: 0,
    total: files.length,
    pack: { name: index.name, versionId: index.versionId, loader: index.loader },
  });

  const total = files.length;
  let nextIndex = 0;

  const worker = async () => {
    for (;;) {
      const position = nextIndex++;
      if (position >= total) return;
      const file = files[position];
      const dest = safeJoin(root, file.path);
      const label = path.basename(file.path);

      try {
        if (await isAlreadyInstalled(dest, file)) {
          stats.skipped += 1;
        } else {
          const received = await downloadFile(file, dest, {
            onProgress: ({ received: got, total: size }) => {
              onProgress({
                stage: 'download',
                message: `下载 ${label}`,
                detail: `${position + 1}/${total}`,
                percent: size ? Math.min(100, Math.round((got / size) * 100)) : null,
                received: got,
                total: size || 0,
                file: file.path,
              });
            },
          });
          stats.downloaded += 1;
          stats.bytes += received;
        }
      } catch (error) {
        stats.failed.push({ path: file.path, error: describeNetError(error) });
      }

      const done = stats.downloaded + stats.skipped + stats.failed.length;
      onProgress({
        stage: 'file',
        message: `${path.basename(file.path)} ${stats.failed.some((f) => f.path === file.path) ? '失败' : '完成'}`,
        detail: `${done}/${total}`,
        percent: total ? Math.round((done / total) * 100) : 100,
        total,
      });
    }
  };

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(8, Number(concurrency) || DEFAULT_CONCURRENCY)) }, worker)
  );

  if (stats.failed.length && stats.downloaded + stats.skipped === 0) {
    throw new ModpackError(
      `整合包文件全部下载失败（${stats.failed.length} 个），请检查网络后重试。\n第一个错误：${
        stats.failed[0].error
      }`
    );
  }

  onProgress({ stage: 'extract', message: '解压 overrides 覆盖文件…', percent: 90 });
  const overrides = extractOverrides(zip, root);
  stats.overrides = overrides.written.length;
  stats.overridesSkipped = overrides.skipped;

  const installedAt = new Date().toISOString();
  const marker = writeMarker(root, {
    name: index.name,
    versionId: index.versionId,
    summary: index.summary,
    formatVersion: index.formatVersion,
    minecraftVersion: index.minecraftVersion,
    loader: index.loader,
    loaderVersion: index.loaderVersion,
    projectId: source.projectId || '',
    projectType: source.projectType || '',
    sourceFile: path.basename(mrpackPath),
    files: stats.downloaded + stats.skipped,
    overrides: stats.overrides,
    failed: stats.failed.length,
    installedAt,
  });

  onProgress({
    stage: 'done',
    message: `整合包解包完成：${stats.downloaded} 个新文件，${stats.overrides} 个覆盖文件`,
    percent: 100,
  });

  return {
    ok: true,
    root,
    marker,
    installedAt,
    pack: {
      name: index.name || '',
      versionId: index.versionId || '',
      summary: index.summary || '',
      formatVersion: index.formatVersion,
      minecraftVersion: index.minecraftVersion,
      loader: index.loader,
      loaderVersion: index.loaderVersion,
      projectId: source.projectId || '',
      dependencies: index.dependencies,
    },
    stats: {
      total: stats.total,
      selected: stats.selected,
      downloaded: stats.downloaded,
      skipped: stats.skipped,
      overrides: stats.overrides,
      overridesSkipped: stats.overridesSkipped,
      bytes: stats.bytes,
      failed: stats.failed,
    },
    raw: { formatVersion: raw.formatVersion },
  };
}

module.exports = {
  ModpackError,
  install,
  parseIndex,
  clientFiles,
  readIndex,
  readMarker,
  writeMarker,
  safeJoin,
  extractOverrides,
  detectLoader,
  MARKER_NAME,
  INDEX_NAME,
  LOADER_KEYS,
  CLIENT_OVERRIDE_DIRS,
  _internal: {
    downloadOnce,
    downloadFile,
    isAlreadyInstalled,
    describeNetError,
  },
};
