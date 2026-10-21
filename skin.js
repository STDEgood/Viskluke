'use strict';

/**
 * skin.js —— 离线皮肤（CustomSkinLoader）
 *
 * 事实依据（2026-10 从 CustomSkinLoader 15.1 的 jar 里反查，不是猜的）：
 *   · 本地皮肤读的是 `<游戏目录>/CustomSkinLoader/LocalSkin/skins/<玩家名>.png`
 *     （另有 LocalSkin/capes/、LocalSkin/elytras/）
 *   · LocalSkin 这个内置 profile 的默认 model 是 `auto`，也就是不写配置 = 经典模型；
 *     CSL 只认 `default` / `slim` / `auto` 三个值
 *   · 想强制纤细模型，只能改 `CustomSkinLoader/CustomSkinLoader.json` 里 loadlist 的
 *     LocalSkin 项（字段：name/type/model/skin/cape/elytra/checkPNG）；
 *     配置还没生成时，退而写 ExtraList/viskluke-skin.json（CSL 会合并，尽力而为）
 *   · CSL 15.1 的 Modrinth 项目 id 是 idMHQ4n2，官方只发一个 Universal jar
 *
 * 本模块职责：
 *   · 皮肤库：导入 PNG（校验签名 + 尺寸）、去重、改名/模型/绑定玩家、删除
 *   · 应用：把库里的 PNG 复制到当前实例的 LocalSkin 目录，并写入模型设置
 *   · 状态：让界面知道 CSL 装没装、配置在不在、哪些玩家已经有本地皮肤
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const { app, shell } = require('electron');
const instances = require('./instances');
const launcher = require('./launcher');

const CSL_DIR = 'CustomSkinLoader';
const CSL_CONFIG = 'CustomSkinLoader.json';
const CSL_EXTRALIST_DIR = 'ExtraList';
const CSL_LOCAL_SKIN_DIR = path.posix.join('LocalSkin', 'skins');
const CSL_LOCAL_CAPE_DIR = path.posix.join('LocalSkin', 'capes');
const CSL_LOCAL_ELYTRA_DIR = path.posix.join('LocalSkin', 'elytras');
const CSL_EXTRALIST_FILE = 'viskluke-skin.json';
const CSL_PROJECT_ID = 'idMHQ4n2'; // Modrinth: customskinloader
const CSL_PROJECT_SLUG = 'customskinloader';
const CSL_SUPPORTED_LOADERS = ['fabric', 'quilt', 'forge', 'neoforge'];
const LIB_DIR = 'skins';
const LIB_INDEX = 'index.json';
const MAX_SKIN_BYTES = 1024 * 1024; // 1MB 够了，正常皮肤 2~20KB
const PLAYER_NAME_RE = /^[A-Za-z0-9_]{3,16}$/;
const MODEL_CHOICES = ['classic', 'slim'];
/** 素材类型：皮肤 / 披风（披风同时写入 elytras，游戏里披风与鞘翅共用一张图） */
const KIND_CHOICES = ['skin', 'cape'];
/** 界面模型名 → CSL 配置里的 model 值 */
const MODEL_TO_CSL = { classic: 'default', slim: 'slim' };

class SkinError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'SkinError';
    Object.assign(this, extra);
  }
}

// ---------------------------------------------------------------------------
// 目录
// ---------------------------------------------------------------------------

/** 皮肤库放在 instances.json 同目录（跟实例列表同一个可写数据目录） */
function dataRoot() {
  try {
    return path.dirname(instances.file());
  } catch {
    const base = process.env.VISKLUKE_DATA_DIR
      || (app && app.getPath ? app.getPath('userData') : '')
      || process.env.USERPROFILE
      || os.homedir();
    return base;
  }
}

function libraryDir() {
  return path.join(dataRoot(), LIB_DIR);
}

function libraryFilesDir() {
  return path.join(libraryDir(), 'files');
}

function indexPath() {
  return path.join(libraryDir(), LIB_INDEX);
}

/** 实例的 CSL 数据目录：<游戏目录>/CustomSkinLoader（会建出来，只给"写"用） */
function cslDirFor(instance) {
  const root = launcher.resolveGameRoot(instance || {});
  return { root, cslDir: path.join(root, CSL_DIR) };
}

