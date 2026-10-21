# Viskluke Launcher

Minecraft 启动器 —— 离线/正版登录、Mod 与整合包一键安装、一键开服 + 自定义域名（Viskluke Address）。

当前版本 **1.0.0** · Electron 33 · Windows 10 / 11

---

## 1. 能干什么

| 模块 | 说明 |
|---|---|
| 登录 | 离线登录（UUID 与 HMCL/PCL 一致）或微软设备码登录 |
| 实例 | 每个实例独立的游戏目录（mods / resourcepacks / shaderpacks / saves），可单独设内存与 Java 路径 |
| 下载中心 | Mojang 版本清单、Modrinth 的 Mod / 资源包 / 光影搜索与安装，装过的会标「已安装」 |
| **整合包** | 点一下自动建实例、下载 `.mrpack`、解包 mods 与 config，再点是续传修复 |
| **加载器** | **Fabric / Quilt**：首次启动生成版本 JSON；**Forge / NeoForge**：自动下载官方 installer，交给 MCLC + ForgeWrapper 启动 |
| **离线皮肤** | 皮肤库导入 PNG、**画布自绘**、**披风/鞘翅**、经典/纤细切换、双击改名，写入 CustomSkinLoader 的 LocalSkin |
| 一键开服 | Paper / Vanilla / Fabric 服务端下载 + eula + properties + 启停 + 控制台 |
| **开服安全** | 正版验证默认开启（可手动关，会二次确认）、白名单（有域名时默认开）、公网暴露提示、局域网地址一键复制 |
| Viskluke Address | Cloudflare 自动建 A/CNAME + SRV，`前缀.后缀` 直接当服务器地址。**推荐用 Worker 代理**（见第 8 节），客户端里不放任何 Token |

## 2. 环境要求

| 项 | 要求 |
|---|---|
| 系统 | Windows 10 2004+ / Windows 11（本项目主要在 Win10 上开发） |
| Node.js | 20 及以上（开发机是 24.19.0） |
| Java | 17（1.20.4 及以下）。26.x 需要 Java 25 |
| 网络 | 能访问 npm（npmmirror）、Mojang、Modrinth |

## 3. 启动方法（三步）

```cmd
cd /d C:\Users\Ystar\viskluke-launcher
npm install
npm start
```

`npm start` 实际执行 `node scripts/launch.js`：它会检测 Chromium 沙箱崩溃（`0x80000003`）并自动加 `--no-sandbox` 重试，之后记住这个选择 —— 所以**尽量不要用 `electron .` 直接起**。

| 命令 | 用途 |
|---|---|
| `npm start` | 正常启动（带沙箱自愈，推荐） |
| `npm run start:safe` | 强制 `--no-sandbox` |
| `npm run start:direct` | 原样 `electron .`，不带兜底 |
| `npm run doctor` | 环境体检：依赖完整性、环境变量、能否真正拉起 Electron |
| `npm run selftest` | 不开窗口跑全部业务逻辑自检（99 项） |
| `npm run test:relay` | 拿真实中继（`wss://relay.stde.eu.cc`）跑端到端：小包 / 256KB / 并发 / 口令错误 / 无主机 |
| `npm run screenshots` | 拉起真实应用并用 CDP 重截 `docs/screenshots/`（8 张） |
| `npm run package` | 打 Windows 安装包 → `dist\Viskluke-Setup-1.0.0.exe`（见第 3.1 节） |
| `npm run deploy:worker` | 用 Cloudflare API 直接部署中继 Worker（不需要 wrangler） |

启动后窗口标题是 **Viskluke**，左侧是「游戏 / 下载 / 服务器」三块，右下角「日志」按钮能直接打开崩溃日志。

### 3.1 打安装包

```cmd
npm run package        :: 安装包 → dist\Viskluke-Setup-1.0.0.exe
npm run package:dir    :: 只出免安装目录 → dist\win-unpacked\Viskluke.exe
```

不想安装也可以直接解压 `dist\Viskluke-1.0.0-portable.zip`，双击里面的
`启动 Viskluke.cmd`（它会带 `--no-sandbox` 启动，原因见本节末尾）。

打包分两步：`electron-builder --dir` 先把应用装进 `dist\win-unpacked`（rcedit 会嵌图标和版本号），
再用 **Inno Setup 6** 的 [build/viskluke.iss](build/viskluke.iss) 打成 per-user 安装包
（装到 `%LOCALAPPDATA%\Programs\Viskluke`，不需要管理员权限）。

