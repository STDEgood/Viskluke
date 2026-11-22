'use strict';

/**
 * datadrive.js —— 读取 YiStarLine Account 的独立数据盘，把 Minecraft 存档放进去
 *
 * YAUA 的 datadrive 功能会：
 *   · 从 C: 压缩出一个新分区（例如 D:）
 *   · 把 C:\Users\<用户>\YiStarLineAccount 变成指向 D:\Account 的 junction
 *   · 在盘根建 saves 目录（日志里 "Saves folder: D:\saves"）
 *
 * 这里做两件事：
 *   1. 自动发现这个盘（不依赖 YAUA 登录态，直接读文件系统）
 *   2. 把实例的 saves 目录做成 junction，指向 <盘>:\saves\<实例>，
 *      这样游戏照常写 <gameDir>\saves，实际落在 YAUA 的独立盘里
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

function home() {
  return process.env.USERPROFILE || os.homedir();
}

/** 找出 YAUA 根目录（junction 解析后）与所在盘符 */
function resolveYauaRoot() {
  const candidates = [];
  candidates.push(path.join(home(), 'YiStarLineAccount'));
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    candidates.push(`${letter}:\\Account`);
    candidates.push(`${letter}:\\YiStarLineAccount`);
  }
  for (const candidate of candidates) {
    try {
      const real = fs.realpathSync(candidate);
      const hasData =
        fs.existsSync(path.join(real, 'data', 'runtime.json')) ||
        fs.existsSync(path.join(real, 'app')) ||
        fs.existsSync(path.join(real, 'data', 'accounts.db'));
      if (!hasData) continue;
      return {
        root: real,
        link: candidate,
        drive: path.parse(real).root,
      };
    } catch {
      /* 下一个 */
    }
  }
  return null;
}

/** 存档根目录：优先 <盘>:\saves，退而求其次 <YAUA 根>\saves */
function savesRoot() {
  const info = resolveYauaRoot();
  if (!info) return null;
  const candidates = [path.join(info.drive, 'saves'), path.join(info.root, 'saves')];
  for (const candidate of candidates) {
    try {
      fs.mkdirSync(candidate, { recursive: true });
      const probe = path.join(candidate, '.viskluke-write-test');
      fs.writeFileSync(probe, 'ok');
      fs.rmSync(probe, { force: true });
      return { ...info, saves: candidate };
    } catch {
      /* 试下一个 */
    }
  }
  return null;
}

function isJunction(target) {
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isSymbolicLink()) return { link: false };
    return { link: true, to: fs.realpathSync(target) };
  } catch {
    return { link: false };
  }
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else if (entry.isFile()) {
      if (!fs.existsSync(dst)) fs.writeFileSync(dst, fs.readFileSync(src));
    }
  }
}

/**
 * 把实例的 saves 指向独立盘。返回 { ok, saves, target, moved }
 * 已有存档会先复制到目标，再把原目录改名备份，最后建 junction。
 */
function linkInstanceSaves(gameRoot, instanceId) {
  const root = savesRoot();
  if (!root) return { ok: false, reason: 'datadrive_not_found' };
  const safeId = String(instanceId || 'instance').replace(/[^A-Za-z0-9._-]+/g, '-');
  const target = path.join(root.saves, safeId);
  const link = path.join(gameRoot, 'saves');
  fs.mkdirSync(target, { recursive: true });

  const current = isJunction(link);
  if (current.link) {
    if (path.resolve(current.to) === path.resolve(target)) {
      return { ok: true, saves: root.saves, target, moved: false, already: true };
    }
    fs.unlinkSync(link);
  } else if (fs.existsSync(link)) {
    const entries = fs.readdirSync(link);
    if (entries.length) copyDir(link, target);
    fs.renameSync(link, `${link}.local-${Date.now()}`);
  }

  fs.symlinkSync(target, link, 'junction');
  return { ok: true, saves: root.saves, target, moved: true };
}

function status() {
  const root = savesRoot();
  return root
    ? { available: true, drive: root.drive, root: root.root, saves: root.saves }
    : { available: false };
}

module.exports = { status, linkInstanceSaves, resolveYauaRoot, savesRoot };
