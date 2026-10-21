'use strict';

/**
 * store.js —— 下载中心
 *
 *  · Minecraft 版本：读取 Mojang 官方版本清单（launchermeta）
 *  · Mod / 资源包 / 光影 / 整合包：使用 Modrinth 开放 API（无需 Key）
 *
 * 安装位置跟随实例的游戏目录：
 *   mod → mods/        resourcepack → resourcepacks/
 *   shader → shaderpacks/   modpack → modpacks/（同时解包到实例根目录，见 modpack.js）
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const axios = require('axios');
const launcher = require('./launcher');
const modpack = require('./modpack');

const USER_AGENT = 'Viskluke-Launcher/0.3 (github.com/viskluke)';
const MANIFEST_URL = 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json';
const MODRINTH = 'https://api.modrinth.com/v2';

const TARGET_DIR = {
  mod: 'mods',
  resourcepack: 'resourcepacks',
  shader: 'shaderpacks',
  modpack: 'modpacks',
};

let manifestCache = null;
let manifestAt = 0;

class StoreError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'StoreError';
    Object.assign(this, extra);
  }
}

function describeNetError(error) {
  if (!error) return '未知错误';
  const code = error.code || '';
  const status = error.response && error.response.status;
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') return '请求超时，请检查网络或代理';
  if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED'].includes(code)) return `网络不可达（${code}）`;
  if (status === 404) return '资源不存在（404）';
  if (status === 429) return '请求过于频繁（429），请稍后再试';
  if (status && status >= 500) return `远端服务异常（${status}）`;
  return error.message || String(error);
}

async function getJson(url, options = {}) {
  const { timeout = 15000, retries = 2 } = options;
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
      if (attempt < retries) await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
    }
  }
  throw new StoreError(`请求失败：${describeNetError(lastError)}`);
}

// ---------------------------------------------------------------------------
// Minecraft 版本
// ---------------------------------------------------------------------------

async function loadManifest() {
  const now = Date.now();
  if (manifestCache && now - manifestAt < 10 * 60 * 1000) return manifestCache;
  const data = await getJson(MANIFEST_URL, { timeout: 20000 });
  manifestCache = data;
  manifestAt = now;
  return data;
}

/**
 * @param {{ type?: 'release'|'snapshot'|'old_beta'|'old_alpha'|'all', limit?: number, query?: string, root?: string }} options
 */
async function listVersions(options = {}) {
  const { type = 'release', limit = 60, query = '', root = '' } = options;
  const manifest = await loadManifest();
  const keyword = String(query || '').trim().toLowerCase();

  const installed = new Set();
  if (root) {
    try {
      for (const entry of await fsp.readdir(path.join(root, 'versions'), { withFileTypes: true })) {
        if (entry.isDirectory()) installed.add(entry.name);
      }
    } catch {
      /* 目录不存在视为未安装 */
    }
  }

  return {
    latest: manifest.latest || {},
    versions: (manifest.versions || [])
      .filter((v) => (type === 'all' ? true : v.type === type))
      .filter((v) => (keyword ? v.id.toLowerCase().includes(keyword) : true))
      .slice(0, Math.max(1, Math.min(200, Number(limit) || 60)))
      .map((v) => ({
        id: v.id,
        type: v.type,
        releaseTime: v.releaseTime,
        installed: installed.has(v.id),
      })),
  };
}

// ---------------------------------------------------------------------------
// Modrinth
// ---------------------------------------------------------------------------

function buildFacets({ projectType, gameVersion, loader }) {
  const facets = [];
  if (projectType) facets.push([`project_type:${projectType}`]);
  if (gameVersion) facets.push([`versions:${gameVersion}`]);
  if (loader && ['mod', 'modpack'].includes(projectType)) facets.push([`categories:${loader}`]);
  return facets;
}

