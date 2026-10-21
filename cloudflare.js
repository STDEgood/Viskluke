'use strict';

/**
 * cloudflare.js —— Viskluke Address（自动域名解析）
 *
 * 负责：
 *   1. 读取配置（环境变量 或 config.json）
 *   2. 通过 Cloudflare API v4 增删 A / CNAME / SRV 记录
 *   3. 自动探测公网出口 IP
 *
 * 配置来源优先级：环境变量 > userData/config.json > 应用目录/config.json > 工作目录/config.json
 * 支持两种写法（混用亦可）：
 *   { "CF_API_TOKEN": "...", "CF_ZONE_ID": "...", "PUBLIC_IP": "1.2.3.4" }
 *   { "cloudflare": { "apiToken": "...", "zoneId": "...", "zones": { "stde.eu.cc": "..." } } }
 *
 * 注意：本模块不会把 Token 返回给渲染进程，只返回“是否已配置”等状态。
 */

const fs = require('fs');
const path = require('path');
const net = require('net');
const axios = require('axios');
const { app } = require('electron');

const API_BASE = 'https://api.cloudflare.com/client/v4';
const USER_AGENT = 'Viskluke-Launcher/0.2 (+https://viskluke.app)';

/** 允许绑定的域名后缀（内置三个；用户自己的域名会追加在后面） */
const SUFFIXES = ['yistarline.eu.cc', 'stde.eu.cc', 'ys2video.eu.cc'];

/** 当前可用的后缀 = 内置三个 + config.json 里 CF_ZONES 配置过的域名 + 手动解析的域名 */
function configuredSuffixes(cfg = loadConfig()) {
  const list = [...SUFFIXES];
  for (const name of Object.keys(cfg.zones || {})) {
    const key = String(name || '').trim().toLowerCase();
    if (key && !list.includes(key) && cfg.zones[key]) list.push(key);
  }
  for (const name of cfg.manualSuffixes || []) {
    const key = String(name || '').trim().toLowerCase();
    if (key && !list.includes(key)) list.push(key);
  }
  return list;
}

/** 手动解析的域名（DNS 不在 Cloudflare，比如注册商是 GNAME / 阿里云） */
function manualSuffixes(cfg = loadConfig()) {
  return (cfg.manualSuffixes || [])
    .map((name) => String(name || '').trim().toLowerCase())
    .filter((name) => isDomainName(name));
}

/** 域名格式校验（用户可以加自己的域名，但要挡住乱七八糟的输入） */
function isDomainName(value) {
  const name = String(value || '').trim().toLowerCase();
  if (!name || name.length > 253) return false;
  if (!/^[a-z0-9.-]+$/.test(name)) return false;
  if (name.startsWith('.') || name.endsWith('.') || name.includes('..')) return false;
  const labels = name.split('.');
  if (labels.length < 2) return false;
  return labels.every((label) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

/** 这个后缀走什么通道：worker 代理 / 本地 Token / 手动解析 / 没配置 */
function transportFor(suffix, cfg = loadConfig()) {
  const key = String(suffix || '').trim().toLowerCase();
  if (!key) return 'none';
  if (cfg.proxyUrl && SUFFIXES.includes(key)) return 'proxy'; // Worker 只管内置的三个
  if (cfg.zones && cfg.zones[key]) return cfg.token ? 'direct' : 'no-token';
  if ((cfg.manualSuffixes || []).map((n) => String(n).toLowerCase()).includes(key)) return 'manual';
  if (cfg.zoneId && SUFFIXES.includes(key)) return cfg.token ? 'direct' : 'no-token';
  return 'none';
}

/**
 * 内置 Zone 映射：把你自己域名的 Zone ID 填在这里，用户端就完全不需要
 * 「Zone:Read」权限，也不需要自动发现 —— 只要一个能改 DNS 的 Token 即可。
 *
 * Zone ID 不是机密（Cloudflare 概览页可见），可以安全地随客户端分发；
 * API Token 绝对不要写在这里。
 *
 * 三个后缀若都属于同一个 Zone（例如 eu.cc），三个键填同一个 ID 即可。
 */
const BUILTIN_ZONES = {
  'yistarline.eu.cc': '',
  'stde.eu.cc': '',
  'ys2video.eu.cc': '',
};

const DEFAULT_TTL = 60;
const IP_CACHE_MS = 5 * 60 * 1000;
const CONFIG_CACHE_MS = 3000;

/**
 * 零配置开服通道：Cloudflare Worker 代理地址。
 *
 * 这里填的是 Worker 的 URL（**不是密钥**，可以随客户端分发）。部署步骤见
 * `worker/README.md`：Token 只放在 Worker 的环境变量里，客户端只传
 * `前缀 / 后缀 / 端口`，Worker 用 `CF-Connecting-IP` 拿用户的公网 IP 建 A 记录。
 *
 * 这样「每个人都能一键开服、又不需要自己有域名/Token」，同时客户端里
 * 不存在任何 Cloudflare 凭据（Token 一旦进客户端 = 公开 DNS 写权限）。
 * 也可以不用它：直接在界面粘贴自己的 Token 走直连。
 */
const BUILTIN_PROXY_URL = '';

/**
 * 内置中继地址：自建 Cloudflare Worker（Durable Object）的 wss 入口。
 *
 * 这不是密钥，可以随客户端分发。用自有域名绑 Worker，因为
 * `*.workers.dev` 在国内基本连不上（实测超时）；`relay.stde.eu.cc` 走 Cloudflare
 * 边缘网络，国内可直连。用户仍可在 config.json 的 `RELAY_URL` 覆盖它。
 */
const BUILTIN_RELAY_URL = 'wss://relay.stde.eu.cc';

/** 代理接口路径（Worker 端一一对应） */
const PROXY_PATHS = { health: '/health', sync: '/sync', remove: '/remove', probe: '/probe' };

/**
 * 带预填权限的 Token 创建页（Cloudflare 官方 template URL 格式）：
 *   · dns:edit  —— 创建/更新/删除 A、SRV 记录
 *   · zone:read —— 列出账号下的 Zone，用于自动识别 Zone ID
 * 用户只需要在浏览器里点两下、复制 Token，其余步骤全部自动完成。
 */
const TOKEN_TEMPLATE_URL =
  'https://dash.cloudflare.com/profile/api-tokens' +
  '?permissionGroupKeys=%5B%7B%22key%22%3A%22dns%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22zone%22%2C%22type%22%3A%22read%22%7D%5D' +
  '&accountId=%2A&zoneId=all&name=Viskluke%20Address';

let configCache = null;
let configCacheAt = 0;
let ipCache = null;
let ipCacheAt = 0;

class CloudflareError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'CloudflareError';
    Object.assign(this, extra);
  }
}

