; viskluke.iss - Inno Setup 6 installer script (ASCII only, so it compiles in any locale)
;
; Why Inno instead of electron-builder's NSIS:
;   On this machine NSIS 3.0.4.1 installers crash at startup
;   (System.dll, exception 0xc0000005). Inno Setup 6 works first try.
;
; Build: ISCC.exe /DAppVersion=1.1.0 build\viskluke.iss
; (scripts/package-win.js runs electron-builder --dir first, then this script)

#ifndef AppVersion
  #define AppVersion "1.1.0"
#endif

#define AppName "Viskluke"
#define AppPublisher "Viskluke"
#define AppExe "Viskluke.exe"
#define SourceDir "..\dist\win-unpacked"

[Setup]
AppId={{8FDADA7F-8789-57F9-809F-99EEFBF1BA3B}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={localappdata}\Programs\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
; per-user install, no admin required
PrivilegesRequired=lowest
OutputDir=..\dist
OutputBaseFilename=Viskluke-Setup-{#AppVersion}
SetupIconFile=icon.ico
UninstallDisplayIcon={app}\{#AppExe}
; installer exe metadata
VersionInfoVersion={#AppVersion}
VersionInfoProductName={#AppName}
VersionInfoProductVersion={#AppVersion}
VersionInfoCompany={#AppPublisher}
VersionInfoDescription={#AppName} Setup
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
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
; --no-sandbox is required on machines where Chromium sandbox init crashes (STATUS_BREAKPOINT);
; the packaged app has no launcher wrapper, so the shortcut must carry the flag.
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExe}"; Parameters: "--no-sandbox"; WorkingDir: "{app}"; IconFilename: "{app}\{#AppExe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Parameters: "--no-sandbox"; WorkingDir: "{app}"; IconFilename: "{app}\{#AppExe}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExe}"; Parameters: "--no-sandbox"; Description: "{cm:LaunchProgram,{#StringChange(AppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; fallback data dir the app may create next to the exe when %APPDATA% is blocked
Type: filesandordirs; Name: "{app}\data"
