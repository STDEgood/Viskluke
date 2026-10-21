# Viskluke Address —— Worker 代理部署（3 分钟）

## 为什么不用"把 Token 写进启动器"

启动器是客户端程序，`asar` 一解包就能看到里面的全部内容。把 Cloudflare Token 写进去等于：

- 任何人拿到 Token 就能改/删你这三个域名下的**任何** DNS 记录（不只是游戏用的那几条）；
- 子域名劫持、钓鱼站、把你正在用的服务顶掉，都只需要一个 Token；
- Token 一旦泄露，只能靠轮换补救，而客户端已经被分发出去收不回来了。

所以正确结构是：**Token 只放 Worker（服务端），客户端只发前缀/后缀/端口。**

```
启动器 ──(prefix/suffix/port)──> Worker ──(Bearer Token)──> Cloudflare API
                                    └─ 用 CF-Connecting-IP 当 A 记录
```

好处不只是安全：客户端连"我的公网 IP 是多少"都不用查，Worker 直接把请求来源 IP 写进 A 记录，
换网/换 IP 后重新开服就自动更新。

## 一条命令部署（推荐，有 Node 环境时）

```bash
cd worker
npx wrangler login                     # 浏览器授权一次
npx wrangler secret put CF_API_TOKEN   # 粘贴第 1 步的 Token
npx wrangler deploy                    # 末尾会打印 Worker URL
```

部署前先改 [wrangler.toml](wrangler.toml) 里的 `CF_ZONES`（三个后缀 → Zone ID）。
注意 Token **不要**写进 wrangler.toml，它走 `wrangler secret`。

部署完把打印出来的 `https://viskluke-dns.<子域>.workers.dev` 填进启动器
（`config.json` 的 `PROXY_URL`，或 `cloudflare.js` 的 `BUILTIN_PROXY_URL`）。

## 网页控制台部署（不想装 Node 时）

下面 1~5 步全部在 Cloudflare 控制台里点完，不需要本地环境。

### 1. 建一个**只管 DNS** 的 Token

Cloudflare 控制台 → 右上头像 → **My Profile → API Tokens → Create Token**：

- 权限：`Zone → DNS → Edit`（想让它能自动列域名再加 `Zone → Zone → Read`，不是必需 —— Zone ID 写在变量里了）
- Zone Resources：`Include → Specific zone →` 你的三个域名（或 `All zones from an account`）
- Client IP 过滤：**留空**（绑了本机 IP 会让 Worker 用不了，因为请求来自 Cloudflare 的 IP）

> ⚠️ 别用 Global API Key，也别勾 `DNS:Edit` 之外的任何东西。

### 2. 建 Worker

控制台 → **Workers & Pages → Create → Worker**，名字随意（如 `viskluke-dns`），
把 [`cloudflare-dns-worker.mjs`](cloudflare-dns-worker.mjs) 的内容整段粘进编辑器（替换默认代码），
**Deploy**。

### 3. 配环境变量

Worker → **Settings → Variables and Secrets**：

| 名称 | 类型 | 值 |
|---|---|---|
| `CF_API_TOKEN` | **Secret** | 第 1 步建的 Token |
| `CF_ZONES` | Variable (Text) | `{"stde.eu.cc":"<Zone ID>","yistarline.eu.cc":"<Zone ID>","ys2video.eu.cc":"<Zone ID>"}` |
| `ALLOWED_SUFFIXES` | Variable（可选） | `stde.eu.cc,yistarline.eu.cc,ys2video.eu.cc` |
| `RATE_LIMIT_PER_MIN` | Variable（可选） | `30`（0 = 不限） |

Zone ID 在 Cloudflare 域名概览页右下角能看到（不是机密，可以公开）。
三个后缀如果都在 `eu.cc` 这个 Zone 下，三个键填同一个 ID 即可。

### 4. 填进启动器

两种方式，任选：

```jsonc
// %APPDATA%\viskluke-launcher\config.json
{
  "PROXY_URL": "https://viskluke-dns.<你的子域>.workers.dev"
}
```

或者改代码里的默认值（这个是 URL 不是密钥，可以随客户端分发）：

```js
// cloudflare.js
const BUILTIN_PROXY_URL = 'https://viskluke-dns.<你的子域>.workers.dev';
```

