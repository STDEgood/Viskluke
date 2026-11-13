'use strict';

/**
 * yistar-sso.js —— 接入本机 YiStarLine Account（127.0.0.1:8600）
 *
 * 流程（对应协议 v1）：
 *   1. 打开浏览器授权页 /sso/authorize?app_id=&redirect_uri=&state=
 *   2. 本地临时 HTTP 服务接收回调 ?ticket=&state=（校验 state）
 *   3. 带 app_secret 调 /api/v1/ticket/redeem 换用户资料 + access_token
 *   4. access_token 存本机（yistar.json），可调 /api/v1/userinfo、/api/v1/logout
 *
 * 安全：app_secret / access_token 只存在 <userData>/yistar.json，不进仓库、不进日志。
 * 说明：接口字段名以你给的文档为准；这里对常见命名（access_token/accessToken/token、
 * user/profile/account）做了兼容，若你的服务返回结构不同，改 normalize() 即可。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { shell, BrowserWindow } = require('electron');
const CALLBACK_URI = 'http://127.0.0.1:47830/sso/callback';

const DEFAULT_BASE = 'http://127.0.0.1:8600';
const TIMEOUT_MS = 180_000;

function dataDir() {
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') return app.getPath('userData');
  } catch {
    /* 纯 Node */
  }
  if (process.env.VISKLUKE_DATA_DIR) return path.resolve(process.env.VISKLUKE_DATA_DIR);
  return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'viskluke-launcher');
}

function file() {
  return path.join(dataDir(), 'yistar.json');
}

// 打包时注入的「内置应用」凭据（sso-defaults.json），用户零配置
let defaultsCache;
function readDefaults() {
  if (defaultsCache !== undefined) return defaultsCache;
  const candidates = [];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'sso-defaults.json'));
  candidates.push(path.join(__dirname, 'sso-defaults.json'));
  for (const candidate of candidates) {
    try {
      const json = JSON.parse(fs.readFileSync(candidate, 'utf8').replace(/\uFEFF/g, ''));
      if (json && (json.publicCode || (json.appId && json.appSecret))) {
        defaultsCache = json;
        return json;
      }
    } catch {
      /* 没有就算了 */
    }
  }
  defaultsCache = null;
  return null;
}

/** 生效配置：用户手填优先，否则用内置应用 */
function effective() {
  const cfg = load();
  const def = readDefaults() || {};
  const publicCode = String(cfg.publicCode || def.publicCode || '').trim().toUpperCase();
  const appId = String(cfg.appId || def.appId || '').trim();
  const appSecret = String(cfg.appSecret || def.appSecret || '').trim();
  const name = String(cfg.name || def.name || 'Viskluke').trim();
  const publisher = String(cfg.publisher || def.publisher || '').trim();
  const baseUrl = String(cfg.baseUrl || def.baseUrl || DEFAULT_BASE).trim().replace(/\/+$/, '') || DEFAULT_BASE;
  return {
    publicCode,
    appId,
    appSecret,
    name,
    publisher,
    baseUrl,
    hasBuiltin: Boolean(publicCode || (def.appId && def.appSecret)),
    usingBuiltin: Boolean(!cfg.publicCode && !(cfg.appId && cfg.appSecret) && (def.publicCode || (def.appId && def.appSecret))),
  };
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(file(), 'utf8').replace(/\uFEFF/g, ''));
  } catch {
    return {};
  }
}