/**
 * 只读版：不建目录、不写探针，猜一个游戏目录出来。
 * 状态查询 / 界面展示必须用这个 —— 目录不可写（安全软件拦了）也不该让面板整个报错。
 */
function peekCslDirFor(instance) {
  const peek = launcher.peekGameRoot(instance || {});
  return {
    root: peek.root,
    cslDir: peek.root ? path.join(peek.root, CSL_DIR) : '',
    exists: peek.exists,
  };
}

// ---------------------------------------------------------------------------
// PNG 校验
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 读 PNG 头里的宽高（不看内容，够用来判断是不是皮肤） */
function readPngInfo(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) {
    throw new SkinError('这个文件太小了，不像是 PNG 皮肤');
  }
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new SkinError('不是 PNG 文件（皮肤必须是 .png）');
  }
  if (buffer.subarray(12, 16).toString('ascii') !== 'IHDR') {
    throw new SkinError('PNG 文件头损坏（缺少 IHDR）');
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return { width, height };
}

/**
 * 合法尺寸：
 *   skin  64×64（1.8+）/ 64×32（旧版），以及整数倍高清皮肤
 *   cape  64×32（标准披风）/ 22×17（1.9 之前的旧披风），以及整数倍
 */
function isSkinSize(width, height, kind = 'skin') {
  if (!width || !height) return false;
  if (kind === 'cape') {
    if (width === 64 && height === 32) return true;
    if (width === 22 && height === 17) return true;
    return width === 64 * (height / 32) && height % 32 === 0;
  }
  if (width === height && width % 64 === 0) return true;
  if (width === height * 2 && height % 32 === 0) return true;
  return false;
}

function inspectSkin(buffer, kind = 'skin') {
  const { width, height } = readPngInfo(buffer);
  if (!isSkinSize(width, height, kind)) {
    throw new SkinError(
      kind === 'cape'
        ? `披风尺寸不对：${width}×${height}。需要 64×32（标准）或 22×17（旧版）`
        : `皮肤尺寸不对：${width}×${height}。需要 64×64（1.8+）或 64×32（旧版），也支持它们的整数倍高清皮肤`
    );
  }
  return { width, height };
}

// ---------------------------------------------------------------------------
// 玩家名
// ---------------------------------------------------------------------------

function normalizePlayerName(input) {
  const name = String(input || '').trim();
  if (!PLAYER_NAME_RE.test(name)) {
    throw new SkinError('玩家名不合法：只能是 3~16 位的字母、数字或下划线（和 Minecraft 用户名规则一致）');
  }
  return name;
}

// ---------------------------------------------------------------------------
// 皮肤库
// ---------------------------------------------------------------------------

function ensureLibrary() {
  fs.mkdirSync(libraryFilesDir(), { recursive: true });
}

function readIndex() {
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath(), 'utf8'));
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.skins)) return parsed.skins;
    return [];
  } catch {
    return [];
  }
}

function writeIndex(list) {
  ensureLibrary();
  const target = indexPath();
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, skins: list }, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, target);
}

function fileFor(entry) {
  return path.join(libraryFilesDir(), entry.file);
}

/** 给界面用的缩略图（小图，直接 base64 塞进 data URL） */
function previewFor(entry) {
  try {
    const buffer = fs.readFileSync(fileFor(entry));
    if (buffer.length > 512 * 1024) return '';
    return `data:image/png;base64,${buffer.toString('base64')}`;
  } catch {
    return '';
  }
}

function decorate(entry, options = {}) {
  return {
    id: entry.id,
    name: entry.name,
    kind: KIND_CHOICES.includes(entry.kind) ? entry.kind : 'skin',
    model: MODEL_CHOICES.includes(entry.model) ? entry.model : 'classic',
    width: entry.width,
    height: entry.height,
    bytes: entry.bytes,
    addedAt: entry.addedAt,
    boundPlayer: entry.boundPlayer || '',
    source: entry.source || 'import',
    missing: !fs.existsSync(fileFor(entry)),
    ...(options.preview ? { preview: previewFor(entry) } : {}),
  };
}

