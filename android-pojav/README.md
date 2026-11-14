# Viskluke for Android（Java 版）

这是 Viskluke 的 Android 端：**完整 Minecraft Java 版**，独立运行，不依赖电脑、不需要遥控。

## 它是怎么来的

Android 上跑 Java 版必须有 JVM + LWJGL/OpenGL 移植层，这部分工作由
[PojavLauncher](https://github.com/PojavLauncherTeam/PojavLauncher)（GPLv3）完成。
本 APK 是在其源码基础上做的 **Viskluke 品牌化构建**：

- 应用名：`Viskluke (Minecraft: Java Edition for Android)` / 短名 `Viskluke`
- 图标：Viskluke 青绿 V 标（全部密度 + 圆形图标）
- 包名：`com.viskluke.android`
- 其余启动、账号、下载、渲染、控制逻辑用上游实现

> 因为基于 GPLv3，分发这个 APK 时必须同时提供对应源码。
> 上游：https://github.com/PojavLauncherTeam/PojavLauncher
> 本地构建用的上游提交：`b12ad04`（版本串 `gladiolus-20261114-b12ad04-v3_openjdk`）

## 构建环境

| 组件 | 版本 |
|---|---|
| JDK | 17（Temurin） |
| Android SDK | platform `android-34`、build-tools `36.0.0` |
| NDK | `r25c`（25.2.9519653） |
| Gradle | 8.13 |

## 构建步骤

```bash
git clone --depth 1 https://github.com/PojavLauncherTeam/PojavLauncher
cd PojavLauncher
# 应用 branding.patch（本目录）
git apply ../android-pojav/branding.patch
# local.properties
echo sdk.dir=C\:\\path\\to\\Android\\Sdk > local.properties
echo ndk.dir=C\:\\path\\to\\android-ndk-r25c >> local.properties
gradlew assembleDebug     # 或 assembleRelease
```

产物：`app_pojavlauncher/build/outputs/apk/debug/app_pojavlauncher-debug.apk`

## 1.1.0：Viskluke 首页`r`n`r`n- 新增 `VisklukeHomeActivity`（WebView，assets/viskluke）作为启动入口`r`n- 首页：启动游戏 / 启动器 / 关于，青绿主题`r`n- 点「启动游戏」进入内置引擎（Pojav 原有界面）`r`n`r`n## 品牌化（1.0.1）`r`n`r`n- 主色从 Pojav 绿改成 Viskluke 青绿（`#0F9D8F`）`r`n- 深色背景改成 Viskluke 的 `#0B1220` / `#0E1526``r`n- 应用名、图标、包名、签名同 1.0.0`r`n`r`n## 已验证

- APK 可安装、可启动（Android 15 模拟器，x86_64）
- 启动后进入 Java 版启动界面：添加账号、版本列表、PLAY
- 四个 ABI 都打包：`arm64-v8a`、`armeabi-v7a`、`x86`、`x86_64`

## 已知限制

- 首次运行需要授予存储/通知权限，并按提示下载 Java 运行时（约 100–200 MB）
- 上游 UI 仍是 Pojav 风格；Viskluke 自己的界面/账号体系是下一步工作
- 新版 Android（16 KB 页）会提示兼容模式，但不影响运行

## 下一步

- 把 PC 端的 Viskluke 视觉/菜单搬到 Android
- 接入 YiStarLine 账号（等提供 token / app 凭据）
- 打包一个 release 签名版本（当前为 debug 签名）