// ---------------------------------------------------------------------------
// 配置读取
// ---------------------------------------------------------------------------

function configPaths() {
  const paths = [];
  try {
    paths.push(path.join(app.getPath('userData'), 'config.json'));
  } catch {
    /* app 未就绪时忽略 */
  }
  try {
    paths.push(path.join(app.getAppPath(), 'config.json'));
  } catch {
    /* ignore */
  }
  paths.push(path.join(process.cwd(), 'config.json'));
  return [...new Set(paths)];
}

function readConfigFile() {
  const errors = [];
  for (const file of configPaths()) {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') errors.push(`${file}: ${err.message}`);
      continue;
    }
    try {
      const json = JSON.parse(raw.replace(/^\uFEFF/, ''));
      return { file, json, errors };
    } catch (err) {
      errors.push(`${file}: JSON 解析失败（${err.message}）`);
    }
  }
  return { file: null, json: {}, errors };
}

const firstString = (...values) =>
  values.find((v) => typeof v === 'string' && v.trim())?.trim() || null;

function parseZoneMap(raw) {
  if (!raw) return {};
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const map = {};
  for (const [suffix, zoneId] of Object.entries(value)) {
    if (typeof zoneId === 'string' && zoneId.trim()) map[suffix.trim().toLowerCase()] = zoneId.trim();
  }
  return map;
}

/** 读取并归一化配置（带 3 秒缓存，便于 UI “重新检测”后立即生效） */
function loadConfig(force = false) {
  const now = Date.now();
  if (!force && configCache && now - configCacheAt < CONFIG_CACHE_MS) return configCache;

  const { file, json, errors } = readConfigFile();
  const cf = json.cloudflare || json.cf || {};

  const token = firstString(
    process.env.CF_API_TOKEN,
    process.env.CLOUDFLARE_API_TOKEN,
    json.CF_API_TOKEN,
    json.cfApiToken,
    cf.apiToken,
    cf.token
  );
  const zoneId = firstString(
    process.env.CF_ZONE_ID,
    json.CF_ZONE_ID,
    json.zoneId,
    cf.zoneId
  );
  // 只采纳非空的内置 Zone，避免"空字符串也算已配置"
  const builtinZones = Object.fromEntries(
    Object.entries(BUILTIN_ZONES).filter(([, value]) => String(value || '').trim())
  );
  const zones = {
    ...builtinZones,
    ...parseZoneMap(process.env.CF_ZONES || json.CF_ZONES || json.zones || cf.zones),
  };
  const publicIp = firstString(process.env.CF_PUBLIC_IP, json.PUBLIC_IP, json.publicIp, cf.publicIp);
  const targetHost = firstString(
    process.env.CF_TARGET_HOST,
    json.PUBLIC_HOST,
    json.publicHost,
    cf.publicHost,
    cf.targetHost
  );
  const manualSuffixes = Array.isArray(json.MANUAL_SUFFIXES)
    ? json.MANUAL_SUFFIXES
    : Array.isArray(json.manualSuffixes)
      ? json.manualSuffixes
      : [];
  const ttl = Number(process.env.CF_TTL || json.TTL || json.ttl || cf.ttl || DEFAULT_TTL);
  const proxyUrl = firstString(
    process.env.CF_PROXY_URL,
    json.PROXY_URL,
    json.proxyUrl,
    cf.proxyUrl
  ) || BUILTIN_PROXY_URL;
  const relayUrl = firstString(
    process.env.RELAY_URL,
    json.RELAY_URL,
    json.relayUrl,
    cf.relayUrl
  ) || BUILTIN_RELAY_URL;

  configCache = {
    file,
    errors,
    token,
    zoneId,
    zones,
    publicIp,
    targetHost,
    ttl: normalizeTtl(ttl),
    proxyUrl: String(proxyUrl || '').trim().replace(/\/+$/, ''),
    relayUrl: String(relayUrl || '').trim().replace(/\/+$/, ''),
    manualSuffixes,
  };
  configCacheAt = now;
  return configCache;
}

