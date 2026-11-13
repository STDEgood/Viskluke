# Viskluke Launcher —— 交接文档（给下一个会话 / 未来的你）

> 用途：新开会话时，先让 AI 读这个文件，再开始干活。它记录了项目现状、环境事实、
> 已踩过的坑、待办事项。**不要在里面写任何密钥。**

## 1. 基本信息

| 项 | 值 |
|---|---|
| 项目路径 | `C:\Users\Ystar\viskluke-launcher` |
| 应用名 | Viskluke Launcher（package.json name: `viskluke-launcher`） |
| 版本 | 1.0.0 |
| Electron | 33.4.11（Windows 10 Pro，build 26300） |
| Node | 24.19.0（Electron 内置 20.18.3） |
| Java | 17.0.20.1（Temurin，`JAVA_HOME` 已设） |
| 网络 | npm 走 npmmirror；`.npmrc` 里有 `electron_mirror` |

## 2. 怎么跑

```cmd
cd /d C:\Users\Ystar\viskluke-launcher
npm start            :: 实际执行 node scripts/launch.js（带沙箱自愈）
```

| 命令 | 说明 |
|---|---|
| `npm start` | 正常启动。若遇 Chromium STATUS_BREAKPOINT，自动降级 `--no-sandbox` 并记住 |
| `npm run start:safe` | 强制 `--no-sandbox` |
| `npm run start:direct` | 原始 `electron .`，不带任何兜底 |
| `npm run doctor` | 环境体检（安装完整性 / 环境变量 / 能否真正拉起 Electron） |
| `npm run probe` | 判断当前进程是 Electron 还是被当成 Node |
| `npm run selftest` | 不开窗口跑业务逻辑自检（离线 UUID、Cloudflare、开服编排、整合包解包、加载器 JSON…） |
| `npm run screenshots` | 拉起真实应用 → CDP 截图 → 覆盖 `docs/screenshots/`（渲染层有 error 时退出码非 0） |

## 3. 数据放在哪（很关键）