> 为什么不用 electron-builder 自带的 NSIS：这台机器上 NSIS 3.0.4.1 生成的安装包**启动即崩**
> （事件日志 `Faulting module System.dll / 0xc0000005`），换自定义 include、换 one-click 都一样；
> Inno Setup 6 一次就过，所以直接换了引擎。细节见 [docs/HANDOFF.md](docs/HANDOFF.md) 第 10.4 节。

`npm run package` 还顺手封装了几个环境坑：缓存全部指到项目内 `.preview\cache`
（`%LOCALAPPDATA%` 常被安全软件拒绝写入）、从 npmmirror 补 `winCodeSign`
（原压缩包里有两个 darwin 符号链接，Windows 普通权限解不开，脚本解压时跳过 `darwin/`）、
跳过代码签名（`CSC_IDENTITY_AUTO_DISCOVERY=false`，没有证书）。

**快捷方式带 `--no-sandbox`**：本机 Chromium 沙箱初始化会 STATUS_BREAKPOINT（见第 9 节第 1 条），
这个崩溃发生在任何 JS 之前，应用自己救不了；所以安装脚本给桌面/开始菜单快捷方式的「目标」加了
`--no-sandbox`。想恢复带沙箱：右键快捷方式 → 属性 → 目标，删掉最后的 `--no-sandbox`。
安装包未签名，首次运行 SmartScreen 会提示「更多信息 → 仍要运行」。

> ⚠️ electron-builder / ISCC 都要 spawn 子进程（`app-builder.exe` / `7za`），**受限沙箱里会被 EPERM 拦掉**，
> 要在普通终端（完整权限）里跑。

## 4. 第一次用怎么走

1. **登录**：点左上「未登录」→ 离线登录填玩家名（3~16 位字母数字下划线）。
2. **建实例**：`下载 → 游戏版本` → 挑一个版本 → 「创建实例」，会自动跳到游戏页。
3. **启动**：右上「启动游戏」。首次会下载该版本全部文件（几百 MB），下完自动进游戏。
4. **装整合包**：`下载 → 整合包` → 搜索 → 「安装整合包」。会自动建一个独立实例并解包；Fabric/Quilt 的加载器版本在首次启动时生成。
5. **换皮肤**：游戏页选实例 → 「皮肤」→ 三条路任选：
   - 「导入皮肤…」：外面找的 64×64 / 64×32 PNG
   - 「画一张…」：内置画布自己画（画笔/橡皮/油漆桶/吸管、左右对称、经典/纤细打底）
   - 「导入披风…」：64×32 披风 PNG（会同时写入鞘翅）
   然后填玩家名 → 「应用到实例」。第一次要先点「安装 CSL 模组」。
   - 第一次用要先点「安装 CSL 模组」（需要实例带 Fabric/Quilt/Forge 加载器）。
6. **开服（现在只要两步）**：`服务器` 页 → 填 `域名前缀` → 点「一键开服」。
   - **留空前缀** = 纯局域网服务器：页面直接显示「局域网地址」，发给同一个 WiFi 的朋友就能进。
   - **填了前缀** = 公网服务器：自动创建 `前缀.后缀` 的解析（需要先按第 6 节配好域名）。
     这时默认开「正版验证」+「白名单」，白名单会自动填上你登录的账号名（自己先能进）。
   - 核心/版本/内存/端口/后缀/各种开关都收进了「高级设置」，默认值（Paper / 1.20.4 / 2G / 25565）能直接用。
   - 公网还要求路由器把该 TCP 端口映射到本机（或你有公网 IP）。DNS 记录本身不等于可达。

## 5. 普通用户没有 Cloudflare Token 怎么办

**不需要 Token 也能开服。** 三种方式按"别人怎么找到你"分：

| 谁要进来 | 用这条地址 | 需要 Token 吗 | 需要什么 |
|---|---|---|---|
| 同一个 WiFi 的朋友 | 页面上的「**局域网地址**」（点一下复制） | ❌ | 无 |
| 任意网络的熟人 | 页面上的「**公网直连**」`你的公网IP:端口` | ❌ | 路由器把该端口映射到本机（或你有公网 IP） |
| 想要一个好记的域名 `xxx.stde.eu.cc` | 「**创建解析**」 | ✅ 见下一节 | 域名管理员那侧配一次 |

页面第二行那三个标签就是答案：**局域网地址**（绿）、**公网直连**（绿=可直接用，"你在 NAT 后面"=要做端口映射）、
**公网域名**（需要 Token 或 Worker 才亮）。

### 「普通用户」和「域名」的关系

