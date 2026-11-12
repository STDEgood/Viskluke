'use strict';

/**
 * relay-server.js —— 自建中继（不依赖 Cloudflare，零额度消耗）
 *
 * 协议和 worker/cloudflare-relay-worker.mjs、relay.js 完全一致：
 *   ws(s)://<host>:<port>/relay?room=<房间>&role=host|guest[&key=<口令>]
 *   host 侧帧：[type 1B][streamId 4B][负载]，type 1=OPEN 2=DATA 3=CLOSE
 *   guest 侧：裸字节
 *
 * 用法（在一台有公网 IP / IPv6 的机器上）：
 *   node scripts/relay-server.js --port 25566
 *   npm run relay:serve
 *
 * 想让外网用 wss://，把本服务放在 Caddy / Nginx 后面即可，例如 Caddyfile：
 *   relay.example.com {
 *     reverse_proxy 127.0.0.1:25566
 *   }
 *
 * 注意：
 *   · 默认只监听 0.0.0.0 的明文 ws://；公网使用请务必套 TLS（否则房间口令裸奔）
 *   · 路由器/防火墙要放行该端口
 *   · 房间口令：第一个连上的人设定，之后必须一致（和 Cloudflare 版行为一致）
 */

const http = require('http');
const os = require('os');
const { WebSocketServer } = require('ws');

const TYPE_OPEN = 1;
const TYPE_DATA = 2;
const TYPE_CLOSE = 3;
const HEADER_SIZE = 5;
const MAX_FRAME = 1024 * 1024;
const MAX_GUESTS = 32;
const ROOM_RE = /^[A-Za-z0-9_-]{3,32}$/;
const KEY_RE = /^[A-Za-z0-9]{6,64}$/;

function frame(type, streamId, payload) {
  const head = Buffer.alloc(HEADER_SIZE);
  head[0] = type;
  head.writeUInt32BE(streamId >>> 0, 1);
  return payload && payload.length ? Buffer.concat([head, payload]) : head;
}

function parseFrame(buffer) {
  if (!buffer || buffer.length < HEADER_SIZE) return null;
  return { type: buffer[0], streamId: buffer.readUInt32BE(1), payload: buffer.subarray(HEADER_SIZE) };
}

/** 在 WebSocket 握手阶段直接回 HTTP 状态码（客户端会得到可读错误） */
function reject(socket, status, text) {
  try {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch {
    /* ignore */
  }
  socket.destroy();
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal) out.push(item.address);
    }
  }
  return out;
}