| 内容 | 路径 |
|---|---|
| 实例列表 | `<userData>\instances.json`；否则 `C:\Users\Ystar\data\instances.json`（见坑 2） |
| 皮肤库 | 与 `instances.json` 同目录的 `skins\`（`index.json` + `files\<sha>.png`） |
| Cloudflare 配置 | `<userData>\config.json`（含 `CF_API_TOKEN` / `CF_ZONES` / `PROXY_URL`，**不要提交**） |
| 游戏目录 | `C:\Users\Ystar\Viskluke\instances\<实例ID>`（每个实例独立，含 mods/ resourcepacks/ shaderpacks/ saves/） |
| 整合包标记 | `<游戏目录>\.viskluke-modpack.json`（同时写进实例记录的 `modpack` 字段） |
| 加载器版本 | `<游戏目录>\versions\<mc>-<loader>-<ver>\<id>.json`（首次启动时生成） |
| 本地皮肤 | `<游戏目录>\CustomSkinLoader\LocalSkin\skins\<玩家名>.png`（另可放 capes/、elytras/） |
| CSL 配置 | `<游戏目录>\CustomSkinLoader\CustomSkinLoader.json`（模型开关在 `loadlist` 里） |
| 皮肤模型兜底 | `<游戏目录>\CustomSkinLoader\ExtraList\viskluke-skin.json`（CSL 还没生成配置时写这里） |
| 服务端 | `<userData>\servers\<serverId>`（`server.properties` / `whitelist.json` / 各核心 jar） |
| 崩溃日志 | `<userData>\viskluke_error.log`（userData 不可写时落到项目根目录） |

`<userData>` 默认 `%APPDATA%\viskluke-launcher`；若 Electron 进程写不进去，
[main.js](main.js) 会在 app ready 前自动切到 `C:\Users\Ystar\Viskluke\data`。
设置环境变量 `VISKLUKE_DATA_DIR=<目录>` 可以把实例列表指到别处（便携模式 / 自检 / 截图用）。

## 4. 代码结构

| 文件 | 职责 |
|---|---|
| [main.js](main.js) | 入口：引导日志 → 判定是否真 Electron → 全局异常钩子 → userData 可写性自愈 → 窗口 → IPC |
| [preload.js](preload.js) | contextBridge 暴露 API + 事件订阅（返回取消订阅函数） |
| [auth.js](auth.js) | 微软设备码登录 + **离线登录**（UUID = md5("OfflinePlayer:名字") 修正 v3 位） |
| [launcher.js](launcher.js) | MCLC 启动封装；多候选游戏目录 + 写探针；**EMFILE 自动重试 4 轮**；整合包实例走 `version.custom` |
| [loader.js](loader.js) | **客户端加载器**：Fabric/Quilt 抓 profile JSON 拍平合并成 `versions/<id>/<id>.json`；
 Forge/NeoForge 下载官方 installer（`ensureInstaller`）交给 MCLC + ForgeWrapper |
| [modpack.js](modpack.js) | **.mrpack 解包**：读 modrinth.index.json → 下载 files[]（过滤 server-only、sha512 校验、并发 2、失败续传）→ 解压 overrides → 写标记 |
| [modpack-instance.js](modpack-instance.js) | 整合包 ↔ 实例：没有就建（`mp-<slug>-<ts>`），有就复用续传；装完把版本/加载器/整合包信息写回 instances.json |
| [renderer/skin-editor.js](renderer/skin-editor.js) | **皮肤绘制器**：canvas 像素画板（画笔/橡皮/油漆桶/吸管/对称/撤销、经典·纤细打底），存成 PNG 进皮肤库 |
| [skin.js](skin.js) | **离线皮肤**：PNG 校验/去重入库（kind=skin/cape）、经典/纤细模型、写入 `LocalSkin/skins` 与 `LocalSkin/capes`+`elytras`、改 CSL 配置里的 LocalSkin.model、安装 CSL 模组 |
| [instances.js](instances.js) | 实例持久化；mkdir + 原子写 + 三级目录回退 + `VISKLUKE_DATA_DIR` 覆盖 |
| [store.js](store.js) | 下载中心：Mojang 版本清单 + Modrinth 搜索/安装（mod/resourcepack/shader/modpack） |
| [server.js](server.js) | 一键开服：下载校验、eula、properties、**白名单**、Fabric 安装、spawn、日志流、域名编排 |
| [cloudflare.js](cloudflare.js) | Cloudflare API：A/CNAME + SRV 增删、Zone 自动识别、`BUILTIN_ZONES` 常量、**Worker 代理通道**、**自定义域名绑定（addZone/removeZone/transportFor）** |
| [relay.js](relay.js) | **自建中继客户端**：主机隧道（一条 WS 多路复用 + TCP 桥接）、玩家本地代理（127.0.0.1:25566）、
 房间号校验、帧编解码；中继服务端见 `worker/cloudflare-relay-worker.mjs`（Durable Object） |
| [scripts/test-relay.js](scripts/test-relay.js) | 自检用本地中继（同一套协议），让中继链路能端到端测 |
| [netcheck.js](netcheck.js) | **可达性探测**：probeTcp / reachability（局域网 / 公网回环 / Worker 外部视角）+ **联机可达性诊断**：公网 IP / 路由器 WAN / 原生 IPv6（过滤 Teredo、6to4）/
 虚拟网卡与 Radmin·ZeroTier 识别，UPnP 自动端口映射，给新手的人话结论 |
| [worker/](worker/) | Worker 代理：`cloudflare-dns-worker.mjs` + 部署说明。Token 只在这里，客户端只发 prefix/suffix/port |
| [renderer/](renderer/) | 极简白 UI：多级侧栏（游戏/下载/服务器）、下载页双栏（任务+下载日志）、右键菜单、整合包安装流程、皮肤弹窗 |
| [scripts/launch.js](scripts/launch.js) | 启动器包装：沙箱崩溃检测 `0x80000003` + 粘性降级 |
| [scripts/selftest.js](scripts/selftest.js) | 自检套件（改代码后必须跑） |
| [scripts/screenshots.js](scripts/screenshots.js) | 截图工具：拉起真实应用 + CDP 点击各页面 + `Page.captureScreenshot` |
| [docs/screenshots/](docs/screenshots/) | 当前 UI 截图（改动 UI 后 `npm run screenshots` 重截） |
| [.preview/screenshot-data/](.preview/) | 截实例页/皮肤页用的示例数据（`VISKLUKE_DATA_DIR` 指过去即可复现），已被 electron-builder 排除 |

## 5. 已经解决的坑（别重复踩）

1. **`npm start` 无输出闪退**：先是 `ELECTRON_RUN_AS_NODE` 被继承，后是 Chromium 沙箱
   STATUS_BREAKPOINT（`0x80000003`）。修法：`scripts/launch.js` 检测后加 `--no-sandbox` 重试并落标记。
2. **实例列表不在你以为的地方**：`instances.js` 的候选目录第 1 个是
   `<app.getAppPath() 的上级>\data`，也就是 `C:\Users\Ystar\data`（不是项目里的 `data/`）。
   现有实例列表就在那儿，**改候选顺序等于丢数据**，要动请先做迁移。
3. **Electron 进程写不进 userData（EPERM）**：普通进程能写、electron.exe 写不了（安全软件隔离）。
   修法：启动时写探针，不可写就 `app.setPath('userData', %USERPROFILE%\Viskluke\data)`。
   注意：两个都 EPERM 时应用仍能跑，只是日志落到项目根目录。
4. **实例"死循环"**：`instances.js` 写盘失败没有提示 → 列表永远空 → 用户反复点创建。
   修法：mkdir + 原子写 + 显式错误；创建后自动跳到游戏页并锁定实例；同版本已有实例时按钮变「打开」。
5. **下载资源 EMFILE**：MCLC 并发句柄耗尽。修法：`launcher.js` 捕获后自动重试（已下文件会跳过）。
   `modpack.js` 里同理——下载并发固定 2、单文件最多重试 3 次。
6. **CF 连不上**：Token 必须带 `Zone:Read` 才能自动识别 Zone；否则用 `BUILTIN_ZONES` 写死 Zone ID。
7. **26.x 需要 Java 25**：本机只有 17，选 1.20.4 及以下。
8. **stderr 被关掉会弹"启动失败"**：终端关闭 / `| head` 之类让管道 EPIPE，main.js 写日志时触发的
   `EPIPE` 会被当成 uncaughtException 弹框。修法：`process.stderr.on('error', ...)` 静默 +
   uncaughtException 跳过 `EPIPE / EPROTO / ERR_STREAM_DESTROYED`。
9. **MCLC 只认官方版本号**：整合包用的是加载器版本，必须自己造 `versions/<id>/<id>.json`
   （原版 JSON + 加载器 profile 拍平），再用 `version: { number: id, custom: id }` 启动。
   id 必须以 Minecraft 版本打头（如 `1.20.4-fabric-0.16.5`）——MCLC 内部用
   `id.split('.')[1]` 推断大版本，决定要不要解 natives / 加 log4j 参数。
10. **截图别用外部截屏工具**：`scripts/screenshots.js` 走 CDP。两个注意点：
    子进程必须 `stdio:'ignore'`（沙箱里管道 stdio 会 EPERM）；窗口被外部关掉时 CDP 连接会断，
    必须让挂起的 RPC 报错，否则 node 事件循环空掉会"静默成功退出"。
11. **CSL 本地皮肤的真实规则（2026-10 从 15.1 的 jar 里反查出来的，别再猜）**：
    · 路径是 `<游戏目录>/CustomSkinLoader/LocalSkin/skins/<玩家名>.png`（另有 capes/、elytras/）
    · `LocalSkin` 是内置 profile，默认 `model = "auto"`，也就是**不写配置就是经典模型**
    · CSL 只认 `default` / `slim` / `auto` 三个值；要纤细必须改
      `CustomSkinLoader/CustomSkinLoader.json` 的 `loadlist` 里 LocalSkin 项的 `model`
    · 配置还没生成时（CSL 没跑过），退而写 `ExtraList/viskluke-skin.json`（尽力而为，可能被去重忽略）
    · Modrinth 项目 id `idMHQ4n2`，官方只发一个 Universal jar（跨加载器通用）
12. **记事本会给 JSON 加 BOM**：手改过的 `CustomSkinLoader.json` 直接 `JSON.parse` 会抛错，
    于是模型设置静默失效。修法：所有配置读取统一 `replace(/^\uFEFF/, '')`（见 `skin.js` 的 `parseJsonFile`）。
13. **状态查询别顺手建目录**：`launcher.resolveGameRoot()` 会 mkdir + 写探针，目录不可写时直接抛
    EPERM，把整个面板带崩（皮肤面板就踩过）。只读场景用 `launcher.peekGameRoot()` / `skin._internal.peekCslDirFor()`。
14. **客户端里绝对不能有 Cloudflare Token**：客户端能被解包，Token 进去 = 公开这几个域名的 DNS 写权限
    （改解析、删记录、劫持子域）。正确做法是 [worker/](worker/) 的代理：Token 在 Worker Secret，
    客户端只发 `前缀/后缀/端口`，公网 IP 由 Worker 从 `CF-Connecting-IP` 取。
    需要 Token 的只有本机自用场景，放 `%APPDATA%\viskluke-launcher\config.json`，**不进仓库**。
15. **白名单的 UUID 必须对**：离线模式用 `auth.offlineUuid()` 推导；正版模式必须查 Mojang 拿真实 UUID，
    查不到就**不要写进 whitelist.json**（写了也不匹配，等于没加人），只记一条 warning 让用户走控制台
    `whitelist add`。另外 `whitelist.json` 采用"按名字合并"，手动用控制台加的人不会被冲掉。
16. **`Page.captureScreenshot` 会永久挂住**：界面合成器卡死时 CDP 不回包，截图脚本必须有超时 +
    重试（`scripts/screenshots.js` 已加 12s 超时）；同一个页面开两个 CDP 客户端同时截图也会卡，
    排查时先确认没有残留的截图进程。

17. **域名现状（2026-10-21 已全部迁移，重要）**：三个 `*.eu.cc` 原本在 **GNAME** 注册、DNS 用
    `share-dns`。现已全部托管到 Cloudflare（NS 改为 `harlee.ns.cloudflare.com` / `nick.ns.cloudflare.com`，
    三个 zone 均 active），Zone ID 已写进本机 `config.json` 的 `CF_ZONES` 和 `worker/wrangler.toml`：

    | 后缀 | Zone ID |
    |---|---|
    | stde.eu.cc | 8e87a98984f83b9be9c7fa6347a9d1d6 |
    | yistarline.eu.cc | 5f22c715f88a33f165012ea4aed899d1 |
    | ys2video.eu.cc | 2995bd959870e8454b3a85a057a00c22 |

    实测三个 zone 的 A + SRV 都能写入并删除。`yistarline.eu.cc` 的旧 GitHub Pages 站已迁到
    `yistarline.icu`，eu.cc 上不再需要那 8 条记录（当前是 0 条）。
    · 域名仍不在 Cloudflare 的，用服务器页「管理域名 → 登记手动解析」，启动器会算好 A/SRV 该填什么。
    · 只是和朋友联机不必用域名：「局域网地址」「公网直连」已经够用。

    ## 6. 待办（按优先级）

### A2. Forge / NeoForge 客户端加载器（已实现，待真机验证启动）
- 做法：`loader.ensureInstaller()` 从官方 maven 下 installer jar（约 6MB）→ 交给 MCLC 的 `options.forge`，
  由 ForgeWrapper 在运行时处理 `inheritsFrom`、模块路径、占位符
- 版本：pack 里没写就用官方推荐表（Forge `promotions_slim.json`）或 NeoForge 的 maven 版本列表
- 已实测（2026-10-21）：Forge 1.20.1 推荐 47.4.10，installer 5.8MB，内含 `version.json`
  （`mainClass=cpw.mods.bootstraplauncher.BootstrapLauncher`，`inheritsFrom=1.20.1`，29 个库），下载/复用都正常
- **待验证**：真机用 Forge 整合包启动一次（ForgeWrapper 会在线补库，第一次慢）


### B2. 皮肤收尾（本轮已完成大头）
- 已做：画布自绘（画笔/橡皮/油漆桶/吸管/左右对称/撤销重做/经典·纤细打底）
- 已做：披风 + 鞘翅（披风写 `LocalSkin/capes`，同时写 `elytras`；清除时三份一起删）
- 还缺：3D 半身预览、皮肤库分组/搜索


### C. UI 收尾
- 下载页「已安装」标记已做（实例记录里的 `installed` 字段），但只是"装过"的标记，不做文件校验
- 仍可优化：任务详情、列表虚拟滚动（上千条 Mod 时）

### D. 开服相关
- 已做：可达性诊断（public / double-nat / cgnat / ipv6 / unknown）、UPnP 一键映射、虚拟网卡与 Teredo 过滤
- 已做：原生 IPv6 → 自动建 AAAA（双栈 A + AAAA）；Worker 侧用 `CF-Connecting-IPv6` 同样支持
- 下一步：**端到端中继**（自建、非第三方）：Worker 用 WebSocket 转发 TCP，启动器内置本地代理，
  玩家 MC 连 `127.0.0.1:25565`。这样纯 IPv4 玩家也能进，且不暴露服务器 IP
- 已做：开服后**外部视角**验证端口（Worker `/probe` 用 `cloudflare:sockets` 连一下，启动器「测一下外面能不能连进来」）
- 白名单批量导入/导出；AuthMe 之类的离线登录插件一键安装

## 7. 硬性约束

- **API Token / 密钥永远不写进代码或配置文件模板**。客户端可被解包，内置 Token 等于公开 DNS 写权限。
- 多用户零配置的正确路线：Cloudflare Worker 代理（Token 放 Worker 环境变量，客户端只传 prefix/suffix/port）。
  本轮已经实现：[worker/cloudflare-dns-worker.mjs](worker/cloudflare-dns-worker.mjs) +
  [worker/README.md](worker/README.md)，客户端侧是 `cloudflare.js` 的 `BUILTIN_PROXY_URL` / `PROXY_URL`。
  部署后把 Worker 地址填进 `BUILTIN_PROXY_URL`（URL 不是密钥，可以提交）即可让所有用户一键开服。
- 正版验证（`online-mode`）默认开启，界面可以手动关，但关的时候会二次确认；有域名时白名单默认开启。
- 改完代码必须 `npm run selftest`；改 UI 后跑 `npm run screenshots` 更新 `docs/screenshots/`。
- 截图用的是 `.preview/screenshot-data` 里的示例数据（`VISKLUKE_DATA_DIR` 指过去即可复现），
  这样截图里有整合包实例和皮肤库；想截真实状态就不设这个变量。

## 7.5 收工状态（2026-10-21 深夜）

- 版本 **1.0.0**，`npm run selftest` **99 通过 / 0 失败**
- 图标已生成（`build/icon.ico` / `icon.png`，`npm run icon` 可重生成）
- **NSIS 安装包已产出**（2026-10-22 凌晨）：`dist\Viskluke-Setup-1.0.0.exe`（78.9 MB，未签名），
  怎么打、踩了哪些坑见第 10 节
- 实机已确认：**游戏能真的启动**（用户机器显卡较弱，性能层面不追）

## 8. 新会话开场提示词（直接复制）

```
项目在 C:\Users\Ystar\viskluke-launcher，先读 docs/HANDOFF.md 和 package.json，
然后用「读文件」的方式了解 main.js、launcher.js、store.js、renderer/renderer.js 的现状，
再开始改。改完必须 npm run selftest。
```


## 9. 新会话接续点（2026-10-21 深夜，中继部署到一半）

**已完成**
- 自检 **99 项全绿**，版本 **1.0.0**，新增依赖 `ws`
- 中继 Worker 已部署：`npx wrangler deploy -c worker/wrangler-relay.toml` → `viskluke-relay`
  - Durable Object 绑定正常：`env.RELAY_ROOMS (RelayRoom)`
  - 自定义域已绑：**`relay.stde.eu.cc`**（wrangler 打印 `(custom domain)`）
- `https://viskluke-relay.ystar366.workers.dev` **国内连不上**（workers.dev 被墙，已放弃这条路）

