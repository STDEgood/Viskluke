'use strict';

/**
 * loader.js —— 客户端模组加载器（Fabric / Quilt）版本 JSON 生成
 *
 * 背景：MCLC 只认两种"版本"：
 *   1. versions/<number>/<number>.json  ← 官方版本清单里的版本
 *   2. options.version.custom + versions/<custom>/<custom>.json  ← 自定义（整合包）版本
 * 整合包用的是加载器版本，官方清单里没有，所以要自己造这个 JSON。
 *
 * 做法（业界通行）：把官方原版 JSON 与加载器 profile JSON 拍平合并成一个
 * "独立版本 JSON"，MCLC 就能像启动原版一样启动它：
 *   · mainClass    ← 加载器（KnotClient）
 *   · libraries    ← 加载器库 + 原版库（按 name 去重）
 *   · arguments    ← 原版参数 + 加载器 jvm 参数
 *   · downloads / assetIndex / javaVersion 等 ← 沿用原版
 * 版本 id 命名成 `<mc>-fabric-<loader>`（如 1.20.4-fabric-0.16.5）：
 * MCLC 内部用 id.split('.')[1] 推断大版本（决定是否解压 natives、是否加 log4j 参数），
 * 让 id 以 Minecraft 版本打头才能得到正确行为。
 *
 * 只支持 Fabric / Quilt：这两个加载器的 profile 是"纯 JSON + Maven 库"，
 * 不需要跑安装器。Forge / NeoForge 要先跑 installer，本轮不做（会给出明确报错）。
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const axios = require('axios');

const USER_AGENT = 'Viskluke-Launcher/0.4 (github.com/viskluke)';
const MANIFEST_URL = 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json';

const PROVIDERS = {
  fabric: {
    label: 'Fabric',
    listUrl: (mc) => `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mc)}`,
    profileUrl: (mc, loader) =>
      `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mc)}/${encodeURIComponent(loader)}/profile/json`,
  },
  quilt: {
    label: 'Quilt',
    listUrl: (mc) => `https://meta.quiltmc.org/v3/versions/loader/${encodeURIComponent(mc)}`,
    profileUrl: (mc, loader) =>
      `https://meta.quiltmc.org/v3/versions/loader/${encodeURIComponent(mc)}/${encodeURIComponent(loader)}/profile/json`,
  },
};

/**
 * Forge / NeoForge 走另一条路：不下 profile JSON，而是下官方 **installer jar**，
 * 交给 MCLC 的 `options.forge` → ForgeWrapper 在运行时处理 inheritsFrom、模块路径、占位符，
 * 比我们手工拍平版本 JSON 可靠得多。
 */
const INSTALLER_PROVIDERS = {
  forge: {
    label: 'Forge',
    // 版本推荐表：{ promos: { "1.20.1-recommended": "47.2.20", ... } }
    promoUrl: 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json',
    installerUrl: (mc, version) =>
      `https://maven.minecraftforge.net/net/minecraftforge/forge/${encodeURIComponent(mc)}-${encodeURIComponent(version)}` +
      `/forge-${encodeURIComponent(mc)}-${encodeURIComponent(version)}-installer.jar`,
    fileName: (mc, version) => `forge-${mc}-${version}-installer.jar`,
  },
  neoforge: {
    label: 'NeoForge',
    versionListUrl: 'https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge',
    installerUrl: (mc, version) =>
      `https://maven.neoforged.net/releases/net/neoforged/neoforge/${encodeURIComponent(version)}` +
      `/neoforge-${encodeURIComponent(version)}-installer.jar`,
    fileName: (mc, version) => `neoforge-${version}-installer.jar`,
  },
};

const SUPPORTED = Object.keys(PROVIDERS).concat(Object.keys(INSTALLER_PROVIDERS));
const UNSUPPORTED_HINT =
  '这个加载器需要先手动安装（本启动器只自动处理 Fabric / Quilt / Forge / NeoForge 客户端）。' +
  '可以把整合包导入 Prism / Modrinth 客户端。';

class LoaderError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'LoaderError';
    Object.assign(this, extra);
  }
}

