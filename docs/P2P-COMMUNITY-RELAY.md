# Viskluke Mesh —— 去中心化社区中继网络（架构设计与关键代码）

> 目标：把现在「所有人共享一个 Cloudflare Worker 中继」升级成「用户自愿贡献带宽作为中继节点 +
> 中央协调服务器负责注册与智能选路 + 内置 Worker 中继做兜底」。
> 本文是设计方案，不是已落地的代码；落地按第 8 节分阶段来。

---

## 0. 先给结论：可行性、以及那条绕不过去的硬约束

**结论：可行，但「谁有资格当节点」和你想的不一样。**

中继节点必须能被 A 和 C **主动连进来**（入站 TCP）。Minecraft Java 版是 TCP，
所以：

| 节点网络环境 | 能否当众包中继 | 说明 |
|---|---|---|
| 公网 IPv4 + 端口映射 / UPnP 打通 | ✅ 可以 | 现有 `netcheck.js` 已经能做 UPnP 映射与公网 IP 判定 |
| 原生公网 IPv6（防火墙放行） | ✅ 可以 | 国内手机流量/部分宽带都有；`netcheck` 已能过滤 Teredo/6to4 |
| 运营商大内网（CGNAT） | ❌ 不行 | 没有入站能力 |
| 普通 NAT（家用路由器） | ⚠️ 只能靠 UPnP 成功 | 失败就不行 |
| 「打洞」 | ❌ 对 TCP 基本不成立 | 见下 |

**为什么不能靠 TCP 打洞**：NAT 打洞需要双方先通过 STUN 拿到各自的公网映射端口，
STUN 是 UDP 协议；TCP 的「同时打开（simultaneous open）」要求两端在同一时刻互相 SYN，
NAT 行为（对称型/端口预测）千差万别，WebSocket 还叠了 TLS/HTTP 层，
实测成功率极低，不能作为默认路径。想做打洞，必须把数据面换成 UDP（QUIC datagram 之类），
而对称型 NAT 依然打不通，最后还是得 TURN 中转 —— 那又回到了「有人出带宽」这件事上。

**所以本方案的设计前提**：

1. 节点准入由**协调服务器实测**（从 Cloudflare 边缘回连节点端口，拿到 nonce 才算通过）；
   不通的用户 UI 上明确置灰，只能当客户端。
2. **现有 Worker 中继永远保留**，作为「没有可用节点 / 节点满 / 节点挂了」的兜底。
3. 本方案**不需要** A 或 C 有公网 IP —— 他们的隧道是「主动向外连」的，
   B 只负责在两条入站 WebSocket 之间转发帧（和现在的 `relay.js` 主机/玩家模式是同一套协议）。

---

## 1. 总体架构

```
        ┌───────────────────────────── Cloudflare Worker（协调层）─────────────────────────────┐
        │  /nodes/register  /nodes/heartbeat  /nodes/candidates  /match    /relay（兜底中继）    │
        │  NodeRegistry (DO)：节点表 + 负载 + 可达性证明 + TTL                                    │
        │  RelayMatch  (DO)：A/C 双方测速结果合流 → 选点 → 下发 ticket                            │
        └───────────────▲───────────────────────────▲──────────────────────────▲───────────────┘
                        │ HTTPS                      │ HTTPS                    │ HTTPS
              ┌─────────┴─────────┐        ┌────────┴────────┐        ┌────────┴─────────┐
              │ 节点 B（贡献者）   │        │ 房主 A          │        │ 玩家 C           │
              │ community-node.js │        │ 主机隧道        │        │ 本地代理         │
              │ 入站 WSS 监听      │◀──────▶│ 出站 WSS ───────▶│        │ 出站 WSS ───────▶│
              │ 房间多路复用/限流  │  WSS   │ 127.0.0.1:25565 │        │ 127.0.0.1:25566  │
              └───────────────────┘        └─────────────────┘        └──────────────────┘
```

关键点：**数据面不经过协调服务器**。协调层只做注册、健康、匹配、发凭证；
真正的字节走 A ↔ B ↔ C。这和现在的 `RelayRoom` 结构一致，只是把「唯一的 Worker 中继」
换成了「一组可替换的社区节点」。

