'use strict';

/**
 * launcher.js —— 调用 MCLC 启动 Minecraft
 *
 * 账号：微软正版（meta.type='msa'）/ 离线（meta.type='legacy'）
 *
 * 整合包实例（instance.loader = fabric / quilt）：
 *   先由 loader.js 生成/复用加载器版本 JSON（versions/<mc>-<loader>-<ver>/），
 *   再让 MCLC 用 version.custom 走这个自定义版本；Forge/NeoForge 暂不支持，直接报错。
 *
 * 游戏目录策略（解决 Windows 上 AppData 写入被安全软件拦截的 EPERM）：
 *   1. 实例自定义 gameDir（如果设置）
 *   2. %USERPROFILE%\Viskluke\instances\<实例>   ← 默认，路径直观、较少被拦
 *   3. <userData>\instances\<实例>                ← 兼容旧行为
 *   4. <临时目录>\viskluke-instances\<实例>       ← 最后兜底
 * 依次尝试，能写哪个就用哪个，并把实际使用的目录返回给界面。
 */

const { Client } = require('minecraft-launcher-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');
const loader = require('./loader');

const SUB_DIRS = ['versions', 'mods', 'resourcepacks', 'shaderpacks', 'saves', 'logs'];

function safeSend(win, channel, payload) {
  if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return;
  try {
    win.webContents.send(channel, payload);
  } catch {
    /* 窗口正在关闭 */
  }
}

function slug(text) {
  return String(text || 'instance')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'instance';
}

function homeDir() {
  return process.env.USERPROFILE || os.homedir();
}

/** 候选游戏根目录（按优先级） */
function candidateRoots(instance = {}) {
  const id = slug(instance.id || instance.name);
  const list = [];
  if (instance.gameDir) list.push(path.resolve(String(instance.gameDir)));
  list.push(path.join(homeDir(), 'Viskluke', 'instances', id));
  try {
    list.push(path.join(app.getPath('userData'), 'instances', id));
  } catch {
    /* ignore */
  }
  list.push(path.join(os.tmpdir(), 'viskluke-instances', id));
  return [...new Set(list)];
}

/**
 * 依次尝试创建目录，返回第一个可写的根目录。
 * @returns {{ root: string, created: boolean, tried: string[] }}
 */
function ensureGameRoot(instance = {}) {
  const tried = [];
  let lastError = null;

  for (const root of candidateRoots(instance)) {
    try {
      fs.mkdirSync(root, { recursive: true });
      for (const dir of SUB_DIRS) fs.mkdirSync(path.join(root, dir), { recursive: true });
      // 真正验证可写（mkdir 存在时不会报错，写文件才会暴露权限问题）
      const probe = path.join(root, '.viskluke-write-test');
      fs.writeFileSync(probe, 'ok', 'utf8');
      fs.rmSync(probe, { force: true });
      return { root, created: true, tried };
    } catch (error) {
      lastError = error;
      tried.push(`${root} → ${error.code || error.message}`);
    }
  }

  throw new Error(
    `无法创建游戏目录。已尝试：\n${tried.join('\n')}\n` +
      `最后错误：${lastError ? lastError.message : '未知'}\n` +
      '常见原因：安全软件拦截（把上述目录加入白名单即可）、磁盘只读、或路径被占用。'
  );
}

/** 用一个不启动游戏的方式拿到目录（供“打开目录”按钮使用） */
function resolveGameRoot(instance = {}) {
  return ensureGameRoot(instance).root;
}

/**
 * 只读地猜一下游戏目录在哪：不建目录、不写探针，只挑第一个存在的候选。
 * 给"状态展示"这类只读场景用（目录不可写时也不会抛错）。
 */
function peekGameRoot(instance = {}) {
  const candidates = candidateRoots(instance);
  const existing = candidates.find((root) => {
    try {
      return fs.statSync(root).isDirectory();
    } catch {
      return false;
    }
  });
  return { root: existing || candidates[0] || '', exists: Boolean(existing), candidates };
}

