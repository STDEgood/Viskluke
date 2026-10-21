'use strict';

/**
 * instances.js —— 实例列表持久化
 *
 * 历史 bug：直接 fs.writeFileSync(userData/instances.json)，
 *   · 没 mkdir，目录不存在就 ENOENT
 *   · 写失败直接抛给 IPC，渲染层只拿到 {ok:false}，界面表现成"点了没反应"，
 *     于是用户反复点「创建实例」→ 看起来就是死循环
 * 现在：确保目录存在；userData 不可写时自动落到 %USERPROFILE%\Viskluke\data。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { app } = require('electron');

const FILE_NAME = 'instances.json';

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const probe = path.join(dir, '.write-test');
  fs.writeFileSync(probe, 'ok', 'utf8');
  fs.rmSync(probe, { force: true });
}

function homeDir() {
  return process.env.USERPROFILE || os.homedir();
}

/**
 * 老版本（开发模式）的数据在 `%USERPROFILE%\data`（因为 app.getAppPath() 的上级是 C:\Users\<用户>）。
 * 装成安装版以后程序目录变了，必须显式认这个位置，否则用户的实例列表会"凭空消失"。
 */
function legacyDir() {
  return path.join(homeDir(), 'data');
}

/** 写盘优先级：先规范位置（%USERPROFILE%\Viskluke\data），最后才是临时目录 */
function candidates() {
  const list = [];
  // 0) 显式指定（便携模式 / 自检 / 截图脚本用，平时不设这个变量）
  if (process.env.VISKLUKE_DATA_DIR) list.push(path.resolve(process.env.VISKLUKE_DATA_DIR));
  // 1) 规范位置（安装版不受程序目录变化影响，卸载也不会删数据）
  list.push(path.join(homeDir(), 'Viskluke', 'data'));
  // 2) userData
  try {
    list.push(app.getPath('userData'));
  } catch {
    /* ignore */
  }
  // 3) 程序自身目录下的 data（安全软件的"隔离运行"通常仍允许写程序目录）
  try {
    list.push(path.join(path.dirname(app.getAppPath ? app.getAppPath() : __dirname), 'data'));
  } catch {
    /* ignore */
  }
  try {
    list.push(path.join(__dirname, 'data'));
  } catch {
    /* ignore */
  }
  // 4) 旧位置 + 临时目录
  list.push(legacyDir());
  list.push(path.join(os.tmpdir(), 'viskluke-data'));
  return [...new Set(list)];
}

/** 读盘顺序：旧位置优先，这样安装版也能直接看到开发版时期建的实例 */
function readCandidates() {
  return [...new Set([legacyDir(), ...candidates()])];
}

/** 找到 instances.json 的路径：已有的原地复用，没有就挑第一个可写目录 */
function resolveFile() {
  // 显式指定（便携模式 / 自检 / 截图）优先级最高，不与任何已有文件"猜"位置
  if (process.env.VISKLUKE_DATA_DIR) {
    const dir = path.resolve(process.env.VISKLUKE_DATA_DIR);
    ensureDir(dir);
    return path.join(dir, FILE_NAME);
  }
  const errors = [];
  // 1) 已经存在的数据文件优先原地复用 —— 读写必须是同一个文件，
  //    否则会出现"界面读到旧的、保存写到新目录"的分裂（用户看到实例消失）
  for (const dir of readCandidates()) {
    const target = path.join(dir, FILE_NAME);
    if (!fs.existsSync(target)) continue;
    try {
      ensureDir(dir);
      return target;
    } catch (error) {
      errors.push(`${target}: ${error.code || error.message}（只读，跳过）`);
    }
  }
  // 2) 全新安装：第一个可写目录
  for (const dir of candidates()) {
    try {
      ensureDir(dir);
      return path.join(dir, FILE_NAME);
    } catch (error) {
      errors.push(`${dir}: ${error.code || error.message}`);
    }
  }
  throw new Error(`找不到可写目录来保存实例列表：\n${errors.join('\n')}`);
}

function file() {
  return resolveFile();
}

/** 只读：按读盘顺序找第一个存在的文件 */
function existingFile() {
  if (process.env.VISKLUKE_DATA_DIR) {
    const target = path.join(path.resolve(process.env.VISKLUKE_DATA_DIR), FILE_NAME);
    return fs.existsSync(target) ? target : null;
  }
  for (const dir of readCandidates()) {
    const target = path.join(dir, FILE_NAME);
    if (fs.existsSync(target)) return target;
  }
  return null;
}

function readAll(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function list() {
  const found = existingFile();
  return found ? readAll(found) : [];
}

function writeAll(filePath, all) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function save(instance) {
  const target = file(); // 可写路径（会抛明确错误）
  const all = readAll(target);
  const idx = all.findIndex((i) => i.id === instance.id);
  if (idx >= 0) {
    all[idx] = { ...all[idx], ...instance };
  } else {
    all.push({ ...instance, id: instance.id || `${Date.now()}` });
  }
  writeAll(target, all);
  return all;
}

function remove(id) {
  const target = file();
  const all = readAll(target).filter((i) => i.id !== id);
  writeAll(target, all);
  return all;
}

module.exports = { list, save, remove, file, existingFile };