**卡点 / 下一步**
1. `relay.stde.eu.cc` 公网仍 **NXDOMAIN**；Cloudflare API 报
   `A DNS record managed by Workers already exists on that host`（记录已建，等生效/浏览器负缓存）
2. 先跑 `ipconfig /flushdns`，再验 `https://relay.stde.eu.cc/health` → 期望 `{"ok":true,"service":"viskluke-relay"}`
3. 若 5 分钟后仍 NXDOMAIN：把 `worker/wrangler-relay.toml` 的 `[[routes]] custom_domain` 改成
   `pattern = "relay.stde.eu.cc/*" + zone_name = "stde.eu.cc"`（或换 `yistarline.eu.cc` zone）重挂
4. 通了之后：用真实 Worker 跑端到端（假 MC ↔ 隧道 ↔ CF ↔ 玩家代理），再把 `wss://relay.stde.eu.cc`
   写成启动器默认中继地址（`config.json` 的 `RELAY_URL`，`cloudflare.status()` 里读）
5. 最后打包：`docs/NEXT.md`（要管理员权限，winCodeSign 的 darwin 软链接需要特权）

**Token 注意**：`%APPDATA%\viskluke-launcher\config.json` 里那个 token 认证失败（Code 9106），
可用的是之前截图里出现过的那个（**需要轮换**）。DNS 操作用它、Workers Routes 权限不足。


