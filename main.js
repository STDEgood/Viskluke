'use strict';

/* ============================================================================
 * Viskluke Launcher —— 主进程入口（带启动自诊断）
 *
 * 启动顺序（顺序决定了"静默闪退"能否留下证据）：
 *   1. 引导日志：此时还没有 require('electron')，只用 node 内置模块，
 *      所以即使 Electron 没真正启动，evidence 也能落盘。
 *   2. 判定当前进程到底是不是 Electron 主进程（识别 ELECTRON_RUN_AS_NODE 等坑）。
 *   3. 安装全局异常钩子：uncaughtException / unhandledRejection / exit。
 *   4. app.whenReady() 之后创建窗口、注册 IPC。
 *
 * 日志文件：<userData>/viskluke_error.log
 *   写入失败依次回退：<项目目录>/viskluke_error.log → <系统临时目录>/viskluke_error.log
 * ========================================================================== */

const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_DIR_NAME = 'viskluke-launcher'; // 与 package.json 的 name 一致（userData 目录名）
const LOG_NAME = 'viskluke_error.log';

// stderr/stdout 有可能被外部关掉（终端被关、`| head` 之类的管道中断、npm 被杀）。
// 这时写日志会以 stream『error』事件冒出 EPIPE，被当成 uncaughtException → 弹"启动失败"，
// 而实际上应用一点问题都没有。这里直接把它静音。
process.stderr.on('error', () => {});
if (process.stdout && typeof process.stdout.on === 'function') process.stdout.on('error', () => {});

// ---------------------------------------------------------------------------
// 1. 引导日志（不依赖 electron）
// ---------------------------------------------------------------------------

function roamingDir() {
  if (process.env.APPDATA) return path.join(process.env.APPDATA, APP_DIR_NAME);
  return path.join(os.homedir(), 'AppData', 'Roaming', APP_DIR_NAME);
}

function logCandidates() {
  return [
    path.join(roamingDir(), LOG_NAME),
    path.join(__dirname, LOG_NAME),
    path.join(os.tmpdir(), LOG_NAME),
  ];
}

let LOG_FILE = null;

function ensureLogFile() {
  if (LOG_FILE !== null) return LOG_FILE;
  for (const file of logCandidates()) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, '', 'utf8'); // 探测可写性
      LOG_FILE = file;
      return file;
    } catch {
      /* 换下一个候选路径 */
    }
  }
  LOG_FILE = '';
  return '';
}