async function searchProjects(options = {}) {
  const {
    query = '',
    projectType = 'mod',
    gameVersion = '',
    loader = '',
    limit = 20,
    offset = 0,
  } = options;

  const params = new URLSearchParams({
    query: String(query || ''),
    limit: String(Math.max(1, Math.min(40, Number(limit) || 20))),
    offset: String(Math.max(0, Number(offset) || 0)),
    index: query ? 'relevance' : 'downloads',
  });
  const facets = buildFacets({ projectType, gameVersion, loader });
  if (facets.length) params.set('facets', JSON.stringify(facets));

  const data = await getJson(`${MODRINTH}/search?${params.toString()}`);
  return {
    total: data.total_hits || 0,
    hits: (Array.isArray(data.hits) ? data.hits : []).map((hit) => ({
      id: hit.project_id,
      slug: hit.slug,
      title: hit.title,
      description: hit.description,
      author: hit.author,
      icon: hit.icon_url,
      downloads: hit.downloads,
      follows: hit.follows,
      categories: hit.categories || [],
      projectType: hit.project_type,
      versions: (hit.versions || []).slice(-6),
      pageUrl: `https://modrinth.com/${hit.project_type || projectType}/${hit.slug || hit.project_id}`,
    })),
  };
}

/** 选一个与实例版本/加载器匹配的文件 */
function pickFile(versions, { gameVersion, loader, projectType }) {
  const list = Array.isArray(versions) ? versions : [];
  const needLoader = ['mod', 'modpack'].includes(projectType) && loader;

  const scored = list.filter((version) => {
    if (gameVersion && Array.isArray(version.game_versions) && !version.game_versions.includes(gameVersion)) {
      return false;
    }
    if (needLoader && Array.isArray(version.loaders) && version.loaders.length) {
      return version.loaders.includes(loader);
    }
    return true;
  });

  const source = scored.length ? scored : list;
  const chosen = source[0];
  if (!chosen) return null;

  const file =
    (chosen.files || []).find((f) => f.primary) || (chosen.files || [])[0];
  if (!file || !file.url) return null;

  return {
    versionId: chosen.id,
    versionNumber: chosen.version_number,
    gameVersions: chosen.game_versions || [],
    loaders: chosen.loaders || [],
    url: file.url,
    filename: file.filename,
    size: file.size,
    sha512: file.hashes && file.hashes.sha512,
  };
}

async function download(url, dest, onProgress) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;

  const res = await axios.get(url, {
    responseType: 'stream',
    timeout: 30000,
    maxRedirects: 5,
    headers: { 'User-Agent': USER_AGENT },
    validateStatus: (s) => s >= 200 && s < 300,
  });

  const total = Number(res.headers['content-length'] || 0);
  let received = 0;
  let lastEmit = 0;

  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(part);
    const fail = (error) => {
      res.data.destroy();
      out.destroy();
      reject(error);
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

  await fsp.rename(part, dest);
  return (await fsp.stat(dest)).size;
}

/**
 * 安装一个 Modrinth 项目到实例目录。
 * @param {{ projectId: string, projectType: string, gameVersion: string, loader: string, instance: object }} options
 */
async function installProject(options = {}) {
  const { projectType = 'mod' } = options;
  if (projectType === 'modpack') return installModpack(options);

  const { projectId, gameVersion = '', loader = '', instance = {} } = options;

  if (!projectId) throw new StoreError('缺少项目 ID');
  const subDir = TARGET_DIR[projectType];
  if (!subDir) throw new StoreError(`不支持的类型：${projectType}`);

  const query = new URLSearchParams();
  if (gameVersion) query.set('game_versions', JSON.stringify([gameVersion]));
  if (loader && ['mod', 'modpack'].includes(projectType)) query.set('loaders', JSON.stringify([loader]));

  const versions = await getJson(
    `${MODRINTH}/project/${encodeURIComponent(projectId)}/version${query.toString() ? `?${query}` : ''}`
  );

  const file = pickFile(versions, { gameVersion, loader, projectType });
  if (!file) {
    throw new StoreError(
      `没有找到匹配的文件${gameVersion ? `（游戏版本 ${gameVersion}）` : ''}${loader ? `（加载器 ${loader}）` : ''}，请换一个项目或检查实例版本`
    );
  }

  const root = launcher.resolveGameRoot(instance);
  const dir = path.join(root, subDir);
  const dest = path.join(dir, path.basename(file.filename));

  const size = await download(file.url, dest, options.onProgress);

  return {
    ok: true,
    projectId,
    projectType,
    root,
    dir,
    file: path.basename(file.filename),
    versionNumber: file.versionNumber,
    size,
    gameVersions: file.gameVersions,
    loaders: file.loaders,
    note: '',
  };
}