function normalizeTtl(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TTL;
  if (n === 1) return 1; // 1 = Automatic
  return Math.min(86400, Math.max(60, Math.round(n)));
}

function requireCloudflare() {
  const cfg = loadConfig();
  if (!cfg.token) {
    throw new CloudflareError(
      '未配置 CF_API_TOKEN：请在 config.json（或环境变量）中填入 Cloudflare API Token'
    );
  }
  if (!cfg.zoneId && Object.keys(cfg.zones).length === 0) {
    throw new CloudflareError(
      '未配置 CF_ZONE_ID：请在 config.json 中填入 Zone ID，或使用 zones 映射多个后缀'
    );
  }
  return cfg;
}

/** 某个后缀使用哪个 Zone */
function zoneIdFor(suffix, cfg = loadConfig()) {
  const key = String(suffix || '').trim().toLowerCase();
  if (SUFFIXES.includes(key)) {
    if (cfg.zones[key]) return cfg.zones[key];
    if (cfg.zoneId) return cfg.zoneId;
    throw new CloudflareError(
      `缺少 ${key} 对应的 Zone ID：请在 config.json 的 zones 中配置，或设置 CF_ZONE_ID`
    );
  }
  if (isDomainName(key) && cfg.zones[key]) return cfg.zones[key];
  if (isDomainName(key)) {
    throw new CloudflareError(
      `域名 ${key} 还没有绑定：请在服务器页「域名管理」里添加它，并填入它的 Zone ID（Cloudflare 域名概览页右侧可复制）`
    );
  }
  throw new CloudflareError(`域名后缀不合法：${suffix}`);
}

/** 供 UI 展示的配置状态（绝不包含 Token 明文） */
function status() {
  const cfg = loadConfig(true);
  const proxyMode = Boolean(cfg.proxyUrl);
  const all = configuredSuffixes(cfg);
  const zoneMap = {};
  for (const suffix of all) {
    const transport = transportFor(suffix, cfg);
    zoneMap[suffix] =
      transport === 'proxy' ? 'proxy' : cfg.zones[suffix] || (SUFFIXES.includes(suffix) ? cfg.zoneId : '') || null;
  }

  const hasZone = Boolean(cfg.zoneId || Object.keys(cfg.zones).length);
  // 代理模式不需要本地 Token / Zone：Worker 那边已经持有了
  const manual = manualSuffixes(cfg);
  const configured = proxyMode || (Boolean(cfg.token) && hasZone) || manual.length > 0;
  return {
    configured,
    transport: proxyMode ? 'proxy' : cfg.token ? 'direct' : 'none',
    hasToken: Boolean(cfg.token),
    hasZone,
    proxyUrl: cfg.proxyUrl || '',
    relayUrl: cfg.relayUrl || '',
    suffixes: all,
    builtinSuffixes: SUFFIXES,
    customSuffixes: all.filter((suffix) => !SUFFIXES.includes(suffix) && !manual.includes(suffix)),
    manualSuffixes: manual,
    transports: Object.fromEntries(all.map((suffix) => [suffix, transportFor(suffix, cfg)])),
    zones: zoneMap,
    missingZones: all.filter((s) => !zoneMap[s] && transportFor(s, cfg) !== 'manual'),
    mode: cfg.targetHost ? 'host' : 'ip',
    targetHost: cfg.targetHost,
    publicIp: cfg.publicIp,
    ttl: cfg.ttl,
    configFile: cfg.file,
    configSearchPaths: configPaths(),
    errors: cfg.errors,
  };
}

// ---------------------------------------------------------------------------
// Cloudflare API 基础请求
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function extractCfErrors(body, statusCode) {
  const list = Array.isArray(body && body.errors) ? body.errors : [];
  const text = list
    .map((e) => `${e && e.code ? `[${e.code}] ` : ''}${(e && e.message) || '未知错误'}`)
    .join('; ');
  return text || `HTTP ${statusCode}`;
}

/**
 * 统一请求封装：自动重试 429/5xx，非 2xx 抛出可读错误。
 * allow404 为 true 时，404 返回 null（用于幂等删除）。
 * options.token 可传入"尚未保存到配置里"的 Token（连接向导用）。
 */
async function request(method, endpoint, data = null, options = {}) {
  const cfg = requireCloudflare();
  const token = String(options.token || cfg.token);
  const { retries = 2, timeout = 15000, allow404 = false } = options;
  const url = `${API_BASE}${endpoint}`;
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    let response;
    try {
      response = await axios({
        method,
        url,
        data: data === null ? undefined : data,
        timeout,
        maxRedirects: 3,
        validateStatus: () => true,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': USER_AGENT,
        },
      });
    } catch (err) {
      lastError = new CloudflareError(`Cloudflare 网络请求失败：${err.message}`);
      if (attempt < retries) {
        await sleep(600 * (attempt + 1));
        continue;
      }
      break;
    }

    if (response.status === 404 && allow404) return null;

    const body = response.data;
    const success = response.status >= 200 && response.status < 300 && body && body.success !== false;
    if (success) return body.result === undefined ? body : body.result;

    const message = extractCfErrors(body, response.status);
    const error = new CloudflareError(
      `Cloudflare 请求失败（HTTP ${response.status}）：${message}`,
      { status: response.status, errors: (body && body.errors) || [] }
    );
    if (response.status === 429 || response.status >= 500) {
      lastError = error;
      if (attempt < retries) {
        await sleep(800 * (attempt + 1));
        continue;
      }
      throw error;
    }
    throw error;
  }

  throw lastError || new CloudflareError('Cloudflare 请求失败：未知错误');
}