function save(patch) {
  const next = { ...load(), ...patch };
  const target = file();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

function baseUrl(cfg = load()) {
  return String(cfg.baseUrl || DEFAULT_BASE).trim().replace(/\/+$/, '') || DEFAULT_BASE;
}
async function request(method, pathname, body, options = {}) {
  const { token = '', appSecret = '' } = options;
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  if (appSecret) headers['x-app-secret'] = appSecret;
  const response = await fetch(`${effective().baseUrl}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!response.ok || (json && json.ok === false)) {
    const error = (json && (json.error || json.message)) || text || `HTTP ${response.status}`;
    const code = (json && json.error && json.error.code) || `http_${response.status}`;
    const message = typeof error === 'string' ? error : error.message || error.code || '请求失败';
    throw Object.assign(new Error(message), { code, status: response.status });
  }
  return json;
}

function normalize(payload) {
  const data = (payload && (payload.data || payload.result || payload)) || {};
  return {
    user: data.user || data.profile || data.account || null,
    token: data.access_token || data.accessToken || data.token || '',
    raw: payload,
  };
}

function status() {
  const cfg = load();
  const eff = effective();
  return {
    configured: Boolean(eff.publicCode || (eff.appId && eff.appSecret)),
    hasBuiltin: eff.hasBuiltin,
    usingBuiltin: eff.usingBuiltin,
    baseUrl: eff.baseUrl,
    appId: eff.appId,
    publicCode: eff.publicCode,
    name: eff.name,
    hasSecret: Boolean(eff.appSecret),
    user: cfg.user || null,
    loggedIn: Boolean(cfg.accessToken && cfg.user),
  };
}

function saveConfig(payload = {}) {
  const patch = {};
  if (payload.baseUrl !== undefined) patch.baseUrl = String(payload.baseUrl).trim() || DEFAULT_BASE;
  if (payload.appId !== undefined) patch.appId = String(payload.appId).trim();
  if (payload.publicCode !== undefined) patch.publicCode = String(payload.publicCode).trim().toUpperCase();
  if (payload.appSecret) patch.appSecret = String(payload.appSecret).trim();
  if (payload.clearSecret) patch.appSecret = '';
  if (payload.clearApp) {
    patch.appId = '';
    patch.appSecret = '';
    patch.publicCode = '';
  }
  save(patch);
  return status();
}

async function health() {
  const json = await request('GET', '/api/v1/health');
  return json;
}

async function test() {
  const eff = effective();
  if (eff.appId && eff.appSecret) {
    // 有密钥：走 verify，能确认「应用 ID + 密钥」匹配
    try {
      return await request('POST', '/api/v1/app/verify', { app_id: eff.appId, app_secret: eff.appSecret }, {
        appSecret: eff.appSecret,
      });
    } catch (error) {
      if (error.status !== 404 && error.status !== 405) throw error;
    }
  }
  if (eff.publicCode) {
    // 只有应用码：用公开查询验证服务在线且认识这个应用
    return request('GET', `/api/v1/apps/lookup?code=${encodeURIComponent(eff.publicCode)}`);
  }
  throw new Error('先配置应用码，或 App ID / App Secret');
}

function waitForCallback(server, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待授权超时（3 分钟）')), timeoutMs);
    server.on('request', (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/sso/callback') {
        res.writeHead(404).end('not found');
        return;
      }
      clearTimeout(timer);
      const ticket = url.searchParams.get('ticket') || '';
      const state = url.searchParams.get('state') || '';
      const errorCode = url.searchParams.get('error') || '';
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        `<!doctype html><meta charset="utf-8"><title>Viskluke</title>` +
          `<body style="font-family:system-ui;padding:40px;text-align:center">` +
          `<h2>${errorCode ? '授权未完成' : '登录成功'}</h2><p>${
            errorCode ? `错误：${errorCode}` : '可以关闭这个页面，回到启动器。'
          }</p></body>`
      );
      if (errorCode) return reject(Object.assign(new Error(errorCode), { code: errorCode }));
      resolve({ ticket, state });
    });
    server.on('error', reject);
  });
}

function openBrowser(url) {
  if (shell && typeof shell.openExternal === 'function') return shell.openExternal(url);
  throw new Error('当前环境无法打开浏览器');
}

async function login(options = {}) {
  const { onLog = () => {}, parent = null } = options;
  const eff = effective();
  if (!eff.publicCode && !(eff.appId && eff.appSecret)) {
    throw new Error('先在「设置 → YiStarLine 账号」里填写应用码（或 App ID / App Secret）');
  }
  const state = crypto.randomBytes(16).toString('hex');

  // 回调固定用白名单里的 47830：窗口里拦截跳转拿 ticket，不需要真的监听端口，
  // 也就不怕端口被占用 / 系统浏览器打不开。
  const params = new URLSearchParams();
  if (eff.publicCode) params.set('code', eff.publicCode);
  if (eff.appId) params.set('app_id', eff.appId);
  if (eff.name) params.set('name', eff.name);
  if (eff.publisher) params.set('publisher', eff.publisher);
  params.set('redirect_uri', CALLBACK_URI);
  params.set('state', state);
  const authorizeUrl = `${eff.baseUrl}/sso/authorize?${params.toString()}`;
  onLog(`[SSO] 打开授权页：${authorizeUrl}`);

  let ticket = '';
  if (BrowserWindow) {
    ticket = await new Promise((resolve, reject) => {
      const win = new BrowserWindow({
        width: 520,
        height: 720,
        parent: parent || undefined,
        center: true,
        autoHideMenuBar: true,
        title: 'YiStarLine 登录',
        webPreferences: { partition: 'persist:viskluke-sso', sandbox: true, contextIsolation: true },
      });
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          win.destroy();
        } catch {
          /* ignore */
        }
        fn(value);
      };
      const inspect = (event, url) => {
        if (!String(url || '').startsWith(CALLBACK_URI)) return;
        try {
          event.preventDefault();
        } catch {
          /* ignore */
        }
        const parsed = new URL(url);
        const error = parsed.searchParams.get('error') || '';
        const returnedState = parsed.searchParams.get('state') || '';
        if (error) return finish(reject, Object.assign(new Error(`授权失败：${error}`), { code: error }));
        if (returnedState !== state) return finish(reject, new Error('state 不匹配，已拒绝'));
        finish(resolve, parsed.searchParams.get('ticket') || '');
      };
      const timer = setTimeout(() => finish(reject, new Error('等待授权超时（3 分钟）')), TIMEOUT_MS);
      win.webContents.on('will-redirect', inspect);
      win.webContents.on('will-navigate', inspect);
      win.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
        if (isMainFrame) onLog(`[SSO] 授权页加载失败：${code} ${description} ${url}`);
      });
      win.on('closed', () => finish(reject, new Error('授权窗口已关闭')));
      win.loadURL(authorizeUrl).catch((error) => finish(reject, error));
    });
  } else {
    // 极端兜底：没有 BrowserWindow 时退回系统浏览器 + 临时端口
    const server = http.createServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(47830, '127.0.0.1', resolve);
    });
    const callback = waitForCallback(server, TIMEOUT_MS);
    openBrowser(authorizeUrl).catch((error) => onLog(`[SSO] 打开浏览器失败：${error.message}`));
    try {
      const result = await callback;
      if (result.state !== state) throw new Error('state 不匹配，已拒绝');
      ticket = result.ticket;
    } finally {
      server.close();
    }
  }
  if (!ticket) throw Object.assign(new Error('授权没有拿到票据'), { code: 'no_ticket' });

  // 优先用应用码兑换（别人机器首次授权后是 imported 应用，不需要 secret）；
  // 失败再回退 app_id + app_secret（开发者本机是 managed 应用）。
  let payload;
  if (eff.publicCode) {
    try {
      payload = await request('POST', '/api/v1/ticket/redeem', { client_id: eff.publicCode, ticket });
    } catch (error) {
      if (!eff.appId || !eff.appSecret) throw error;
      onLog(`[SSO] 应用码兑换失败（${error.code || error.message}），改用 app_id + app_secret`);
    }
  }
  if (!payload) {
    if (!eff.appId || !eff.appSecret) throw new Error('这个应用需要 App Secret 才能兑换票据');
    payload = await request(
      'POST',
      '/api/v1/ticket/redeem',
      { app_id: eff.appId, app_secret: eff.appSecret, ticket },
      { appSecret: eff.appSecret }
    );
  }
  const { user, token } = normalize(payload);
  if (!token && !user) throw Object.assign(new Error('兑换响应里没有用户或令牌'), { code: 'bad_response' });

  const display = user ? user.nickname || user.display_name || user.username || user.name || user.email || user.id : '';
  const playerName = sanitizePlayerName(display || 'Player');
  save({ accessToken: token, user: user || { name: playerName }, loggedAt: new Date().toISOString() });
  onLog(`[SSO] 已登录：${display || playerName}`);
  return {
    ok: true,
    user: user || { name: playerName },
    playerName,
    uuid: offlineUuid(playerName),
  };
}

async function userinfo() {
  const cfg = load();
  if (!cfg.accessToken) throw new Error('还没登录 YiStarLine');
  const json = await request('GET', '/api/v1/userinfo', undefined, { token: cfg.accessToken });
  const user = normalize(json).user || null;
  if (user) save({ user });
  return { ok: true, user };
}

async function logout() {
  const cfg = load();
  try {
    if (cfg.accessToken) await request('POST', '/api/v1/logout', {}, { token: cfg.accessToken });
  } catch {
    /* 服务不在线也要能本地退出 */
  }
  save({ accessToken: '', user: null });
  return { ok: true };
}

/** 账号名映射成 Minecraft 允许的离线名（3-16 位字母数字下划线） */
function sanitizePlayerName(value) {
  const cleaned = String(value || '')
    .replace(/[^A-Za-z0-9_]/g, '_')
    .slice(0, 16);
  return cleaned.length >= 3 ? cleaned : 'Player';
}

function offlineUuid(name) {
  const hash = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  hash[6] = (hash[6] & 0x0f) | 0x30;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

module.exports = {
  DEFAULT_BASE,
  status,
  saveConfig,
  test,
  login,
  userinfo,
  logout,
  sanitizePlayerName,
  offlineUuid,
  file,
};