/**
 * 安装整合包（.mrpack）：下载 → 解包清单 → 逐个下载 files[] → 解压 overrides。
 *
 * @param {{ projectId: string, projectTitle?: string, gameVersion?: string, loader?: string,
 *           instance: object, onProgress?: Function, resolveVersions?: Function }} options
 *   resolveVersions 仅用于自检注入（跳过真实 Modrinth 请求）。
 */
async function installModpack(options = {}) {
  const {
    projectId,
    projectTitle = '',
    gameVersion = '',
    loader = '',
    instance = {},
    onProgress = () => {},
    resolveVersions = null,
  } = options;

  if (!projectId) throw new StoreError('缺少项目 ID');

  const query = new URLSearchParams();
  if (gameVersion) query.set('game_versions', JSON.stringify([gameVersion]));
  if (loader) query.set('loaders', JSON.stringify([loader]));

  const versions = resolveVersions
    ? await resolveVersions({ projectId, gameVersion, loader })
    : await getJson(
        `${MODRINTH}/project/${encodeURIComponent(projectId)}/version${query.toString() ? `?${query}` : ''}`
      );

  const file = pickFile(versions, { gameVersion, loader, projectType: 'modpack' });
  if (!file) {
    throw new StoreError(
      `没有找到匹配的整合包文件${gameVersion ? `（游戏版本 ${gameVersion}）` : ''}${
        loader ? `（加载器 ${loader}）` : ''
      }，请换一个整合包或放宽筛选条件`
    );
  }
  if (!/\.mrpack$/i.test(file.filename || '')) {
    throw new StoreError(`该整合包提供的不是 .mrpack 文件（${file.filename || '未知'}），无法自动安装`);
  }

  const root = launcher.resolveGameRoot(instance);
  const dir = path.join(root, TARGET_DIR.modpack);
  const filename = path.basename(file.filename);
  const dest = path.join(dir, filename);

  onProgress({
    stage: 'pack',
    message: `下载整合包 ${filename}`,
    percent: 0,
    versionNumber: file.versionNumber,
    projectId,
  });
  const size = await download(file.url, dest, (progress = {}) => {
    onProgress({
      stage: 'pack',
      message: `下载整合包 ${filename}`,
      detail: progress.percent == null ? '' : `${progress.percent}%`,
      received: progress.received,
      total: progress.total,
      percent: progress.percent == null ? null : Math.round(progress.percent * 0.15),
      projectId,
    });
  });

  const result = await modpack.install({
    mrpackPath: dest,
    root,
    onProgress,
    source: { projectId, projectType: 'modpack', projectTitle },
  });

  const failures = result.stats.failed || [];
  const packLoader = result.pack.loader || loader;

  return {
    ok: true,
    projectId,
    projectType: 'modpack',
    projectTitle,
    root,
    dir,
    file: filename,
    size,
    versionNumber: file.versionNumber,
    pack: result.pack,
    loader: packLoader,
    loaderVersion: result.pack.loaderVersion,
    stats: result.stats,
    failures,
    note: failures.length
      ? `${failures.length} 个文件没下载成功（网络原因居多），再点一次「安装整合包」会续传补齐。`
      : '',
  };
}

module.exports = {
  StoreError,
  listVersions,
  loadManifest,
  searchProjects,
  installProject,
  installModpack,
  pickFile,
  buildFacets,
  TARGET_DIR,
};