角色与职责：

| 角色 | 代码位置（新增/修改） | 职责 |
|---|---|---|
| 协调层 | `worker/cloudflare-relay-worker.mjs` + 两个 DO | 节点注册/心跳/实测、候选列表、选点、发 ticket、兜底中继 |
| 贡献节点 | 新增 `community-node.js`（可被 `main.js` 或独立 CLI 启动） | 入站 WSS、房间配对、帧转发、配额、统计 |
| 客户端 | `relay.js`（改）+ 新增 `p2p/match.js` | 并发测速、申请匹配、按 ticket 连接节点 |
| UI | `renderer/index.html` + `renderer.js` + `preload.js` | 开关、配额、状态、一键停止；联机方式选择 |

---

## 2. 一、节点发现与注册机制

### 2.1 节点身份与凭证

- `nodeId`：启动器首次开启互助时生成（16 字节随机，Base64url），持久化到
  `<userData>/community-node.json`，和 `nodeSecret` 一起保存。
- `nodeSecret`：**注册成功时由协调服务器下发**（32 字节），节点用它给心跳签名、
  校验协调服务器签发的 ticket。不要复用 Cloudflare Token，也不要提交进仓库。
- 节点注册信息（DO 里存）：

```jsonc
{
  "nodeId": "AbC...",
  "endpoint": { "host": "203.0.113.7", "port": 25566 },
  "capacity": { "maxRooms": 2, "maxGuestsPerRoom": 8, "maxEgressMbps": 8 },
  "region": "cn-east",                  // 可选：按 AS/时区粗分，减少无效测速
  "load": { "rooms": 1, "guests": 2, "egressBps": 480000 },
  "verified": true,                     // 协调服务器实测通过
  "lastSeen": 1730000000000,
  "software": "1.0.0",
  "protocol": 1
}
```

### 2.2 注册流程（三道校验）

```
POST /nodes/register
  body: { nodeId, endpoint:{host,port}, capacity, software, protocol }
  header: X-Viskluke-Signature: HMAC(prevSecret, body)   // 首次注册可空
```

1. **来源一致性**：`endpoint.host` 必须等于 `CF-Connecting-IP`（IPv6 归一化后比较）。
   否则拒绝 —— 防止有人把**别人的 IP** 注册成节点，让协调服务器去回连、也让 A/C 去测速，
   等于借刀打人（反射/SSRF）。
2. **地址合法性**：必须是 IP 字面量（不接受域名，避免 DNS 重绑定）、
   端口 1024–65535、拒绝私网/回环/链路本地/组播/保留地址。
3. **可达性实测**：协调服务器用 `cloudflare:sockets` 主动连一次 `endpoint`，
   发一个随机 nonce，要求 3 秒内原样回显（见下）。通过才 `verified: true`。

```js
// worker/cloudflare-relay-worker.mjs（片段）
import { connect } from 'cloudflare:sockets';

const PRIVATE = [
  /^10\./, /^127\./, /^169\.254\./, /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

function isPublicIp(host) {
  return /^\d+\.\d+\.\d+\.\d+$/.test(host) && !PRIVATE.some((re) => re.test(host));
}

async function probeNode(endpoint, timeoutMs = 3000) {
  const nonce = crypto.randomUUID();
  const sock = connect({ hostname: endpoint.host, port: endpoint.port });
  const timer = setTimeout(() => sock.close(), timeoutMs);
  try {
    const writer = sock.writable.getWriter();
    await writer.write(new TextEncoder().encode(`VLK-PROBE ${nonce}\n`));
    const reader = sock.readable.getReader();
    let text = '';
    while (text.length < 128) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
      if (text.includes(nonce)) return true;
    }
    return false;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    sock.close();
  }
}
```

> 节点侧在同一个端口上同时提供 `http.Server`（给 WS 升级 + 给 `/probe` 回显），
> 这样一次监听同时满足「协调服务器探活」和「A/C 的 WSS」，不用开第二个端口。

### 2.3 心跳与过期

- 节点每 30s `POST /nodes/heartbeat`，带 `{nodeId, load}`，HMAC 用 `nodeSecret`；
  协调服务器刷新 `lastSeen` 与负载。