### 9.1 中继首次真实测试结果（已修好，2026-10-22）

- ✅ `https://relay.stde.eu.cc/health` 返回 `{"ok":true,"service":"viskluke-relay"}`（自定义域已生效）
- ✅ 真实 Cloudflare 上：**隧道建立成功**、**OPEN 帧到达主机**（日志 `玩家接入（流 #1）`）
- ✅ 错误口令被正确拒绝（拿到的数据为空）
- ❌ 当时的判断（「玩家侧 ws 还没 open 就发数据，最早字节丢了」）**只对了一半**，真正的原因见第 10 节：
  Worker 把 Cloudflare 传来的 `ArrayBuffer` 当成可下标数组，`buffer[0]` 恒为 `undefined`，
  于是「主机 → 玩家」方向的 DATA 帧全部被静默丢掉（OPEN 走另一条路径，所以现象是"连上了但没数据"）
- 现在 `npm run test:relay` 全绿（小包 / 256KB / 两玩家并发 / 口令错误 403 / 无主机 409）；
  玩家侧也补了握手期间的数据排队（`relay.js` 的 `pending` 队列），早到的字节不会再丢

### 9.2 新会话开场提示词（第 9 节已闭环，改用第 10 节的提示词）

```
项目在 C:\Users\Ystar\viskluke-launcher。先读 docs/HANDOFF.md（重点第 10 节）和 package.json，
再读 main.js / launcher.js / store.js / renderer/renderer.js 了解现状，然后开始干活。
改完必须 npm run selftest；动中继协议还要 npm run test:relay；动 UI 跑 npm run screenshots；
打包用 npm run package（要完整权限，受限沙箱里 electron-builder 的 spawn 会被 EPERM）。
用中文回复。
```

## 10. 2026-10-22 凌晨：中继修好 + 安装包产出（本轮结果）

**一句话：第 9 节的中继问题已闭环，NSIS 安装包打出来了，自检 99 项全绿。**

### 10.1 中继：真正的原因在 Worker，不在客户端

现象：真实 Cloudflare 上隧道通了、OPEN 到了主机、主机也把 MC 的字节推回中继，
但玩家侧一个字节都收不到（`TIMEOUT 收到 0/4116 字节`）。

根因（[worker/cloudflare-relay-worker.mjs](worker/cloudflare-relay-worker.mjs)）：
Cloudflare 的二进制 WS 消息 `event.data` 是 **ArrayBuffer**，而代码写的是

```js
const type = buffer[0];                       // ← ArrayBuffer 没有索引访问，恒为 undefined
```

于是 `onHostMessage` 两条分支（DATA / CLOSE）都不成立，host→guest 的数据被静默丢弃；
而 OPEN 走的是 `sendToHost(frame(...))` 另一条路径，guest→host 走 guest 自己的 message 监听，
所以「连得上、能认证、就是没数据」。**本地中继用的是 Node Buffer，能下标访问，所以自检永远是绿的。**

修法：统一用 `toBytes()` 把 ArrayBuffer/ArrayBufferView/string 转成 `Uint8Array`，
再取 `bytes[0]`、用 `new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)`。

客户端侧还补了一个真实存在的问题（HANDOFF 原判断的那一半）：
`startGuestProxy` 里 WSS 握手要 200~300ms，玩家在这之前发来的字节会被丢掉。
现在 `client.on('data')` 从连接第一毫秒就挂上，ws 没 OPEN 就先攒进 `pending` 队列，open 后按顺序补发
（上限 4MB，超了直接断开，不会无限积压）。`VISKLUKE_RELAY_DEBUG=1` 时会把每个帧打到 stderr。