域名解析必须由**域名的持有者**去 Cloudflare 改记录 —— 借你（或某个管理员）的账号，不是借玩家的。
所以现实里只有两种分工：

1. **你部署一次 Worker**（第 6 节），之后每个装了这个启动器的人填前缀就能拿到自己的域名，全程不碰 Token。
   这是唯一能"让普通用户零配置用域名"的方案，Token 只存在你部署的 Worker 里。
2. **每个用户自己申请** Cloudflare（免费）+ 自己的域名 + 自己的 Token —— 适合想自己掌控的情况。

> 一句话：**Token 属于服务器管理员，不属于玩家。** 玩家只需要复制你给的地址。

## 6. 真联机：IPv4 端口映射 / IPv6 直连（不依赖第三方联机工具）

启动器不吃"装个 Radmin 就好"这套，走的是真·公网直连，两条腿：

### A. IPv6 直连（最干净，不用碰路由器）

- 启动器检测**原生公网 IPv6**，自动排除 Teredo（`2001:0:`）和 6to4（`2002:`）这类看不了端口的假地址
- 有 IPv6 时创建解析会**自动建 AAAA 记录**；同时有 IPv4 就再加一条 A，形成**双栈**
- 玩家只要有 IPv6（手机流量基本都有）就能直连；Windows 防火墙仍要放行 Java

### B. IPv4 端口映射（IPv4 玩家的唯一正路）

| 诊断结果 | 做法 |
|---|---|
| 有公网 IPv4（不在 `100.64/10`） | 点「自动映射端口」用 UPnP 映射；路由器不支持就登录路由器加一条 TCP 转发 |
| 两层 NAT（路由器 WAN 是私网） | 光猫上再加同一条映射，或把光猫改成桥接 |
| 运营商大内网（CGNAT） | 自己怎么映射都没用：打客服要公网 IP（电信 10000），或改用 IPv6 |

### 开服后怎么确认"外面真的连进来了"

服务器页有「**测一下外面能不能连进来**」：

- 会依次探测 局域网 IP、公网 IP（回环）、以及**外部视角**（需要部署了 Worker）
- 结论直接给：`公网可达` / `外面连不上（映射没生效或被拦）` / `只有局域网能连` / `服务器没在监听`
- 没有 Worker 时只能本机自测，界面会提示「想要外部视角请部署 Worker」

### C. 内网穿透：自建中继（已上线，零配置）

没有公网 IP、在运营商大内网、又不想碰路由器时的终极方案。中继是我们自己的 Cloudflare Worker
（Durable Object），流量不过任何第三方联机工具：

```
玩家 MC ─TCP─▶ 启动器本地代理 ─WSS─▶ relay.stde.eu.cc ─WSS─▶ 主机启动器 ─TCP─▶ 本机 MC 服务器
```

用法（两边都只用启动器，不用改任何配置）：

1. 主机：服务器页「内网穿透」→ 房间号留空会自动生成一个（建议再填「房间口令」）→「开隧道」
2. 玩家：填**同一个房间号 + 口令** →「我是玩家，加入房间」
3. 玩家在 MC 里连 `127.0.0.1:25566` 就能进

**默认中继地址 `wss://relay.stde.eu.cc` 已经编译进客户端**，地址框留空就是它。
想换成自己部署的中继（或想完全自己掌控），改一下地址框即可，部署见 [worker/README.md](worker/README.md)：

```cmd
npm run deploy:worker   :: 用 Cloudflare API 直接部署（不需要 wrangler）
```

加固项：**房间口令**（6~64 位字母数字，第一个连上的人设定，之后必须一致，不一致直接 1008 拒绝）、
**人数上限 32**、**单帧上限 1MB**、主机侧 TCP 出错自动清流。

已验证（2026-10-22，真实 Cloudflare + 真机）：小包往返、256KB 大包往返、两个玩家并发、
口令错误被 403 拒绝、房间里没有主机时被 409 拒绝，`npm run test:relay` 全绿。

> 注意：早期版本有个 bug —— Worker 把 Cloudflare 传来的 `ArrayBuffer` 当成可下标数组用，
> `buffer[0]` 永远是 `undefined`，导致「主机 → 玩家」方向的数据被静默丢掉（OPEN 走另一条路径，
> 所以现象是「连上了但服务器没反应」）。已修正，并给玩家侧补了握手期间的数据排队。

> Radmin VPN / ZeroTier / Tailscale 这类工具启动器会**识别出来并提示**，但只当兜底，不推荐。

## 7. Viskluke Address 怎么开（二选一）