function startRelay(options = {}) {  const port = Number(options.port) || 25566;
  const host = options.host || '0.0.0.0';
  const rooms = new Map(); // room -> { host, guests: Map<ws, streamId>, nextStream, key }

  const server = http.createServer((req, res) => {
    if (req.url && req.url.startsWith('/health')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'viskluke-relay-selfhost', rooms: rooms.size }));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('viskluke relay: use /relay over websocket');
  });

  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

  server.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, 'http://relay');
    } catch {
      return socket.destroy();
    }
    if (url.pathname !== '/relay') return socket.destroy();

    const room = url.searchParams.get('room') || '';
    const role = url.searchParams.get('role') || '';
    const key = url.searchParams.get('key') || '';
    if (!ROOM_RE.test(room)) return socket.destroy();
    if (!['host', 'guest'].includes(role)) return socket.destroy();
    if (key && !KEY_RE.test(key)) return socket.destroy();

    let entry = rooms.get(room);
    if (!entry) {
      entry = { host: null, guests: new Map(), nextStream: 1, key };
      rooms.set(room, entry);
    } else if (!entry.key) {
      entry.key = key;
    } else if (entry.key !== key) {
      console.log(`[relay] 拒绝 ${room}：房间口令不一致`);
      return reject(socket, 403, 'Forbidden');
    }

    // 用 HTTP 状态码拒绝，客户端（relay.js）能给出可读提示，和 Cloudflare 版一致
    if (role === 'host' && entry.host) return reject(socket, 409, 'Conflict');
    if (role === 'guest') {
      if (!entry.host) return reject(socket, 409, 'Conflict');
      if (entry.guests.size >= MAX_GUESTS) return reject(socket, 429, 'Too Many Requests');
    }

    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, { room, role, entry }));
  });

  wss.on('connection', (ws, { room, role, entry }) => {
    const stats = () => `房间 ${room}：主机=${entry.host ? 1 : 0} 玩家=${entry.guests.size}`;

    if (role === 'host') {
      if (entry.host) return ws.close(1013, 'room already has a host');
      if (entry.guests.size > 0) return ws.close(1013, 'host must join first');
      entry.host = ws;
      console.log(`[relay] 主机接入 ${room}（${stats()}）`);

      ws.on('message', (raw) => {
        const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        if (buffer.length > MAX_FRAME) return;
        const parsed = parseFrame(buffer);
        if (!parsed) return;
        for (const [guest, id] of entry.guests) {
          if (id !== parsed.streamId) continue;
          if (guest.readyState !== guest.OPEN) break;
          if (parsed.type === TYPE_DATA && parsed.payload.length) guest.send(parsed.payload, { binary: true });
          else if (parsed.type === TYPE_CLOSE) guest.close(1000, 'stream closed');
          break;
        }
      });

      ws.on('close', () => {
        console.log(`[relay] 主机关闭 ${room}`);
        for (const guest of entry.guests.keys()) {
          try {
            guest.close(1001, 'host gone');
          } catch {
            /* ignore */
          }
        }
        entry.guests.clear();
        entry.host = null;
        rooms.delete(room);
      });
      ws.on('error', () => {});
      return;
    }

    // guest
    if (entry.guests.size >= MAX_GUESTS) return ws.close(1013, 'room full');
    if (!entry.host) return ws.close(1013, 'no host');
    const streamId = entry.nextStream++;
    entry.guests.set(ws, streamId);
    entry.host.send(frame(TYPE_OPEN, streamId), { binary: true });
    console.log(`[relay] 玩家接入 ${room}（${stats()}）`);

    ws.on('message', (raw) => {
      const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      if (buffer.length > MAX_FRAME) return;
      if (!entry.host || entry.host.readyState !== entry.host.OPEN) return;
      entry.host.send(frame(TYPE_DATA, streamId, buffer), { binary: true });
    });
    ws.on('close', () => {
      entry.guests.delete(ws);
      if (entry.host && entry.host.readyState === entry.host.OPEN) {
        entry.host.send(frame(TYPE_CLOSE, streamId), { binary: true });
      }
      console.log(`[relay] 玩家离开 ${room}（${stats()}）`);
    });
    ws.on('error', () => {});
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const actual = server.address().port;
      const ips = lanAddresses();
      console.log('');
      console.log(`Viskluke 自建中继已启动：ws://${host === '0.0.0.0' ? '0.0.0.0' : host}:${actual}/relay`);
      console.log(`本机测试：  ws://127.0.0.1:${actual}`);
      for (const ip of ips) console.log(`局域网：    ws://${ip}:${actual}`);
      console.log('公网使用请把端口映射/防火墙放行，并建议套 Caddy/Nginx 变成 wss://');
      console.log('');
      resolve({
        port: actual,
        close: () =>
          new Promise((done) => {
            for (const client of wss.clients) {
              try {
                client.close(1001, 'server closing');
              } catch {
                /* ignore */
              }
            }
            wss.close(() => server.close(done));
          }),
      });
    });
  });
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const portIndex = args.indexOf('--port');
  const port = portIndex >= 0 ? Number(args[portIndex + 1]) : Number(process.env.PORT) || 25566;
  startRelay({ port }).then((relay) => {
    process.on('SIGINT', () => {
      console.log('\n[relay] 正在关闭…');
      relay.close().then(() => process.exit(0));
    });
  });
}

module.exports = { startRelay };