验证：`npm run test:relay`（默认打 `wss://relay.stde.eu.cc`）全绿 —— 小包、256KB 大包、
两个玩家并发、错误口令 403、无主机 409。

### 10.2 部署 Worker 不再依赖 wrangler

这台机器的沙箱里 `wrangler` 的 esbuild 要 spawn 子进程 + 管道 stdio，直接 EPERM；
就算不受限，`%LOCALAPPDATA%\npm-cache` 也常被安全软件拦。

所以新增 [scripts/deploy-worker.js](scripts/deploy-worker.js)：直接调 Cloudflare REST API
（`PUT /accounts/<id>/workers/scripts/viskluke-relay`，multipart 上传 metadata + 模块），
凭据按顺序取 `CLOUDFLARE_API_TOKEN` → wrangler 的 OAuth 登录态
（`%APPDATA%\xdg.config\.wrangler\config\default.toml`），账号 ID 能从 `/memberships` 自动发现。

```cmd
npm run deploy:worker              :: 直接部署 + 探一次 /health
node scripts/deploy-worker.js --dry-run
```

### 10.3 默认中继地址

`cloudflare.js` 的 `BUILTIN_RELAY_URL = 'wss://relay.stde.eu.cc'`，`cloudflare.status().relayUrl`
把它带给 UI（服务器页「内网穿透」的地址框留空就是它），`relay:host-start` / `relay:guest-start`
在 payload 没填时回落到 `cfg.relayUrl`。config.json 的 `RELAY_URL` 可以覆盖（想换自己的中继）。

### 10.4 安装包：`dist\Viskluke-Setup-1.0.0.exe`（Inno Setup 6，per-user 安装）

```cmd
npm run package       :: 先 electron-builder --dir，再用 Inno Setup 打安装包
npm run package:dir   :: 只出免安装目录
```

**为什么弃用 electron-builder 的 NSIS**（重要）：本机用 NSIS 3.0.4.1 生成的安装包
**启动即崩**，事件日志固定是
`Faulting application Viskluke-Setup-1.0.0.exe / Faulting module System.dll / Exception 0xc0000005`，
运行直接退出、连安装界面都不出。排查结论：
- 去掉 `build/installer.nsh`（自定义 include）后一样崩 → 不是我们的脚本；
- 用 `makensis` 单独编一个最简安装包 + `System::Call` 不崩 → 插件本身在这台机器可用；
- 换 Inno Setup 6 后一次通过 → 直接换引擎，不再纠缠 NSIS 版本/插件兼容。

所以现在 `npm run package` 的流程是：
1. `electron-builder --dir` 产出 `dist\win-unpacked`（含 rcedit 改好图标/版本号的 exe）；
2. [build/viskluke.iss](build/viskluke.iss) 用 Inno Setup 6 打成
   `dist\Viskluke-Setup-<版本>.exe`（`PrivilegesRequired=lowest`，装到
   `%LOCALAPPDATA%\Programs\Viskluke`，不需要管理员权限）。

`scripts/package-win.js` 顺手处理的四个坑（文件头有注释）：
1. `ELECTRON_CACHE` / `ELECTRON_BUILDER_CACHE` 指到项目内 `.preview\cache`
   （默认的 `%LOCALAPPDATA%` 会被安全软件拒绝写入）
2. `winCodeSign-2.6.0.7z` 里有两个 darwin 符号链接（`libcrypto.dylib` / `libssl.dylib`），
   Windows 普通权限创建符号链接会失败 → 7za 整包报错 → electron-builder 反复重试后
   报 `cannot execute cause=exit status 2`。解法：app-builder 的缓存路径是
   `<cache>\winCodeSign\winCodeSign-2.6.0`，用 `7za x -x!darwin\*` 解压后放进去，
   缓存命中就不再下载/解压。
3. 没有代码签名证书：`CSC_IDENTITY_AUTO_DISCOVERY=false`，签名自动跳过（首次运行 SmartScreen 会提示）。
4. 镜像走 npmmirror，并把 `TEMP`/`TMP` 固定到 `.preview\cache\tmp`。

**快捷方式带 `--no-sandbox`**：本机 Chromium 沙箱初始化会 STATUS_BREAKPOINT（坑 1），
而这个崩溃发生在任何 JS 之前，应用自己救不了自己；安装版没有 `scripts/launch.js` 这层包装，
所以 [build/viskluke.iss](build/viskluke.iss) 的 `[Icons]` 与 `[Run]` 都加了 `--no-sandbox`。
想恢复带沙箱启动：右键快捷方式 → 属性 → 目标，删掉最后的 `--no-sandbox`。

产物验证：
- `dist\win-unpacked\Viskluke.exe` 版本信息 = `ProductName=Viskluke` / `CompanyName=Viskluke` / `FileVersion=1.0.0`
- 安装包未签名（约 85 MB），Inno 支持 `/VERYSILENT` 静默安装/卸载，便于回归测试
- 另有 `dist\Viskluke-1.0.0-portable.zip`（解压即用，里面带
  `启动 Viskluke.cmd` —— 它清掉 `ELECTRON_RUN_AS_NODE` 再 `--no-sandbox` 启动，
  适合不想安装 / 安装器被安全软件拦的场景）

⚠️ **安装器没法在 DSH 会话里做非交互验证**：Inno 安装包从本会话启动会立刻退出
（没有日志、没有进程、没有崩溃事件），从普通 cmd/Explorer 双击才是真实场景。
所以本轮只验证到「安装包成功产出 + 免安装目录里的 exe 能起窗口」；
双击安装这一步要在桌面上人工确认一次（装完桌面/开始菜单快捷方式已带 `--no-sandbox`）。

⚠️ **打包必须在完整权限下跑**：electron-builder 要 spawn `app-builder.exe` / `7za`
并捕获输出，DSH 的受限沙箱会以 `spawn EPERM` 拒绝。

### 10.5 其他改动

- `scripts/test-relay-live.js`：失败路径以前会让进程挂着不退出（回声服务器没关），
  现在失败后 200ms 强制退出，CI/手工跑都不会卡住
- `package.json`：新增 `author`（修掉 CompanyName 是 `GitHub, Inc.` 的问题）、
  `license: MIT`、`deploy:worker` / `package` / `package:dir` 脚本