async function launch(config, win) {
  const account = config.minecraft || {};
  const offline = account.type === 'offline' || config.accountType === 'offline';
  const username = String(account.name || '').trim();
  const uuid = String(account.uuid || '').trim();
  const version = String(config.version || '').trim();

  if (!username || !uuid) throw new Error('账号信息不完整：缺少用户名或 UUID，请重新登录');
  if (!version) throw new Error('请填写游戏版本，例如 1.20.4');

  const instance = config.instance || { id: config.instanceId, name: config.instanceName };
  const { root } = ensureGameRoot(instance);
  safeSend(win, 'launch:log', `[Viskluke] 游戏目录：${root}`);

  // ---- 加载器（整合包实例）----
  // Fabric / Quilt：自己生成 versions/<id>/<id>.json，用 MCLC 的 version.custom 启动。
  // Forge / NeoForge：下官方 installer jar，交给 MCLC 的 options.forge（ForgeWrapper 运行时处理）。
  const loaderType = String(config.loader || instance.loader || '').trim().toLowerCase();
  const loaderVersion = String(config.loaderVersion || instance.loaderVersion || '').trim();
  let mclcVersion = { number: version, type: config.versionType || 'release' };
  let loaderInfo = null;
  let forgeInstaller = '';

  if (loaderType) {
    if (!loader.SUPPORTED.includes(loaderType)) {
      throw new Error(
        `这个实例需要「${loaderType}」加载器，本启动器只自动处理 Fabric / Quilt / Forge / NeoForge。\n` +
          '可以把这个整合包导入 Prism / Modrinth 客户端。'
      );
    }

    if (loader.usesInstaller(loaderType)) {
      // Forge 系：确保 installer jar（config.forgeInstaller 允许外部指定，自检用）
      if (config.forgeInstaller && fs.existsSync(config.forgeInstaller)) {
        forgeInstaller = config.forgeInstaller;
        safeSend(win, 'launch:log', `[Viskluke] 使用指定的 ${loaderType} 安装器：${forgeInstaller}`);
      } else {
        safeSend(win, 'launch:log', `[Viskluke] 准备 ${loaderType} 安装器 ${loaderVersion || '(自动选择推荐版本)'}…`);
        const prepared = await loader.ensureInstaller({
          root,
          loader: loaderType,
          mcVersion: version,
          loaderVersion,
          onLog: (msg) => safeSend(win, 'launch:log', String(msg)),
          onProgress: ({ percent, received, total }) => {
            if (!win) return;
            try {
              win.webContents.send('launch:log', `  下载安装器 ${percent == null ? '' : `${percent}%`} ${
                total ? `${(received / 1048576).toFixed(1)}/${(total / 1048576).toFixed(1)} MB` : ''
              }`);
            } catch {
              /* 窗口正在关闭 */
            }
          },
        });
        forgeInstaller = prepared.installerPath;
        loaderInfo = {
          type: prepared.loader,
          version: prepared.loaderVersion,
          installer: prepared.installerPath,
          created: true,
        };
        safeSend(
          win,
          'launch:log',
          `[Viskluke] 启动版本：Minecraft ${version} + ${prepared.label} ${prepared.loaderVersion}（ForgeWrapper 接管启动参数）`
        );
      }
      if (!loaderInfo) loaderInfo = { type: loaderType, version: loaderVersion, installer: forgeInstaller };
    } else {
      safeSend(win, 'launch:log', `[Viskluke] 准备加载器：${loaderType} ${loaderVersion || '(自动选择最新版本)'}`);
      const prepared = await loader.ensureLoaderVersion({
        root,
        loader: loaderType,
        mcVersion: version,
        loaderVersion,
        onLog: (msg) => safeSend(win, 'launch:log', String(msg)),
      });
      mclcVersion = { number: prepared.id, custom: prepared.id, type: 'release' };
      loaderInfo = {
        type: prepared.loader,
        version: prepared.loaderVersion,
        versionId: prepared.id,
        created: prepared.created,
      };
      safeSend(
        win,
        'launch:log',
        `[Viskluke] 启动版本：${prepared.id}（Minecraft ${version} + ${prepared.loader} ${prepared.loaderVersion}）`
      );
    }
  }

  const opts = {
    authorization: {
      access_token: String(account.accessToken || (offline ? '0' : '')),
      client_token: String(account.clientToken || (offline ? '0' : '')),
      uuid,
      name: username,
      user_properties: '{}',
      meta: offline ? { type: 'legacy', demo: false } : { type: 'msa', demo: false },
    },
    root,
    version: mclcVersion,
    memory: { max: config.maxMemory || '4G', min: config.minMemory || '2G' },
    javaPath: config.javaPath || undefined,
    ...(forgeInstaller ? { forge: forgeInstaller } : {}),
  };

  // MCLC 下载资源时并发句柄过多会抛 EMFILE（Retrying... false 就放弃该文件）。
  // 已下载的资源会被跳过，所以重新 launch 是"续传"，重试几轮即可补齐。
  const MAX_ATTEMPTS = 4;
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const client = new Client();
    client.on('debug', (msg) => safeSend(win, 'launch:log', String(msg)));
    client.on('data', (msg) => safeSend(win, 'launch:log', String(msg)));
    client.on('error', (err) => safeSend(win, 'launch:error', String(err)));
    client.on('close', (code) => {
      safeSend(win, 'launch:close', code);
      safeSend(win, 'launch:log', `游戏进程已退出（code=${code}）`);
    });

    if (attempt > 1) {
      safeSend(win, 'launch:log', `[Viskluke] 继续下载缺失文件（第 ${attempt}/${MAX_ATTEMPTS} 轮）…`);
      await sleep(1200);
    }

    try {
      const proc = await client.launch(opts);
      return {
        ok: true,
        pid: (proc && proc.pid) || null,
        root,
        offline,
        attempts: attempt,
        version: mclcVersion.number,
        loader: loaderInfo,
      };
    } catch (error) {
      lastError = error;
      const raw = (error && error.message) || String(error);

      if (/EMFILE|ENFILE|EBUSY/i.test(raw) && attempt < MAX_ATTEMPTS) {
        safeSend(win, 'launch:log', `[Viskluke] 文件句柄耗尽（EMFILE），自动重试 ${attempt}/${MAX_ATTEMPTS}…`);
        continue;
      }

      let hint = '';
      if (/EPERM|EACCES/.test(raw)) {
        hint = `\n\n提示：这是文件权限被拒绝。已使用的目录是 ${root}，请把该目录（或整个 Viskluke 文件夹）加入杀毒软件白名单后重试。`;
      } else if (/ENOENT/.test(raw)) {
        hint = '\n\n提示：缺少 Java 或版本文件，请先在「下载 → 版本」安装该版本，或检查 Java 路径。';
      } else if (/EMFILE|ENFILE/i.test(raw)) {
        hint = '\n\n提示：已自动重试多轮仍未下完。请关闭其他程序/杀软实时扫描后再次点「启动游戏」，已下载的文件会保留。';
      }
      throw new Error(`${raw}${hint}`);
    }
  }

  throw new Error(`启动失败：${(lastError && lastError.message) || '未知错误'}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { launch, resolveGameRoot, peekGameRoot, ensureGameRoot, candidateRoots };
