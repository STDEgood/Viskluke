'use strict';

/**
 * settings.js —— 本机可调设置（用户偏好，不含密钥）
 *
 * 与 config.json 的区别：
 *   · config.json 存 Cloudflare Token 这类**敏感**信息，不进仓库；
 *   · settings.json 只存下载源、Java 路径、浏览器首页这类**普通偏好**，
 *     由设置页读写，可以放心展示给用户。
 *
 * 放在 <userData>/settings.json；userData 不可写时回落到 %APPDATA%\viskluke-launcher。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULTS = {
  // 下载源：mojang（官方）| bmclapi（国内镜像）| custom（自定义镜像）
  downloadSource: 'mojang',
  // 自定义镜像的根地址，例如 https://mirror.example.com
  customMirror: '',
  // 手动指定的 Java（留空 = 自动检测 / 自动下载）
  javaPath: '',
  // 微软正版登录用的 Azure 应用 client_id（没有它无法走设备码登录）
  msaClientId: '',
  // 内置浏览器首页 / 搜索（默认 Bing）
  browserHome: 'https://www.bing.com',
};

function dataDir() {
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') {
      const dir = app.getPath('userData');
      if (dir) return dir;
    }
  } catch {
    /* 纯 Node 环境（自检 / 脚本）没有 electron */
  }
  if (process.env.VISKLUKE_DATA_DIR) return path.resolve(process.env.VISKLUKE_DATA_DIR);
  const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(roaming, 'viskluke-launcher');
}

function file() {
  return path.join(dataDir(), 'settings.json');
}

function read() {
  try {
    const raw = fs.readFileSync(file(), 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

function write(patch = {}) {
  const next = { ...read(), ...patch };
  const target = file();
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  } catch {
    /* 写不进去就只在本进程生效 */
  }
  return next;
}

module.exports = { DEFAULTS, dataDir, file, read, write };