function describeError(error) {
  if (!error) return String(error);
  if (error instanceof Error) return `${error.name}: ${error.message}\n${error.stack || '(no stack)'}`;
  if (typeof error === 'object') {
    try {
      return JSON.stringify(error, null, 2);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

function log(tag, message) {
  const line = `[${new Date().toISOString()}] [${tag}] ${message}\n`;
  try {
    const file = ensureLogFile();
    if (file) fs.appendFileSync(file, line, 'utf8');
  } catch {
    /* 日志都写不了就只能靠 stderr */
  }
  try {
    process.stderr.write(line);
  } catch {
    /* ignore */
  }
}

log('BOOT', '==================== Viskluke 启动 ====================');
log('BOOT', `pid=${process.pid}`);
log('BOOT', `execPath=${process.execPath}`);
log('BOOT', `argv=${JSON.stringify(process.argv)}`);
log('BOOT', `cwd=${process.cwd()}`);
log('BOOT', `__dirname=${__dirname}`);
log('BOOT', `node=${process.versions.node} electron=${process.versions.electron || '(无)'} chrome=${process.versions.chrome || '(无)'}`);
log('BOOT', `ELECTRON_RUN_AS_NODE=${process.env.ELECTRON_RUN_AS_NODE || '(未设置)'}`);
log('BOOT', `日志文件=${ensureLogFile() || '(不可写)'}`);

// ---------------------------------------------------------------------------
// 2. 判定是否真的运行在 Electron 中
// ---------------------------------------------------------------------------

let electronApi = null;
try {
  electronApi = require('electron');
} catch (error) {
  log('FATAL', `require('electron') 失败：${describeError(error)}`);
  log('FATAL', '这不是 Electron 环境，或 node_modules/electron 未正确安装。');
  process.exit(1);
}

// 纯 Node 环境下 require('electron') 返回的是 electron.exe 的路径字符串
if (!electronApi || typeof electronApi === 'string') {
  log('FATAL', '当前进程不是 Electron 主进程！');
  log('FATAL', `require('electron') 返回类型：${typeof electronApi}`);
  if (process.env.ELECTRON_RUN_AS_NODE) {
    log('FATAL', '检测到 ELECTRON_RUN_AS_NODE=1：electron.exe 会以纯 Node 模式运行，不创建窗口、不走 Electron 生命周期。');
    log('FATAL', '修复：PowerShell 执行  Remove-Item Env:\\ELECTRON_RUN_AS_NODE  ；CMD 执行  set ELECTRON_RUN_AS_NODE=  后重新 npm start');
  } else {
    log('FATAL', '请用 npm start 或 npx electron . 启动，不要用 node main.js。');
  }
  process.exit(1);
}

const { app, BrowserWindow, ipcMain, shell, dialog } = electronApi;

if (!app) {
  log('FATAL', 'electron 模块已加载，但 app 为空，无法继续。');
  process.exit(1);
}

log('BOOT', `Electron 主进程已就绪：electron=${process.versions.electron}`);

// ---------------------------------------------------------------------------
// 2.5 userData 可写性自愈
//
// 现象：Electron 进程写 %APPDATA%\<app> 被拦（EPERM），导致
//   · 崩溃日志写不出来
//   · instances.json 保存失败 → 新建实例后列表为空（看起来像"死循环"）
//   · config.json 存不下 → Cloudflare 每次都连不上
//   · localStorage 失效 → 离线账号重启后丢失
// 这里在 app ready 之前探测；不可写就整体切到 %USERPROFILE%\Viskluke\data。
// ---------------------------------------------------------------------------

function relocateUserDataIfNeeded() {
  let current = '';
  try {
    current = app.getPath('userData');
    fs.mkdirSync(current, { recursive: true });
    const probe = path.join(current, '.write-test');
    fs.writeFileSync(probe, 'ok', 'utf8');
    fs.rmSync(probe, { force: true });
    log('BOOT', `userData 可写：${current}`);
    return;
  } catch (error) {
    log('BOOT', `userData 不可写（${error.code || error.message}）：${current}`);
  }

  const home = process.env.USERPROFILE || os.homedir();
  // 备用目录按顺序试：安装版尤其需要注意 —— 安全软件可能连 %USERPROFILE%\Viskluke 也拦，
  // 但"隔离运行"通常还允许写程序目录，所以把 exe 同级目录也放进来。
  const fallbacks = [
    path.join(home, 'Viskluke', 'data'),
    path.join(path.dirname(process.execPath), 'data'),
    path.join(os.tmpdir(), 'viskluke-data'),
  ];
  for (const fallback of fallbacks) {
    try {
      fs.mkdirSync(fallback, { recursive: true });
      const probe = path.join(fallback, '.write-test');
      fs.writeFileSync(probe, 'ok', 'utf8');
      fs.rmSync(probe, { force: true });
      app.setPath('userData', fallback);
      // 日志也一并搬过去，否则日志仍写在只读目录
      LOG_FILE = path.join(fallback, LOG_NAME);
      log('BOOT', `已把 userData 切换到：${fallback}`);
      return;
    } catch (error) {
      log('BOOT', `备用目录不可写（${error.code || error.message}）：${fallback}`);
    }
  }
  log('BOOT', '所有候选目录都不可写：本次会话的设置与日志只能留在内存里');
}

relocateUserDataIfNeeded();

// ---------------------------------------------------------------------------
// 3. 全局异常钩子（必须在任何业务逻辑之前安装）
// ---------------------------------------------------------------------------

process.on('uncaughtException', (error) => {
  // 管道/终端被关掉不是启动失败，别拿弹窗吓用户
  if (error && ['EPIPE', 'EPROTO', 'ERR_STREAM_DESTROYED'].includes(error.code)) return;

  log('UNCAUGHT_EXCEPTION', describeError(error));
  try {
    if (!app.isReady()) {
      dialog.showErrorBox('Viskluke 启动失败', `${(error && error.message) || error}\n\n详细日志：\n${ensureLogFile()}`);
    }
  } catch {
    /* 极端情况下 dialog 也会失败 */
  }
  if (!app.isReady()) process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  log('UNHANDLED_REJECTION', describeError(reason));
});

process.on('exit', (code) => {
  log('PROCESS_EXIT', `code=${code}`);
});

process.on('warning', (warning) => {
  log('PROCESS_WARNING', `${warning.name}: ${warning.message}`);
});

app.on('child-process-gone', (_event, details) => {
  log('CHILD_PROCESS_GONE', JSON.stringify(details));
});

app.on('render-process-gone', (_event, _contents, details) => {
  log('RENDER_PROCESS_GONE', JSON.stringify(details));
});

// 渲染进程的 console 也落盘，白屏/前端报错能直接在日志里看到
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', (...args) => {
    const maybeDetails = args[1];
    if (maybeDetails && typeof maybeDetails === 'object') {
      log('RENDERER_CONSOLE', `[${maybeDetails.level}] ${maybeDetails.message} (${maybeDetails.sourceId || ''}:${maybeDetails.lineNumber || ''})`);
    } else {
      const [, level, message, line, sourceId] = args;
      log('RENDERER_CONSOLE', `[${level}] ${message} (${sourceId || ''}:${line || ''})`);
    }
  });
  contents.on('preload-error', (_e, preloadPath, error) => {
    log('PRELOAD_ERROR', `${preloadPath}: ${describeError(error)}`);
  });
  contents.on('render-process-gone', (_e, details) => {
    log('RENDERER_GONE', JSON.stringify(details));
  });
  contents.on('did-fail-load', (_e, code, description, url) => {
    log('DID_FAIL_LOAD', `code=${code} desc=${description} url=${url}`);
  });
  contents.setWindowOpenHandler(({ url }) => {
    log('WINDOW_OPEN', url);
    if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
});

// 部分 Windows 显卡驱动会让 GPU 进程反复崩溃 → 窗口不出现，用 VISKLUKE_DISABLE_GPU=1 启动可绕过
if (process.env.VISKLUKE_DISABLE_GPU === '1') {
  log('BOOT', '已按环境变量禁用硬件加速');
  app.disableHardwareAcceleration();
}

app.setAppUserModelId('com.viskluke.launcher');

// ---------------------------------------------------------------------------
// 4. 业务模块（放在 electron 校验之后加载，避免级联崩溃）
// ---------------------------------------------------------------------------

const auth = require('./auth');
const launcher = require('./launcher');
const instances = require('./instances');
const servers = require('./server');
const cloudflare = require('./cloudflare');
const store = require('./store');
const modpackInstaller = require('./modpack-instance');
const skin = require('./skin');
const netcheck = require('./netcheck');
const relay = require('./relay');

// 中继（内网穿透）运行时状态：同一时刻各一个
let relayHost = null;
let relayGuest = null;

let mainWindow = null;
let quitting = false;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// 5. 窗口
// ---------------------------------------------------------------------------

const INDEX_FILE = path.join(__dirname, 'renderer', 'index.html');
const PRELOAD_FILE = path.join(__dirname, 'preload.js');
// 开发时用 build/icon.ico（打包后 electron-builder 会把图标嵌进 exe，这里也带上以防万一）
const ICON_FILE = ['icon.ico', 'icon.png']
  .map((name) => path.join(__dirname, 'build', name))
  .find((file) => fs.existsSync(file));

function createMainWindow() {
  log('WINDOW', `创建窗口 index=${INDEX_FILE} exists=${fs.existsSync(INDEX_FILE)} preloadExists=${fs.existsSync(PRELOAD_FILE)}`);

  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 960,
    minHeight: 620,
    title: 'Viskluke',
    backgroundColor: '#1e1e2e',
    ...(ICON_FILE ? { icon: ICON_FILE } : {}),
    show: false,
    webPreferences: {
      preload: PRELOAD_FILE,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    log('WINDOW', 'ready-to-show，显示窗口');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // 兜底：ready-to-show 因环境问题不触发时，4 秒后强制显示，避免"进程活着但没窗口"
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      log('WINDOW', 'ready-to-show 未触发，强制显示窗口');
      mainWindow.show();
    }
  }, 4000).unref?.();

  mainWindow.on('closed', () => {
    log('WINDOW', '窗口已关闭');
    mainWindow = null;
  });

  mainWindow.on('unresponsive', () => log('WINDOW', '窗口无响应'));

  mainWindow.webContents.on('did-finish-load', () => log('WINDOW', '渲染进程加载完成'));
  mainWindow.webContents.on('did-fail-load', (_e, code, description, url) => {
    log('WINDOW', `页面加载失败 code=${code} desc=${description} url=${url}`);
    try {
      dialog.showErrorBox('界面加载失败', `无法加载：\n${INDEX_FILE}\n\n${description} (${code})`);
    } catch {
      /* ignore */
    }
  });

  servers.attachWindow(mainWindow);

  mainWindow.loadFile(INDEX_FILE).catch((error) => {
    log('WINDOW', `loadFile 失败：${describeError(error)}`);
    try {
      dialog.showErrorBox('界面加载失败', `${INDEX_FILE}\n\n${error.message}`);
    } catch {
      /* ignore */
    }
  });
}

