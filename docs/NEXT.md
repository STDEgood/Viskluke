# 明天第一件事：把安装包打出来

> **✅ 2026-10-22 已完成**：`dist\Viskluke-Setup-1.0.0.exe`（78.9 MB，未签名）已产出。
> 收尾方式和踩到的新坑（winCodeSign 符号链接、NSIS `!tempfile`）记在
> [docs/HANDOFF.md](HANDOFF.md) 第 10 节；现在一条 `npm run package` 就能重打。
> 下面保留原始排查记录，作为「为什么不能直接 npm run build」的参考。

> 2026-10-21 收工时的状态：**代码全绿（87 项自检通过）、图标已就绪、版本号已到 1.0.0，
> 但 NSIS 安装包还没产出。** 卡点和工作量都在下面，10 分钟能收掉。

## 现在的状态

| 项 | 状态 |
|---|---|
| `npm run selftest` | 87 通过 / 0 失败 |
| `build/icon.ico` + `build/icon.png` | 已生成（深色圆角 + 白色 V，512/256/128…16 多尺寸） |
| `package.json` version | **1.0.0** |
| `package.json` build 段 | 已配好：`directories.output=dist`、`win.icon=build/icon.ico`、NSIS（可选安装目录 + 桌面/开始菜单快捷方式）、`artifactName=Viskluke-Setup-${version}.exe` |
| `main.js` | 窗口已带 `icon`（开发模式任务栏图标也正常） |
| `scripts/make-icon.py` | 改图标只需 `npm run icon`（需要 Python + Pillow） |
| **安装包** | ❌ 未产出 |

## 卡在哪（两次失败的原始原因）

```
⨯ open C:\Users\Ystar\AppData\Local\electron\Cache\158521719.zip.part3: Access is denied.
```

electron-builder 想往 `%LOCALAPPDATA%\electron\Cache` 下载 Electron 的 115MB zip，被系统/安全软件拒绝。
第二次（把 `ELECTRON_CACHE` / `ELECTRON_BUILDER_CACHE` 指到项目内）已经越过了下载，但倒在
`WinPackager.signApp` —— 机器没有代码签名证书/环境拦了签名器。

## 明天按这个顺序试（逐个叠加）

```cmd
cd /d C:\Users\Ystar\viskluke-launcher

:: 1. 缓存指到可写目录（已经验证能越过第一次失败）
set ELECTRON_CACHE=%CD%\.preview\cache\electron
set ELECTRON_BUILDER_CACHE=%CD%\.preview\cache\electron-builder

:: 2. 跳过代码签名（没有证书时必须在的开关）
set CSC_IDENTITY_AUTO_DISCOVERY=false

:: 3. 先出免安装目录（最快验证打包链路）
npm run build:dir

:: 4. 成了再出安装包
npm run build
```

如果还是倒在 `signApp` / `rcedit`：

- 加 `--config.win.signAndEditExecutable=false`（代价：图标不会嵌进 exe，但安装包能出）
- 或以**管理员身份**跑一次（`C:\Users\Ystar\AppData\Local\electron\Cache` 的权限问题多半是安全软件隔离）

产物位置：`dist\Viskluke-Setup-1.0.0.exe`（安装包）和 `dist\win-unpacked\Viskluke.exe`（免安装）。

## 打包成功后的收尾清单

1. 双击安装包 → 装到默认目录 → 桌面图标正常、双击能起窗口
2. `npm run screenshots` 顺手重截（`servers.png` 已经是最新的，其余几张如果 UI 没动可不重截）
3. 把 README 的「版本 0.6.0」改成 1.0.0
4. `worker/wrangler.toml` 里已有三个真实 Zone ID，部署 Worker：
   `npx wrangler login` → `npx wrangler secret put CF_API_TOKEN` → `npx wrangler deploy`
   然后把打印出的 URL 填进 `cloudflare.js` 的 `BUILTIN_PROXY_URL`
5. 🔴 **轮换 Cloudflare Token**（它在两张截图里明文出现过），并删掉旧的 `cfut_HlTk…`

## 还没做（不急，按需）

- **Forge / NeoForge 客户端加载器**：能装能标注，点启动会明确报错（大多数优化整合包是 Fabric，可以先不做）
- **端到端中继**（自建 Worker + 本地代理）：彻底不需要端口映射，纯 IPv4 玩家也能进
- 皮肤：披风 / 鞘翅、3D 预览
- 开服后「从外网视角」验证端口是否真通（Worker 加 `/probe`）
