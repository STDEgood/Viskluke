'use strict';

/**
 * relay.js —— 自建端到端中继（不依赖任何第三方联机工具）
 *
 * 解决的是"主机没有公网 IP / 在运营商大内网 / 不想做端口映射"的场景：
 *
 *   玩家 MC ──TCP──▶ 启动器本地代理 ──WebSocket──▶ 中继(Worker) ──WebSocket──▶ 主机启动器 ──TCP──▶ 本机 MC 服务器
 *
 * 两个角色的职责：
 *   host（开服的人）：一条 WebSocket 挂在中继上，收到"新流"就本地连一次 MC 服务器
 *   guest（玩家）    ：在 127.0.0.1:25566 起个 TCP 监听，每个玩家连接对应一条 WebSocket
 *
 * 帧格式（host ↔ 中继，二进制）：
 *   [0] 类型  1=OPEN 2=DATA 3=CLOSE
 *   [1..4] 流号（大端 32 位）
 *   [5..] 负载（DATA 才有）
 * 中继 → guest 直接发负载（不带头），guest → 中继也是裸负载。
 *
 * 中继本身：worker/cloudflare-relay-worker.mjs（Cloudflare Durable Object）。
 * 自检里有一个本地中继实现（scripts/selftest.js），用的是同一套协议。
 */

const net = require('net');
const crypto = require('crypto');

const WS = require('ws');

const TYPE_OPEN = 1;
const TYPE_DATA = 2;
const TYPE_CLOSE = 3;
const HEADER_SIZE = 5;
const MAX_FRAME = 1024 * 1024; // 单帧上限，MC 的包远小于这个

const DEFAULT_PROXY_PORT = 25566;
const MAX_GUESTS = 32;
const ROOM_RE = /^[A-Za-z0-9_-]{3,32}$/;
const KEY_RE = /^[A-Za-z0-9]{6,64}$/;

class RelayError extends Error {}

const DEBUG = process.env.VISKLUKE_RELAY_DEBUG === '1';
function dlog(message) {
  if (!DEBUG) return;
  try {
    process.stderr.write(`[relay ${new Date().toISOString().slice(11, 23)}] ${message}\n`);
  } catch {
    /* ignore */
  }
}

function normalizeRoom(room) {
  const value = String(room || '').trim();
  if (!ROOM_RE.test(value)) {
    throw new RelayError('房间号只能用 3~32 位字母、数字、下划线或短横线');
  }
  return value;
}

function normalizeKey(key) {
  const value = String(key || "").trim();
  if (!value) return "";
  if (!KEY_RE.test(value)) throw new RelayError("房间口令只能用 6~64 位字母或数字");
  return value;
}