// ---------------------------------------------------------------------------
// 6. IPC
// ---------------------------------------------------------------------------

function handle(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await handler(event, ...args);
    } catch (error) {
      log('IPC_ERROR', `${channel}: ${describeError(error)}`);
      return { ok: false, error: (error && error.message) || String(error) };
    }
  });
}

/** 从 IPC 参数里找出实例记录：优先用 id 查磁盘上的记录，其次用传进来的对象 */
function resolveInstance(payload = {}) {
  const id = payload.instanceId || (payload.instance && payload.instance.id) || '';
  if (id) {
    const found = instances.list().find((item) => item.id === id);
    if (found) return found;
  }
  return payload.instance || null;
}

function registerIpc() {
  // ---------- 应用信息 / 诊断 ----------
  handle('app:info', () => ({
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron || null,
    chrome: process.versions.chrome || null,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    userData: app.getPath('userData'),
    logFile: ensureLogFile(),
    serverRoot: path.join(app.getPath('userData'), 'servers'),
    configFile: cloudflare.status().configFile || null,
  }));

  handle('app:open-log', async () => {
    const file = ensureLogFile();
    if (!file) return { ok: false, error: '日志文件不可写' };
    shell.showItemInFolder(file);
    return { ok: true, file };
  });

  // ---------- 登录：离线 / 微软 ----------
  handle('auth:offline', (_event, name) => auth.offlineLogin(name));
  handle('auth:start', () => auth.startDeviceFlow(mainWindow));
  handle('auth:refresh', (_event, refreshToken) => auth.refresh(refreshToken));

  // ---------- 启动游戏 ----------
  handle('launch:start', async (_event, config = {}) => {
    // 把实例记录（loader / modpack 元数据）合并进去，渲染层不必重复传
    const stored = config.instanceId
      ? instances.list().find((item) => item.id === config.instanceId) || null
      : null;
    const instance = stored || config.instance || { id: config.instanceId, name: config.instanceName };
    return launcher.launch({ ...config, instance }, mainWindow);
  });
  handle('launch:open-root', async (_event, instance) => {
    const root = launcher.resolveGameRoot(instance || {});
    const error = await shell.openPath(root);
    return error ? { ok: false, error } : { ok: true, root };
  });

  // ---------- 下载中心 ----------
  handle('store:versions', (_event, options) => store.listVersions(options || {}));
  handle('store:search', (_event, options) => store.searchProjects(options || {}));
  handle('store:install', async (_event, options = {}) => {
    const onProgress = (progress) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      try {
        mainWindow.webContents.send('store:progress', { ...progress, projectId: options.projectId });
      } catch {
        /* ignore */
      }
    };

    // 整合包：先建（或复用）一个专属实例，再把包解进去，最后把包信息写回实例记录
    if (options.projectType === 'modpack') {
      const result = await modpackInstaller.installModpackInstance(options, {
        onProgress,
        repository: instances,
        storeModule: store,
      });
      log(
        'STORE',
        `整合包 ${options.projectId} → ${result.root}（${result.stats.downloaded} 新文件，实例 ${result.instance.id}）`
      );
      return result;
    }

    const result = await store.installProject({ ...options, onProgress });
    log('STORE', `安装 ${options.projectType}/${options.projectId} → ${result.file}`);

    // 记一笔"装过什么"，下载页据此显示「已安装」
    if (result && result.ok && options.instanceId) {
      try {
        const record = instances.list().find((item) => item.id === options.instanceId);
        if (record) {
          const key = options.projectType || 'mod';
          const installed = { ...(record.installed || {}) };
          installed[key] = [...new Set([...(installed[key] || []), options.projectId])].slice(-300);
          instances.save({ ...record, installed });
        }
      } catch (error) {
        log('STORE', `记录已安装列表失败（不影响安装结果）：${describeError(error)}`);
      }
    }
    return result;
  });

  // ---------- 实例管理 ----------
  handle('instances:list', () => instances.list());
  handle('instances:save', (_event, instance) => instances.save(instance));
  handle('instances:remove', (_event, id) => instances.remove(id));

  // ---------- 一键开服 ----------
  handle('server:list', () => servers.list());
  handle('server:logs', (_event, serverId) => servers.getLogs(serverId));
  handle('server:start', (_event, options) => servers.startServer(options || {}));
  handle('server:stop', (_event, payload = {}) =>
    servers.stopServer(payload.id, {
      force: Boolean(payload.force),
      removeDns: payload.removeDns !== false,
    })
  );
  handle('server:delete', (_event, payload = {}) =>
    servers.deleteServer(payload.id, {
      deleteFiles: payload.deleteFiles !== false,
      removeDns: payload.removeDns !== false,
    })
  );
  handle('server:command', (_event, payload = {}) => servers.sendCommand(payload.id, payload.command));
  handle('server:whitelist', (_event, payload = {}) =>
    servers.setWhitelist({ id: payload.id, players: payload.players, whitelist: payload.whitelist })
  );
  handle('server:lan', () => ({ ok: true, ip: servers.lanAddress() }));
  handle('net:report', (_event, payload = {}) =>
    netcheck.report({ port: Number(payload.port) || 25565, tryMap: Boolean(payload.tryMap) })
  );
  handle('net:unmap', (_event, payload = {}) => netcheck.unmap(Number(payload.port) || 25565));
  // ---- 自建中继（内网穿透）----
  handle('relay:suggest-room', (_event, payload = {}) => ({ ok: true, room: relay.suggestRoom(payload.prefix || 'mc') }));
  handle('relay:status', () => ({
    ok: true,
    host: relayHost
      ? { room: relayHost.room, key: Boolean(relayHost.key), localPort: relayHost.localPort, relayUrl: relayHost.relayUrl }
      : null,
    guest: relayGuest
      ? { room: relayGuest.room, key: Boolean(relayGuest.key), address: relayGuest.address, connections: relayGuest.connections }
      : null,
  }));
  handle('relay:host-start', async (_event, payload = {}) => {
    if (relayHost) return { ok: false, error: '隧道已经开着了，先停掉再开' };
    const cfg = cloudflare.status ? cloudflare.status() : {};
    const relayUrl = String(payload.relayUrl || cfg.relayUrl || '').trim();
    if (!relayUrl) throw new Error('还没有中继地址：先在「高级设置」里填中继的 wss:// 地址（部署 worker/cloudflare-relay-worker.mjs 后得到）');
    relayHost = await relay.startHostTunnel({
      relayUrl,
      room: payload.room,
      key: payload.key,
      localPort: Number(payload.port) || 25565,
      onLog: (line) => log('RELAY', line),
    });
    return { ok: true, room: relayHost.room, relayUrl: relayHost.relayUrl, localPort: relayHost.localPort };
  });
  handle('relay:host-stop', async () => {
    if (!relayHost) return { ok: true, stopped: false };
    relayHost.close();
    relayHost = null;
    return { ok: true, stopped: true };
  });
  handle('relay:guest-start', async (_event, payload = {}) => {
    if (relayGuest) await relayGuest.close();
    const cfg = cloudflare.status ? cloudflare.status() : {};
    const relayUrl = String(payload.relayUrl || cfg.relayUrl || '').trim();
    if (!relayUrl) throw new Error('还没有中继地址：先填中继的 wss:// 地址');
    relayGuest = await relay.startGuestProxy({
      relayUrl,
      room: payload.room,
      key: payload.key,
      listenPort: Number(payload.listenPort) || relay.DEFAULT_PROXY_PORT,
      onLog: (line) => log('RELAY', line),
    });
    return { ok: true, room: relayGuest.room, address: relayGuest.address, port: relayGuest.port };
  });
  handle('relay:guest-stop', async () => {
    if (!relayGuest) return { ok: true, stopped: false };
    await relayGuest.close();
    relayGuest = null;
    return { ok: true, stopped: true };
  });
  handle('net:probe', async (_event, payload = {}) => {
    const port = Number(payload.port) || 25565;
    const lanIp = netcheck.lanIpv4();
    const publicIp = payload.publicIp || (await netcheck.publicIpv4());
    // 配了 Worker 才有真正的"外部视角"
    let proxyProbe = null;
    try {
      if (cloudflare.status().proxyUrl) {
        proxyProbe = (target) => cloudflare.probeReachable({ host: target.host, port: target.port });
      }
    } catch {
      proxyProbe = null;
    }
    const result = await netcheck.reachability({ port, lanIp, publicIp, proxyProbe });
    log('NET', `可达性探测 ${port} → ${result.verdict}（${result.summary}）`);
    return result;
  });
  handle('server:public-ip', async () => {
    try {
      const ip = await cloudflare.detectPublicIp();
      if (!ip) return { ok: false, error: '探测不到公网 IP（可能没有联网）' };
      return { ok: true, ip, private: cloudflare.isPrivateIp(ip) };
    } catch (error) {
      return { ok: false, error: (error && error.message) || String(error) };
    }
  });
  handle('server:sync-dns', async (_event, serverId) => ({ ok: true, dns: await servers.syncDns(serverId) }));
  handle('server:remove-dns', (_event, serverId) => servers.removeDnsFor(serverId));
  handle('server:open-folder', (_event, serverId) => servers.openFolder(serverId));
  handle('server:java', () => servers.javaInfo());

  // ---------- 皮肤（离线皮肤 / CustomSkinLoader） ----------
  handle('skin:status', (_event, payload = {}) => skin.status({ instance: resolveInstance(payload) }));
  handle('skin:import', async (_event, payload = {}) => {
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: '选择皮肤 PNG',
      properties: ['openFile'],
      filters: [{ name: 'Minecraft 皮肤', extensions: ['png'] }],
    });
    if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true };
    const result = skin.importSkin({
      sourcePath: picked.filePaths[0],
      model: payload.model,
      kind: payload.kind === 'cape' ? 'cape' : 'skin',
    });
    log('SKIN', `导入${result.skin.kind === 'cape' ? '披风' : '皮肤'} ${result.skin.name}（${result.skin.width}×${result.skin.height}）`);
    return result;
  });
  handle('skin:set-model', (_event, payload = {}) => skin.updateSkin(payload.id, { model: payload.model }));
  handle('skin:rename', (_event, payload = {}) => skin.updateSkin(payload.id, { name: payload.name }));
  handle('skin:remove', (_event, payload = {}) => skin.removeSkin(payload.id));
  // 绘制器保存：dataURL → PNG buffer → 进皮肤库
  handle('skin:save-drawing', (_event, payload = {}) => {
    const dataUrl = String(payload.dataUrl || '');
    const match = /^data:image\/png;base64,(.+)$/i.exec(dataUrl);
    if (!match) throw new Error('画布数据不是 PNG');
    const buffer = Buffer.from(match[1], 'base64');
    if (buffer.length > 1024 * 1024) throw new Error('画出来太大了（超过 1MB）');
    const result = skin.importSkin({
      buffer,
      name: payload.name || '我画的皮肤',
      model: payload.model || 'classic',
      kind: payload.kind === 'cape' ? 'cape' : 'skin',
      source: 'draw',
    });
    log('SKIN', `画布保存：${result.skin.name}（${result.skin.width}×${result.skin.height}，${result.skin.kind}）`);
    return result;
  });
  handle('skin:apply', (_event, payload = {}) => {
    const instance = resolveInstance(payload);
    if (!instance) throw new Error('请先选择实例');
    const result = skin.applySkin({
      instance,
      skinId: payload.skinId,
      playerName: payload.playerName,
      model: payload.model,
    });
    log('SKIN', `应用皮肤 ${result.playerName} → ${result.target}（模型 ${result.model}）`);
    return result;
  });
  handle('skin:clear', (_event, payload = {}) => {
    const instance = resolveInstance(payload);
    if (!instance) throw new Error('请先选择实例');
    return skin.clearSkin({ instance, playerName: payload.playerName });
  });
  handle('skin:open-folder', (_event, payload = {}) => skin.openFolder({ instance: resolveInstance(payload) }));
  handle('skin:install-csl', async (_event, payload = {}) => {
    const instance = resolveInstance(payload);
    if (!instance) throw new Error('请先选择实例');
    return skin.installCsl({
      instance,
      onProgress: (progress) => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        try {
          mainWindow.webContents.send('store:progress', {
            ...progress,
            projectId: skin.CSL_PROJECT_ID,
            stage: 'csl',
            message: '安装 CustomSkinLoader',
          });
        } catch {
          /* ignore */
        }
      },
    });
  });

  // ---------- Viskluke Address / Cloudflare ----------
  handle('cf:status', () => ({ ...cloudflare.status(), tokenUrl: cloudflare.TOKEN_TEMPLATE_URL }));
  handle('cf:verify', () => cloudflare.verify());
  handle('cf:reveal-config', () => revealConfigFile());
  handle('cf:connect', (_event, token) => cloudflare.connect(token));
  handle('cf:add-zone', (_event, payload = {}) =>
    cloudflare.addZone({ suffix: payload.suffix, zoneId: payload.zoneId })
  );
  handle('cf:remove-zone', (_event, payload = {}) => cloudflare.removeZone(payload.suffix));
  handle('cf:add-manual-zone', (_event, payload = {}) => cloudflare.addManualZone({ suffix: payload.suffix }));
  handle('cf:remove-manual-zone', (_event, payload = {}) => cloudflare.removeManualZone(payload.suffix));
  handle('cf:open-token-page', () => shell.openExternal(cloudflare.TOKEN_TEMPLATE_URL));

  // ---------- 打开外部链接 ----------
  handle('shell:open', (_event, url) => {
    const target = String(url || '');
    if (!/^https?:\/\//i.test(target)) throw new Error('只允许打开 http/https 链接');
    return shell.openExternal(target);
  });

  log('BOOT', 'IPC 通道注册完成');
}