- TTL 90s：`alarm()` 每 30s 扫一遍，`lastSeen` 超时的节点标记 `stale`，不再进候选列表；
  连续 3 次心跳失败 → 节点侧 UI 提示「当前无法被外部访问，已自动停止接单」。
- 节点本地也应**自适应**：若 10 分钟内没有一次成功匹配，主动降频注册（省电、省日志）。

### 2.4 候选下发（不要全量暴露）

```
GET /nodes/candidates?region=cn-east&limit=6
→ { nodes: [{ nodeId, endpoint, loadRatio, capacityLeft, software }] }
```

- 只下发**已验证且未过期**的节点，按 `loadRatio` 升序 + 随机打散，最多 6 个；
- 按 IP 限流（例如 30 次/分钟），防止有人批量拉取节点表做扫描；
- 不下发节点的房间号、对端 IP、历史流量。

---

## 3. 二、延迟测速与智能路由

### 3.1 客户端并发测速（TCP 建连 RTT）

对每个候选节点测 3 次 TCP 建连耗时取中位数，限并发 6、单次超时 1.2s、总预算 3.5s：

```js
// p2p/match.js
const net = require('net');

function tcpRtt({ host, port }, timeout = 1200) {
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('timeout'));
    }, timeout);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(Number(process.hrtime.bigint() - started) / 1e6);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function measureCandidates(candidates, { concurrency = 6, timeout = 1200, budget = 3500 } = {}) {
  const queue = [...candidates];
  const result = new Map(); // nodeId -> ms
  const deadline = Date.now() + budget;

  const worker = async () => {
    while (queue.length && Date.now() < deadline) {
      const node = queue.shift();
      const samples = [];
      for (let i = 0; i < 3; i += 1) {
        try {
          samples.push(await tcpRtt(node.endpoint, timeout));
        } catch {
          /* 单次失败不算致命，继续下一轮 */
        }
      }
      if (samples.length >= 2) {
        samples.sort((a, b) => a - b);
        result.set(node.nodeId, samples[Math.floor(samples.length / 2)]);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return result;
}

module.exports = { tcpRtt, measureCandidates };
```

补充说明：

- TCP 建连 RTT 只反映**握手路径**，不反映带宽。若要更贴近实际，可在节点 `/probe`
  里回显一个 4KB 随机块，测「首字节时间 + 下载 4KB 时间」；这一点作为 v2 优化项。
- 不要测「A 到 C」：A 和 C 之间大概率互相不可达，测了也没用；只测各自到候选节点。
- 失败节点直接丢弃，不做重试（重试会拖长整体匹配时间）。

### 3.2 中央协调服务器怎么选点

A 和 C 各自测完，把自己的 `Map<nodeId, rtt>` 发到协调层：

```
POST /match   body: { room, role: "host"|"guest", rtts: { nodeId: ms } }
→ 第一方收到 { pending: true }，客户端 1s 后重试（最多 10s）
→ 双方都到齐后，DO 选点并给双方返回 { node, ticket, expiresIn }
```

选点算法（最小化「较慢那一侧」的延迟，兼顾负载与新鲜度）：

```js
// RelayMatch DO 内部
function pickNode(nodes, rttsA, rttsC) {
  let best = null;
  for (const node of nodes) {
    const a = rttsA[node.nodeId];
    const c = rttsC[node.nodeId];
    if (!Number.isFinite(a) || !Number.isFinite(c)) continue; // 两边都必须能到
    if (node.rooms >= node.capacity.maxRooms) continue;
    const load = node.rooms / node.capacity.maxRooms;
    if (load > 0.8) continue;                                 // 接近满就不派了
    const worst = Math.max(a, c);
    if (worst > 180) continue;                                // 太差不如走兜底
    const score =
      worst +                    // 瓶颈侧延迟（主导项）
      0.35 * (a + c) / 2 +       // 平均延迟，避免只看最差
      load * 40 +                // 负载惩罚：满载节点等于多 40ms
      (node.verified ? 0 : 200); // 未验证节点基本不派
    if (!best || score < best.score) best = { node, score, worst };
  }
  return best;
}
```

选不出来时的降级链：