function relayUrlOf(base, room, role, key) {
  const url = new URL(String(base || '').trim());
  if (!/^wss?:$/.test(url.protocol)) throw new RelayError('中继地址必须是 ws:// 或 wss://');
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/relay`;
  const normalizedKey = normalizeKey(key);
  url.search =
    `?room=${encodeURIComponent(normalizeRoom(room))}&role=${role}` +
    (normalizedKey ? `&key=${encodeURIComponent(normalizedKey)}` : "");
  return url.toString();
}

function frame(type, streamId, payload) {
  const head = Buffer.alloc(HEADER_SIZE);
  head[0] = type;
  head.writeUInt32BE(streamId >>> 0, 1);
  return payload && payload.length ? Buffer.concat([head, payload]) : head;
}

function parseFrame(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < HEADER_SIZE) return null;
  return {
    type: buffer[0],
    streamId: buffer.readUInt32BE(1),
    payload: buffer.subarray(HEADER_SIZE),
  };
}

function openSocket(url, options = {}) {
  const { timeout = 15000 } = options;
  return new Promise((resolve, reject) => {
    const socket = new WS(url, { perMessageDeflate: false, handshakeTimeout: timeout });
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      try {
        socket.terminate();
      } catch {
        /* ignore */
      }
      reject(new RelayError(`连不上中继：${error.message || error}`));
    };
    socket.once('open', () => {
      if (settled) return;
      settled = true;
      resolve(socket);
    });
    socket.once('error', fail);
    socket.once('unexpected-response', (_req, res) => fail(new Error(`中继返回 ${res.statusCode}`)));
    setTimeout(() => fail(new Error('中继连接超时')), timeout).unref();
  });
}

/**
 * 主机侧：把本地 MC 服务器挂到中继上。
 * @param {{ relayUrl: string, room: string, localHost?: string, localPort: number,
 *           onLog?: Function, onState?: Function }} options
 */
async function startHostTunnel(options = {}) {
  const {
    relayUrl,
    room,
    localHost = '127.0.0.1',
    localPort,
    onLog = () => {},
    onState = () => {},
  } = options;
  const port = Number(localPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RelayError(`本地端口不合法：${localPort}`);

  const roomKey = normalizeKey(options.key);
  const url = relayUrlOf(relayUrl, room, 'host', roomKey);
  onLog(`[Viskluke] 正在连中继：${url}`);
  const socket = await openSocket(url);

  /** @type {Map<number, import('net').Socket>} */
  const streams = new Map();
  let closed = false;

  const send = (type, streamId, payload) => {
    if (closed || socket.readyState !== WS.OPEN) return;
    try {
      socket.send(frame(type, streamId, payload), { binary: true });
    } catch {
      /* 中继断开时忽略 */
    }
  };

  const openStream = (streamId) => {
    if (streams.has(streamId)) return;
    dlog(`host OPEN 流 #${streamId} → ${localHost}:${port}`);
    const tcp = net.connect({ host: localHost, port }, () => {
      dlog(`host 流 #${streamId} 已连上本机服务器`);
      onLog(`[Viskluke] 玩家接入（流 #${streamId}）`);
    });
    streams.set(streamId, tcp);
    tcp.on('data', (chunk) => {
      dlog(`host 流 #${streamId} ← 本机 ${chunk.length} 字节，转发中继`);
      send(TYPE_DATA, streamId, chunk);
    });
    tcp.on('error', (error) => {
      dlog(`host 流 #${streamId} TCP 错误：${error.code || error.message}`);
      onLog(`[Viskluke] 流 #${streamId} 出错：${error.code || error.message}`);
      closeStream(streamId);
    });
    tcp.on('close', () => {
      dlog(`host 流 #${streamId} TCP 关闭`);
      streams.delete(streamId);
      send(TYPE_CLOSE, streamId);
    });
  };

  const closeStream = (streamId) => {
    const tcp = streams.get(streamId);
    streams.delete(streamId);
    if (tcp) {
      try {
        tcp.destroy();
      } catch {
        /* ignore */
      }
    }
    send(TYPE_CLOSE, streamId);
  };

  socket.on('message', (raw) => {
    const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    if (buffer.length > MAX_FRAME) return; // 超大帧直接丢，防内存被撑爆
    const parsed = parseFrame(buffer);
    if (!parsed) return;
    dlog(`host ← 中继 frame type=${parsed.type} stream=#${parsed.streamId} payload=${parsed.payload.length}`);
    if (parsed.type === TYPE_OPEN) return openStream(parsed.streamId);
    if (parsed.type === TYPE_DATA) {
      const tcp = streams.get(parsed.streamId);
      if (tcp && !tcp.destroyed) tcp.write(parsed.payload);
      else dlog(`host 流 #${parsed.streamId} 不存在，DATA 丢弃`);
      return;
    }
    if (parsed.type === TYPE_CLOSE) {
      const tcp = streams.get(parsed.streamId);
      streams.delete(parsed.streamId);
      if (tcp) tcp.end();
    }
  });

  const shutdown = (reason) => {
    if (closed) return;
    closed = true;
    for (const [streamId, tcp] of streams) {
      try {
        tcp.destroy();
      } catch {
        /* ignore */
      }
      void streamId;
    }
    streams.clear();
    try {
      socket.close(1000, 'tunnel closed');
    } catch {
      /* ignore */
    }
    onLog(`[Viskluke] 隧道已关闭：${reason || '主动停止'}`);
    onState('closed');
  };

  socket.on('close', () => shutdown('中继断开'));
  socket.on('error', (error) => shutdown(error.message));

  onState('open');
  onLog(`[Viskluke] 隧道已建立，房间号「${normalizeRoom(room)}」——玩家用启动器加入这个房间即可，无需端口映射`);

  return {
    ok: true,
    room: normalizeRoom(room),
    key: roomKey,
    relayUrl,
    localPort: port,
    close: () => shutdown('主动停止'),
    get active() {
      return !closed;
    },
  };
}

/**
 * 玩家侧：本地起一个 TCP 代理，MC 连 127.0.0.1:25566 就等于连到房间里的服务器。
 * @param {{ relayUrl: string, room: string, listenPort?: number, listenHost?: string,
 *           onLog?: Function, onState?: Function }} options
 */