| 方式 | 需要什么 | 适合谁 |
|---|---|---|
| **直连 Token** | 自己的 Cloudflare Token（DNS 编辑 + Zone 读取） | 自己用，最省事 |
| **Worker 代理** | 你部署一次 Worker，客户端填 URL | 想"每个人都一键开服"：用户完全不用 Token |

### 直连 Token 的最快路径（自己用，30 秒配好）

1. Cloudflare 控制台 → My Profile → API Tokens → Create Token，权限勾**两条**：
   `Zone → DNS → Edit` **和** `Zone → Zone → Read`；Zone Resources 选你那三个域名。
2. 服务器页 →「设置公网域名」→ 粘贴 →「连接」→ 三个后缀前面都变成 ✓。
3. 以后只要填前缀 →「一键开服」。

> **如果只给了 DNS 权限会怎样？** Token 是有效的，但 Cloudflare 不允许它列出域名，所以启动器读不到
> Zone ID（实测：`/user/tokens/verify` = active，`/zones` = 0 条），界面会显示「Token 已保存，但没有识别到 Zone」。
> 修法二选一：
> ① 点界面上的「改 Token 权限」→ 给现有 Token 加一条 `Zone → Zone → Read`（30 秒，不用重建）；
> ② 或者把三个域名的 Zone ID 填进 `config.json` 的 `CF_ZONES`（Zone ID 不是密钥，在域名概览页右下角）。
> 注意：光有 `Zone → DNS → Edit` 是**不够**的 —— Cloudflare 的接口必须在 URL 里带 Zone ID。

### 绑定自己的域名（内置三个之外）

内置的后缀是 `stde.eu.cc` / `yistarline.eu.cc` / `ys2video.eu.cc`。想用**自己的域名**：

1. 域名先托管到 Cloudflare（NS 指过去，状态 Active）；
2. 服务器页 →「设置公网域名」→ 连接 Token（要 `Zone → DNS → Edit`；想让它自动查 Zone ID 再加 `Zone → Zone → Read`）；
3. 点「管理域名」→ 输入 `mydomain.com` → Zone ID 可留空（有 Zone:Read 会自动查，没有就填上）→「添加」；
4. 后缀下拉里就会多出 `mydomain.com`，填个前缀 →「一键开服」，得到 `前缀.mydomain.com`。

- 绑定信息存在本机 `config.json` 的 `CF_ZONES` 里；解绑只删本机绑定，不动 Cloudflare 上的记录。
- **自己的域名必须走直连 Token**：Worker 代理只持有内置那三个域名，别人的域名它管不了。
- 绑定后如果提示"写不了这个域名的记录"，是 Token 的 Zone Resources 没包含它 —— Cloudflare 里把它加进这个 Token 的授权范围即可。

### Worker 代理（给别人用 / 自己不想折腾 Token）

Token 只放 Worker 的 Secret，客户端只发 `前缀/后缀/端口`，公网 IP 由 Worker 从
`CF-Connecting-IP` 直接取（连"我的 IP 是多少"都不用客户端查）。部署 3 分钟，步骤和接口约定见
[worker/README.md](worker/README.md)。

填进启动器：

```jsonc
// %APPDATA%\viskluke-launcher\config.json
{ "PROXY_URL": "https://viskluke-dns.<你的子域>.workers.dev" }
```

或者改 [cloudflare.js](cloudflare.js) 里的 `BUILTIN_PROXY_URL` 常量（那是 URL 不是密钥，可以随客户端分发）。

> ⚠️ **绝对不要把 Cloudflare API Token 写进客户端代码或提交进仓库。** 客户端能被解包，
> Token 一旦进去就等于把域名的 DNS 写权限公开；需要 Token 的场景一律走 Worker。
> 如果 Token 曾经出现在聊天记录/截图/日志里，去 Cloudflare 后台吊销重建。

## 8. 数据放在哪

