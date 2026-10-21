# 第三方组件声明 / Third-Party Notices

Viskluke Launcher 本身以 [MIT License](LICENSE) 发布，构建时使用了以下开源组件。
打包后的安装目录里还随包附带了 Electron / Chromium 的完整许可证文本
（`LICENSE.electron.txt`、`LICENSES.chromium.html`），请一并保留。

## 运行时依赖（随安装包分发）

| 组件 | 版本 | 许可证 |
|---|---|---|
| Electron | 33.4.11 | MIT（内含 Chromium、Node.js 等，见随包许可证文件） |
| minecraft-launcher-core | 3.18.2 | MIT |
| adm-zip | 0.4.16 | MIT |
| axios | 1.20.0 | MIT |
| ws | 8.22.0 | MIT |

各组件版权声明：

- Electron — Copyright (c) Electron contributors; Copyright (c) 2013-2020 GitHub Inc.
- minecraft-launcher-core — Copyright (c) 2019 Pierce Harriz
- adm-zip — Copyright (c) 2012 Another-D-Mention Software and other contributors
- axios — Copyright (c) 2014-present Matt Zabriskie & Collaborators
- ws — Copyright (c) 2011 Einar Otto Stangvik; Copyright (c) 2013 Arnout Kazemier and contributors;
  Copyright (c) 2016 Luigi Pinca and contributors

以上组件均为 MIT 许可证，正文与 [LICENSE](LICENSE) 相同；完整原文见各组件发布仓库的 LICENSE 文件。

## 构建期工具（不随安装包分发）

| 组件 | 版本 | 许可证 |
|---|---|---|
| electron-builder | 25.1.8 | MIT（Copyright (c) 2015 Loopline Systems） |
| 7-Zip (7za.exe, via 7zip-bin) | — | LGPL / unRAR restriction |
| Inno Setup 6 | 6.x | Inno Setup License（允许自由分发用它编译的安装包） |

## 运行时会下载、但不随本仓库分发的内容

- **CustomSkinLoader（CSL）**：由启动器在「安装 CSL 模组」时从 Modrinth 下载到游戏目录，
  不包含在本仓库或安装包中；其许可证以官方发布页为准。
- **Minecraft 游戏本体、材质、音效、服务端核心（Paper / Vanilla / Fabric 等）**：
  版权归 Mojang Studios / Microsoft 或各项目作者所有。本仓库不包含任何游戏资源，
  均由启动器在运行时从官方源下载；使用需遵守 Minecraft EULA 与对应项目的许可证。

## 商标

「Viskluke」名称与图标仅用于标识本项目。MIT 许可证只授予代码版权许可，
不授予商标使用权；Minecraft、Mojang、Microsoft 等名称与商标归其各自所有者。
