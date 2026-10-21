; installer.nsh —— 安装时把「Chromium 沙箱」降级参数写进快捷方式
;
; 背景：部分 Windows 机器（本机就是）Chromium 沙箱初始化会 CHECK() 失败，
; 进程以 STATUS_BREAKPOINT（0x80000003）在 main.js 之前静默退出 —— 表现是
; 「双击快捷方式没反应，连日志都没有」。
;
; 开发模式靠 scripts/launch.js 检测退出码后自动加 --no-sandbox 兜底；
; 安装版没有这层包装，而且这个崩溃发生在任何 JS 之前，应用自己救不了自己。
; 唯一可靠的办法是让入口带上参数，所以这里把桌面 / 开始菜单快捷方式统一加上
; --no-sandbox（electron-builder 默认创建完快捷方式后会调用 customInstall）。
;
; 为什么可以直接一刀切：
;   · 本项目是个人自用启动器（README 也这么写），只加载本地页面，
;     contextIsolation 开启、nodeIntegration 关闭，沙箱降级的风险可控；
;   · 之前试过在安装时跑「沙箱探针」（启动一次带环境变量的 app 看退出码），
;     但崩溃时 Windows 会弹「程序已停止工作」对话框，把静默安装卡死，所以放弃。
;
; 想恢复带沙箱启动：右键快捷方式 → 属性 → 目标，删掉最后的 --no-sandbox 即可。

!include "LogicLib.nsh"

!macro customInstall
  ${If} ${FileExists} "$newDesktopLink"
    CreateShortCut "$newDesktopLink" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--no-sandbox" \
      "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 "" "" "${APP_DESCRIPTION}"
    DetailPrint "桌面快捷方式已带 --no-sandbox（绕过本机 Chromium 沙箱崩溃）"
  ${EndIf}
  ${If} ${FileExists} "$newStartMenuLink"
    CreateShortCut "$newStartMenuLink" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--no-sandbox" \
      "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 "" "" "${APP_DESCRIPTION}"
  ${EndIf}
!macroend