- 开源准备：[LICENSE](LICENSE)（MIT）、[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)
  （Electron / MCLC / adm-zip / axios / ws 全是 MIT，附版权行）、`.gitignore`
  （`config.json`、日志、`dist/`、`.preview/`、`.selftest-data/`、`worker/.wrangler/`），
  README 第 12 节写了「非官方项目，与 Mojang / Microsoft 无关」
- `README.md`：中继章节重写（内置地址、`npm run test:relay`、ArrayBuffer 那个坑），
  命令表补 `package` / `deploy:worker`，已知限制更新（UPnP、中继、披风都已实现）
- [instances.js](instances.js)：写盘优先级改成
  「**已有 instances.json 原地复用** → `%USERPROFILE%\Viskluke\data` → userData →
  程序目录\data → 旧位置 `%USERPROFILE%\data` → 临时目录」，并让"读"优先看旧位置。
  原因：开发版的数据在 `C:\Users\<用户>\data`（appPath 的上级），
  装成安装版后 appPath 变成 `...\resources\app.asar`，按老逻辑会去写
  `...\resources\data`，于是"界面读到旧列表、保存写到新目录"，看起来就是实例全没了。
  ⚠️ 例外：`VISKLUKE_DATA_DIR` 一旦设置就是**绝对优先**（直接返回，不做任何"找已有文件"的探测）。
  这一条是自检抓出来的：一开始没加例外，自检里皮肤用例读到了真实的
  `C:\Users\Ystar\data\skins`，去重用例直接红了两条。
- [main.js](main.js)：userData 备用目录从 1 个变成 3 个
  （`%USERPROFILE%\Viskluke\data` → exe 同级 `data` → 临时目录），
  安全软件连用户目录也拦的时候至少日志/配置还能落盘

### 10.6 测试 Electron 应用时的两个环境坑（DSH 会话里）

1. **`ELECTRON_RUN_AS_NODE=1` 会被继承**（坑 1 的变种）：此时 `Viskluke.exe --enable-logging`
   会报 `bad option: --enable-logging`（Node 的口吻），双击/无参数则直接静默退出。
   测之前先 `Remove-Item Env:\ELECTRON_RUN_AS_NODE`（CMD 是 `set ELECTRON_RUN_AS_NODE=`，
   注意 cmd 里必须用 `set VAR=` 而不是 `set VAR=""`，后者是"设为空字符串"，Electron 仍当成已设置）。
2. **DSH 的子进程里 Electron 写 `%APPDATA%` 会 EPERM**（普通 node 进程能写，只有 electron.exe 被拦）。
   这是机器上的安全软件隔离，不是代码问题；用 Explorer 双击启动就正常。
   应用本身有三级兜底（userData → `%USERPROFILE%\Viskluke\data` → exe 同级 data → 临时目录）。

### 10.7 还没做 / 下一轮

1. **安装包冒烟**：双击 `dist\Viskluke-Setup-1.0.0.exe` 装一次，确认桌面/开始菜单图标、
   双击快捷方式能起窗口、卸载干净。**本轮只验证到产物产出 + 免安装 exe 能起窗口** ——
   安装器从 DSH 会话里启动会立刻退出（无日志/无进程/无崩溃事件），从 Explorer 双击才是真实场景；
   实在装不上就先用 `dist\Viskluke-1.0.0-portable.zip`（解压 → 双击 `启动 Viskluke.cmd`）
2. **Forge / NeoForge 真机**：用一个真实 Forge 整合包启动一次（installer 下载/版本拍平都有自检覆盖）
3. 皮肤：3D 半身预览、皮肤库分组/搜索
4. UI：下载任务详情、上千条 Mod 时的列表虚拟滚动
5. 开服：白名单批量导入/导出、AuthMe 之类离线登录插件一键安装
6. 🔴 **轮换 Cloudflare Token**（旧 token 在截图/日志里明文出现过，且 `%APPDATA%` 里那个已经 9106 失效）
7. `docs/screenshots/` 这轮 UI 没动，不用重截；下次动 UI 记得 `npm run screenshots`
8. `.preview\cache` 已经 140MB（Electron zip + winCodeSign + NSIS），已在打包排除列表里；
   想清就删，下次打包会重新下载
9. 若以后想回到 NSIS：先解决本机 `System.dll 0xc0000005` 崩溃（换新 NSIS 版本 / 换个打包机），
   再删掉 `npm run package` 里的 Inno 步骤即可

## 11. 2026-10-22 功能更新（下载源 / Java / 浏览器 / 可改界面 / 正版登录）

用户提的六件事，这一轮全部落地了，文件对应关系：

| 功能 | 新文件 / 改动 | 行为 |
|---|---|---|
| **下载源可切换** | 新增 [settings.js](settings.js)、[mirror.js](mirror.js)；改 [store.js](store.js) / [loader.js](loader.js) / [launcher.js](launcher.js) | 设置页选 官方 / BMCLAPI / 自定义；非官方源时把版本 JSON 里的地址改写到镜像，MCLC 走 `overrides.url`（meta/resource/maven）；下载页「刷新」带 `force` 绕过 10 分钟缓存 |
| **Java 免手动配置** | 新增 [java.js](java.js)；[launcher.js](launcher.js) 启动前调用 | 检测顺序：实例路径 → 设置路径 → 启动器下载过的 JRE → `JAVA_HOME` → `PATH` → 常见目录；缺失时从 Adoptium 下载 Temurin JRE（8/17/21/25，按 MC 版本推）到 `<userData>/java/temurin-<major>`，解压用 adm-zip |
| **正版登录** | [auth.js](auth.js) 改用 `settings.msaClientId` | 设备码流程原本就写好了，但 `client_id` 是 `YOUR_AZURE_CLIENT_ID` 占位符，等于不可用。现在从 settings/环境变量读；设置页可填；未配置时登录弹窗提示并跳设置。README 3.2 有 Azure 注册 3 步 |
| **可编辑前端** | [main.js](main.js) 的 `ensureUiDir()` | 首次启动把 `renderer/` 复制到 `<userData>/ui`，之后加载这份；打包后改 `ui/index.html`、`ui/style.css` 即可换主题。设置页有「打开界面目录 / 恢复默认界面」；`VISKLUKE_UI_DIR` 可覆盖 |
| **内置浏览器** | [main.js](main.js) webview 管控 + 下载；[renderer/index.html](renderer/index.html) 新页面；[renderer.js](renderer.js) 标签页逻辑 | `<webview>` 用独立分区 `persist:viskluke-browser`；主进程 `will-attach-webview` 强制去 preload / 沙箱 / 只允许 http(s)；下载落到 `<userData>/downloads`，完成后弹窗导入实例（mods / resourcepacks / shaderpacks / modpacks） |
| **首页美化 + 窗口** | [renderer/index.html](renderer/index.html) + [style.css](renderer/style.css) | 加 Hero 卡片（四个快捷入口）；窗口 1180×780 → **1080×720**，最小 940×600；窄屏侧栏 208px |

