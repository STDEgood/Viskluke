# Android 版计划（2026-11-15 开工）

## 已确定的路线

**闭源 + 可收费**，不把 PojavLauncher（GPLv3）代码放进闭源 APK。

- 自研启动壳：OpenJDK（GPLv2 + Classpath Exception，JVM 开源、App 可闭源）+ LWJGL 3（BSD）+ GL4ES（MIT）
- 闭源部分：Viskluke 的 UI、账号、下载、设置、商业功能

## 四期

### Phase 1（1–2 周）Android WebView 壳 + 功能移植
- APK 加载现有 `renderer/`，做手机适配（底部导航、触控尺寸、安全区）
- 原生桥：文件读写、下载落盘、解压（zip/mrpack）、剪贴板、打开目录
- 可 100% 搬过去：离线账号、实例管理、版本/Mod/整合包下载、设置、皮肤
- 「启动游戏」在 Runner 未安装时给出明确提示
- 产物：可安装的 `Viskluke-Android-<ver>.apk`（闭源签名）

### Phase 2（3–4 周）Runner POC
- 在 Android 上加载 OpenJDK ARM64，JNI 启动 JVM
- 跑通 Hello World → LWJGL 空窗口
- 证明「闭源 + 自研启动壳」可行

### Phase 3（2–3 月）Runner 可用
- 拉起 Minecraft 1.20+，能进游戏
- 开服复用同一 JVM（服务端 JAR）
- 图形：GL4ES / ANGLE 转译 OpenGL→GLES

### Phase 4（2–4 周）联机 + 产品化
- 原生 TCP 中继/代理（浏览器做不了 raw TCP）
- 账号体系、支付、分发（自建下载页优先）

## 当前状态

| 项 | 状态 |
|---|---|
| PC 端 | 1.2.2 已发布（菜单栏/多语言/主题/自建中继/SSO 内置应用码） |
| Android | 1.0.0 是基于 PojavLauncher 的品牌版，**仅作参考，不进入闭源产品** |
| 仓库 | `STDEgood/Viskluke`，含 `android-pojav/`（构建说明 + branding patch） |
| SSO | 内置应用码 `YLP-Y6AE-SC5X-JFE3`；本机 managed 应用兑换仍需 secret |
| 待定 | Runner 的 JRE 来源（Temurin ARM64）、分发方式、VOML 品牌命名 |

## 需要用户提供

1. YiStarLine 的完整 App Secret（本机测试用）或决定 Android 端不做 SSO
2. 产品命名：继续用 Viskluke，还是 VOML
3. 分发渠道：自建下载页 / Google Play（启动器类目审核更严）

## 明日第一件事

Phase 1：建 Android WebView 工程 → 复用 `renderer/` → 手机适配 → 原生桥（文件/下载）→ 打出第一个可安装 APK。