```
社区节点（延迟达标） → 社区节点（放宽到 300ms / 负载 95%） → 内置 Worker 中继 → 报错并给「局域网地址」
```

每次匹配结果都要落日志（选点原因、双方延迟、节点负载），出问题能复盘。

### 3.3 Ticket：让节点自己校验，不依赖协调层在线

协调层用节点注册时下发的 `nodeSecret` 签一张一次性票：

```js
// 双端共用（worker 里是 Web Crypto，node 里是 node:crypto，算法一致）
function ticketPayload({ nodeId, room, role, exp }) {
  return `v1.${nodeId}.${room}.${role}.${exp}`;
}

function signTicket(secret, data) {
  const mac = crypto.createHmac('sha256', secret).update(ticketPayload(data)).digest('base64url');
  return `${data.exp}.${mac}`;
}

function verifyTicket(secret, ticket, { nodeId, room, role, now = Date.now(), skew = 60_000 }) {
  const [expStr, mac] = String(ticket || '').split('.');
  const exp = Number(expStr);
  if (!exp || !mac || exp + skew < now) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(ticketPayload({ nodeId, room, role, exp }))
    .digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
```

- `exp` 建议 10 分钟；节点连上后不再校验（房间生命周期由节点自己管）。
- 反向意义：节点只接受**协调层签过**的房间，杜绝「拿节点当免费代理」的裸奔用法。

---

## 4. 三、节点 B 的转发逻辑（核心）

### 4.1 协议完全复用现有 `relay.js`

现有帧格式已经是 `[type:1][streamId:4][payload]`（`TYPE_OPEN/DATA/CLOSE`），
主机侧有头、玩家侧裸负载。B 只需要：

- 接受两条角色的 WSS：`/relay?room=&role=host|guest&ticket=`；
- `host` 先到就绪，`guest` 到达时分配 `streamId` 并给 host 发 `TYPE_OPEN`；
- guest → host：包成 `TYPE_DATA, streamId, payload`；
- host → guest：去掉 5 字节头，只发给对应 `streamId` 的 guest；
- 任何一端断开：给另一端发 `TYPE_CLOSE` 并清理。

**所以节点 B 完全不需要理解 Minecraft 协议**，也**永远不会主动连接任何外部 IP** ——
它只在本机 MC 服务器（由 host 侧的隧道负责连 `127.0.0.1`）和玩家之间搬字节。
这一点是防滥用设计的基石（见 5.2）。

### 4.2 核心实现（新增 `community-node.js`）

