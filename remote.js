'use strict';

/**
 * remote.js —— 手机遥控（Android / 任意手机浏览器）
 *
 * 为什么不是「Android 版启动器」：
 *   启动器是 Electron + Node，并且要 spawn 本地 Java 跑 Minecraft Java 版；
 *   Android 上没有 Electron，也没有能直接跑 Java 版的内置运行时（那是 PojavLauncher 级别的工程）。
 *   所以这里做的是「手机当遥控器」：手机浏览器打开电脑上的这个页面，
 *   可以查看实例 / 启动游戏 / 开关服务器 / 开关联机隧道。
 *
 * 安全：
 *   · 只监听局域网，必须带 token（随机生成，存在 settings.remoteToken）
 *   · 每次启动器重启 token 不变；想换就清掉 settings.json 里的 remoteToken
 *   · 页面没有登录态、不暴露任何账号信息，只做控制
 */

const http = require('http');
const crypto = require('crypto');

const DEFAULT_PORT = 47821;

function lanAddresses() {
  const os = require('os');
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal) out.push(item.address);
    }
  }
  return out;
}

function ensureToken(existing) {
  const value = String(existing || '').trim();
  if (/^[a-f0-9]{24,64}$/i.test(value)) return value;
  return crypto.randomBytes(16).toString('hex');
}

const PAGE = String.raw`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>Viskluke 遥控</title>
<style>
  :root { --bg:#f7f8fa; --card:#fff; --line:#e5e7eb; --text:#111827; --muted:#6b7280; --accent:#0f9d8f; }
  * { box-sizing:border-box; }
  body { margin:0; font-family:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; background:var(--bg); color:var(--text); }
  header { position:sticky; top:0; background:rgba(247,248,250,.92); backdrop-filter:blur(8px); padding:14px 16px 10px; border-bottom:1px solid var(--line); }
  h1 { font-size:17px; margin:0 0 4px; }
  .sub { font-size:12px; color:var(--muted); }
  main { padding:14px 16px 40px; display:flex; flex-direction:column; gap:12px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:14px; }
  .card h2 { font-size:14px; margin:0 0 10px; }
  .row { display:flex; align-items:center; gap:10px; padding:8px 0; border-top:1px dashed var(--line); }
  .row:first-of-type { border-top:0; }
  .row .name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .row .meta { font-size:11px; color:var(--muted); }
  button { border:1px solid var(--line); background:#fff; border-radius:10px; padding:7px 12px; font-size:13px; color:var(--text); }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
  button:disabled { opacity:.45; }
  .tag { font-size:11px; color:var(--muted); }
  .empty { font-size:12px; color:var(--muted); }
  .toast { position:fixed; left:50%; bottom:20px; transform:translateX(-50%); background:#111827; color:#fff; font-size:12px; padding:8px 14px; border-radius:999px; opacity:0; transition:opacity .2s; pointer-events:none; }
  .toast.show { opacity:.92; }
</style>
</head>
<body>
<header>
  <h1>Viskluke 遥控</h1>
  <div class="sub" id="status">连接中…</div>
</header>
<main>
  <section class="card"><h2>实例</h2><div id="instances" class="empty">加载中…</div></section>
  <section class="card"><h2>服务器</h2><div id="servers" class="empty">加载中…</div></section>
  <section class="card"><h2>联机隧道</h2><div id="relay" class="empty">加载中…</div></section>
</main>
<div class="toast" id="toast"></div>
<script>
(function () {
  var params = new URLSearchParams(location.search);
  var token = params.get('token') || localStorage.getItem('viskluke.remote.token') || '';
  if (token) localStorage.setItem('viskluke.remote.token', token);
  function api(path, body) {
    return fetch(path + (path.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(token), body ? {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    } : undefined).then(function (r) { return r.json(); });
  }
  function toast(text) {
    var el = document.getElementById('toast');
    el.textContent = text; el.classList.add('show');
    setTimeout(function () { el.classList.remove('show'); }, 1800);
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
  function row(name, meta, button) {
    var div = document.createElement('div');
    div.className = 'row';
    div.innerHTML = '<div class="name">' + esc(name) + '<div class="meta">' + esc(meta) + '</div></div>';
    if (button) { div.appendChild(button); }
    return div;
  }
  function action(name, payload, okText) {
    api('/api/action', { action: name, payload: payload }).then(function (res) {
      if (res && res.ok) { toast(okText || '已执行'); refresh(); }
      else toast((res && res.error) || '失败');
    }).catch(function () { toast('网络错误'); });
  }
  function render(state) {
    document.getElementById('status').textContent = '已连接 · ' + state.app.version + ' · ' + (state.host || '');
    var box = document.getElementById('instances');
    box.innerHTML = ''; box.classList.remove('empty');
    if (!state.instances.length) box.textContent = '电脑上还没有实例';
    state.instances.forEach(function (i) {
      var b = document.createElement('button');
      b.className = 'primary'; b.textContent = '启动';
      b.onclick = function () { action('launch', { instanceId: i.id }, '正在启动 ' + i.name); };
      box.appendChild(row(i.name, (i.version || '?') + (i.loader ? ' · ' + i.loader : ''), b));
    });
    var sbox = document.getElementById('servers');
    sbox.innerHTML = ''; sbox.classList.remove('empty');
    if (!state.servers.length) sbox.textContent = '还没有服务器';
    state.servers.forEach(function (s) {
      var b = document.createElement('button');
      b.textContent = s.running ? '停止' : '启动';
      b.onclick = function () { action(s.running ? 'server-stop' : 'server-start', { id: s.id }, s.running ? '正在停止' : '正在启动'); };
      sbox.appendChild(row(s.name, [s.core, s.version, s.address].filter(Boolean).join(' · '), b));
    });
    var rbox = document.getElementById('relay');
    rbox.innerHTML = ''; rbox.classList.remove('empty');
    if (state.relay.host) {
      var off = document.createElement('button');
      off.textContent = '关闭隧道';
      off.onclick = function () { action('relay-stop', {}, '隧道已关闭'); };
      rbox.appendChild(row('隧道 ' + state.relay.host.room, state.relay.host.key ? '带口令' : '无口令', off));
    } else {
      var on = document.createElement('button');
      on.className = 'primary'; on.textContent = '开隧道';
      on.onclick = function () { action('relay-start', {}, '隧道已开启'); };
      rbox.appendChild(row('未开启', '开启后手机/朋友可加入', on));
    }
    if (state.relay.guest) {
      rbox.appendChild(row('本地代理 ' + state.relay.guest.address, '正在作为玩家代理', null));
    }
  }
  function refresh() {
    api('/api/state').then(render).catch(function () {
      document.getElementById('status').textContent = '连接失败：检查电脑是否开着、手机是否同一 WiFi';
    });
  }
  refresh();
  setInterval(refresh, 3000);
})();
</script>
</body>
</html>`;