/** 校验 Token / 代理是否可用，UI 的“检测配置”按钮会调用 */
async function verify() {
  const cfg = loadConfig(true);
  if (cfg.proxyUrl) {
    try {
      const data = await proxyRequest(PROXY_PATHS.health, null, { timeout: 12000 });
      return { ok: true, tokenStatus: 'proxy', transport: 'proxy', proxyUrl: cfg.proxyUrl, zones: data.zones || [] };
    } catch (err) {
      return { ok: false, error: err.message, transport: 'proxy', proxyUrl: cfg.proxyUrl };
    }
  }

  try {
    const config = requireCloudflare();
    const result = await request('GET', '/user/tokens/verify', null, { retries: 0, timeout: 10000 });
    return {
      ok: true,
      tokenStatus: (result && result.status) || 'active',
      transport: 'direct',
      configFile: config.file,
    };
  } catch (err) {
    return { ok: false, error: err.message, status: err.status };
  }
}

// ---------------------------------------------------------------------------
// Worker 代理（零配置开服通道）
// ---------------------------------------------------------------------------

function proxyBase() {
  const cfg = loadConfig();
  return cfg.proxyUrl || '';
}

async function proxyRequest(pathname, payload = null, options = {}) {
  const base = proxyBase();
  if (!base) throw new CloudflareError('没有配置 Worker 代理地址（PROXY_URL）');
  const url = `${base}${pathname}`;
  const { timeout = 20000 } = options;

  let res;
  try {
    res = payload
      ? await axios.post(url, payload, {
          timeout,
          maxRedirects: 3,
          headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/json', Accept: 'application/json' },
          validateStatus: (s) => s >= 200 && s < 500,
        })
      : await axios.get(url, {
          timeout,
          maxRedirects: 3,
          headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
          validateStatus: (s) => s >= 200 && s < 500,
        });
  } catch (error) {
    throw new CloudflareError(`连不上 Viskluke 代理：${(error && error.message) || error}`);
  }

  const data = res.data || {};
  if (!data || data.ok !== true) {
    const reason = (data && (data.error || data.message)) || `HTTP ${res.status}`;
    throw new CloudflareError(`Viskluke 代理返回失败：${reason}`);
  }
  return data;
}

/**
 * 让 Worker（= 公网视角）连一下服务器端口，回答"外面到底能不能连进来"。
 * 需要配置了 PROXY_URL 且 Worker 是新版（带 /probe）。
 * @param {{ host: string, port: number }} input
 */
async function probeReachable(input = {}) {
  const cfg = loadConfig();
  if (!cfg.proxyUrl) throw new CloudflareError('没有配置 Worker 代理（PROXY_URL），拿不到外部视角');
  const host = String(input.host || '').trim();
  const port = Number(input.port);
  if (!host) throw new CloudflareError('缺少要探测的地址');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new CloudflareError(`端口不合法：${input.port}`);

  const data = await proxyRequest(PROXY_PATHS.probe, { host, port }, { timeout: 15000 });
  return {
    reachable: data.reachable === true,
    host: data.host || host,
    port: Number(data.port || port),
    ms: Number(data.ms || 0),
    error: data.error || data.reason || '',
    viaProxy: true,
  };
}

// ---------------------------------------------------------------------------
// 公网 IP / 工具函数
// ---------------------------------------------------------------------------