let manifestCache = null;
let manifestAt = 0;

function describeNetError(error) {
  if (!error) return '未知错误';
  const code = error.code || '';
  const status = error.response && error.response.status;
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') return '请求超时';
  if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED'].includes(code)) return `网络不可达（${code}）`;
  if (status === 404) return '远端没有这个版本（404）';
  if (status && status >= 500) return `远端服务异常（${status}）`;
  return (error && error.message) || String(error);
}

async function getJson(url, { timeout = 20000, retries = 2 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await axios.get(url, {
        timeout,
        maxRedirects: 5,
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      });
      return res.data;
    } catch (error) {
      lastError = error;
      const status = error.response && error.response.status;
      if (status && status < 500 && status !== 429) break;
      if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 700 * (attempt + 1)));
    }
  }
  throw new LoaderError(`请求失败：${describeNetError(lastError)}`);
}

// ---------------------------------------------------------------------------
// 版本 id
// ---------------------------------------------------------------------------

function sanitize(value) {
  return String(value || '')
    .trim()
    .replace(/[^0-9A-Za-z._-]/g, '');
}

/** 加载器版本的目录名 / 版本 id：<mc>-<loader>-<loaderVersion> */
function loaderVersionId(loader, mcVersion, loaderVersion) {
  const type = sanitize(loader).toLowerCase();
  const mc = sanitize(mcVersion);
  const ver = sanitize(loaderVersion);
  if (!mc) throw new LoaderError('缺少 Minecraft 版本号');
  if (!type) throw new LoaderError('缺少加载器类型');
  if (!ver) throw new LoaderError('缺少加载器版本号');
  return `${mc}-${type}-${ver}`;
}

function assertSupported(loader) {
  const type = String(loader || '').toLowerCase();
  if (!SUPPORTED.includes(type)) {
    throw new LoaderError(
      `${type ? `不支持自动安装「${type}」加载器。` : '缺少加载器类型。'}${UNSUPPORTED_HINT}`
    );
  }
  return type;
}

/** 这个加载器是不是"下 installer jar 交给 MCLC"的那一类 */
function usesInstaller(loader) {
  return Object.keys(INSTALLER_PROVIDERS).includes(String(loader || '').toLowerCase());
}

// ---------------------------------------------------------------------------
// 元数据
// ---------------------------------------------------------------------------

/** 某个 Minecraft 版本可用的加载器版本列表（新 → 旧） */
async function listLoaderVersions(loader, mcVersion) {
  const type = assertSupported(loader);
  if (!sanitize(mcVersion)) throw new LoaderError('缺少 Minecraft 版本号');
  const data = await getJson(PROVIDERS[type].listUrl(sanitize(mcVersion)));
  const list = Array.isArray(data) ? data : [];
  return list
    .map((item) => {
      const loaderInfo = (item && item.loader) || {};
      return { version: sanitize(loaderInfo.version), stable: loaderInfo.stable !== false };
    })
    .filter((item) => item.version);
}

async function pickLoaderVersion(loader, mcVersion) {
  const type = assertSupported(loader);
  const list = await listLoaderVersions(type, mcVersion);
  if (!list.length) {
    throw new LoaderError(`${PROVIDERS[type].label} 还没有支持 Minecraft ${mcVersion} 的版本`);
  }
  const stable = list.find((item) => item.stable);
  return (stable || list[0]).version;
}

async function fetchProfile(loader, mcVersion, loaderVersion) {
  const type = assertSupported(loader);
  const mc = sanitize(mcVersion);
  const lv = sanitize(loaderVersion);
  const profile = await getJson(PROVIDERS[type].profileUrl(mc, lv));
  if (!profile || typeof profile !== 'object' || !profile.mainClass) {
    throw new LoaderError(`${PROVIDERS[type].label} ${lv} 的 profile JSON 不完整（缺少 mainClass）`);
  }
  if (profile.inheritsFrom && String(profile.inheritsFrom) !== mc) {
    throw new LoaderError(
      `${PROVIDERS[type].label} ${lv} 声明的父版本是 ${profile.inheritsFrom}，与实例版本 ${mc} 不一致`
    );
  }
  return profile;
}