function listSkins(options = {}) {
  return readIndex()
    .filter((entry) => entry && entry.file)
    .map((entry) => decorate(entry, options))
    .sort((a, b) => String(b.addedAt || '').localeCompare(String(a.addedAt || '')));
}

/**
 * 导入一张皮肤。buffer 优先，其次 sourcePath（来自文件对话框）。
 * 内容相同的文件会被去重（sha256 作为 id）。
 */
function importSkin(options = {}) {
  const { sourcePath = '', buffer = null, name = '', model = 'classic', kind = 'skin', source = 'import' } = options;
  const entryKind = KIND_CHOICES.includes(kind) ? kind : 'skin';
  let data = buffer;
  if (!Buffer.isBuffer(data)) {
    if (!sourcePath) throw new SkinError('没有选择皮肤文件');
    let stat;
    try {
      stat = fs.statSync(sourcePath);
    } catch {
      throw new SkinError(`读不到这个文件：${sourcePath}`);
    }
    if (!stat.isFile()) throw new SkinError('选择的不是文件');
    if (stat.size > MAX_SKIN_BYTES) {
      throw new SkinError(`文件太大（${(stat.size / 1024).toFixed(0)} KB），最大 1 MB`);
    }
    data = fs.readFileSync(sourcePath);
  }
  if (data.length > MAX_SKIN_BYTES) {
    throw new SkinError(`文件太大（${(data.length / 1024).toFixed(0)} KB），最大 1 MB`);
  }

  const { width, height } = inspectSkin(data, entryKind);
  const hash = crypto.createHash('sha256').update(data).digest('hex');
  const id = `${entryKind.slice(0, 1)}${hash.slice(0, 15)}`;
  const fileName = `${entryKind}-${hash.slice(0, 28)}.png`;

  ensureLibrary();
  fs.writeFileSync(path.join(libraryFilesDir(), fileName), data);

  const list = readIndex();
  const existing = list.find((entry) => entry.file === fileName);
  const fallbackName = (
    name
    || (sourcePath ? path.basename(sourcePath, path.extname(sourcePath)) : '')
    || `${entryKind === 'cape' ? '披风' : '皮肤'} ${list.length + 1}`
  ).slice(0, 60);

  if (existing) {
    existing.width = width;
    existing.height = height;
    existing.bytes = data.length;
    existing.kind = entryKind;
    if (name) existing.name = fallbackName;
    if (MODEL_CHOICES.includes(model)) existing.model = model;
    writeIndex(list);
    return { ok: true, skin: decorate(existing, { preview: true }), duplicated: true };
  }

  const entry = {
    id,
    name: fallbackName,
    kind: entryKind,
    file: fileName,
    model: MODEL_CHOICES.includes(model) ? model : 'classic',
    width,
    height,
    bytes: data.length,
    addedAt: new Date().toISOString(),
    boundPlayer: '',
    lastAppliedAt: null,
    source: String(source || 'import').slice(0, 20),
  };
  list.push(entry);
  writeIndex(list);
  return { ok: true, skin: decorate(entry, { preview: true }), duplicated: false };
}

function findSkin(id) {
  const entry = readIndex().find((item) => item.id === id);
  if (!entry) throw new SkinError('皮肤不存在（可能已被删除）');
  if (!fs.existsSync(fileFor(entry))) throw new SkinError('皮肤文件丢失了，请重新导入');
  return entry;
}

function removeSkin(id) {
  const list = readIndex();
  const idx = list.findIndex((item) => item.id === id);
  if (idx < 0) throw new SkinError('皮肤不存在');
  const [entry] = list.splice(idx, 1);
  writeIndex(list);
  // 只有没有别的条目引用同一个文件时才删文件
  const stillUsed = list.some((item) => item.file === entry.file);
  if (!stillUsed) {
    try {
      fs.rmSync(path.join(libraryFilesDir(), entry.file), { force: true });
    } catch {
      /* ignore */
    }
  }
  return { ok: true, removed: entry.id };
}

