'use strict';

/**
 * modpack-instance.js —— 整合包 → 自动建/复用实例 → 安装 → 写回"整合包"标注
 *
 * 职责边界：
 *   · store.js      只管把 .mrpack 解到实例目录（不懂"实例"这个概念）
 *   · 本文件        负责实例生命周期：没有就建一个专属实例，有就复用（等于续传修复），
 *                   装完把 版本 / 加载器 / 整合包元数据 写回 instances.json，界面据此显示
 *   · main.js       只做 IPC 转接
 *
 * repository 可注入（默认 instances.js），自检时用内存实现，避免写到真实数据目录。
 */

const path = require('path');
const instances = require('./instances');
const store = require('./store');

function slugify(text, fallback = 'modpack') {
  return (
    String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || fallback
  );
}

/** 同一个整合包重复安装时复用原有实例，避免实例列表里堆一堆同名条目 */
function findModpackInstance(projectId, repository = instances) {
  const list = repository.list();
  return (Array.isArray(list) ? list : []).find(
    (item) => item.modpack && item.modpack.projectId === projectId
  ) || null;
}

/**
 * @param {{ projectId: string, projectTitle?: string, gameVersion?: string, loader?: string }} options
 * @param {{ onProgress?: Function, repository?: object, storeModule?: object }} hooks
 */
async function installModpackInstance(options = {}, hooks = {}) {
  const {
    onProgress = () => {},
    repository = instances,
    storeModule = store,
  } = hooks;

  const projectId = String(options.projectId || '').trim();
  if (!projectId) throw new Error('缺少整合包项目 ID');
  const title = String(options.projectTitle || projectId).trim();

  let instance = findModpackInstance(projectId, repository);
  const created = !instance;

  if (!instance) {
    instance = {
      id: `mp-${slugify(title)}-${Date.now().toString(36)}`,
      name: title,
      version: String(options.gameVersion || '').trim(),
      maxMemory: '4G',
      minMemory: '2G',
      javaPath: '',
      loader: '',
      loaderVersion: '',
      // 正常情况下由 launcher 按默认策略挑目录；显式给了就固定下来（自检 / 便携场景用）
      ...(options.gameDir ? { gameDir: String(options.gameDir) } : {}),
      modpack: {
        projectId,
        projectType: 'modpack',
        name: title,
        status: 'installing',
        installedAt: null,
      },
    };
    const saved = repository.save(instance);
    if (!Array.isArray(saved)) {
      throw new Error('实例列表写入失败，无法为整合包创建实例（检查 userData 是否可写）');
    }
  }

  let result;
  try {
    result = await storeModule.installModpack({ ...options, instance, onProgress });
  } catch (error) {
    // 安装失败也保留实例：下次点「安装整合包」会复用它续传，不必重新建
    try {
      repository.save({
        ...instance,
        modpack: {
          ...(instance.modpack || {}),
          projectId,
          projectType: 'modpack',
          name: title,
          status: 'failed',
          error: (error && error.message) || String(error),
        },
      });
    } catch {
      /* ignore */
    }
    throw error;
  }

  const stats = result.stats || {};
  const pack = result.pack || {};
  const failures = result.failures || [];
  const next = {
    ...instance,
    name: pack.name || instance.name || title,
    version: pack.minecraftVersion || instance.version || '',
    loader: pack.loader || '',
    loaderVersion: pack.loaderVersion || '',
    modpack: {
      projectId,
      projectType: 'modpack',
      name: pack.name || title,
      versionId: pack.versionId || '',
      formatVersion: pack.formatVersion || 1,
      minecraftVersion: pack.minecraftVersion || '',
      loader: pack.loader || '',
      loaderVersion: pack.loaderVersion || '',
      file: result.file || '',
      files: (stats.downloaded || 0) + (stats.skipped || 0),
      overrides: stats.overrides || 0,
      failed: failures.length,
      status: failures.length ? 'partial' : 'ready',
      installedAt: new Date().toISOString(),
    },
  };

  const saved = repository.save(next);
  const stored = (Array.isArray(saved) ? saved : []).find((item) => item.id === next.id) || next;
  return { ...result, instance: stored, reused: !created };
}

module.exports = { installModpackInstance, findModpackInstance, slugify };
