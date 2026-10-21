; viskluke.iss 鈥斺€?Inno Setup 6 瀹夎鑴氭湰
;
; 涓轰粈涔堜笉鐢?electron-builder 鑷甫鐨?NSIS锛?;   鏈満璺?NSIS 3.0.4.1 鐢熸垚鐨勫畨瑁呭寘浼氬湪鍚姩闃舵鐩存帴宕╂簝
;   锛堜簨浠舵棩蹇楋細Faulting module System.dll, exception 0xc0000005锛夛紝
;   鎹?Inno Setup 6 涓€鏉″懡浠ゅ氨鑳界ǔ瀹氫骇鍑猴紝鑰屼笖鏀寔 per-user 瀹夎銆佸揩鎹锋柟寮忓甫鍙傛暟銆?;
; 缂栬瘧锛欼SCC.exe /DAppVersion=1.0.0 build\viskluke.iss
; 鐢?scripts/package-win.js 鑷姩璋冪敤锛堝厛 electron-builder --dir 浜у嚭 dist\win-unpacked锛夈€?
#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif

#define AppName "Viskluke"
#define AppPublisher "Viskluke"
#define AppExe "Viskluke.exe"
#define SourceDir "..\dist\win-unpacked"

[Setup]
; AppId 蹇呴』鍥哄畾锛堝悓涓€涓?GUID 鎵嶈兘姝ｇ‘瑕嗙洊瀹夎/鍗歌浇鏃х増鏈級
AppId={{8FDADA7F-8789-57F9-809F-99EEFBF1BA3B}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={localappdata}\Programs\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
; per-user 瀹夎锛屼笉闇€瑕佺鐞嗗憳鏉冮檺
PrivilegesRequired=lowest
OutputDir=..\dist
OutputBaseFilename=Viskluke-Setup-{#AppVersion}
SetupIconFile=icon.ico
UninstallDisplayIcon={app}\{#AppExe}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=yes
RestartApplications=no
AllowNoIcons=yes

[Languages]
Name: "chinesesimplified"; MessagesFile: "ChineseSimplified.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: checkedonce

[Files]
; win-unpacked 閲屽氨鏄畬鏁寸殑 Electron 搴旂敤锛坅pp.asar + 杩愯鏃讹級
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
; --no-sandbox 鏄繀椤荤殑锛氭湰鏈?Chromium 娌欑鍒濆鍖栦細 STATUS_BREAKPOINT锛?x80000003锛夛紝
; 涓嶅甫杩欎釜鍙傛暟鍙屽嚮蹇嵎鏂瑰紡浼氶潤榛橀棯閫€锛堣瑙?docs/HANDOFF.md 鍧?1锛?Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExe}"; Parameters: "--no-sandbox"; WorkingDir: "{app}"; IconFilename: "{app}\{#AppExe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Parameters: "--no-sandbox"; WorkingDir: "{app}"; IconFilename: "{app}\{#AppExe}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExe}"; Parameters: "--no-sandbox"; Description: "{cm:LaunchProgram,{#StringChange(AppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; 鏋佺鎯呭喌涓嬪簲鐢ㄤ細鎶婂厹搴曟暟鎹啓杩涚▼搴忕洰褰曪紙瀹夊叏杞欢鎷?%APPDATA% 鏃讹級
Type: filesandordirs; Name: "{app}\data"