async function startGuestProxy(options = {}) {
  const {
    relayUrl,
    room,
    listenPort = DEFAULT_PROXY_PORT,
    listenHost = '127.0.0.1',
    onLog = () => {},
    onState = () => {},
  } = options;
  const port = Number(listenPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RelayError(`代理端口不合法：${listenPort}`);

  const normalized = normalizeRoom(room);
  const roomKey = normalizeKey(options.key);
  let closed = false;
  /** @type {Set<import('net').Socket>} */
  const clients = new Set();
  let active = 0;

  const server = net.createServer((client) => {
    if (closed) {
      client.destroy();
      return;
    }
    clients.add(client);
    active += 1;
    if (clients.size >= MAX_GUESTS) {
      onLog(`[Viskluke] 玩家数已达上限（${MAX_GUESTS}），拒绝新连接`);
      client.destroy();
      return;
    }
    const url = relayUrlOf(relayUrl, normalized, 'guest', roomKey);
    onLog(`[Viskluke] 玩家连入本地代理，正在连中继…`);

    /** @type {import('ws').WebSocket | null} */
    let socket = null;
    let failed = false;

    // WSS 握手要 200~300ms（经 Cloudflare 更久），这期间 MC 早就把握手包发出来了。
    // 必须先攒着，等 ws open 后按顺序补发——否则最前面那几个字节（正是 MC 的
    // 握手包）会被丢掉，表现为"连上了但服务器一直没响应"。
    const pending = [];
    let pendingBytes = 0;
    const PENDING_LIMIT = 4 * 1024 * 1024;

    const kill = (reason) => {
      if (failed) return;
      failed = true;
      pending.length = 0;
      pendingBytes = 0;
      try {
        client.destroy();
      } catch {
        /* ignore */
      }
      try {
        if (socket) socket.close();
      } catch {
        /* ignore */
      }
      if (reason) onLog(`[Viskluke] ${reason}`);
    };

    const sendToRelay = (chunk) => {
      if (failed || client.destroyed) return;
      if (socket && socket.readyState === WS.OPEN) {
        socket.send(chunk, { binary: true });
        return;
      }
      if (socket && socket.readyState !== WS.CONNECTING) return; // CLOSING / CLOSED，丢弃
      pending.push(chunk);
      pendingBytes += chunk.length;
      dlog(`guest 先攒着 ${chunk.length} 字节（中继还没连上），共 ${pendingBytes}`);
      if (pendingBytes > PENDING_LIMIT) kill('中继迟迟连不上，玩家数据积压过多，已断开');
    };

    // 立刻挂 data 监听：从玩家连上的第一字节开始收，绝不漏
    client.on('data', sendToRelay);

    openSocket(url)
      .then((ws) => {
        if (closed || failed) {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          try {
            client.destroy();
          } catch {
            /* ignore */
          }
          return;
        }
        socket = ws;
        dlog(`guest ws 已连上 ${url}`);
        ws.on('message', (raw) => {
          const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
          dlog(`guest ← 中继 ${chunk.length} 字节`);
          if (!client.destroyed) client.write(chunk);
        });
        ws.on('close', (code) => {
          dlog(`guest ws 关闭 code=${code}`);
          kill(
            code === 1008
              ? '房间口令不对，或房间号不匹配'
              : code === 1013
                ? '房间不存在主机，或人数已满'
                : code === 1001
                  ? '主机已关闭隧道'
                  : '中继断开'
          );
        });
        ws.on('error', (error) => kill(`中继出错：${error.message}`));
        // 把握手期间攒下的字节按顺序补发
        if (pending.length) {
          dlog(`guest 补发 ${pending.length} 段 / ${pendingBytes} 字节`);
          for (const chunk of pending) {
            try {
              ws.send(chunk, { binary: true });
            } catch (error) {
              dlog(`guest 补发失败：${error.message}`);
              break;
            }
          }
        }
        pending.length = 0;
        pendingBytes = 0;
      })
      .catch((error) => kill(error.message));

    const cleanup = () => {
      clients.delete(client);
      active -= 1;
      try {
        if (socket) socket.close();
      } catch {
        /* ignore */
      }
    };
    client.on('close', cleanup);
    client.on('error', cleanup);
  });

  await new Promise((resolve, reject) => {
    server.once('error', (error) =>
      reject(new RelayError(error.code === 'EADDRINUSE' ? `端口 ${port} 被占用，换个端口` : error.message))
    );
    server.listen(port, listenHost, resolve);
  });

  const actualPort = server.address() && server.address().port ? server.address().port : port;
  onState('listening');
  onLog(`[Viskluke] 本地代理已就绪：在 MC 里连接 ${listenHost === '0.0.0.0' ? '127.0.0.1' : listenHost}:${actualPort}（房间「${normalized}」）`);

  return {
    ok: true,
    room: normalized,
    key: roomKey,
    relayUrl,
    address: `${listenHost === '0.0.0.0' ? '127.0.0.1' : listenHost}:${actualPort}`,
    port: actualPort,
    close: () =>
      new Promise((resolve) => {
        closed = true;
        for (const client of clients) {
          try {
            client.destroy();
          } catch {
            /* ignore */
          }
        }
        clients.clear();
        server.close(() => resolve({ ok: true }));
      }),
    get connections() {
      return active;
    },
  };
}

/** 生成一个好记的房间号（前缀 + 4 位随机） */
function suggestRoom(prefix = 'mc') {
  const base = String(prefix || 'mc').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 20) || 'mc';
  return `${base}-${crypto.randomBytes(2).toString('hex')}`;
}

module.exports = {
  RelayError,
  DEFAULT_PROXY_PORT,
  TYPE_OPEN,
  TYPE_DATA,
  TYPE_CLOSE,
  HEADER_SIZE,
  MAX_FRAME,
  normalizeRoom,
  normalizeKey,
  relayUrlOf,
  MAX_GUESTS,
  suggestRoom,
  startHostTunnel,
  startGuestProxy,
  _internal: { frame, parseFrame, openSocket },
};