```js
'use strict';
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const crypto = require('crypto');

const TYPE_OPEN = 1, TYPE_DATA = 2, TYPE_CLOSE = 3, HEADER = 5;
const MAX_FRAME = 1024 * 1024;

const frame = (type, id, payload) => {
  const head = Buffer.alloc(HEADER);
  head[0] = type;
  head.writeUInt32BE(id >>> 0, 1);
  return payload && payload.length ? Buffer.concat([head, payload]) : head;
};

function startCommunityNode(options) {
  const {
    port = 25566,
    nodeId,
    ticketSecret,
    maxRooms = 2,
    maxGuestsPerRoom = 8,
    maxEgressBps = 1_000_000,   // 8 Mbps
    onLog = () => {},
    onStats = () => {},
  } = options;

  const rooms = new Map(); // room -> { host, guests: Map<ws, streamId>, nextStream, bytes }
  let egressWindow = { at: Date.now(), bytes: 0 };

  const server = http.createServer((req, res) => {
    // 协调服务器探活：原样回显 "VLK-PROBE <nonce>"
    if (req.url.startsWith('/probe')) {
      const nonce = new URL(req.url, 'http://x').searchParams.get('nonce') || '';
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(`VLK-PROBE ${nonce}`);
    }
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

  server.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, 'http://node');
    } catch {
      return socket.destroy();
    }
    if (url.pathname !== '/relay') return socket.destroy();

    const room = url.searchParams.get('room') || '';
    const role = url.searchParams.get('role');
    const ticket = url.searchParams.get('ticket') || '';
    if (!/^[A-Za-z0-9_-]{3,32}$/.test(room)) return socket.destroy();
    if (!['host', 'guest'].includes(role)) return socket.destroy();
    if (!verifyTicket(ticketSecret, ticket, { nodeId, room, role })) {
      onLog(`拒绝 ${room}: ticket 无效`);
      return socket.destroy();
    }

    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, { room, role }));
  });

  wss.on('connection', (ws, { room, role }) => {
    let entry = rooms.get(room);
    if (!entry) {
      if (rooms.size >= maxRooms) return ws.close(1013, 'node full');
      entry = { host: null, guests: new Map(), nextStream: 1, bytes: 0 };
      rooms.set(room, entry);
    }

    if (role === 'host') {
      if (entry.host) return ws.close(1013, 'room already has host');
      if (entry.guests.size > 0) return ws.close(1013, 'host must join first');
      entry.host = ws;
      ws.on('message', (raw) => {
        const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        if (buf.length < HEADER || buf.length > MAX_FRAME) return;
        const streamId = buf.readUInt32BE(1);
        const type = buf[0];
        for (const [guest, id] of entry.guests) {
          if (id !== streamId || guest.readyState !== WebSocket.OPEN) continue;
          if (type === TYPE_DATA && buf.length > HEADER) guest.send(buf.subarray(HEADER), { binary: true });
          if (type === TYPE_CLOSE) guest.close(1000, 'stream closed');
          break;
        }
      });
      ws.on('close', () => {
        for (const guest of entry.guests.keys()) guest.close(1001, 'host gone');
        rooms.delete(room);
      });
      onLog(`房间 ${room} 主机已接入（当前 ${rooms.size} 个房间）`);
      return;
    }

    // guest
    if (!entry.host) return ws.close(1013, 'no host yet');
    if (entry.guests.size >= maxGuestsPerRoom) return ws.close(1013, 'room full');
    const streamId = entry.nextStream++;
    entry.guests.set(ws, streamId);
    entry.host.send(frame(TYPE_OPEN, streamId), { binary: true });

    ws.on('message', (raw) => {
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      if (buf.length > MAX_FRAME) return ws.close(1009, 'frame too big');
      if (!entry.host || entry.host.readyState !== WebSocket.OPEN) return;
      // 出口限速：按 1 秒窗口算，超了就丢帧（MC 会自己重传/重连，不会脏数据）
      egressWindow.bytes += buf.length;
      const now = Date.now();
      if (now - egressWindow.at >= 1000) egressWindow = { at: now, bytes: 0 };
      if (egressWindow.bytes > maxEgressBps) return;
      entry.host.send(frame(TYPE_DATA, streamId, buf), { binary: true });
    });
    ws.on('close', () => {
      entry.guests.delete(ws);
      if (entry.host && entry.host.readyState === WebSocket.OPEN) {
        entry.host.send(frame(TYPE_CLOSE, streamId), { binary: true });
      }
    });
    onLog(`房间 ${room} 玩家 +1（${entry.guests.size}/${maxGuestsPerRoom}）`);
  });

  return new Promise((resolve) => {
    server.listen(port, '0.0.0.0', () => {
      onStats({ rooms: rooms.size, port: server.address().port });
      resolve({
        port: server.address().port,
        stop: () => {
          for (const entry of rooms.values()) {
            if (entry.host) entry.host.close(1001, 'node stopped');
            for (const guest of entry.guests.keys()) guest.close(1001, 'node stopped');
          }
          rooms.clear();
          wss.close();
          server.close();
        },
        stats: () => ({ rooms: rooms.size }),
      });
    });
  });
}
```

> 注意：`verifyTicket` 和 `frame` 应该抽到共享文件（比如 `relay-protocol.js`），
> 让 `relay.js`、`community-node.js`、worker 用的是同一份常量，避免协议漂移。
> `ticket` 校验失败直接 `socket.destroy()`，不要回 HTTP 错误细节（防探测）。

### 4.3 内网节点能不能用？（直接回答你的难点）