| 内容 | 路径 |
|---|---|
| 实例列表 | `%APPDATA%\viskluke-launcher\instances.json`；不可写时 `C:\Users\Ystar\data\instances.json` |
| 皮肤库 | 与 `instances.json` 同目录的 `skins\` |
| 游戏目录 | `C:\Users\Ystar\Viskluke\instances\<实例ID>` |
| 本地皮肤 | `<游戏目录>\CustomSkinLoader\LocalSkin\skins\<玩家名>.png` |
| 服务端目录 | `%APPDATA%\viskluke-launcher\servers\<serverId>`（含 `server.properties`、`whitelist.json`） |
| 崩溃日志 | `%APPDATA%\viskluke-launcher\viskluke_error.log`（不可写时落到项目根目录） |
| Cloudflare 配置 | `%APPDATA%\viskluke-launcher\config.json`（**可能含 Token，不要提交/外发**） |

想换数据目录（便携模式）：设环境变量 `VISKLUKE_DATA_DIR=<目录>`。

## 9. 出问题怎么办

| 现象 | 处理 |
|---|---|
| `npm start` 没反应 / 闪退 | `npm run doctor`；再试 `npm run start:safe` |
| 提示 `ELECTRON_RUN_AS_NODE` | `set ELECTRON_RUN_AS_NODE=`（CMD）后重新启动 |
| 实例创建了却列表为空 / EPERM | 安全软件拦了写入。把项目目录和 `%USERPROFILE%\Viskluke` 加白名单 |
| 下载一堆文件失败 | 多半是 EMFILE 或网络；再点一次「启动游戏」/「安装整合包」会续传 |
| 皮肤不显示 | ① 实例要是加载器实例且装了 CSL；② 文件名必须等于游戏内玩家名；③ 看日志里 `[SKIN]` |
| 自己进不去自己的服务器 | 白名单开了但名单为空 → 「服务器详情 → 白名单玩家」填名字后保存（运行中会立即生效） |
| 正版验证模式下加人不生效 | 查不到 Mojang UUID 的人不会被写进 whitelist.json，日志会提示；用控制台 `whitelist add <名字>` 补 |
| 服务器地址连不上 | 服务器页看解析状态；公网需要端口映射/公网 IP，见第 4 节；Token 需要 `Zone.DNS Edit` |
| Cloudflare 用不了但不想申请 Token | 用 Worker 代理（第 5 节），部署一次即可 |

日志：界面右下角「日志」，或直接看 `viskluke_error.log`。

## 10. 已知限制

- **Forge / NeoForge**：客户端加载器已支持（自动下载官方 installer，约 6MB，需要能访问 maven.minecraftforge.net /
  maven.neoforged.net）。首次启动时 ForgeWrapper 还会在线补一批库，第一次会比较慢；
  打包和版本识别都验证过，但还没用真实的 Forge 整合包在真机上完整启动一次。
- **真机启动游戏**：已实机确认能启动（1.20.4 + Fabric）。开发机显卡弱，性能层面不追。
- **公网可达性**：普通公网直连仍需要端口映射或公网 IP —— 启动器能自动做 UPnP 映射、能诊断
  CGNAT / 两层 NAT / 原生 IPv6，但映射失败时得你自己弄；实在不行就用中继（第 6 节 C），完全不用碰路由器。
- Worker 代理（域名）需要你自己部署一次（免费额度够个人用）；没部署前只能走直连 Token。
  中继（联机穿透）**不用部署**，`wss://relay.stde.eu.cc` 已经内置。
- 皮肤：披风/鞘翅已经接进界面；还没有 3D 半身预览，皮肤库也没做分组/搜索。

## 11. 开发

```cmd
npm run selftest       :: 改完代码必须跑（99 项，含真实 Mojang/Modrinth 请求与本地 HTTP 夹具）
npm run test:relay     :: 改中继协议后跑（走真实 Cloudflare，约 10 秒）
npm run screenshots    :: 改完 UI 跑，覆盖 docs/screenshots/
```

代码结构、踩过的坑、待办清单都在 [docs/HANDOFF.md](docs/HANDOFF.md) —— 新开会话先读它。
Cloudflare Worker 代理的代码和部署说明在 [worker/](worker/)。

本项目是个人自用启动器，不做多用户分发；Cloudflare Token 只存本机，任何情况下都不要把 Token 写进代码或提交进仓库。

## 12. 许可证与声明

- 本仓库代码以 **MIT License** 发布，全文见 [LICENSE](LICENSE)。
- 第三方组件（Electron / minecraft-launcher-core / adm-zip / axios / ws 等，均为 MIT）的版权声明见
  [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)；打包产物里还随包附带 Electron / Chromium 的完整许可证文本。
- **非官方项目**：Viskluke Launcher 与 Mojang Studios、Microsoft 均无关联，也未获其认可或赞助。
  Minecraft 游戏本体、材质、音效、服务端核心的版权归各自所有者，本仓库不包含任何游戏资源，
  均由启动器在运行时从官方源下载；使用需自备正版账号并遵守 Minecraft EULA。
- 「Viskluke」名称与图标仅用于标识本项目；MIT 许可证只授予代码层面的版权许可，不授予商标使用权。
