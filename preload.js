'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * 订阅主进程事件，返回取消订阅函数（避免视图切换时重复绑定）。
 */
function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, payload) => {
    try {
      callback(payload);
    } catch (err) {
      console.error(`[viskluke] ${channel} 回调异常:`, err);
    }
  };
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('viskluke', {
  // ---------------- 登录 / 游戏 ----------------
  authOffline: (name) => ipcRenderer.invoke('auth:offline', name),
  authStart: () => ipcRenderer.invoke('auth:start'),
  authRefresh: (refreshToken) => ipcRenderer.invoke('auth:refresh', refreshToken),
  launch: (config) => ipcRenderer.invoke('launch:start', config),
  openGameRoot: (instance) => ipcRenderer.invoke('launch:open-root', instance),

  // ---------------- 下载中心 ----------------
  storeVersions: (options) => ipcRenderer.invoke('store:versions', options),
  storeSearch: (options) => ipcRenderer.invoke('store:search', options),
  storeInstall: (options) => ipcRenderer.invoke('store:install', options),
  onStoreProgress: (cb) => subscribe('store:progress', cb),

  // ---------------- 实例 ----------------
  listInstances: () => ipcRenderer.invoke('instances:list'),
  saveInstance: (instance) => ipcRenderer.invoke('instances:save', instance),
  removeInstance: (id) => ipcRenderer.invoke('instances:remove', id),

  // ---------------- 皮肤（离线皮肤 / CSL） ----------------
  skinStatus: (payload) => ipcRenderer.invoke('skin:status', payload),
  skinImport: (payload) => ipcRenderer.invoke('skin:import', payload),
  skinSetModel: (id, model) => ipcRenderer.invoke('skin:set-model', { id, model }),
  skinRename: (id, name) => ipcRenderer.invoke('skin:rename', { id, name }),
  skinSaveDrawing: (payload) => ipcRenderer.invoke('skin:save-drawing', payload),
  skinRemove: (id) => ipcRenderer.invoke('skin:remove', { id }),
  skinApply: (payload) => ipcRenderer.invoke('skin:apply', payload),
  skinClear: (payload) => ipcRenderer.invoke('skin:clear', payload),
  skinOpenFolder: (payload) => ipcRenderer.invoke('skin:open-folder', payload),
  skinInstallCsl: (payload) => ipcRenderer.invoke('skin:install-csl', payload),

  // ---------------- 一键开服 ----------------
  serverList: () => ipcRenderer.invoke('server:list'),
  serverLogs: (serverId) => ipcRenderer.invoke('server:logs', serverId),
  serverStart: (options) => ipcRenderer.invoke('server:start', options),
  serverStop: (serverId, options = {}) => ipcRenderer.invoke('server:stop', { id: serverId, ...options }),
  serverDelete: (serverId, options = {}) => ipcRenderer.invoke('server:delete', { id: serverId, ...options }),
  serverCommand: (serverId, command) =>
    ipcRenderer.invoke('server:command', { id: serverId, command }),
  serverWhitelist: (serverId, payload = {}) =>
    ipcRenderer.invoke('server:whitelist', { id: serverId, ...payload }),
  serverLan: () => ipcRenderer.invoke('server:lan'),
  serverPublicIp: () => ipcRenderer.invoke('server:public-ip'),
  netReport: (payload) => ipcRenderer.invoke('net:report', payload),
  netUnmap: (port) => ipcRenderer.invoke('net:unmap', { port }),
  netProbe: (payload) => ipcRenderer.invoke('net:probe', payload),
  relaySuggestRoom: (prefix) => ipcRenderer.invoke('relay:suggest-room', { prefix }),
  relayStatus: () => ipcRenderer.invoke('relay:status'),
  relayHostStart: (payload) => ipcRenderer.invoke('relay:host-start', payload),
  relayHostStop: () => ipcRenderer.invoke('relay:host-stop'),
  relayGuestStart: (payload) => ipcRenderer.invoke('relay:guest-start', payload),
  relayGuestStop: () => ipcRenderer.invoke('relay:guest-stop'),
  serverSyncDns: (serverId) => ipcRenderer.invoke('server:sync-dns', serverId),
  serverRemoveDns: (serverId) => ipcRenderer.invoke('server:remove-dns', serverId),
  serverOpenFolder: (serverId) => ipcRenderer.invoke('server:open-folder', serverId),
  serverJava: () => ipcRenderer.invoke('server:java'),

  // ---------------- Viskluke Address / Cloudflare ----------------
  cfStatus: () => ipcRenderer.invoke('cf:status'),
  cfVerify: () => ipcRenderer.invoke('cf:verify'),
  cfRevealConfig: () => ipcRenderer.invoke('cf:reveal-config'),
  cfConnect: (token) => ipcRenderer.invoke('cf:connect', token),
  cfAddZone: (payload) => ipcRenderer.invoke('cf:add-zone', payload),
  cfRemoveZone: (suffix) => ipcRenderer.invoke('cf:remove-zone', { suffix }),
  cfAddManualZone: (suffix) => ipcRenderer.invoke('cf:add-manual-zone', { suffix }),
  cfRemoveManualZone: (suffix) => ipcRenderer.invoke('cf:remove-manual-zone', { suffix }),
  cfOpenTokenPage: () => ipcRenderer.invoke('cf:open-token-page'),

  // ---------------- 事件订阅 ----------------
  onDeviceCode: (cb) => subscribe('auth:device-code', cb),
  onLog: (cb) => subscribe('launch:log', cb),
  onServerLog: (cb) => subscribe('server:log', cb),
  onServerStatus: (cb) => subscribe('server:status', cb),
  onServerProgress: (cb) => subscribe('server:progress', cb),
  onServerDns: (cb) => subscribe('server:dns', cb),
  onServerReady: (cb) => subscribe('server:ready', cb),

  // ---------------- 系统 ----------------
  appInfo: () => ipcRenderer.invoke('app:info'),
  openLog: () => ipcRenderer.invoke('app:open-log'),
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
});