- **不能。** 节点必须能被 A/C 入站连接；NAT 后面没有映射就没有入口。
- 可选的三条活路（按推荐度）：
  1. **UPnP/NAT-PMP 自动映射**（`netcheck.js` 已有能力）：启动时尝试，成功就上报；
     失败就把开关置灰并给出人话原因。
  2. **IPv6 直连**：很多宽带/手机网络有公网 IPv6，防火墙放行即可；
     节点注册时优先上报 IPv6 地址，客户端优先测 IPv6（可复用 `netcheck` 的地址过滤）。
  3. **大版本再考虑 UDP 数据面 + 打洞**：把 MC 的 TCP 流封装进 QUIC datagram，
     对称 NAT 仍然回落到 TURN。工程量至少是现在中继的 3–4 倍，不建议首版做。
- 因此**节点数量会远小于用户数量**，这决定了 UI 必须把「匹配失败 → 自动用内置中继」
  当成一等公民，而不是异常路径。

---

## 5. 四、负载限制与防滥用

### 5.1 带宽与并发（节点自己兜底）

| 限制 | 默认值 | 实现位置 |
|---|---|---|
| 单节点房间数 | 2 | `rooms.size >= maxRooms` 拒绝新房间 |
| 单房间玩家数 | 8 | `guests.size >= maxGuestsPerRoom` |
| 单节点上传 | 8 Mbps（可调 2–50） | 1 秒窗口字节计数，超了丢帧（不是断线，避免 MC 反复重连） |
| 单帧上限 | 1 MB | 已有约定，超过直接 `1009` |
| 空房间回收 | 10 分钟 | 定时器清理无连接的 room |
| 握手超时 | 10 秒 | upgrade 后未完成角色握手直接断开 |

**背压**：`ws.bufferedAmount` 超过 1MB 时，host 侧暂停本地 TCP 读取
（`tcp.pause()`），降到阈值以下再 `resume()`；guest 侧同理。
只在内存里计数，不需要额外线程。

### 5.2 防滥用：结构上就不是开放代理

这是本方案最重要的一条安全性质：

- 节点 B **从不主动连接任何 IP**。它只把 guest 的帧转发给「同房间的 host」，
  而 host 一侧的隧道也只连自己的 `127.0.0.1:25565`。
  即使攻击者拿到节点地址和 ticket，也只能把流量倒进某个真实 MC 服务器，**不能当跳板扫内网/打别人**。
- ticket 由协调层签名，绑定 `nodeId + room + role + exp`，节点本地用 HMAC 校验，
  不需要回源查询；伪造 ticket 需要 `nodeSecret`（只存在节点和协调层）。
- 每个房间 1 host + N guest，host 先到；guest 不能自己开房，
  因此不存在「用节点搭任意 TCP 隧道」的通用通道。
- 限流：同一 IP 每分钟最多 6 次 upgrade，超了直接拒；
  ticket 校验失败 5 次/分钟的 IP 拉黑 10 分钟（节点本地内存表）。
- 协议层不解析 MC 内容，因此**不做内容审查**；但节点可以按字节数封顶，
  防止单房间把带宽吃满。
- 隐私：节点能看到 guest 的 IP（TCP 对端），这是 P2P 的固有代价，
  必须在 UI 明示；协调层不记录房间内容，只在心跳里统计字节数。

### 5.3 相关法律/运营风险（别忽略）

- 贡献节点 = 用户用自己的宽带上行承载陌生人的流量，可能违反部分 ISP 的「禁止服务器用途」条款；
  开关文案里要写清楚。
- 不要做「默认开启」——必须用户主动勾选，并展示当前上传速率与累计流量。
- 节点崩溃/被 DDoS 时要有熔断：连续 3 次升级失败或 CPU 超阈值 → 自动停止接单。
- 建议加「举报/拉黑节点」入口（协调层维护黑名单），以及节点版本号字段，
  协议升级时能强制下线旧节点。

---

## 6. 五、UI 修改建议

### 6.1 设置页：新增「社区互助」卡片（默认关闭）