function isPrivateIp(ip) {
  if (!ip) return false;
  const version = net.isIP(ip);
  if (version === 6) {
    return /^(fc|fd|fe80|::1)/i.test(ip);
  }
  if (version !== 4) return false;
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

async function detectPublicIp() {
  const now = Date.now();
  if (ipCache && now - ipCacheAt < IP_CACHE_MS) return ipCache;

  const providers = [
    { url: 'https://api.ipify.org?format=json', pick: (d) => d && d.ip },
    { url: 'https://api64.ipify.org?format=json', pick: (d) => d && d.ip },
    { url: 'https://ifconfig.co/json', pick: (d) => d && (d.ip || d.ip_addr) },
    { url: 'https://api.myip.com', pick: (d) => d && d.ip },
  ];

  for (const provider of providers) {
    try {
      const res = await axios.get(provider.url, {
        timeout: 8000,
        validateStatus: () => true,
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      });
      if (res.status !== 200) continue;
      const ip = String(provider.pick(res.data) || '').trim();
      if (net.isIP(ip)) {
        ipCache = ip;
        ipCacheAt = now;
        return ip;
      }
    } catch {
      /* 换下一个服务商 */
    }
  }
  return null;
}

async function findRecords(zoneId, name) {
  const query = new URLSearchParams({ name, per_page: '100' });
  const result = await request('GET', `/zones/${zoneId}/dns_records?${query.toString()}`);
  return Array.isArray(result) ? result : [];
}

async function deleteRecord(zoneId, recordId) {
  return request('DELETE', `/zones/${zoneId}/dns_records/${recordId}`, null, { allow404: true });
}

/** 同一主机名只允许存在一种主机记录：切换 ip/host 模式时先清掉另一种 */
async function removeByType(zoneId, name, types) {
  const list = await findRecords(zoneId, name);
  for (const record of list) {
    if (types.includes(record.type)) {
      await deleteRecord(zoneId, record.id).catch(() => {});
    }
  }
}

/** 新增或更新一条记录（同名同类型则 PUT，否则 POST） */
async function upsertRecord(zoneId, payload) {
  const list = await findRecords(zoneId, payload.name);
  const existing = list.find((r) => r.type === payload.type);
  if (existing) {
    const record = await request('PUT', `/zones/${zoneId}/dns_records/${existing.id}`, payload);
    return { id: existing.id, action: 'updated', record };
  }
  const record = await request('POST', `/zones/${zoneId}/dns_records`, payload);
  return { id: record.id, action: 'created', record };
}

/**
 * SRV 记录的写入方式在 Cloudflare 上存在两种被广泛使用的形态，
 * 不同账户/API 版本校验不同，这里按顺序尝试，直到成功为止：
 *   1) data.name = 基础域名（官方文档示例）
 *   2) data.name = 完整 _service._proto 名称
 *   3) 扁平字段 priority/weight/port/target
 */
async function upsertSrv(zoneId, { srvName, baseName, port, target, ttl }) {
  const variants = [
    {
      label: 'data',
      payload: {
        type: 'SRV',
        name: srvName,
        ttl,
        data: {
          service: '_minecraft',
          proto: '_tcp',
          name: baseName,
          priority: 0,
          weight: 5,
          port,
          target,
        },
      },
    },
    {
      label: 'data-full',
      payload: {
        type: 'SRV',
        name: srvName,
        ttl,
        data: {
          service: '_minecraft',
          proto: '_tcp',
          name: srvName,
          priority: 0,
          weight: 5,
          port,
          target,
        },
      },
    },
    {
      label: 'flat',
      payload: { type: 'SRV', name: srvName, ttl, priority: 0, weight: 5, port, target },
    },
  ];

  const list = await findRecords(zoneId, srvName);
  const existing = list.find((r) => r.type === 'SRV');
  let lastError = null;

  for (const variant of variants) {
    try {
      if (existing) {
        const record = await request('PUT', `/zones/${zoneId}/dns_records/${existing.id}`, variant.payload);
        return { id: existing.id, action: 'updated', variant: variant.label, record };
      }
      const record = await request('POST', `/zones/${zoneId}/dns_records`, variant.payload);
      return { id: record.id, action: 'created', variant: variant.label, record };
    } catch (err) {
      lastError = err;
      // 只有 400（格式校验失败）才值得换一种写法重试
      if (err.status !== 400) break;
    }
  }

  throw new CloudflareError(`SRV 记录写入失败：${(lastError && lastError.message) || '未知错误'}`);
}

// ---------------------------------------------------------------------------
// 对外：创建 / 更新解析
// ---------------------------------------------------------------------------

/**
 * 为某台服务器创建（或更新）A/CNAME + SRV 记录。
 *
 * @param {object} opts
 * @param {string} opts.prefix  主机名前缀，例如 myminecraft
 * @param {string} opts.suffix  yistarline.eu.cc / stde.eu.cc / ys2video.eu.cc
 * @param {number} opts.port    服务器实际监听端口（写入 SRV）
 * @param {number} [opts.ttl]
 * @param {object} [opts.previous] 上一次的解析信息，用于清理残留记录
 */
async function sync({ prefix, suffix, port, ttl: ttlOption, previous = {}, ipv6 = '' }) {
  const cfg = loadConfig();
  const key = String(suffix || '').trim().toLowerCase();
  const v6 = String(ipv6 || '').trim();

  if (!isDomainName(key)) {
    throw new CloudflareError(`域名后缀不合法：${suffix}`);
  }
  if (!prefix) throw new CloudflareError('缺少域名前缀');
  if (!Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535) {
    throw new CloudflareError(`端口不合法：${port}`);
  }

  const transport = transportFor(key, cfg);
  if (transport === 'none') {
    throw new CloudflareError(
      SUFFIXES.includes(key)
        ? `域名 ${key} 还没有可用通道：请先连接 Cloudflare Token，或配置 Worker 代理（PROXY_URL）`
        : `域名 ${key} 还没有绑定：在服务器页「域名管理」里添加它，并填入它在 Cloudflare 的 Zone ID`
    );
  }
  if (transport === 'no-token') {
    throw new CloudflareError(`域名 ${key} 已经有 Zone ID，但缺少 Token：请先在「设置公网域名」里连接一次`);
  }

  // 走 Worker 代理：客户端不需要 Token / Zone，公网 IP 由 Worker 侧识别
  if (transport === 'proxy') {
    const data = await proxyRequest(PROXY_PATHS.sync, {
      prefix,
      suffix: key,
      port: Number(port),
      ttl: normalizeTtl(ttlOption || cfg.ttl),
    });
    return {
      zoneId: data.zoneId || 'proxy',
      mode: data.mode || 'ip',
      address: data.address,
      srvName: data.srvName,
      srvTarget: data.srvTarget,
      port: Number(data.port || port),
      ttl: Number(data.ttl || normalizeTtl(ttlOption || cfg.ttl)),
      targetIp: data.targetIp || null,
      targetHost: data.targetHost || null,
      records: data.records || {},
      warnings: Array.isArray(data.warnings) ? data.warnings : [],
      viaProxy: true,
    };
  }

  const config = requireCloudflare();
  const zoneId = zoneIdFor(key, config);
  const fqdn = `${prefix}.${suffix}`;
  const actualPort = Number(port);
  const normalizedTtl = normalizeTtl(ttlOption || cfg.ttl);
  const wantIpv6 = net.isIP(v6) === 6;
  const mode = cfg.targetHost ? 'host' : wantIpv6 ? 'dual' : 'ip';
  const warnings = [];

  let targetIp = null;
  let targetHost = null;
  let targetIpv6 = null;

  if (mode === 'host') {
    targetHost = String(cfg.targetHost).trim().toLowerCase();
    warnings.push(`已启用 PUBLIC_HOST 模式：主机记录使用 CNAME → ${targetHost}`);
  } else {
    targetIpv6 = wantIpv6 ? v6 : null;
    if (!targetIpv6) {
      targetIp = cfg.publicIp || (await detectPublicIp());
      if (!targetIp) {
        throw new CloudflareError('无法自动获取公网 IP，请在 config.json 中设置 PUBLIC_IP');
      }
      if (!net.isIP(targetIp)) {
        throw new CloudflareError(`PUBLIC_IP 不是合法的 IP：${targetIp}`);
      }
      if (isPrivateIp(targetIp)) {
        warnings.push(
          `目标 IP ${targetIp} 属于内网地址，公网玩家无法直连；请做端口映射/公网 IP，或改用 config.json 的 PUBLIC_HOST 指向 DDNS 域名`
        );
      }
    } else {
      warnings.push(
        `已按 IPv6 建 AAAA 记录（${targetIpv6}）：有 IPv6 的玩家可直连，纯 IPv4 的玩家仍然需要端口映射`
      );
    }
  }

  const records = {};

  // 1) 主机记录：AAAA（IPv6 直连）/ A（IPv4）/ CNAME（指向 DDNS 或节点）
  if (mode === 'host') {
    await removeByType(zoneId, fqdn, ['A', 'AAAA']);
    const hostRecord = await upsertRecord(zoneId, {
      type: 'CNAME',
      name: fqdn,
      content: targetHost,
      ttl: normalizedTtl,
      proxied: false,
    });
    records.cname = hostRecord.id;
  } else {
    await removeByType(zoneId, fqdn, ['CNAME']);
    if (targetIpv6) {
      const aaaa = await upsertRecord(zoneId, {
        type: 'AAAA',
        name: fqdn,
        content: targetIpv6,
        ttl: normalizedTtl,
        proxied: false, // 游戏流量必须直连，不能走 Cloudflare 代理
      });
      records.aaaa = aaaa.id;
    }
    if (targetIp) {
      const a = await upsertRecord(zoneId, {
        type: 'A',
        name: fqdn,
        content: targetIp,
        ttl: normalizedTtl,
        proxied: false,
      });
      records.a = a.id;
    }
  }

  // 2) SRV 记录：让玩家不用输入端口
  const srvName = `_minecraft._tcp.${fqdn}`;
  const srvTarget = mode === 'host' ? targetHost : fqdn;
  const srv = await upsertSrv(zoneId, {
    srvName,
    baseName: fqdn,
    port: actualPort,
    target: srvTarget,
    ttl: normalizedTtl,
  });
  records.srv = srv.id;
  if (srv.variant && srv.variant !== 'data') {
    warnings.push(`SRV 记录使用了兼容写法「${srv.variant}」，已创建成功`);
  }

  // 3) 清理旧记录中未被复用的部分（例如 ip ↔ host 模式切换后的残留）
  if (previous && previous.zoneId === zoneId && previous.records) {
    for (const [key, id] of Object.entries(previous.records)) {
      if (!id || Object.values(records).includes(id)) continue;
      await deleteRecord(zoneId, id).catch(() => {});
      void key;
    }
  }

  return {
    zoneId,
    mode,
    address: fqdn,
    srvName,
    srvTarget,
    port: actualPort,
    ttl: normalizedTtl,
    targetIp,
    targetIpv6,
    targetHost,
    records,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// 对外：删除解析
// ---------------------------------------------------------------------------

/**
 * 删除与某台服务器相关的解析记录。
 * 优先按记录的 ID 精确删除；若 ID 丢失，再按域名兜底查找删除。
 */
async function remove({ zoneId, records = {}, address, suffix } = {}) {
  const cfg = loadConfig();

  // 代理模式：按域名让 Worker 自己清理（Worker 那边不认我们本地的记录 ID）
  // 按域名推断后缀，再决定走代理还是直连
  const inferredSuffix = suffix
    || configuredSuffixes(cfg).find((item) => String(address || '').toLowerCase().endsWith(`.${item}`))
    || '';
  const transport = transportFor(inferredSuffix, cfg);

  if (transport === 'proxy') {
    if (!address) throw new CloudflareError('缺少域名，无法删除解析');
    const data = await proxyRequest(PROXY_PATHS.remove, {
      address,
      prefix: String(address).split('.')[0],
      suffix: inferredSuffix,
    });
    return { removed: Array.isArray(data.removed) ? data.removed : [], viaProxy: true };
  }

  const zone = zoneId || (inferredSuffix ? zoneIdFor(inferredSuffix, cfg) : cfg.zoneId);
  if (!zone) throw new CloudflareError('缺少 Zone ID，无法删除解析记录');

  const removed = [];
  const failed = [];
  const knownIds = Object.values(records).filter(Boolean);

  for (const id of knownIds) {
    try {
      await deleteRecord(zone, id);
      removed.push(id);
    } catch (err) {
      failed.push(err.message);
    }
  }

  // 兜底：只有在完全没有 ID 记录时才按名字清理，避免误删同名但非本启动器创建的记录
  if (address && knownIds.length === 0) {
    for (const name of [address, `_minecraft._tcp.${address}`]) {
      try {
        const list = await findRecords(zone, name);
        for (const record of list) {
          if (['A', 'AAAA', 'CNAME', 'SRV'].includes(record.type)) {
            await deleteRecord(zone, record.id);
            removed.push(record.id);
          }
        }
      } catch (err) {
        failed.push(`${name}: ${err.message}`);
      }
    }
  }

  if (failed.length) {
    throw new CloudflareError(`部分解析记录删除失败：${failed.join('；')}`);
  }
  return { removed };
}

// ---------------------------------------------------------------------------
// 连接向导：粘贴 Token → 自动识别 Zone → 写入 config.json
// ---------------------------------------------------------------------------

/** 把 Zone 列表归一化成 { suffix: zoneId }，只保留我们支持的三个后缀 */
function mapZonesByName(zones) {
  const map = {};
  for (const zone of Array.isArray(zones) ? zones : []) {
    const name = String(zone && zone.name ? zone.name : '').toLowerCase();
    if (!name) continue;
    if (SUFFIXES.includes(name)) map[name] = zone.id;
  }
  return map;
}

/**
 * 用给定 Token 校验身份并自动发现 Zone。
 * @returns {{ tokenStatus: string, zones: Record<string,string>, missing: string[], accountNames: string[] }}
 */
async function discoverZones(token) {
  const clean = String(token || '').trim();
  if (!/^[A-Za-z0-9_-]{20,}$/.test(clean)) {
    throw new CloudflareError('Token 格式不正确（应为 20 位以上的字母/数字/下划线/连字符）');
  }

  const verifyResult = await request('GET', '/user/tokens/verify', null, {
    token: clean,
    retries: 0,
    timeout: 12000,
  });

  let zoneList = [];
  let listError = null;
  try {
    // 一次拉取全部 Zone（per_page 上限 50），再本地匹配后缀
    zoneList = await request('GET', '/zones?per_page=50', null, { token: clean, retries: 1 });
  } catch (err) {
    listError = err;
  }

  const zones = mapZonesByName(zoneList);
  const missing = SUFFIXES.filter((suffix) => !zones[suffix]);

  return {
    tokenStatus: (verifyResult && verifyResult.status) || 'active',
    zones,
    missing,
    zoneCount: Array.isArray(zoneList) ? zoneList.length : 0,
    listError: listError ? listError.message : null,
  };
}

function configTargetPath() {
  const cfg = loadConfig(true);
  if (cfg.file) return cfg.file;
  return path.join(app.getPath('userData'), 'config.json');
}

/** 合并写入 config.json（保留用户其它键，不会整体覆盖） */
function saveConfig(patch) {
  const file = configTargetPath();
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    current = {};
  }
  const next = { ...current, ...patch };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  try {
    fs.chmodSync(file, 0o600); // 含 Token，尽量收紧权限（Windows 上是近似行为）
  } catch {
    /* ignore */
  }
  configCache = null;
  configCacheAt = 0;
  return file;
}

/**
 * 绑定一个新的域名后缀（用户自己的域名）。
 * Zone ID 可以手填；不填就尝试用 Token 自动查（需要 Zone:Read）。
 * @param {{ suffix: string, zoneId?: string }} input
 */
async function addZone(input = {}) {
  const suffix = String(input.suffix || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!isDomainName(suffix)) {
    throw new CloudflareError(`域名格式不对：${input.suffix || '(空)'}（例如 mydomain.com）`);
  }
  const cfg = loadConfig(true);
  let zoneId = String(input.zoneId || '').trim();

  if (zoneId) {
    if (!/^[0-9a-f]{32}$/i.test(zoneId)) {
      throw new CloudflareError('Zone ID 格式不对：应该是 32 位十六进制（Cloudflare 域名概览页右侧可复制）');
    }
  } else {
    if (!cfg.token) {
      throw new CloudflareError(
        '没有 Token 就没法自动查 Zone ID：请填写 Zone ID（Cloudflare 域名概览页右侧可复制），或先连接 Token'
      );
    }
    const found = await request('GET', `/zones?name=${encodeURIComponent(suffix)}`, null, { retries: 0 });
    const hit = Array.isArray(found) ? found[0] : null;
    if (!hit) {
      throw new CloudflareError(
        `Token 里找不到 ${suffix} 这个域名。检查：① 域名是否在这个 Cloudflare 账号下；② Token 是否有「Zone → Zone → Read」权限。也可以直接手填 Zone ID。`
      );
    }
    zoneId = hit.id;
  }

  const zones = { ...(cfg.zones || {}), [suffix]: zoneId };
  const file = saveConfig({ CF_ZONES: zones });
  const verified = await verifyZoneAccess(zoneId, suffix).catch(() => ({ ok: false }));
  return {
    ok: true,
    suffix,
    zoneId,
    configFile: file,
    zones,
    canWrite: verified.ok,
    warning: verified.ok
      ? ''
      : 'Zone ID 已保存，但用当前 Token 写不了它的记录 —— 检查 Token 的 Zone Resources 是否包含这个域名。',
  };
}

/** 用 Token 试着读一下这个 Zone，确认真有写权限（读不了就不报错，只给提示） */
async function verifyZoneAccess(zoneId, suffix) {
  const cfg = requireCloudflare();
  const hit = await request('GET', `/zones/${zoneId}`, null, { retries: 0 });
  void cfg;
  void suffix;
  return { ok: Boolean(hit && hit.id) };
}

/** 解绑一个自定义域名（内置三个不能删） */
function removeZone(suffix) {
  const key = String(suffix || '').trim().toLowerCase();
  if (SUFFIXES.includes(key)) throw new CloudflareError('内置的三个后缀不能删除（可以不给它建解析）');
  const cfg = loadConfig(true);
  if (!cfg.zones || !cfg.zones[key]) throw new CloudflareError(`没有绑定过这个域名：${key}`);
  const zones = { ...cfg.zones };
  delete zones[key];
  const file = saveConfig({ CF_ZONES: zones });
  return { ok: true, suffix: key, configFile: file, zones };
}

/**
 * 登记一个"手动解析"的域名：DNS 不在 Cloudflare（例如注册商是 GNAME / 阿里云）。
 * 启动器不会去改它的记录，只负责算好该填什么（A 记录 → 你的公网 IP，SRV → 端口）。
 * @param {{ suffix: string }} input
 */
function addManualZone(input = {}) {
  const suffix = String(input.suffix || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!isDomainName(suffix)) {
    throw new CloudflareError(`域名格式不对：${input.suffix || '(空)'}（例如 mydomain.com）`);
  }
  const cfg = loadConfig(true);
  const current = manualSuffixes(cfg);
  if (current.includes(suffix)) return { ok: true, suffix, manualSuffixes: current, duplicated: true };
  const next = [...current, suffix];
  const file = saveConfig({ MANUAL_SUFFIXES: next });
  return { ok: true, suffix, configFile: file, manualSuffixes: next };
}

/** 取消手动解析登记 */
function removeManualZone(suffix) {
  const key = String(suffix || '').trim().toLowerCase();
  const cfg = loadConfig(true);
  const current = manualSuffixes(cfg);
  if (!current.includes(key)) throw new CloudflareError(`没有登记过这个域名：${key}`);
  const next = current.filter((item) => item !== key);
  const file = saveConfig({ MANUAL_SUFFIXES: next });
  return { ok: true, suffix: key, configFile: file, manualSuffixes: next };
}

/**
 * 手动解析要填的记录（给界面展示 / 复制用）。
 * @param {{ prefix: string, suffix: string, port: number, ip?: string }} input
 */
async function manualRecords(input = {}) {
  const prefix = String(input.prefix || '').trim().toLowerCase();
  const suffix = String(input.suffix || '').trim().toLowerCase();
  if (!prefix || !isDomainName(suffix)) throw new CloudflareError('缺少前缀或域名');
  const port = Number(input.port) || 25565;
  const ip = String(input.ip || '').trim() || (await detectPublicIp()) || '';
  const ipv6 = String(input.ipv6 || '').trim();
  const fqdn = `${prefix}.${suffix}`;
  const records = [
    { type: 'A', name: fqdn, value: ip || '（你的公网 IP）', note: 'IPv4 玩家用这条，指向你的公网 IP' },
    {
      type: 'SRV',
      name: `_minecraft._tcp.${fqdn}`,
      value: `0 5 ${port} ${fqdn}`,
      note: `加了就不用让朋友输端口（当前端口 ${port}）`,
    },
  ];
  if (ipv6) {
    records.splice(1, 0, {
      type: 'AAAA',
      name: fqdn,
      value: ipv6,
      note: 'IPv6 玩家走这条，完全不用端口映射',
    });
  }
  return {
    address: fqdn,
    ip,
    ipv6,
    privateIp: ip ? isPrivateIp(ip) : false,
    records,
  };
}

/**
 * 一键连接：校验 Token → 自动识别 Zone → 保存配置。
 * 用户全程只需要「浏览器点两下 + 粘贴一次」。
 *
 * 多个后缀分属不同 Cloudflare 账号时，可以分别连接多次：
 * 这里对 zones 做「合并」而不是覆盖，已识别到的映射不会丢。
 */
async function connect(token) {
  const clean = String(token || '').trim();
  const discovered = await discoverZones(clean);

  const current = loadConfig(true);
  const mergedZones = { ...(current.zones || {}), ...discovered.zones };

  const patch = { CF_API_TOKEN: clean };
  if (Object.keys(mergedZones).length > 0) {
    patch.CF_ZONES = mergedZones;
  }

  const file = saveConfig(patch);
  configCache = null;
  configCacheAt = 0;

  return {
    ok: true,
    configFile: file,
    tokenStatus: discovered.tokenStatus,
    zones: discovered.zones,
    mergedZones,
    missingZones: SUFFIXES.filter((suffix) => !mergedZones[suffix]),
    zoneCount: discovered.zoneCount,
    listError: discovered.listError,
    status: status(),
  };
}

module.exports = {
  SUFFIXES,
  configuredSuffixes,
  manualSuffixes,
  addManualZone,
  removeManualZone,
  manualRecords,
  isDomainName,
  transportFor,
  probeReachable,
  addZone,
  removeZone,
  TOKEN_TEMPLATE_URL,
  BUILTIN_PROXY_URL,
  BUILTIN_RELAY_URL,
  PROXY_PATHS,
  CloudflareError,
  loadConfig,
  status,
  verify,
  sync,
  remove,
  detectPublicIp,
  isPrivateIp,
  zoneIdFor,
  discoverZones,
  saveConfig,
  connect,
};
