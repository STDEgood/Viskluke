/**
 * cloudflare-relay-worker.mjs —— 自建中继（Cloudflare Durable Objects）
 *
 * 为什么需要 Durable Object：两个 WebSocket（主机 + 玩家）必须落在**同一个状态容器**里
 * 才能互相转发，普通 Worker 的两个请求可能在不同 isolate，内存里配不上对。
 *
 * 协议（与 relay.js 一致）：
 *   GET /relay?room=<房间号>&role=host|guest   → WebSocket Upgrade
 *   host ↔ DO：二进制帧 [类型 1B][流号 4B 大端][负载]
 *     1 = OPEN（DO 让 host 新开一条到 MC 服务器的连接）
 *     2 = DATA
 *     3 = CLOSE
 *   guest ↔ DO：裸负载（DO 负责加/去 5 字节头）
 *
 * 部署：
 *   npx wrangler deploy -c worker/wrangler-relay.toml
 * 然后在启动器的「内网穿透」里填 wss://<worker 域名>（不带 /relay）
 */

const ROOM_RE = /^[A-Za-z0-9_-]{3,32}$/;
const TYPE_OPEN = 1;
const TYPE_DATA = 2;
const TYPE_CLOSE = 3;
const HEADER_SIZE = 5;
const MAX_FRAME = 1024 * 1024;
const MAX_GUESTS = 32;
const KEY_RE = /^[A-Za-z0-9]{6,64}$/;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** 一个房间 = 一个 Durable Object 实例 */
export class RelayRoom {
  constructor(state) {
    this.state = state;
    this.host = null; // WebSocket
    this.guests = new Map(); // guest WebSocket -> streamId
    this.nextStream = 1;
    this.key = ''; // 房间口令：第一个连上的人设定，之后必须一致
    // 用 WebSocket Hibernation？为简单起见这里不启用，连接断开即回收
    this.state.blockConcurrencyWhile(async () => {});
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/status') {
      return json({ ok: true, host: Boolean(this.host), guests: this.guests.size });
    }

    const role = url.searchParams.get('role');
    const key = String(url.searchParams.get('key') || '');
    if (key && !KEY_RE.test(key)) return json({ ok: false, error: '口令格式不对（6~64 位字母数字）' }, 400);
    if (!this.key) this.key = key;
    else if (this.key !== key) return json({ ok: false, error: '房间口令不对' }, 403);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    if (role === 'host') {
      if (this.host) {
        client.close(1013, 'room already has a host');
        return new Response(null, { status: 409 });
      }
      this.host = server;
      server.accept();
      server.addEventListener('message', (event) => this.onHostMessage(event.data));
      server.addEventListener('close', () => {
        if (this.host === server) this.host = null;
        for (const guest of this.guests.keys()) {
          try {
            guest.close(1001, 'host gone');
          } catch {
            /* ignore */
          }
        }
        this.guests.clear();
      });
      server.addEventListener('error', () => {
        if (this.host === server) this.host = null;
      });
      return new Response(null, { status: 101, webSocket: client });
    }

    if (role === 'guest') {
      if (this.guests.size >= MAX_GUESTS) return json({ ok: false, error: '房间人数已满' }, 429);
      const streamId = this.nextStream++;
      this.guests.set(server, streamId);
      server.accept();
      if (!this.host) {
        server.close(1013, 'no host');
        return new Response(null, { status: 409 });
      }
      // 通知 host 开一条新流
      this.sendToHost(frame(TYPE_OPEN, streamId));
      server.addEventListener('message', (event) => {
        const payload = toBytes(event.data);
        if (!payload || payload.byteLength > MAX_FRAME) return;
        this.sendToHost(frame(TYPE_DATA, streamId, payload));
      });
      server.addEventListener('close', () => {
        this.guests.delete(server);
        this.sendToHost(frame(TYPE_CLOSE, streamId));
      });
      server.addEventListener('error', () => this.guests.delete(server));
      return new Response(null, { status: 101, webSocket: client });
    }

    client.close(1008, 'unknown role');
    return new Response('unknown role', { status: 400 });
  }

  sendToHost(message) {
    if (!this.host) return;
    try {
      this.host.send(message);
    } catch {
      /* host 已断 */
    }
  }

  onHostMessage(data) {
    const bytes = toBytes(data);
    if (!bytes || bytes.byteLength < HEADER_SIZE) return;
    // 注意：Cloudflare 收到的二进制是 ArrayBuffer，**不能**用 buffer[0] 下标取值
    // （ArrayBuffer 没有索引访问，取出来是 undefined）。之前 host→guest 的 DATA
    // 帧就是这样被静默丢掉的：OPEN 走的是另一条路径，所以看起来"连上了但没数据"。
    const type = bytes[0];
    const streamId = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1, false);
    const payload = bytes.byteLength > HEADER_SIZE ? bytes.slice(HEADER_SIZE) : null;

    let target = null;
    for (const [guest, id] of this.guests) {
      if (id === streamId) {
        target = guest;
        break;
      }
    }
    if (!target) return;
    try {
      if (type === TYPE_DATA && payload && payload.byteLength) target.send(payload);
      else if (type === TYPE_CLOSE) target.close(1000, 'stream closed');
    } catch {
      /* guest 已断 */
    }
  }
}

function frame(type, streamId, payload) {
  const head = new Uint8Array(HEADER_SIZE);
  head[0] = type;
  new DataView(head.buffer).setUint32(1, streamId >>> 0, false);
  if (!payload || !payload.byteLength) return head;
  const out = new Uint8Array(HEADER_SIZE + payload.byteLength);
  out.set(head, 0);
  out.set(payload instanceof Uint8Array ? payload : new Uint8Array(payload), HEADER_SIZE);
  return out;
}

/** 统一转成 Uint8Array（Cloudflare 的二进制帧是 ArrayBuffer，Node 侧是 Buffer） */
function toBytes(data) {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (typeof data === 'string') return new TextEncoder().encode(data);
  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return json({ ok: true, service: 'viskluke-relay' });
    }

    if (url.pathname !== '/relay') {
      return json({ ok: false, error: 'not found' }, 404);
    }

    const room = String(url.searchParams.get('room') || '');
    const role = String(url.searchParams.get('role') || '');
    if (!ROOM_RE.test(room)) return json({ ok: false, error: '房间号不合法' }, 400);
    if (!['host', 'guest'].includes(role)) return json({ ok: false, error: '角色不合法' }, 400);
    if (request.headers.get('Upgrade') !== 'websocket') {
      return json({ ok: false, error: '需要 WebSocket Upgrade' }, 400);
    }

    const id = env.RELAY_ROOMS.idFromName(room);
    const stub = env.RELAY_ROOMS.get(id);
    return stub.fetch(request);
  },
};