```html
<section class="panel" id="community-panel">
  <header class="panel-head">
    <h3>社区互助（贡献带宽）</h3>
    <label class="switch">
      <input type="checkbox" id="community-enable" />
      <span>开启后允许其他玩家通过本机中转</span>
    </label>
  </header>

  <div class="rows">
    <label>上传带宽上限
      <select id="community-bandwidth">
        <option>2 Mbps</option><option selected>8 Mbps</option>
        <option>16 Mbps</option><option>不限（不推荐）</option>
      </select>
    </label>
    <label>最多同时中转房间
      <input id="community-max-rooms" type="number" min="1" max="5" value="2" />
    </label>
    <label>每房间最大玩家
      <input id="community-max-guests" type="number" min="1" max="16" value="8" />
    </label>
  </div>

  <p class="hint" id="community-eligibility">正在检测本机是否可被外部访问…</p>

  <dl class="stats">
    <dt>当前中转</dt><dd id="community-stats">0 个房间 / 0 位玩家</dd>
    <dt>本次上传</dt><dd id="community-traffic">0 MB</dd>
  </dl>

  <div class="actions">
    <button class="btn subtle" id="btn-community-copy" disabled>复制我的节点地址</button>
    <button class="btn danger" id="btn-community-stop" disabled>强制停止并断开所有房间</button>
  </div>
</section>
```

必须的交互细节：

- 开关打开前先跑一次可达性检测（复用 `netcheck.report()` 的结论），
  不通就**不允许**打开，并显示原因（「运营商大内网，无法作为节点」/「UPnP 失败」）。
- 打开时二次确认弹窗，明确写：会消耗你的上传带宽、对端能看到你的 IP、可随时关闭。
- `强制停止` 立即 `community:disable`：关监听、断所有 WS、向协调层注销（`DELETE /nodes/register`）。

### 6.2 服务器页：联机方式与匹配结果

```html
<div class="relay-mode">
  <label><input type="radio" name="relay-mode" value="auto" checked> 自动匹配社区节点</label>
  <label><input type="radio" name="relay-mode" value="builtin"> 只用内置中继</label>
  <label><input type="radio" name="relay-mode" value="manual"> 手动填地址</label>
</div>
<p class="match" id="relay-match">
  正在为房间 <code>mc-a1b2</code> 查找节点…（已测速 4/6）
</p>
```

- 匹配成功展示：节点地址（脱敏成 `203.0.113.*:25566`）、双方延迟
  （`A→B 38ms / C→B 52ms`）、预计带宽、`重新匹配` 按钮。
- 匹配失败展示原因 + 自动降级到内置中继的一行提示，不要弹窗。
- 房主和玩家两侧都要显示同一条匹配结果（房间号是共同锚点）。

### 6.3 IPC 与 preload（新增）

```js
// preload.js
communityStatus: () => ipcRenderer.invoke('community:status'),
communityEnable: (payload) => ipcRenderer.invoke('community:enable', payload),
communityDisable: () => ipcRenderer.invoke('community:disable'),
communityStats: () => ipcRenderer.invoke('community:stats'),
relayMatch: (payload) => ipcRenderer.invoke('relay:match', payload),
onCommunityEvent: (cb) => {
  const listener = (_e, data) => cb(data);
  ipcRenderer.on('community:event', listener);
  return () => ipcRenderer.removeListener('community:event', listener);
},
```

事件流：`community:event` → `{ type: 'registered'|'unreachable'|'room-open'|'room-close'|'quota-hit', ... }`，
渲染层据此更新统计并弹一次 toast（不要刷屏）。

---

## 7. 模块划分与改动清单

| 文件 | 改动 |
|---|---|
| `worker/cloudflare-relay-worker.mjs` | 新增 `/nodes/register`、`/nodes/heartbeat`、`/nodes/candidates`、`/match`、`DELETE /nodes/register`；新增两个 DO：`NodeRegistry`、`RelayMatch`；保留现有 `/relay` 兜底 |
| `worker/wrangler-relay.toml` | 新增两个 DO 绑定 + migration `v2`（`new_sqlite_classes`） |
| **新增** `community-node.js` | 节点侧服务（本文件第 4 节代码的完整版：配额、背压、统计、优雅停止） |
| **新增** `p2p/match.js` | 并发测速 + 匹配申请 + 结果重试 |
| **新增** `relay-protocol.js` | 帧编解码、`TYPE_*` 常量、ticket 签名/校验（worker 与 node 共用实现，双端各一份） |
| `relay.js` | `startHostTunnel` / `startGuestProxy` 增加 `ticket` 参数，连节点时拼进 URL；保持对内置中继的兼容（无 ticket 时行为不变） |
| `main.js` | 新增 IPC：`community:*`、`relay:match`；进程退出时注销节点；`community` 生命周期状态机 |
| `netcheck.js` | 抽出 `describeReachabilityForNode()`，给 UI 判断「能不能当节点」 |
| `renderer/index.html` + `renderer.js` | 第 6 节的两块 UI + 状态渲染 |
| `scripts/selftest.js` | 新增：ticket 签名/过期、注册参数校验（私网 IP/端口越界）、选点函数单测（构造 rtts）、本地三节点端到端（A/B/C 全是 ws，不打真实网络） |
| `scripts/test-community-relay.js` | 新增端到端脚本：启动节点 B + 主机 A + 玩家 C，跑小包/大包/并发/配额拒绝 |