填好后启动器的 Cloudflare 状态会显示「**Worker 代理**」，之后
「一键开服 → 创建解析」全程不需要用户填 Token。

### 5. 自测

```bash
curl https://viskluke-dns.xxx.workers.dev/health
# {"ok":true,"zones":["stde.eu.cc",...],"zoneCount":3}

curl -X POST https://viskluke-dns.xxx.workers.dev/sync \
  -H 'content-type: application/json' \
  -d '{"prefix":"testmc","suffix":"stde.eu.cc","port":25565}'
# {"ok":true,"address":"testmc.stde.eu.cc","targetIp":"<你的IP>",...}

curl -X POST https://viskluke-dns.xxx.workers.dev/remove \
  -H 'content-type: application/json' \
  -d '{"address":"testmc.stde.eu.cc","suffix":"stde.eu.cc"}'
```

## 接口契约（客户端 `cloudflare.js` 按这个实现）

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/health` | — | `{ ok, zones: string[] }` |
| POST | `/sync` | `{ prefix, suffix, port, ttl? }` | `{ ok, address, mode, targetIp, targetIpv6, srvName, srvTarget, port, ttl, records, warnings }` |
| POST | `/remove` | `{ address, suffix }` | `{ ok, removed: string[] }` |
| POST | `/probe` | `{ host, port }` | `{ ok, reachable: boolean, host, port, ms, error? }` |

失败一律返回 `{ ok:false, error:"原因" }`，HTTP 4xx/5xx；客户端会把 `error` 显示在界面上。

## 安全设计说明

- Worker 只允许 `CF_ZONES` 里配置过的后缀，前缀限制为 1~40 位 `[a-z0-9-]`，并挡掉 `www/mail/api` 等保留字
  —— 别人拿到你的 Worker 地址也**不能**拿它去改任意域名的解析。
- A 记录强制 `proxied: false`（Cloudflare 橙云转发不了 Minecraft 流量）。
- 只删「自己管的那两条」：`<前缀>.<后缀>` 的 A/AAAA/CNAME 与 `_minecraft._tcp.<前缀>.<后缀>` 的 SRV，
  不会碰同 Zone 下的其它记录。
- 每个 isolate 有内存限流（默认 30 次/分钟/IP）；要更严格的可以接 KV/Durable Object，
  但注意 Workers 免费额度有限，别被刷。
- 如果哪天 Worker 地址被滥用，直接在 Cloudflare 里改 Token 或删 Worker 即可，**客户端不用重发**。

## `/probe`：验证"外面到底能不能连进来"

启动器服务器页的「测一下外面能不能连进来」会调这个接口。Worker 用 `cloudflare:sockets` 的
`connect()` 从**公网这一侧**去连 `host:port`，连上立刻断开，只判断可达性：

```jsonc
// 请求
{ "host": "122.238.17.108", "port": 25565 }
// 响应（连上）
{ "ok": true, "reachable": true, "host": "122.238.17.108", "port": 25565, "ms": 38 }
// 响应（连不上）
{ "ok": true, "reachable": false, "ms": 3000, "error": "connection refused" }
```

注意：`reachable:false` 本身也是"探测成功"（说明外面真的连不进来），启动器会据此告诉你
「端口映射没生效 / 被防火墙或运营商拦了」。

---

## 另一个 Worker：内网穿透中继（可选）

`cloudflare-relay-worker.mjs` + `wrangler-relay.toml`，用 **Durable Objects** 把两个 WebSocket
（主机 + 玩家）配对到一个房间，转发 TCP 数据。没公网 IP 的用户靠它联机。

```cmd
npx wrangler deploy -c worker/wrangler-relay.toml
```

部署完记下域名（形如 `viskluke-relay.<你的>.workers.dev`），填到启动器「内网穿透」的中继地址里，
**不需要**加 `/relay` 后缀（启动器会自己拼）。

说明：
- 免费版 Durable Objects 有每日请求/时长额度，几个人联机够用；
- 房间号就是配对凭据（3~32 位字母数字），别用太容易猜的；
- 免费版 Worker 不适合大流量长期跑，重度使用建议升级或换自建 frp。