/** 官方版本 JSON（优先读本地缓存） */
async function loadVanillaJson(mcVersion, options = {}) {
  const { root = '', onLog = () => {}, fresh = false } = options;
  const mc = sanitize(mcVersion);
  if (!mc) throw new LoaderError('缺少 Minecraft 版本号');

  const cacheDir = path.join(root || os.tmpdir(), 'cache', 'json');
  const cacheFile = path.join(cacheDir, `${mc}.json`);
  if (!fresh) {
    try {
      const cached = JSON.parse(await fsp.readFile(cacheFile, 'utf8'));
      if (cached && cached.downloads && cached.libraries) return cached;
    } catch {
      /* 缓存不存在或损坏 → 联网 */
    }
  }

  const now = Date.now();
  if (!manifestCache || now - manifestAt > 10 * 60 * 1000) {
    onLog(`[Viskluke] 读取 Mojang 版本清单…`);
    manifestCache = await getJson(MANIFEST_URL);
    manifestAt = now;
  }
  const entry = (manifestCache.versions || []).find((version) => version.id === mc);
  if (!entry) throw new LoaderError(`Mojang 版本清单里没有 ${mc}`);

  onLog(`[Viskluke] 下载 ${mc} 的版本描述…`);
  const json = await getJson(entry.url);
  if (!json || !json.downloads || !Array.isArray(json.libraries)) {
    throw new LoaderError(`${mc} 的版本描述不完整`);
  }
  try {
    await fsp.mkdir(cacheDir, { recursive: true });
    await fsp.writeFile(cacheFile, JSON.stringify(json), 'utf8');
  } catch {
    /* 缓存失败忽略 */
  }
  return json;
}

// ---------------------------------------------------------------------------
// 合并
// ---------------------------------------------------------------------------

function dedupeLibraries(profileLibraries, vanillaLibraries) {
  const seen = new Set();
  const out = [];
  for (const lib of [...(profileLibraries || []), ...(vanillaLibraries || [])]) {
    if (!lib || typeof lib !== 'object' || !lib.name) continue;
    if (seen.has(lib.name)) continue;
    seen.add(lib.name);
    out.push(lib);
  }
  return out;
}

/**
 * 把加载器 profile 与原版版本 JSON 拍平成一份独立版本 JSON。
 */
function mergeProfile(vanilla, profile, options = {}) {
  if (!vanilla || !profile) throw new LoaderError('合并版本 JSON 失败：缺少输入');
  const id = options.id || loaderVersionId(options.loader || 'fabric', vanilla.id, options.loaderVersion || '0');
  const merged = { ...vanilla };

  merged.id = id;
  merged.type = vanilla.type || profile.type || 'release';
  merged.mainClass = profile.mainClass;
  merged.libraries = dedupeLibraries(profile.libraries, vanilla.libraries);
  merged.loader = {
    type: String(options.loader || '').toLowerCase(),
    version: String(options.loaderVersion || ''),
    parent: vanilla.id,
  };

  const vanillaArgs = vanilla.arguments || {};
  if (vanilla.minecraftArguments && !Array.isArray(vanillaArgs.game)) {
    // 1.12 及更早的老格式：保留 minecraftArguments，加载器参数塞进 jvm
    merged.minecraftArguments = vanilla.minecraftArguments;
    delete merged.arguments;
  } else {
    merged.arguments = {
      game: [...(vanillaArgs.game || []), ...((profile.arguments && profile.arguments.game) || [])],
      jvm: [...(vanillaArgs.jvm || []), ...((profile.arguments && profile.arguments.jvm) || [])],
    };
  }

  // 拍平后不应再有 inheritsFrom，MCLC 会把它当独立版本处理
  delete merged.inheritsFrom;
  return merged;
}

/**
 * 确保实例目录里存在加载器版本 JSON。
 * @param {{ root: string, loader: string, mcVersion: string, loaderVersion?: string,
 *           onLog?: Function, force?: boolean }} options
 * @returns {Promise<{ id: string, versionDir: string, jsonPath: string, jarPath: string,
 *                     loader: string, loaderVersion: string, parentVersion: string, created: boolean }>}
 */