function updateSkin(id, patch = {}) {
  const list = readIndex();
  const entry = list.find((item) => item.id === id);
  if (!entry) throw new SkinError('皮肤不存在');
  if (patch.name != null) entry.name = String(patch.name).slice(0, 60) || entry.name;
  if (patch.model != null) {
    if (!MODEL_CHOICES.includes(patch.model)) throw new SkinError(`不支持的模型：${patch.model}`);
    entry.model = patch.model;
  }
  if (patch.boundPlayer != null) {
    entry.boundPlayer = patch.boundPlayer ? normalizePlayerName(patch.boundPlayer) : '';
  }
  writeIndex(list);
  return { ok: true, skin: decorate(entry, { preview: true }) };
}

// ---------------------------------------------------------------------------
// 写到实例
// ---------------------------------------------------------------------------

function isLocalSkinProfile(entry) {
  if (!entry || typeof entry !== 'object') return false;
  const name = String(entry.name || '').toLowerCase();
  const skinPath = String(entry.skin || '').toLowerCase();
  return name === 'localskin' || skinPath.includes('localskin');
}

/** 读 JSON 配置：去掉 UTF-8 BOM（用户用记事本改过就会带上），解析失败返回 null */
function parseJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

/** 把模型写进 CSL 配置；配置还没生成时退而写 ExtraList（尽力而为） */
function applyModel(cslDir, model) {
  const cslModel = MODEL_TO_CSL[model] || 'default';
  const configFile = path.join(cslDir, CSL_CONFIG);
  const profile = {
    name: 'LocalSkin',
    type: 'Legacy',
    checkPNG: true,
    model: cslModel,
    skin: `${CSL_LOCAL_SKIN_DIR}/{USERNAME}.png`,
    cape: 'LocalSkin/capes/{USERNAME}.png',
    elytra: 'LocalSkin/elytras/{USERNAME}.png',
  };

  if (fs.existsSync(configFile)) {
    let config = parseJsonFile(configFile);
    if (config && typeof config === 'object') {
      const list = Array.isArray(config.loadlist) ? config.loadlist : [];
      const existing = list.find(isLocalSkinProfile);
      if (existing) {
        existing.model = cslModel;
      } else {
        list.push(profile);
      }
      config.loadlist = list;
      const tmp = `${configFile}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
      fs.renameSync(tmp, configFile);
      return { mode: 'config', model: cslModel, file: configFile };
    }
  }

  // 配置还不存在：写 ExtraList，CSL 首次启动会合并
  const extraDir = path.join(cslDir, CSL_EXTRALIST_DIR);
  fs.mkdirSync(extraDir, { recursive: true });
  const extraFile = path.join(extraDir, CSL_EXTRALIST_FILE);
  const tmp = `${extraFile}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify([profile], null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, extraFile);
  return { mode: 'extralist', model: cslModel, file: extraFile };
}

/** 当前 CSL 配置里 LocalSkin 的模型（读不到就 null） */
function readConfiguredModel(cslDir) {
  const config = parseJsonFile(path.join(cslDir, CSL_CONFIG));
  if (!config) return null;
  const list = Array.isArray(config.loadlist) ? config.loadlist : [];
  const entry = list.find(isLocalSkinProfile);
  if (!entry || !entry.model) return null;
  const model = String(entry.model).toLowerCase();
  if (model === 'slim') return 'slim';
  if (model === 'default') return 'classic';
  return 'auto';
}

function cslModInstalled(root) {
  try {
    return fs
      .readdirSync(path.join(root, 'mods'))
      .some((name) => /^customskinloader.*\.jar$/i.test(name));
  } catch {
    return false;
  }
}

/**
 * 把库里的一张皮肤应用到某个玩家（写入实例的 LocalSkin 目录）。
 * @param {{ instance: object, skinId: string, playerName: string, model?: string }} options
 */
function applySkin(options = {}) {
  const { instance, skinId, playerName, model = '' } = options;
  if (!instance || !instance.id) throw new SkinError('请先选择实例');
  const entry = findSkin(skinId);
  const name = normalizePlayerName(playerName || entry.boundPlayer);
  const chosenModel = MODEL_CHOICES.includes(model) ? model : entry.model;
  const kind = KIND_CHOICES.includes(entry.kind) ? entry.kind : 'skin';

  const { root, cslDir } = cslDirFor(instance);
  const kindDir = kind === 'cape' ? CSL_LOCAL_CAPE_DIR : CSL_LOCAL_SKIN_DIR;
  const skinDir = path.join(cslDir, kindDir);
  fs.mkdirSync(skinDir, { recursive: true });

  const target = path.join(skinDir, `${name}.png`);
  const tmp = `${target}.tmp`;
  fs.copyFileSync(fileFor(entry), tmp);
  fs.renameSync(tmp, target); // 原子替换，避免游戏读到半个文件

  // 披风同时写进 elytras：游戏里鞘翅用的就是披风贴图
  let elytraTarget = '';
  if (kind === 'cape') {
    const elytraDir = path.join(cslDir, CSL_LOCAL_ELYTRA_DIR);
    fs.mkdirSync(elytraDir, { recursive: true });
    elytraTarget = path.join(elytraDir, `${name}.png`);
    const elytraTmp = `${elytraTarget}.tmp`;
    fs.copyFileSync(fileFor(entry), elytraTmp);
    fs.renameSync(elytraTmp, elytraTarget);
  }

  // 皮肤才需要动 model；披风不涉及模型
  const modelResult = kind === 'skin' ? applyModel(cslDir, chosenModel) : { mode: 'skipped', model: null, file: '' };

  updateSkin(entry.id, { boundPlayer: name, model: chosenModel });
  const list = readIndex();
  const updated = list.find((item) => item.id === entry.id);
  if (updated) {
    updated.lastAppliedAt = new Date().toISOString();
    writeIndex(list);
  }

  return {
    ok: true,
    kind,
    root,
    cslDir,
    target,
    elytraTarget,
    playerName: name,
    model: chosenModel,
    modelWritten: modelResult,
    note:
      kind === 'cape'
        ? '披风已写入 LocalSkin/capes（同时写了 elytras，鞘翅会一起用）'
        : modelResult.mode === 'config'
          ? ''
          : 'CustomSkinLoader.json 还没生成（CSL 首次启动游戏后才有），已先写入 ExtraList；下次应用或 CSL 启动后模型设置才生效。',
  };
}

/** 删掉某个玩家的本地皮肤（皮肤 + 披风 + 鞘翅一起清） */
function clearSkin(options = {}) {
  const { instance, playerName } = options;
  if (!instance || !instance.id) throw new SkinError('请先选择实例');
  const name = normalizePlayerName(playerName);
  const { cslDir } = cslDirFor(instance);
  const targets = [
    path.join(cslDir, CSL_LOCAL_SKIN_DIR, `${name}.png`),
    path.join(cslDir, CSL_LOCAL_CAPE_DIR, `${name}.png`),
    path.join(cslDir, CSL_LOCAL_ELYTRA_DIR, `${name}.png`),
  ];
  const removed = [];
  for (const target of targets) {
    if (fs.existsSync(target)) {
      fs.rmSync(target, { force: true });
      removed.push(target);
    }
  }
  return { ok: true, removed: removed.length > 0, count: removed.length, playerName: name, targets: removed };
}

/** 扫实例里已经放了哪些本地素材 */
function appliedSkins(cslDir) {
  const scan = (dirName) => {
    const dir = path.join(cslDir, dirName);
    try {
      return fs
        .readdirSync(dir)
        .filter((name) => /\.png$/i.test(name))
        .map((name) => {
          const info = fs.statSync(path.join(dir, name));
          return { playerName: path.basename(name, '.png'), bytes: info.size, modifiedAt: info.mtime.toISOString() };
        });
    } catch {
      return [];
    }
  };
  const skins = scan(CSL_LOCAL_SKIN_DIR);
  const capes = scan(CSL_LOCAL_CAPE_DIR);
  const caped = new Set(capes.map((item) => item.playerName));
  return skins
    .map((item) => ({ ...item, hasCape: caped.has(item.playerName) }))
    .sort((a, b) => a.playerName.localeCompare(b.playerName));
}

// ---------------------------------------------------------------------------
// 状态 / 安装 CSL
// ---------------------------------------------------------------------------

function status(options = {}) {
  const instance = options.instance || null;
  const result = {
    library: listSkins({ preview: true }),
    dataRoot: dataRoot(),
    libraryDir: libraryDir(),
    instance: null,
    csl: {
      projectId: CSL_PROJECT_ID,
      slug: CSL_PROJECT_SLUG,
      url: `https://modrinth.com/mod/${CSL_PROJECT_SLUG}`,
      supportedLoaders: CSL_SUPPORTED_LOADERS,
    },
  };
  if (!instance || !instance.id) return result;

  // 只读：不建目录、不写探针（游戏目录被安全软件拦了也照样能看皮肤库）
  try {
    const peeked = peekCslDirFor(instance);
    result.instance = {
      id: instance.id,
      name: instance.name || '',
      root: peeked.root,
      cslDir: peeked.cslDir,
      rootExists: peeked.exists,
      configExists: peeked.cslDir ? fs.existsSync(path.join(peeked.cslDir, CSL_CONFIG)) : false,
      model: peeked.cslDir ? readConfiguredModel(peeked.cslDir) : null,
      modInstalled: peeked.root ? cslModInstalled(peeked.root) : false,
      loader: instance.loader || '',
      version: instance.version || '',
    };
    result.applied = peeked.cslDir ? appliedSkins(peeked.cslDir) : [];
  } catch (error) {
    // 状态查询失败不能连累整个面板：皮肤库照常返回，实例那部分留个错误说明
    result.instance = null;
    result.applied = [];
    result.instanceError = (error && error.message) || String(error);
  }
  return result;
}

/** 打开实例的 CSL 目录（没有就建出来） */
async function openFolder(options = {}) {
  const instance = options.instance;
  if (!instance || !instance.id) throw new SkinError('请先选择实例');
  const { cslDir } = cslDirFor(instance);
  fs.mkdirSync(path.join(cslDir, CSL_LOCAL_SKIN_DIR), { recursive: true });
  const error = await shell.openPath(cslDir);
  return error ? { ok: false, error, cslDir } : { ok: true, cslDir };
}

/**
 * 往实例里装 CSL 模组（走下载中心同一个 Modrinth 安装逻辑）。
 * @param {{ instance: object, onProgress?: Function }} options
 */
async function installCsl(options = {}) {
  const { instance, onProgress = () => {} } = options;
  if (!instance || !instance.id) throw new SkinError('请先选择实例');

  const loader = String(instance.loader || '').toLowerCase();
  if (!loader) {
    throw new SkinError(
      '这个实例没有加载器，装不了 CSL。请用 Fabric/Quilt 实例，或先装整合包（整合包实例自带加载器信息）。'
    );
  }
  if (!CSL_SUPPORTED_LOADERS.includes(loader)) {
    throw new SkinError(`CSL 不支持 ${loader} 加载器（支持 Fabric / Quilt / Forge / NeoForge）`);
  }  const version = String(instance.version || '').trim();
  if (!version) throw new SkinError('实例没有填写游戏版本，无法选择 CSL 版本');

  // 延迟 require，避免 store → launcher → skin 的环形依赖
  const store = require('./store');
  const result = await store.installProject({
    projectId: CSL_PROJECT_ID,
    projectType: 'mod',
    gameVersion: version,
    loader,
    instance,
    onProgress,
  });
  return {
    ok: true,
    file: result.file,
    dir: result.dir,
    versionNumber: result.versionNumber,
    gameVersions: result.gameVersions,
    loaders: result.loaders,
  };
}

module.exports = {
  SkinError,
  CSL_PROJECT_ID,
  CSL_PROJECT_SLUG,
  CSL_DIR,
  CSL_CONFIG,
  CSL_LOCAL_SKIN_DIR,
  CSL_LOCAL_CAPE_DIR,
  CSL_LOCAL_ELYTRA_DIR,
  KIND_CHOICES,
  CSL_EXTRALIST_FILE,
  MODEL_CHOICES,
  listSkins,
  importSkin,
  removeSkin,
  updateSkin,
  findSkin,
  applySkin,
  clearSkin,
  status,
  openFolder,
  installCsl,
  normalizePlayerName,
  inspectSkin,
  readPngInfo,
  isSkinSize,
  dataRoot,
  libraryDir,
  _internal: {
    readIndex,
    writeIndex,
    applyModel,
    readConfiguredModel,
    isLocalSkinProfile,
    cslModInstalled,
    appliedSkins,
    cslDirFor,
    peekCslDirFor,
    MODEL_TO_CSL,
  },
};