// ---------------------------------------------------------------------------
// 6.5 整合包：自动建实例 → 解包安装 → 把包信息写回实例记录（实现见 modpack-instance.js）
// ---------------------------------------------------------------------------

function revealConfigFile() {
  const status = cloudflare.status();
  const target = status.configFile || path.join(app.getPath('userData'), 'config.json');

  if (!fs.existsSync(target)) {
    const template = {
      CF_API_TOKEN: '在此填入 Cloudflare API Token（权限：Zone.DNS Edit）',
      CF_ZONE_ID: '在此填入 Zone ID',
      CF_ZONES: { 'yistarline.eu.cc': '', 'stde.eu.cc': '', 'ys2video.eu.cc': '' },
      PUBLIC_IP: '',
      PUBLIC_HOST: '',
      TTL: 60,
    };
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(template, null, 2)}\n`, 'utf8');
    log('CONFIG', `已创建配置模板：${target}`);
  }

  shell.showItemInFolder(target);
  return { ok: true, file: target };
}

// ---------------------------------------------------------------------------
// 7. 生命周期
// ---------------------------------------------------------------------------

app.whenReady().then(
  () => {
    log('BOOT', `app ready，userData=${app.getPath('userData')}`);
    try {
      fs.mkdirSync(app.getPath('userData'), { recursive: true });
    } catch (error) {
      log('BOOT', `创建 userData 目录失败：${describeError(error)}`);
    }
    registerIpc();
    createMainWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  },
  (error) => {
    log('FATAL', `app.whenReady() 失败：${describeError(error)}`);
    try {
      dialog.showErrorBox('Viskluke 启动失败', `${(error && error.message) || error}\n\n日志：${ensureLogFile()}`);
    } catch {
      /* ignore */
    }
  }
);

app.on('window-all-closed', () => {
  log('BOOT', '所有窗口已关闭');
  if (process.platform !== 'darwin') app.quit();
});

/**
 * 退出前先给所有 Minecraft 服务器发 stop，避免世界存档损坏。
 * 加硬超时，防止某个服务器卡住导致"窗口关了进程还在"。
 */
app.on('before-quit', (event) => {
  if (quitting) return;
  quitting = true;
  event.preventDefault();
  log('BOOT', '开始优雅退出：停止所有正在运行的服务器');

  Promise.race([servers.shutdownAll(), sleep(9000)])
    .catch((error) => log('BOOT', `关闭服务器时出错：${describeError(error)}`))
    .finally(() => {
      log('BOOT', '退出流程结束');
      app.exit(0);
    });
});

app.on('quit', (_event, exitCode) => {
  log('BOOT', `应用退出，exitCode=${exitCode}`);
});