async function ensureLoaderVersion(options = {}) {
  const { root, onLog = () => {}, force = false } = options;
  if (!root) throw new LoaderError('缺少实例目录');
  const type = assertSupported(options.loader);
  const mcVersion = sanitize(options.mcVersion);
  if (!mcVersion) throw new LoaderError('缺少 Minecraft 版本号');

  const loaderVersion = sanitize(options.loaderVersion) || (await pickLoaderVersion(type, mcVersion));
  const id = loaderVersionId(type, mcVersion, loaderVersion);
  const versionDir = path.join(root, 'versions', id);
  const jsonPath = path.join(versionDir, `${id}.json`);

  if (!force && fs.existsSync(jsonPath)) {
    try {
      const existing = JSON.parse(await fsp.readFile(jsonPath, 'utf8'));
      if (existing && existing.mainClass && Array.isArray(existing.libraries) && existing.loader) {
        onLog(`[Viskluke] 加载器已就绪：${PROVIDERS[type].label} ${loaderVersion}（${id}）`);
        return {
          id,
          versionDir,
          jsonPath,
          jarPath: path.join(versionDir, `${id}.jar`),
          loader: type,
          loaderVersion,
          parentVersion: mcVersion,
          created: false,
        };
      }
      onLog(`[Viskluke] 现有加载器 JSON 不完整，重新生成：${id}`);
    } catch {
      onLog(`[Viskluke] 现有加载器 JSON 解析失败，重新生成：${id}`);
    }
  }

  onLog(`[Viskluke] 准备加载器：${PROVIDERS[type].label} ${loaderVersion} + Minecraft ${mcVersion}`);
  const vanilla = await loadVanillaJson(mcVersion, { root, onLog });
  const profile = await fetchProfile(type, mcVersion, loaderVersion);
  const merged = mergeProfile(vanilla, profile, { id, loader: type, loaderVersion });

  await fsp.mkdir(versionDir, { recursive: true });
  const tmp = `${jsonPath}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  await fsp.rename(tmp, jsonPath);
  onLog(`[Viskluke] 已生成加载器版本 JSON：${jsonPath}（${merged.libraries.length} 个库）`);

  return {
    id,
    versionDir,
    jsonPath,
    jarPath: path.join(versionDir, `${id}.jar`),
    loader: type,
    loaderVersion,
    parentVersion: mcVersion,
    created: true,
  };
}

/** 实例的加载器是否已经装好（只看版本 JSON 是否在） */
function isLoaderReady(root, loader, mcVersion, loaderVersion) {
  try {
    const id = loaderVersionId(loader, mcVersion, loaderVersion);
    return fs.existsSync(path.join(root, 'versions', id, `${id}.json`));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Forge / NeoForge：installer jar
// ---------------------------------------------------------------------------

/** 查 Forge 推荐版本（pack 里没写版本时才用） */
async function pickForgeVersion(mcVersion, fetchJson = getJson) {
  const mc = sanitize(mcVersion);
  const data = await fetchJson(INSTALLER_PROVIDERS.forge.promoUrl);
  const promos = (data && data.promos) || {};
  const recommended = promos[`${mc}-recommended`];
  const latest = promos[`${mc}-latest`];
  const version = sanitize(recommended) || sanitize(latest);
  if (!version) {
    throw new LoaderError(`Forge 没有支持 Minecraft ${mc} 的版本（查了官方推荐表）`);
  }
  return version;
}

/** 查 NeoForge 最新版本（版本号形如 20.4.200 / 21.1.66） */
async function pickNeoForgeVersion(mcVersion, fetchJson = getJson) {
  const mc = sanitize(mcVersion);
  const data = await fetchJson(INSTALLER_PROVIDERS.neoforge.versionListUrl);
  const all = (data && Array.isArray(data.versions) ? data.versions : []).map(sanitize).filter(Boolean);
  if (!all.length) throw new LoaderError('NeoForge 版本列表为空');
  // NeoForge 的版本号前两段对应 MC（1.20.4 → 20.4），用它过滤
  const [, minor, patch] = String(mc).split('.');
  const prefix = `${minor}.${patch}`;
  const candidates = all.filter((v) => v.startsWith(prefix));
  const version = candidates.sort((a, b) => {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const diff = (pb[i] || 0) - (pa[i] || 0);
      if (diff) return diff;
    }
    return 0;
  })[0];
  if (!version) throw new LoaderError(`NeoForge 没有支持 Minecraft ${mc} 的版本`);
  return version;
}

/**
 * 确保 installer jar 已下载，返回它的路径。
 * @param {{ root: string, loader: 'forge'|'neoforge', mcVersion: string, loaderVersion?: string,
 *           onLog?: Function, onProgress?: Function, force?: boolean }} options
 */
async function ensureInstaller(options = {}) {
  const { root, onLog = () => {}, onProgress = () => {}, force = false } = options;
  if (!root) throw new LoaderError('缺少实例目录');
  const type = assertSupported(options.loader);
  if (!usesInstaller(type)) throw new LoaderError(`${type} 不需要 installer jar`);
  const provider = INSTALLER_PROVIDERS[type];
  const mcVersion = sanitize(options.mcVersion);
  if (!mcVersion) throw new LoaderError('缺少 Minecraft 版本号');

  const loaderVersion = sanitize(options.loaderVersion)
    || (type === 'forge' ? await pickForgeVersion(mcVersion) : await pickNeoForgeVersion(mcVersion));

  const dir = path.join(root, 'forge-installers');
  const target = path.join(dir, provider.fileName(mcVersion, loaderVersion));
  // installerUrl 可覆盖：国内镜像加速，或自检时指到本地服务器
  const url = String(options.installerUrl || '') || provider.installerUrl(mcVersion, loaderVersion);

  let size = 0;
  let downloaded = false;
  try {
    const stat = await fsp.stat(target);
    if (!force && stat.isFile() && stat.size > 1024 * 64) size = stat.size;
  } catch {
    /* 不存在就下 */
  }

  if (!size) {
    onLog(`[Viskluke] 下载 ${provider.label} ${loaderVersion} 安装器…`);
    await fsp.mkdir(dir, { recursive: true });
    const part = `${target}.part`;
    const res = await axios.get(url, {
      responseType: 'stream',
      timeout: 120000,
      maxRedirects: 5,
      headers: { 'User-Agent': USER_AGENT },
      validateStatus: (status) => status >= 200 && status < 300,
    });
    const total = Number((res.headers && res.headers['content-length']) || 0) || 0;
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
        onProgress({ received, total, percent: total ? Math.round((received / total) * 100) : null });
      });
      out.on('finish', () => {
        if (settled) return;
        settled = true;
        resolve();
      });
      res.data.pipe(out);
    });
    if (received < 1024 * 64) {
      await fsp.rm(part, { force: true });
      throw new LoaderError(`${provider.label} 安装器下载不完整（${received} 字节）`);
    }
    await fsp.rm(target, { force: true });
    await fsp.rename(part, target);
    size = received;
    downloaded = true;
    onLog(`[Viskluke] 安装器已就绪：${target}（${(size / 1048576).toFixed(1)} MB）`);
  } else {
    onLog(`[Viskluke] 复用已下载的 ${provider.label} 安装器：${target}`);
  }

  return {
    loader: type,
    label: provider.label,
    loaderVersion,
    installerPath: target,
    url,
    size,
    created: downloaded,
  };
}

module.exports = {
  LoaderError,
  SUPPORTED,
  PROVIDERS,
  INSTALLER_PROVIDERS,
  UNSUPPORTED_HINT,
  loaderVersionId,
  assertSupported,
  usesInstaller,
  listLoaderVersions,
  pickLoaderVersion,
  pickForgeVersion,
  pickNeoForgeVersion,
  ensureInstaller,
  loadVanillaJson,
  mergeProfile,
  ensureLoaderVersion,
  isLoaderReady,
  dedupeLibraries,
  _internal: { sanitize, fetchProfile, getJson, describeNetError },
};