function startRemote(options = {}) {
  const {
    port = DEFAULT_PORT,
    token: initialToken,
    getState,
    actions,
    onLog = () => {},
  } = options;
  if (!getState || !actions) throw new Error('remote.start 需要 getState / actions');
  const token = ensureToken(initialToken);

  const hits = new Map();
  const server = http.createServer((req, res) => {
    const now = Date.now();
    const ip = (req.socket && req.socket.remoteAddress) || 'unknown';
    const bucket = hits.get(ip) || { at: now, count: 0 };
    if (now - bucket.at > 60_000) {
      bucket.at = now;
      bucket.count = 0;
    }
    bucket.count += 1;
    hits.set(ip, bucket);
    if (bucket.count > 300) {
      res.writeHead(429, { 'content-type': 'text/plain' });
      return res.end('too many requests');
    }

    const url = new URL(req.url, 'http://remote');
    const given = String(url.searchParams.get('token') || req.headers['x-viskluke-token'] || '');

    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(PAGE);
    }
    if (given !== token) {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: 'token 不对' }));
    }

    if (url.pathname === '/api/state' && req.method === 'GET') {
      Promise.resolve(getState())
        .then((state) => {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          res.end(JSON.stringify({ ok: true, ...state, host: req.headers.host || '' }));
        })
        .catch((error) => {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: error.message }));
        });
      return;
    }

    if (url.pathname === '/api/action' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 64 * 1024) req.destroy();
      });
      req.on('end', () => {
        let payload = {};
        try {
          payload = JSON.parse(body || '{}');
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: 'JSON 不合法' }));
        }
        const name = String(payload.action || '');
        const handler = actions[name];
        if (typeof handler !== 'function') {
          res.writeHead(400, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: `未知操作：${name}` }));
        }
        Promise.resolve(handler(payload.payload || {}))
          .then((result) => {
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: true, result: result || null }));
          })
          .catch((error) => {
            res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: (error && error.message) || String(error) }));
          });
      });
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      const actual = server.address().port;
      const ips = lanAddresses();
      const urls = ips.map((ip) => `http://${ip}:${actual}/?token=${token}`);
      onLog(`[遥控] 已启动，端口 ${actual}，地址：${urls[0] || `http://127.0.0.1:${actual}`}`);
      resolve({
        port: actual,
        token,
        urls,
        localUrl: `http://127.0.0.1:${actual}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

module.exports = { startRemote, DEFAULT_PORT, ensureToken, lanAddresses };