### 11.1 已知取舍 / 下一轮

- **版本号**：这一轮的功能（下载源/Java/浏览器/可改界面/正版登录）是破坏性新增，
  `package.json` 从 1.0.0 → **1.1.0**；安装包会变成 `Viskluke-Setup-1.1.0.exe`。
- **`modpack` 类型的本地导入**只是把文件放进 `modpacks/`，真正的「一键安装本地 .mrpack」还没接
  （现有安装器要 Modrinth 项目 ID）；提示文案已写清楚。
- **Java 自动下载只支持 Windows**（zip）；mac/linux 只检测不下载。
- 内嵌浏览器用 `<webview>`（Electron 里仍可用但官方更推荐 WebContentsView）——
  选它是为了标签页切换最简单；以后要做多窗口/下载管理器再换。
- **界面目录**：优先 `<userData>/ui`；userData 不可写（本机会被安全软件拦）时依次退到
  `exe 同级目录/ui`、`%TEMP%/viskluke-ui`，最后才用内置只读目录。
  设置页显示的路径就是实际生效的那个。
- 自检 99 项全绿；`npm run screenshots` 现在会截 **10 张**（新增 `settings.png`、`browser.png`），
  且会检查渲染层 console.error / 未捕获异常（本轮 0 / 0）。

### 11.2 1.1.1 补丁（用户反馈后）

- **首页去掉推广式 Hero**：不再有「一个窗口玩完整个 Minecraft」+ 四张快捷卡；
  改成纯动效美化：顶部呼吸光（`.stage::before`）、菜单指示条生长、按钮按下反馈、
  列表 hover 抬升、空状态文字依次浮入，并支持 `prefers-reduced-motion`。
- **内置浏览器默认 Bing**：`settings.browserHome = https://www.bing.com`，
  地址栏输入非网址的关键词直接走 `https://www.bing.com/search?q=...`。
- **便携包文件名改 ASCII**：`Start Viskluke.cmd` + `README.txt`。
  原因：adm-zip 写中文文件名时没有 UTF-8 标志位，7za / 资源管理器解压会变乱码，
  用户找不到启动脚本；中文说明改放 README.txt（UTF-8）。
  启动脚本加了「没有 Viskluke.exe 就提示先解压」的检查。
- **`打开界面目录` 兜底**：`shell.openPath` 在受限环境会失败（本机截图里那个
  「Windows 无法访问指定设备、路径或文件」就是它，不是 index.html 坏了——
  界面本身就是从那个目录加载的）。现在失败会改用 `showItemInFolder`，再不行把路径返回给 UI，
  由界面复制到剪贴板并提示。
- 正式版隐藏 Electron 默认菜单栏（File/Edit/View…）。
- 版本 1.1.0 → **1.1.1**。

### 11.3 1.1.2：内置浏览器里「链接点不动」

现象：Bing 搜索结果点了没反应。

原因：Bing（以及很多站点）的结果链接是 `target="_blank"`。`<webview>` 默认**不允许多窗口**，
这种点击会被直接吞掉，既不导航也不报错。之前的 `setWindowOpenHandler` 因为没有
`allowpopups` 属性，根本不会被调用。

修法：
- webview 加 `allowpopups`；
- 主进程的 `setWindowOpenHandler` 把 `http(s)` 的 URL 转成 `browser:open-tab` 事件，
  界面新开标签页（`about:blank` 之类直接忽略），仍然 `action: 'deny'`，不会弹真窗口；
- 顺带 `scripts/screenshots.js` 设置 `VISKLUKE_UI_DIR=<项目>/renderer`，避免开发时
  被 `userData/ui` 的旧副本挡住 UI 改动。

验证：CDP 里真实点击 Bing 的 `target="_blank"` 链接（“图片”），标签页数 1 → 2，
新标签加载 `https://cn.bing.com/images/search?...`，原标签保持不动。
版本 1.1.1 → **1.1.2**。






### 11.4 1.1.3：极简首页 / 主题色 / 自建中继 / 主题导入

- **首页去掉大标题**：`showPage('instances')` 时给 `.stage-head` 加 `hidden`，
  首页只剩实例面板和「启动游戏」；其他页仍保留小标题。
- **主题色**：`--accent: #0f9d8f`（青绿）+ `--accent-soft`，只用在选中项、链接 hover、
  进度条、focus ring、ok 标签；其余保持黑白，整体仍是白底极简。
- **动效**：统一 `cubic-bezier(.22,.8,.24,1)`、180–240ms；页面切换、菜单、卡片、按钮
  过渡一致，并继续尊重 `prefers-reduced-motion`。
- **更多联机方式（重点：CF 额度不够）**：
  - 新增 [scripts/relay-server.js](scripts/relay-server.js)：自建中继，协议与 Worker 版一致，
    `npm run relay:serve` 即可跑，支持房间口令、32 人上限、1MB 帧、403/409 语义。
  - 服务器页新增「联机方式」下拉：Cloudflare 中继 / 自建中继，并给出口径说明与「怎么自建？」链接。
  - 文档：[docs/RELAY-SELFHOST.md](docs/RELAY-SELFHOST.md)（含 Caddy wss 反代示例）。
  - 验证：用 `RELAY_URL=ws://127.0.0.1:25677 npm run test:relay` 跑自建中继，
    小包/256KB/并发/口令 403/无主机 409 全过。