---

## 8. 落地节奏（建议按这个顺序，别一口气全上）

| 阶段 | 内容 | 预估 |
|---|---|---|
| **MVP** | `community-node.js` + 手动填节点地址（不做注册/匹配），验证 B 转发链路与配额 | 0.5–1 天 |
| **v2** | 协调层注册/心跳/探活 + 候选列表 + 客户端测速 + 选点 + ticket | 2–3 天 |
| **v3** | 设置页/服务器页 UI、统计、强制停止、降级提示 | 1–2 天 |
| **v4** | 背压/限速完善、黑名单、节点信誉、IPv6 优先、自检与端到端脚本 | 2–3 天 |

先做 MVP 的好处：**在不碰 Worker 的前提下**，先用两台机器（一台有公网）验证
「B 能不能稳定转发 MC 流量、延迟/丢包是否可接受」。这一步不过，后面全是空中楼阁。

---

## 9. 技术风险清单（按严重程度）

1. **节点供给不足（高）**：CGNAT + 无 IPv6 的用户占多数，能当节点的比例可能只有个位数。
   必须保留 Worker 兜底，并在 UI 上把「自动降级」做成正常路径。上线前先统计
   「有多少用户能通过可达性检测」，再决定是否值得投入。
2. **延迟测速失真（中）**：TCP 握手 RTT 不等于吞吐；跨运营商 QoS 会让「最近」的节点反而更慢。
   缓解：测 3 次取中位数、把带宽/丢包纳入 v2 评分、允许用户手动「换一个节点」。
3. **隐私（中）**：节点能看到 guest 的公网 IP；guest 也能看到节点 IP。这是 P2P 固有属性，
   必须在开关与匹配 UI 里明示，并写进隐私说明。
4. **被 DDoS / 被滥用为跳板（低-中）**：结构上不是开放代理（见 5.2），但节点端口暴露在公网，
   仍可能被扫端口/灌垃圾连接；靠限流、ticket、`MAX_FRAME` 与本地黑名单兜底。
5. **法律与 ISP 条款（中）**：用户上传他人流量；必须 opt-in + 明确告知，
   项目 LICENSE 里加免责声明。
6. **分布式复杂度（中）**：注册表、心跳、TTL、版本协商、节点上下线都会引入
   「偶发连不上」类问题；每一条都要有可观测日志（选点原因、ticket 失败原因、配额命中）。
7. **协议漂移（低）**：帧格式/ticket 版本必须带 `protocol` 字段，节点与客户端都要拒绝不认识的版本，
   否则新旧混跑很难查。

---

## 10. 和现有代码的关系（一句话版）

- **不用推倒重来**：`relay.js` 的帧协议、`RelayRoom` 的房间模型、`cloudflare.js` 的中继地址配置
  全部复用；新增的是「节点侧服务」「注册/匹配 API」「测速与选点」三块。
- 现有 Worker 中继从「唯一通道」降级为「兜底通道」，代码几乎不动。
- 现有 `netcheck.js` 的可达性诊断是节点准入判断的现成基础，直接复用。

---

## 附：本方案的三个「不要」

1. **不要**默认开启贡献节点，也不要静默上传别人的流量。
2. **不要**在没有可达性检测的情况下允许用户开节点（会制造一堆「注册成功但连不上」的幽灵节点）。
3. **不要**为了「去中心化」去掉 Worker 兜底 —— 在 CGNAT 普及的现实里，兜底才是可用性的保证。
