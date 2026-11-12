# 自建中继（免费联机，不消耗 Cloudflare 额度）

Viskluke 的内置中继跑在 Cloudflare Worker 上，会消耗你账号的免费额度。
如果额度不够、或者你不想依赖 Cloudflare，可以在一台**有公网 IP / 公网 IPv6** 的机器上
自己跑中继——协议完全一样，启动器里把「联机方式」切成「自建中继」填地址即可。

## 1. 准备

- 一台能被外网连进来的机器（VPS、家里的公网 IPv4 + 端口映射、或公网 IPv6 都行）
- Node.js 18+
- 把本仓库拉下来：`git clone https://github.com/STDEgood/Viskluke.git`
- `npm install`（只装依赖，不需要打包）

## 2. 启动

```bash
node scripts/relay-server.js --port 25566
# 或者
npm run relay:serve
```

启动后会打印：

```
Viskluke 自建中继已启动：ws://0.0.0.0:25566/relay
本机测试：  ws://127.0.0.1:25566
局域网：    ws://192.168.x.x:25566
```

- **路由器 / 防火墙要放行 TCP 25566**
- 环境变量 `PORT` 也可以指定端口

## 3. 想要 wss://（推荐）

明文 `ws://` 在公网上会让房间口令和流量裸奔。用 Caddy 反代最省事：

```caddyfile
relay.example.com {
    reverse_proxy 127.0.0.1:25566
}
```

Caddy 会自动申请证书，之后启动器里填 `wss://relay.example.com` 就行。
Nginx 同理（`proxy_pass` + `Upgrade` 头）。

## 4. 在启动器里用

1. 服务器页 → 联机方式 → **自建中继（免费）**
2. 中继地址填 `wss://relay.example.com`（或内网测试用 `ws://192.168.x.x:25566`）
3. 开隧道 / 加入房间，和用 Cloudflare 时完全一样

## 5. 零成本的其他联机方式（不用中继）

| 方式 | 条件 | 说明 |
|---|---|---|
| 局域网 | 同一个 WiFi | 服务器页会直接显示局域网地址 |
| 公网直连 | 公网 IPv4 + 端口映射（或 UPnP） | 页面可一键 UPnP 映射，并诊断 CGNAT |
| IPv6 直连 | 双方都有公网 IPv6 | 启动器会自动建 AAAA 解析 |

没有公网条件时，才需要中继（Cloudflare 或自建）。

## 6. 安全说明

- 房间口令：第一个连上的人设定，之后必须一致；不一致返回 403
- 单房间最多 32 个玩家；单帧上限 1 MB
- 中继只看帧、不解 MC 协议，也不记录内容
- 公网部署请务必限制端口来源或套 TLS，避免被扫端口