- **UI 主题导入/导出（解决“改不动/打不开目录”）**：
  - 设置页新增：导入主题（zip）/ 导入主题（文件夹）/ 导出当前主题 / 重新加载界面。
  - 主进程：`ui:import`（解压到临时目录、自动下探一层、校验 index.html 或 style.css、
    先备份当前 UI 到 `userData/ui-backups` 保留 3 份、合并覆盖、写 custom 标记、reload）、
    `ui:export`（把当前 UI 打成 zip）、`ui:reload`。
  - 清单 `.viskluke-ui-manifest.json` 增加 `custom` 字段：自定义主题升级时**只补缺失文件**，
    不覆盖用户内容；「恢复默认」才会清掉 custom。
- 版本 1.1.2 → **1.1.3**。


### 11.5 1.1.3 追加：应用菜单栏

按用户要求，在最上面的菜单栏放置了必要选项（不再是空菜单/被隐藏）：

- **文件**：打开日志文件、打开数据目录、打开下载目录、退出
- **编辑**：撤销 / 重做 / 剪切 / 复制 / 粘贴 / 全选（标准 role，输入框里可用）
- **视图**：重新加载界面（Ctrl+R）、开发者工具、实际大小 / 放大 / 缩小、全屏
- **主题**：导入主题（zip / 文件夹）、导出当前主题、重新加载界面、**恢复默认主题…**（带确认框）
- **帮助**：GitHub 仓库、自建中继文档、关于 Viskluke（显示版本 / Electron / 界面目录）

实现：`main.js` 的 `installAppMenu()` + `importUiTheme()` / `exportUiTheme()` / `resetUiTheme()`。
菜单项和设置页按钮共用同一套函数，避免两处逻辑不一致。
启动时在日志里会打印 `[MENU] 应用菜单已创建`。


### 11.6 1.1.3 追加：多语言（简体中文 / English）

- 新增 [renderer/i18n.js](renderer/i18n.js)：以**中文原文为 key** 的翻译层，
  启动时翻译 DOM 文本 / `placeholder` / `title`，并用 `MutationObserver`
  覆盖后续动态生成的节点（下载列表、服务器状态等），不侵入现有 HTML/JS。
- 语言存 `settings.language`（`zh-CN` / `en-US`），同时写一份到
  `localStorage['viskluke.lang']` 供界面启动时读取；切换后自动 reload。
- 设置页新增「界面语言」下拉；主进程菜单栏文案通过 `L()` 查表，
  切换语言时 `installAppMenu()` 重建菜单。
- 覆盖范围：导航、首页、下载页、服务器页、设置页、浏览器、登录/导入弹窗、
  菜单栏、主题相关对话框；**带变量的句子**（如「已导入：xxx」）匹配不到，会回退中文。
- 验证：CDP 探针把 `settings.language` 设为 `en-US` 后，导航显示
  Play / Downloads / Servers / Browser / Settings，按钮为 `Launch game`，
  搜索框 placeholder 为 `Search by name…`；切回 `zh-CN` 恢复中文。


### 11.7 1.2.0：手机遥控 + YiStarLine 账号接入

**手机遥控（Android / 手机浏览器）**

- 新增 `remote.js`：局域网 HTTP 控制台，`/` 是移动端页面，`/api/state` 读状态，
  `/api/action` 执行 launch / server-start / server-stop / relay-start / relay-stop。
- 安全：只监听局域网、必须带 token（`settings.remoteToken`，首次自动生成并持久化）、
  每 IP 每分钟 300 次限流；页面不含账号信息。
- 设置页「手机遥控」：一键开关、显示地址、复制地址；启动器启动时若 `remoteEnabled` 自动恢复。
- 启动游戏由主进程转发 `remote:action` 给渲染层，复用现有启动流程（账号/Java/版本都走原逻辑）。
- 实测：无 token 返回 401；带 token 读到实例状态；`launch` 动作回执 `{ok:true}`。

**YiStarLine 账号（本机 SSO，协议 v1）**

- 新增 `yistar-sso.js`：`/sso/authorize` 打开浏览器 → 本地临时端口接 `/sso/callback`
  → 校验 `state` → `POST /api/v1/ticket/redeem`（带 app_secret）→ 保存 access_token 与用户资料。
- 凭据只写 `<userData>/yistar.json`（已加入 .gitignore）；日志只打 URL，不打密钥。
- 设置页「YiStarLine 账号」：服务地址 / App ID / App Secret / 测试连接（`/api/v1/app/verify`，
  404 时回退 `/api/v1/health`）/ 退出账号。
- 登录弹窗新增 YiStarLine 标签页；成功后用账号昵称映射成合法玩家名（3–16 位字母数字下划线）
  + 离线 UUID 进入启动流程，账号类型显示 `YiStarLine`。
- 说明：兑换接口字段按文档常见命名做了兼容（`access_token|accessToken|token`、
  `user|profile|account`）；若实际返回结构不同，改 `normalize()` 即可。
- 未验证项：本机当前没有 8600 服务，SSO 完整链路（授权/兑换/用户信息）需要用户在本机启动
  YiStarLine Account 并填真实 App Secret 后实测。


### 11.8 1.2.1：YiStarLine 内置应用（应用码）+ 固定回调端口

- **应用码（public_code）**：`YLP-Y6AE-SC5X-JFE3`，内置到 `sso-defaults.json`（构建时由 `config.sso.local.json` 注入，
  该文件被 .gitignore 忽略），**不打包 app_secret**。
- **固定回调端口**：`47830/47831/47832`。原因：Account 的 `match_redirect` 会把白名单里的 `{port}`
  展开成**服务自己的端口**（8600），不是通配；第三方桌面应用必须用白名单里的精确端口。
- **授权参数**：`code=应用码&app_id=...&name=Viskluke&publisher=StarDegree&redirect_uri=...&state=...`。
  本机已登记（managed）时走 app_id；别人机器（未登记）时自动落到「首次使用此应用」确认页，
  用户点「允许」后 `create_imported_app` 登记为 imported。
- **兑换顺序**：先 `{client_id: 应用码, ticket}`（imported 应用免 secret）；
  失败且配置了 app_id/app_secret 时回退 `{app_id, app_secret, ticket}`（开发者本机 managed 应用）。
- **测试连接**：有 secret → `/api/v1/app/verify`；只有应用码 → `/api/v1/apps/lookup?code=`。
- 已验证：`/api/v1/apps/lookup?code=YLP-Y6AE-SC5X-JFE3` 返回 Viskluke / StarDegree / Protect 证书信息。
- 待验证：从「首次授权」到「兑换」的完整交互链路（需要浏览器里登录 YAUA 并点允许）。
