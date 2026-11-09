'use strict';

/**
 * mirror.js —— 下载源（镜像）解析
 *
 * 背景：官方 Mojang / Forge 的下载在国内经常超时。启动器允许用户把下载源换成
 * 镜像（内置 BMCLAPI，也可以填自己的反代），只需要改「地址前缀」，不改协议。
 *
 * 支持的范围（这是启动器实际会下载的东西）：
 *   · 版本清单 version_manifest_v2.json
 *   · 版本 JSON 里的 client jar / libraries / assetIndex / logging
 *   · 资源文件（assets）—— 通过 MCLC 的 overrides.url.resource
 *   · Fabric / Quilt 的 meta（loader 列表与 profile）
 *   · Forge installer（maven）
 *
 * 自定义镜像约定：根地址下按 BMCLAPI 的目录布局反代：
 *   <base>/mc/...            版本清单与版本 JSON
 *   <base>/maven/...         库与 Forge installer
 *   <base>/assets/<xx>/<hash> 资源
 *   <base>/fabric-meta/...   Fabric meta
 *   <base>/quilt-meta/...    Quilt meta
 */

const settings = require('./settings');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const USER_AGENT = 'Viskluke-Launcher/1.0 (mirror resolver)';

const PRESETS = {
  mojang: {
    id: 'mojang',
    label: '官方 Mojang',
    meta: 'https://launchermeta.mojang.com',
    asset: 'https://resources.download.minecraft.net',
    maven: 'https://libraries.minecraft.net',
    fabric: 'https://meta.fabricmc.net',
    quilt: 'https://meta.quiltmc.org',
  },
  bmclapi: {
    id: 'bmclapi',
    label: 'BMCLAPI 镜像（国内推荐）',
    meta: 'https://bmclapi2.bangbang93.com',
    asset: 'https://bmclapi2.bangbang93.com/assets',
    maven: 'https://bmclapi2.bangbang93.com/maven',
    fabric: 'https://bmclapi2.bangbang93.com/fabric-meta',
    quilt: 'https://bmclapi2.bangbang93.com/quilt-meta',
  },
};

const KNOWN_HOSTS = new Set([
  'launchermeta.mojang.com',
  'piston-meta.mojang.com',
  'piston-data.mojang.com',
  'launcher.mojang.com',
  'libraries.minecraft.net',
  'resources.download.minecraft.net',
  'files.minecraftforge.net',
  'maven.minecraftforge.net',
  'maven.neoforged.net',
  'meta.fabricmc.net',
  'meta.quiltmc.org',
]);

function customPreset(base) {
  const root = String(base || '').trim().replace(/\/+$/, '');
  return {
    id: 'custom',
    label: `自定义镜像（${root || '未填写'}）`,
    meta: root,
    asset: `${root}/assets`,
    maven: `${root}/maven`,
    fabric: `${root}/fabric-meta`,
    quilt: `${root}/quilt-meta`,
  };
}

/** 当前生效的下载源（每次读 settings，改了立刻生效） */
function active() {
  const pref = settings.read();
  if (pref.downloadSource === 'bmclapi') return PRESETS.bmclapi;
  if (pref.downloadSource === 'custom' && String(pref.customMirror || '').trim()) {
    return customPreset(pref.customMirror);
  }
  return PRESETS.mojang;
}

function manifestUrl(src = active()) {
  return `${src.meta}/mc/game/version_manifest_v2.json`;
}

function joinBase(base, pathname) {
  const b = new URL(base);
  let prefix = b.pathname.replace(/\/+$/, '');
  let rest = pathname || '/';
  if (prefix && (rest === prefix || rest.startsWith(`${prefix}/`))) rest = rest.slice(prefix.length) || '/';
  if (!rest.startsWith('/')) rest = `/${rest}`;
  return `${b.origin}${prefix}${rest}`;
}

/**
 * 把一个官方 URL 换到镜像上；不认识的 host 原样返回（宁可失败也不要乱改）。
 */
function resolve(url, src = active()) {
  if (!url) return url;
  if (src.id === 'mojang') return url;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const host = parsed.hostname.toLowerCase();
  if (!KNOWN_HOSTS.has(host)) return url;

  if (host === 'resources.download.minecraft.net') return joinBase(src.asset, parsed.pathname);
  if (host === 'libraries.minecraft.net') return joinBase(src.maven, parsed.pathname);
  if (host === 'files.minecraftforge.net' || host === 'maven.minecraftforge.net') {
    // 官方路径自带 /maven 前缀，镜像的 maven 根已经包含它
    const rest = parsed.pathname.replace(/^\/maven/, '');
    return joinBase(src.maven, rest);
  }
  if (host === 'meta.fabricmc.net') return joinBase(src.fabric, parsed.pathname);
  if (host === 'meta.quiltmc.org') return joinBase(src.quilt, parsed.pathname);
  // maven.neoforged.net 没有通用镜像，原样保留
  if (host === 'maven.neoforged.net') return url;
  // 其余 mojang 域名（版本清单 / 版本 JSON / client jar / logging）
  return joinBase(src.meta, parsed.pathname);
}

function shouldRewrite(value) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return false;
  try {
    return KNOWN_HOSTS.has(new URL(value).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** 深拷贝版本 JSON，并把里面所有官方下载地址换到镜像 */
function rewriteVersionJson(json, src = active()) {
  if (src.id === 'mojang' || !json || typeof json !== 'object') return json;
  const clone = JSON.parse(JSON.stringify(json));
  const walk = (node) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (shouldRewrite(value)) node[key] = resolve(value, src);
      else walk(value);
    }
  };
  walk(clone);
  return clone;
}

/** 给 UI / 日志用的描述 */
function status() {
  const pref = settings.read();
  const src = active();
  return {
    source: src.id,
    label: src.label,
    customMirror: pref.customMirror || '',
    meta: src.meta,
    asset: src.asset,
    maven: src.maven,
    fabric: src.fabric,
    quilt: src.quilt,
    presets: [
      { id: 'mojang', label: PRESETS.mojang.label },
      { id: 'bmclapi', label: PRESETS.bmclapi.label },
      { id: 'custom', label: '自定义镜像' },
    ],
  };
}

async function fetchJson(url, timeout = 30000) {
  const response = await axios.get(url, {
    timeout,
    maxRedirects: 5,
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });
  return response.data;
}

/**
 * 非官方源：把版本 JSON 预取下来、改写成镜像地址，落到 versions/<id>/<id>.json，
 * 让 MCLC 以 version.custom 走它（客户端的 jar / 库 / 资源索引都会走镜像）。
 * 官方源不调用这个函数，保持原行为。
 */
async function prepareVersionJson(root, version, hooks = {}) {
  const { onLog = () => {} } = hooks;
  const src = active();
  if (src.id === 'mojang') return null;
  const manifest = await fetchJson(manifestUrl(src));
  const entry = (manifest.versions || []).find((item) => item.id === version);
  if (!entry) throw new Error(`镜像的版本清单里没有 ${version}`);
  const json = await fetchJson(resolve(entry.url, src));
  const rewritten = rewriteVersionJson(json, src);
  const dir = path.join(root, 'versions', version);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${version}.json`);
  fs.writeFileSync(target, `${JSON.stringify(rewritten, null, 2)}\n`, 'utf8');
  onLog(`[下载源] 版本 JSON 已指向镜像：${target}`);
  return target;
}

/** 把已经生成好的加载器版本 JSON 原地改写（Fabric/Quilt 的库地址等） */
function rewriteVersionFile(filePath) {
  const src = active();
  if (src.id === 'mojang') return false;
  try {
    const json = JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
    fs.writeFileSync(filePath, `${JSON.stringify(rewriteVersionJson(json, src), null, 2)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  PRESETS,
  active,
  status,
  manifestUrl,
  resolve,
  rewriteVersionJson,
  rewriteVersionFile,
  prepareVersionJson,
  shouldRewrite,
};
