'use strict';

/*
 * scripts/selftest.js —— 开服 / 域名解析逻辑自检（手动运行）
 *
 *   node scripts/selftest.js                     基础用例（假 spawn + 假 Cloudflare）
 *   HARNESS_DOWNLOAD=1 node scripts/selftest.js  额外真实下载 Vanilla 服务端（约 50MB）
 *
 * 为了在无 GUI 环境跑通：child_process.spawn 用假实现代替真实 Java 进程，
 * Cloudflare 请求被拦截，Mojang / Paper / Fabric 的元数据接口是真实请求。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

const ROOT = path.resolve(__dirname, '..');
const USER_DATA = path.join(ROOT, '.selftest-data');
fs.rmSync(USER_DATA, { recursive: true, force: true });
fs.mkdirSync(path.join(USER_DATA, 'servers'), { recursive: true });

process.env.CF_API_TOKEN = 'test-token';
process.env.CF_ZONE_ID = 'zone-abc';
process.env.CF_PUBLIC_IP = '203.0.113.10';
process.env.CF_TTL = '120';
// 实例列表 / 皮肤库都落到 .selftest-data，绝不碰真实数据目录（C:\Users\Ystar\data）
process.env.VISKLUKE_DATA_DIR = path.join(USER_DATA, 'data');

// ---------------------------------------------------------------- stubs
const Module = require('module');
const origLoad = Module._load;
const events = [];
const fakeWindow = {
  isDestroyed: () => false,
  webContents: { send: (channel, payload) => events.push({ channel, payload }) },
};
const openedPaths = [];
/** 假的 MCLC：只记录 launch 参数，不真的起进程（自检用） */
const mcclcLaunches = [];
class FakeMclcClient {
  constructor() {
    this.handlers = {};
  }
  on(event, handler) {
    this.handlers[event] = handler;
    return this;
  }
  async launch(options) {
    mcclcLaunches.push(options);
    return { pid: 4242 };
  }
}

Module._load = function (request) {
  if (request === 'minecraft-launcher-core') {
    return { Client: FakeMclcClient };
  }
  if (request === 'electron') {
    return {
      app: { getPath: () => USER_DATA, getAppPath: () => ROOT },
      shell: {
        openPath: async (p) => { openedPaths.push(p); return ''; },
        showItemInFolder: () => {},
        openExternal: async () => {},
      },
    };
  }
  return origLoad.apply(this, arguments);
};

// ---- axios: fake only for api.cloudflare.com, real for everything else
const axiosPath = require.resolve(path.join(ROOT, 'node_modules', 'axios'));
const realAxios = require(axiosPath);
const cfStore = [];
let cfId = 0;
const cfCalls = [];
let cfOverride = null;
const mojangLookups = [];

function cfRoute(config) {
  const url = String(config.url || '');
  const method = String(config.method || 'get').toUpperCase();
  cfCalls.push({ method, url, data: config.data });
  if (cfOverride) {
    const result = cfOverride({ method, url, data: config.data });
    if (result) return Promise.resolve(result);
  }
  return Promise.resolve(cfDefault({ method, url, data: config.data }));
}

function cfDefault({ method, url, data }) {
  const ok = (result) => ({ status: 200, data: { success: true, result } });
  const idMatch = /\/dns_records\/([^/?]+)$/.exec(url);

  if (method === 'GET' && url.includes('/user/tokens/verify')) {
    return ok({ id: 'token-id', status: 'active' });
  }
  if (method === 'GET' && url.includes('/dns_records')) {
    const name = new URL(url).searchParams.get('name') || '';
    return ok(cfStore.filter((record) => record.name === decodeURIComponent(name) && !record.deleted));
  }
  if (method === 'GET' && /\/zones(\?|$)/.test(url)) {
    // 账号下的 Zone 列表：故意只返回两个后缀，用于验证 missing 计算
    return ok([
      { id: 'zone-stde', name: 'stde.eu.cc' },
      { id: 'zone-ys2', name: 'ys2video.eu.cc' },
    ]);
  }
  if (method === 'POST' && url.endsWith('/dns_records')) {
    if (data && data.type === 'SRV' && !data.data) {
      return { status: 400, data: { success: false, errors: [{ code: 9005, message: 'SRV requires data' }] } };
    }
    const record = { id: `cf_${++cfId}`, ...data };
    cfStore.push(record);
    return ok(record);
  }
  if (method === 'PUT' && idMatch) {
    const record = cfStore.find((r) => r.id === idMatch[1]);
    Object.assign(record, data);
    return ok(record);
  }
  if (method === 'DELETE' && idMatch) {
    const record = cfStore.find((r) => r.id === idMatch[1]);
    if (!record) return { status: 404, data: { success: false, errors: [{ code: 81044, message: 'not found' }] } };
    record.deleted = true;
    return ok({ id: record.id });
  }
  return { status: 400, data: { success: false, errors: [{ code: 1, message: `unhandled ${method} ${url}` }] } };
}

function routedAxios(config) {
  const url = String(config.url || '');
  if (url.startsWith('https://api.cloudflare.com/client/v4')) return cfRoute(config);
  // Mojang 用户名 → UUID 查询：自检里固定返回"查无此人"，保证离线可跑
  if (url.startsWith('https://api.mojang.com/')) {
    mojangLookups.push(url);
    return Promise.resolve({ status: 204, data: '', headers: {} });
  }
  return realAxios(config);
}
routedAxios.get = (url, config) => routedAxios({ ...(config || {}), method: 'get', url });
routedAxios.post = (url, data, config) => routedAxios({ ...(config || {}), method: 'post', url, data });
routedAxios.put = (url, data, config) => routedAxios({ ...(config || {}), method: 'put', url, data });
routedAxios.delete = (url, config) => routedAxios({ ...(config || {}), method: 'delete', url });
require.cache[axiosPath].exports = routedAxios;

// ---- child_process.spawn 假实现（沙箱里真实 spawn 会 EPERM）
const cp = require('child_process');
const spawned = [];
cp.spawn = function fakeSpawn(exe, args = [], options = {}) {
  const proc = new EventEmitter();
  proc.exe = exe;
  proc.args = args;
  proc.options = options;
  proc.pid = 4000 + spawned.length;
  proc.killed = false;
  proc.stdinWrites = [];
  proc.stdin = new PassThrough();
  proc.stdin.on('data', (chunk) => proc.stdinWrites.push(chunk.toString()));
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = (signal) => {
    proc.killed = true;
    setImmediate(() => proc.emit('exit', null, signal || 'SIGTERM'));
  };
  spawned.push(proc);

  if (args[0] === '-version') {
    proc.stderr.write('openjdk version "17.0.20.1" 2026-08-18\nOpenJDK Runtime Environment Temurin-17.0.20.1+1\n');
    setImmediate(() => proc.emit('close', 0));
  } else {
    setImmediate(() => proc.emit('spawn'));
  }
  return proc;
};

// ---------------------------------------------------------------- harness
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`FAIL  ${name}\n      ${err.message}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = () => sleep(20);

// ---------------------------------------------------------------- load modules
const cloudflare = require(path.join(ROOT, 'cloudflare.js'));
const server = require(path.join(ROOT, 'server.js'));
const internals = server._internal;

(async () => {
  server.attachWindow(fakeWindow);

  // =====================================================================
  // 1. 纯函数
  // =====================================================================
  await test('parseJavaVersion 解析 Java 8 / 17 / 21', () => {
    assert.strictEqual(internals.parseJavaVersion('java version "1.8.0_402"').major, 8);
    assert.strictEqual(internals.parseJavaVersion('openjdk version "17.0.20.1" 2026-08-18').major, 17);
    assert.strictEqual(internals.parseJavaVersion('openjdk version "21.0.5" 2024-10-15').major, 21);
    assert.strictEqual(internals.parseJavaVersion('garbage'), null);
  });

  await test('requiredJavaMajor 版本推断', () => {
    assert.strictEqual(internals.requiredJavaMajor('1.16.5'), 8);
    assert.strictEqual(internals.requiredJavaMajor('1.17.1'), 16);
    assert.strictEqual(internals.requiredJavaMajor('1.19.4'), 17);
    assert.strictEqual(internals.requiredJavaMajor('1.20.4'), 17);
    assert.strictEqual(internals.requiredJavaMajor('1.20.6'), 21);
    assert.strictEqual(internals.requiredJavaMajor('1.21.1'), 21);
    assert.strictEqual(internals.requiredJavaMajor('26.3'), 25);
  });

  await test('buildMeta 正常输入', () => {
    const meta = internals.buildMeta({
      core: 'paper', version: '1.20.4', maxMemory: '2g', prefix: 'MyMineCraft',
      suffix: 'stde.eu.cc', port: 25565,
    });
    assert.strictEqual(meta.core, 'paper');
    assert.strictEqual(meta.maxMemory, '2G');
    assert.strictEqual(meta.prefix, 'myminecraft');
    assert.strictEqual(meta.address, 'myminecraft.stde.eu.cc');
    assert.ok(meta.id.startsWith('paper-1.20.4'));
    assert.strictEqual(meta.dnsRequested, true);
    assert.strictEqual(meta.onlineMode, true);
  });

  await test('buildMeta 允许空前缀（不绑定域名）', () => {
    const meta = internals.buildMeta({ core: 'vanilla', version: '1.21', prefix: '', enableDns: false });
    assert.strictEqual(meta.address, '');
    assert.strictEqual(meta.dnsRequested, false);
  });

  await test('buildMeta 校验非法输入', () => {
    assert.throws(() => internals.buildMeta({ core: 'spigot', version: '1.20' }), /服务器核心/);
    assert.throws(() => internals.buildMeta({ core: 'paper', version: '../etc' }), /版本格式/);
    assert.throws(() => internals.buildMeta({ core: 'paper', version: '1.20', maxMemory: '2GB' }), /内存格式/);
    assert.throws(() => internals.buildMeta({ core: 'paper', version: '1.20', maxMemory: '65G' }), /不能大于/);
    assert.throws(() => internals.buildMeta({ core: 'paper', version: '1.20', prefix: '-bad' }), /前缀/);
    assert.throws(() => internals.buildMeta({ core: 'paper', version: '1.20', prefix: 'www' }), /保留字/);
    // 没绑定过的域名会被拦住（内置三个之外要先在「域名管理」里绑定）
    assert.throws(() => internals.buildMeta({ core: 'paper', version: '1.20', suffix: 'evil.com' }), /还没有绑定/);
    assert.throws(() => internals.buildMeta({ core: 'paper', version: '1.20', suffix: 'not a domain' }), /不合法/);
  });

  await test('serverDir 阻止路径穿越', () => {
    assert.throws(() => internals.serverDir('../../evil'), /非法/);
    assert.throws(() => internals.serverDir('a/../../b'), /非法/);
    assert.throws(() => internals.serverDir('..'), /非法/);
    assert.throws(() => internals.serverDir(''), /非法/);
    const dir = internals.serverDir('paper-1.20.4');
    assert.ok(dir.startsWith(internals.serversRoot()));
  });

  await test('server.properties 读写保持其它键', () => {
    const file = path.join(USER_DATA, 'props-test.properties');
    internals.writeProperties(file, { 'server-port': '25565', motd: 'a=b', 'view-distance': '10' });
    const read = internals.readProperties(file);
    assert.strictEqual(read['server-port'], '25565');
    assert.strictEqual(read.motd, 'a=b');
    assert.strictEqual(read['view-distance'], '10');
  });

  await test('formatBytes', () => {
    assert.strictEqual(internals.formatBytes(0), '未知大小');
    assert.strictEqual(internals.formatBytes(512), '512 B');
    assert.strictEqual(internals.formatBytes(1024 * 1024 * 50), '50.0 MB');
  });

  // =====================================================================
  // 2. 端口
  // =====================================================================
  await test('isPortFree / pickFreePort 跳过被占用端口', async () => {
    const net = require('net');
    const blocker = net.createServer();
    await new Promise((resolve) => blocker.listen(25565, '0.0.0.0', resolve));
    try {
      assert.strictEqual(await internals.isPortFree(25565), false);
      const picked = await internals.pickFreePort(25565, null);
      assert.ok(picked > 25565 && picked <= 25595, `picked=${picked}`);
      assert.strictEqual(await internals.isPortFree(picked), true);
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });

  // =====================================================================
  // 3. 真实网络：各核心的下载地址解析
  // =====================================================================
  await test('resolveVanilla 1.20.4 返回官方 server.jar', async () => {
    const info = await internals.resolveVanilla('1.20.4');
    assert.ok(/piston-data\.mojang\.com.*server\.jar$/.test(info.url), info.url);
    assert.ok(info.sha1 && info.size > 40 * 1024 * 1024);
  });

  await test('resolveVanilla 未知版本给出可读错误', async () => {
    await assert.rejects(() => internals.resolveVanilla('99.99.99'), /版本清单里没有/);
  });

  await test('resolvePaper 1.20.4 走 Fill v3', async () => {
    const info = await internals.resolvePaper('1.20.4');
    assert.ok(info.url.startsWith('https://fill-data.papermc.io/'), info.url);
    assert.ok(info.sha256 && info.sha256.length === 64);
    assert.strictEqual(typeof info.buildId, 'number');
  });

  await test('resolvePaper 不存在的版本抛错', async () => {
    await assert.rejects(() => internals.resolvePaper('99.99.99'), /无法获取 Paper/);
  });

  await test('resolveFabric 1.20.4 返回 loader + installer', async () => {
    const info = await internals.resolveFabric('1.20.4');
    assert.ok(/^\d+\.\d+\.\d+$/.test(info.loaderVersion), info.loaderVersion);
    assert.ok(info.installerUrl.includes('fabric-installer'));
    assert.ok(info.installerVersion);
  });

  // =====================================================================
  // 4. cloudflare.js（假 API）
  // =====================================================================
  await test('cloudflare.status 不泄露 token', () => {
    const status = cloudflare.status();
    assert.strictEqual(status.configured, true);
    assert.strictEqual(status.mode, 'ip');
    assert.deepStrictEqual(status.suffixes, cloudflare.SUFFIXES);
    assert.ok(!JSON.stringify(status).includes('test-token'));
  });

  await test('cloudflare.verify 校验 token', async () => {
    const result = await cloudflare.verify();
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.tokenStatus, 'active');
  });

  await test('cloudflare.sync 创建 A + SRV', async () => {
    cfCalls.length = 0;
    const info = await cloudflare.sync({ prefix: 'myminecraft', suffix: 'stde.eu.cc', port: 25565 });
    assert.strictEqual(info.address, 'myminecraft.stde.eu.cc');
    assert.strictEqual(info.mode, 'ip');
    assert.strictEqual(info.targetIp, '203.0.113.10');
    assert.ok(info.records.a && info.records.srv);

    const aCall = cfCalls.find((c) => c.method === 'POST' && c.data.type === 'A');
    assert.strictEqual(aCall.data.name, 'myminecraft.stde.eu.cc');
    assert.strictEqual(aCall.data.content, '203.0.113.10');
    assert.strictEqual(aCall.data.proxied, false);
    assert.strictEqual(aCall.data.ttl, 120);

    const srvCall = cfCalls.find((c) => c.method === 'POST' && c.data.type === 'SRV');
    assert.strictEqual(srvCall.data.name, '_minecraft._tcp.myminecraft.stde.eu.cc');
    assert.strictEqual(srvCall.data.data.service, '_minecraft');
    assert.strictEqual(srvCall.data.data.proto, '_tcp');
    assert.strictEqual(srvCall.data.data.port, 25565);
    assert.strictEqual(srvCall.data.data.target, 'myminecraft.stde.eu.cc');
    assert.strictEqual(srvCall.data.data.priority, 0);
  });

  await test('cloudflare.sync 端口变化时更新已有记录（PUT）', async () => {
    cfCalls.length = 0;
    const previous = {
      zoneId: 'zone-abc',
      records: cfStore.filter((r) => r.name === 'myminecraft.stde.eu.cc' || r.name.startsWith('_minecraft'))
        .reduce((acc, r) => { acc[r.type === 'SRV' ? 'srv' : 'a'] = r.id; return acc; }, {}),
    };
    const info = await cloudflare.sync({ prefix: 'myminecraft', suffix: 'stde.eu.cc', port: 25566, previous });
    const puts = cfCalls.filter((c) => c.method === 'PUT');
    assert.strictEqual(puts.length, 2, `expected 2 PUT, got ${puts.length}`);
    const srvPut = puts.find((c) => c.data.type === 'SRV');
    assert.strictEqual(srvPut.data.data.port, 25566);
    assert.strictEqual(info.port, 25566);
  });

  await test('cloudflare SRV 400 时回退到第二种写法', async () => {
    cfCalls.length = 0;
    let srvAttempts = 0;
    cfOverride = ({ method, data }) => {
      if (method === 'POST' && data && data.type === 'SRV') {
        srvAttempts += 1;
        if (srvAttempts === 1) {
          return { status: 400, data: { success: false, errors: [{ code: 9005, message: 'bad data.name' }] } };
        }
      }
      return null;
    };
    const info = await cloudflare.sync({ prefix: 'fallback', suffix: 'stde.eu.cc', port: 25577 });
    cfOverride = null;
    assert.strictEqual(srvAttempts, 2, `srvAttempts=${srvAttempts}`);
    assert.ok(info.records.srv);
    assert.ok(info.warnings.some((w) => w.includes('SRV')));
  });

  await test('cloudflare.sync 拒绝未绑定的后缀', async () => {
    await assert.rejects(() => cloudflare.sync({ prefix: 'x', suffix: 'evil.com', port: 25565 }), /还没有绑定/);
    await assert.rejects(() => cloudflare.sync({ prefix: 'x', suffix: 'not a domain', port: 25565 }), /不合法/);
  });

  await test('cloudflare.addZone / removeZone 绑定用户自己的域名', async () => {
    const zoneId = 'c'.repeat(32);
    const added = await cloudflare.addZone({ suffix: 'MyOwnDomain.COM', zoneId });
    assert.strictEqual(added.ok, true);
    assert.strictEqual(added.suffix, 'myowndomain.com', '域名要小写规范化');
    assert.strictEqual(added.zones['myowndomain.com'], zoneId);

    const st = cloudflare.status();
    assert.ok(st.suffixes.includes('myowndomain.com'), JSON.stringify(st.suffixes));
    assert.deepStrictEqual(st.customSuffixes, ['myowndomain.com']);
    assert.ok(st.builtinSuffixes.includes('stde.eu.cc'));
    assert.strictEqual(st.transports['myowndomain.com'], 'direct', '有 Zone + Token → 直连');
    assert.strictEqual(cloudflare.transportFor('myowndomain.com'), 'direct');

    // 自定义域名也能建解析
    cfCalls.length = 0;
    const info = await cloudflare.sync({ prefix: 'mc', suffix: 'myowndomain.com', port: 25599 });
    assert.strictEqual(info.address, 'mc.myowndomain.com');
    const aCall = cfCalls.find((c) => c.method === 'POST' && c.data && c.data.type === 'A');
    assert.strictEqual(aCall.data.name, 'mc.myowndomain.com');
    const srvCall = cfCalls.find((c) => c.method === 'POST' && c.data && c.data.type === 'SRV');
    assert.strictEqual(srvCall.data.data.port, 25599);

    // 服务器配置也认这个后缀
    const meta = internals.buildMeta({ core: 'paper', version: '1.20.4', suffix: 'myowndomain.com', prefix: 'mc' });
    assert.strictEqual(meta.suffix, 'myowndomain.com');
    assert.strictEqual(meta.address, 'mc.myowndomain.com');

    // 解绑；内置三个不允许删
    const removed = cloudflare.removeZone('myowndomain.com');
    assert.strictEqual(removed.ok, true);
    assert.ok(!cloudflare.status().suffixes.includes('myowndomain.com'));
    assert.throws(() => cloudflare.removeZone('stde.eu.cc'), /内置/);

    assert.strictEqual(cloudflare.isDomainName('bad domain'), false);
    assert.strictEqual(cloudflare.isDomainName('ok-domain.example.com'), true);
    assert.strictEqual(cloudflare.isDomainName('localhost'), false);
    await assert.rejects(() => cloudflare.addZone({ suffix: 'bad domain' }), /域名格式不对/);
    await assert.rejects(() => cloudflare.addZone({ suffix: 'ok.example.com', zoneId: 'short' }), /Zone ID 格式不对/);
  });

  await test('cloudflare.remove 按 ID 删除 A / SRV', async () => {
    cfCalls.length = 0;
    const records = cfStore
      .filter((r) => r.name.includes('fallback') && !r.deleted)
      .reduce((acc, r) => { acc[r.type === 'SRV' ? 'srv' : 'a'] = r.id; return acc; }, {});
    const result = await cloudflare.remove({ zoneId: 'zone-abc', records, address: 'fallback.stde.eu.cc' });
    assert.strictEqual(result.removed.length, 2);
    const deletes = cfCalls.filter((c) => c.method === 'DELETE');
    assert.strictEqual(deletes.length, 2);
  });

  await test('cloudflare zones 映射（CF_ZONES 覆盖 CF_ZONE_ID）', () => {
    process.env.CF_ZONES = JSON.stringify({ 'stde.eu.cc': 'zone-stde', 'ys2video.eu.cc': 'zone-ys2' });
    cloudflare.loadConfig(true);
    assert.strictEqual(cloudflare.zoneIdFor('stde.eu.cc'), 'zone-stde');
    assert.strictEqual(cloudflare.zoneIdFor('ys2video.eu.cc'), 'zone-ys2');
    assert.strictEqual(cloudflare.zoneIdFor('yistarline.eu.cc'), 'zone-abc');
    delete process.env.CF_ZONES;
    cloudflare.loadConfig(true);
  });

  await test('cloudflare PUBLIC_HOST 模式使用 CNAME', async () => {
    process.env.CF_TARGET_HOST = 'node.example.com';
    cloudflare.loadConfig(true);
    cfCalls.length = 0;
    const info = await cloudflare.sync({ prefix: 'hostmode', suffix: 'stde.eu.cc', port: 25565 });
    delete process.env.CF_TARGET_HOST;
    cloudflare.loadConfig(true);

    assert.strictEqual(info.mode, 'host');
    const cname = cfCalls.find((c) => c.method === 'POST' && c.data.type === 'CNAME');
    assert.ok(cname, 'should create CNAME');
    assert.strictEqual(cname.data.content, 'node.example.com');
    const srv = cfCalls.find((c) => c.method === 'POST' && c.data.type === 'SRV');
    assert.strictEqual(srv.data.data.target, 'node.example.com');
  });

  // =====================================================================
  // 4b. 离线登录 + Cloudflare 一键连接
  // =====================================================================
  await test('auth.offlineLogin 生成官方一致的离线 UUID', () => {
    const auth = require(path.join(ROOT, 'auth.js'));
    const result = auth.offlineLogin('Steve');

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.type, 'offline');
    assert.strictEqual(result.minecraft.type, 'offline');
    // md5("OfflinePlayer:Steve") + UUID v3 位修正
    assert.strictEqual(result.minecraft.uuid, '5627dd98-e6be-3c21-b8a8-e92344183641');
    assert.strictEqual(result.minecraft.accessToken, '0');
    assert.strictEqual(auth.offlineUuid('Notch'), auth.offlineUuid('Notch'), 'UUID 必须稳定');
  });

  await test('auth.offlineLogin 拒绝非法玩家名', () => {
    const auth = require(path.join(ROOT, 'auth.js'));
    assert.strictEqual(auth.offlineLogin('ab').ok, false, '太短');
    assert.strictEqual(auth.offlineLogin('a'.repeat(17)).ok, false, '太长');
    assert.strictEqual(auth.offlineLogin('bad name').ok, false, '含空格');
    assert.strictEqual(auth.offlineLogin('中文名').ok, false, '非 ASCII');
    assert.strictEqual(auth.offlineLogin('').ok, false, '空');
  });

  await test('cloudflare.discoverZones 自动识别 Zone', async () => {
    const result = await cloudflare.discoverZones('a'.repeat(32));
    assert.strictEqual(result.tokenStatus, 'active');
    assert.strictEqual(result.zones['stde.eu.cc'], 'zone-stde');
    assert.strictEqual(result.zones['ys2video.eu.cc'], 'zone-ys2');
    assert.ok(result.missing.includes('yistarline.eu.cc'), JSON.stringify(result.missing));
  });

  await test('cloudflare.connect 写入 config.json（不泄露到渲染层）', async () => {
    const token = `b${'c'.repeat(31)}`;
    const result = await cloudflare.connect(token);

    assert.strictEqual(result.ok, true);
    assert.ok(result.configFile && fs.existsSync(result.configFile), 'config.json 应被写入');

    const saved = JSON.parse(fs.readFileSync(result.configFile, 'utf8'));
    assert.strictEqual(saved.CF_API_TOKEN, token);
    assert.strictEqual(saved.CF_ZONES['stde.eu.cc'], 'zone-stde');

    const status = cloudflare.status();
    assert.ok(!JSON.stringify(status).includes(token), 'status 不得返回 Token');
  });

  await test('cloudflare.connect 拒绝非法 Token', async () => {
    await assert.rejects(() => cloudflare.connect('short'), /Token 格式不正确/);
  });

  // =====================================================================
  // 5. server.js 编排（假 spawn + 假 CF）
  // =====================================================================
  const SERVER_ID = 'itest-paper';
  const serverDirPath = path.join(USER_DATA, 'servers', SERVER_ID);

  await test('startServer 完成准备并拉起进程 + 创建解析', async () => {
    fs.mkdirSync(serverDirPath, { recursive: true });
    fs.writeFileSync(path.join(serverDirPath, 'server.jar'), 'dummy-jar-bytes');
    fs.writeFileSync(
      path.join(serverDirPath, '.viskluke-setup.json'),
      JSON.stringify({ core: 'paper', version: '1.20.4', launcherJar: 'server.jar' })
    );
    fs.writeFileSync(
      path.join(USER_DATA, 'servers.json'),
      JSON.stringify([
        {
          id: SERVER_ID,
          name: '集成测试服务器',
          core: 'paper',
          version: '1.20.4',
          maxMemory: '2G',
          port: 25565,
          onlineMode: false,
          maxPlayers: 20,
          motd: 'itest',
          prefix: 'itest',
          suffix: 'stde.eu.cc',
          address: 'itest.stde.eu.cc',
          dns: { enabled: false, records: {} },
          dnsRequested: true,
          removeDnsOnStop: true,
          createdAt: new Date().toISOString(),
        },
      ])
    );

    cfCalls.length = 0;
    events.length = 0;
    spawned.length = 0;

    const result = await server.startServer({ id: SERVER_ID });
    assert.strictEqual(result.ok, true, result.error);

    // eula / properties
    const eula = fs.readFileSync(path.join(serverDirPath, 'eula.txt'), 'utf8');
    assert.ok(eula.includes('eula=true'));
    const props = internals.readProperties(path.join(serverDirPath, 'server.properties'));
    assert.ok(props['server-port']);
    assert.strictEqual(props['server-port'], String(result.server.port));
    assert.strictEqual(props['online-mode'], 'false');

    // spawn 参数
    const proc = spawned.find((p) => p.args.includes('-jar'));
    assert.ok(proc, 'server process spawned');
    assert.ok(proc.args.includes('-Xmx2G'), proc.args.join(' '));
    assert.ok(proc.args.includes('server.jar'));
    assert.strictEqual(proc.args[proc.args.length - 1], 'nogui');
    assert.strictEqual(proc.options.cwd, serverDirPath);
    assert.strictEqual(proc.options.stdio[0], 'pipe');

    // DNS 已创建并落盘
    assert.ok(result.dns && result.dns.address === 'itest.stde.eu.cc', JSON.stringify(result.dns));
    const stored = JSON.parse(fs.readFileSync(path.join(USER_DATA, 'servers.json'), 'utf8'))[0];
    assert.strictEqual(stored.dns.enabled, true);
    assert.ok(stored.dns.records.srv);

    // 状态事件
    assert.ok(events.some((e) => e.channel === 'server:status' && e.payload.status === 'starting'));

    // 就绪检测
    proc.stdout.write('Done (3.141s)! For help, type "help"\n');
    await tick();
    assert.ok(events.some((e) => e.channel === 'server:status' && e.payload.status === 'online'));
  });

  await test('sendCommand 写入 stdin', async () => {
    const proc = spawned.find((p) => p.args.includes('-jar'));
    const result = await server.sendCommand(SERVER_ID, 'list');
    assert.strictEqual(result.ok, true);
    await tick();
    assert.deepStrictEqual(proc.stdinWrites, ['list\n']);
  });

  await test('setWhitelist 运行时下发控制台命令并落盘', async () => {
    const proc = spawned.find((p) => p.args.includes('-jar'));
    const before = proc.stdinWrites.slice();
    proc.stdinWrites.length = 0;

    const result = await server.setWhitelist({ id: SERVER_ID, players: 'Steve Alex', whitelist: true });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.applied, 'live');
    assert.strictEqual(result.whitelist, true);

    const writes = proc.stdinWrites.join('');
    assert.ok(writes.includes('whitelist add Steve'), writes);
    assert.ok(writes.includes('whitelist add Alex'), writes);
    assert.ok(writes.includes('whitelist reload'), writes);

    const file = path.join(serverDirPath, 'whitelist.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepStrictEqual(parsed.map((entry) => entry.name).sort(), ['Alex', 'Steve']);
    assert.ok(
      parsed.every((entry) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(entry.uuid)),
      `离线模式应写入推导 UUID：${JSON.stringify(parsed)}`
    );

    // 还原 stdin 记录，后面的 stopServer 用例还在用
    proc.stdinWrites.length = 0;
    for (const chunk of before) proc.stdinWrites.push(chunk);
  });

  await test('stopServer 发送 stop 并等待退出 + 清理解析', async () => {
    const proc = spawned.find((p) => p.args.includes('-jar'));
    cfCalls.length = 0;
    const stopPromise = server.stopServer(SERVER_ID, {});
    await tick();
    assert.deepStrictEqual(proc.stdinWrites, ['list\n', 'stop\n']);
    proc.emit('exit', 0, null);
    const result = await stopPromise;
    assert.strictEqual(result.ok, true);
    await sleep(120);

    const list = server.list();
    const target = list.find((s) => s.id === SERVER_ID);
    assert.strictEqual(target.status, 'stopped');
    assert.ok(cfCalls.some((c) => c.method === 'DELETE'), 'DNS records should be deleted on stop');
  });

  await test('deleteServer 删除目录与记录', async () => {
    const result = await server.deleteServer(SERVER_ID, { deleteFiles: true, removeDns: true });
    assert.strictEqual(result.ok, true, result.error);
    assert.strictEqual(fs.existsSync(serverDirPath), false);
    assert.strictEqual(server.list().some((s) => s.id === SERVER_ID), false);
  });

  await test('openFolder 打开服务器目录', async () => {
    const result = await server.openFolder('some-server');
    assert.strictEqual(result.ok, true);
    assert.ok(openedPaths.some((p) => p.includes('some-server')));
  });

  await test('javaInfo 探测到 Java 17', async () => {
    const info = await server.javaInfo();
    assert.ok(info.exe, 'java executable resolved');
    assert.strictEqual(info.version.major, 17);
  });

  // =====================================================================
  // 5b. 失败路径：Cloudflare 报错不影响服务器运行
  // =====================================================================
  const DNSFAIL_ID = 'itest-dnsfail';
  const dnsFailDir = path.join(USER_DATA, 'servers', DNSFAIL_ID);

  await test('Cloudflare 报错时服务器仍启动，UI 收到失败事件', async () => {
    fs.mkdirSync(dnsFailDir, { recursive: true });
    fs.writeFileSync(path.join(dnsFailDir, 'server.jar'), 'dummy');
    fs.writeFileSync(
      path.join(dnsFailDir, '.viskluke-setup.json'),
      JSON.stringify({ core: 'paper', version: '1.20.4', launcherJar: 'server.jar' })
    );
    const all = JSON.parse(fs.readFileSync(path.join(USER_DATA, 'servers.json'), 'utf8'));
    all.push({
      id: DNSFAIL_ID,
      name: 'DNS 失败测试',
      core: 'paper',
      version: '1.20.4',
      maxMemory: '2G',
      port: 25565,
      onlineMode: true,
      maxPlayers: 20,
      motd: 'itest',
      prefix: 'dnsfail',
      suffix: 'stde.eu.cc',
      address: 'dnsfail.stde.eu.cc',
      dns: { enabled: false, records: {} },
      dnsRequested: true,
      removeDnsOnStop: true,
      createdAt: new Date().toISOString(),
    });
    fs.writeFileSync(path.join(USER_DATA, 'servers.json'), JSON.stringify(all));

    cfOverride = ({ method, data }) =>
      method === 'POST' && data && data.type === 'A'
        ? { status: 403, data: { success: false, errors: [{ code: 9109, message: 'Unauthorized to access zone' }] } }
        : null;

    events.length = 0;
    spawned.length = 0;
    const result = await server.startServer({ id: DNSFAIL_ID });
    cfOverride = null;

    assert.strictEqual(result.ok, true, result.error);
    assert.strictEqual(result.dns, null);
    const dnsEvent = events.find((e) => e.channel === 'server:dns');
    assert.ok(dnsEvent, 'expected server:dns event');
    assert.strictEqual(dnsEvent.payload.ok, false);
    assert.ok(/Unauthorized|403/.test(dnsEvent.payload.error), dnsEvent.payload.error);

    const stored = JSON.parse(fs.readFileSync(path.join(USER_DATA, 'servers.json'), 'utf8'))
      .find((s) => s.id === DNSFAIL_ID);
    assert.strictEqual(stored.dns.enabled, false);

    // 收尾：正常退出并删除
    const proc = spawned.find((p) => p.args.includes('-jar'));
    const stopPromise = server.stopServer(DNSFAIL_ID, {});
    await tick();
    proc.emit('exit', 0, null);
    await stopPromise;
    await server.deleteServer(DNSFAIL_ID, { deleteFiles: true, removeDns: true });
  });

  await test('重复域名被拒绝启动', async () => {
    const conflictId = 'itest-conflict';
    const all = JSON.parse(fs.readFileSync(path.join(USER_DATA, 'servers.json'), 'utf8'));
    all.push(
      { id: 'dup-a', name: 'A', core: 'paper', version: '1.20.4', address: 'dup.stde.eu.cc', dns: {}, port: 25565 },
      { id: conflictId, name: 'B', core: 'paper', version: '1.20.4', address: 'dup.stde.eu.cc', dns: {}, port: 25565 }
    );
    fs.writeFileSync(path.join(USER_DATA, 'servers.json'), JSON.stringify(all));

    const result = await server.startServer({ id: conflictId });
    assert.strictEqual(result.ok, false);
    assert.ok(/已被服务器/.test(result.error), result.error);

    const remaining = JSON.parse(fs.readFileSync(path.join(USER_DATA, 'servers.json'), 'utf8'))
      .filter((s) => !['dup-a', conflictId].includes(s.id));
    fs.writeFileSync(path.join(USER_DATA, 'servers.json'), JSON.stringify(remaining));
  });

  await test('getLogs 返回运行日志缓冲', () => {
    const logs = server.getLogs(DNSFAIL_ID);
    assert.ok(Array.isArray(logs));
    assert.ok(events.some((e) => e.channel === 'server:log'));
  });

  // =====================================================================
  // 5c. 可选：真实下载 Vanilla 服务端（HARNESS_DOWNLOAD=1 时执行，约 50MB）
  // =====================================================================
  if (process.env.HARNESS_DOWNLOAD === '1') {
    const DL_ID = 'dl-vanilla';
    const dlDir = path.join(USER_DATA, 'servers', DL_ID);

    await test('真实下载 Vanilla 1.20.4 并校验 SHA1', async () => {
      fs.mkdirSync(dlDir, { recursive: true });
      fs.writeFileSync(
        path.join(USER_DATA, 'servers.json'),
        JSON.stringify([
          {
            id: DL_ID,
            name: '下载测试',
            core: 'vanilla',
            version: '1.20.4',
            maxMemory: '2G',
            port: 25565,
            onlineMode: true,
            maxPlayers: 20,
            motd: 'dl',
            prefix: '',
            suffix: 'stde.eu.cc',
            address: '',
            dns: { enabled: false, records: {} },
            dnsRequested: false,
            removeDnsOnStop: true,
            createdAt: new Date().toISOString(),
          },
        ])
      );

      events.length = 0;
      spawned.length = 0;
      const started = Date.now();
      const result = await server.startServer({ id: DL_ID });
      assert.strictEqual(result.ok, true, result.error);

      const jar = path.join(dlDir, 'server.jar');
      assert.ok(fs.existsSync(jar), 'server.jar 应已下载');
      const stat = fs.statSync(jar);
      assert.ok(stat.size > 45 * 1024 * 1024, `size=${stat.size}`);
      console.log(`      · 下载 ${(stat.size / 1024 / 1024).toFixed(1)} MB，用时 ${((Date.now() - started) / 1000).toFixed(1)}s`);

      const marker = JSON.parse(fs.readFileSync(path.join(dlDir, '.viskluke-setup.json'), 'utf8'));
      assert.strictEqual(marker.launcherJar, 'server.jar');
      assert.strictEqual(marker.core, 'vanilla');
      assert.ok(events.some((e) => e.channel === 'server:progress' && e.payload.stage === 'download'));
      assert.ok(events.some((e) => e.channel === 'server:progress' && e.payload.stage === 'verify'));

      const proc = spawned.find((p) => p.args.includes('-jar'));
      const stopPromise = server.stopServer(DL_ID, {});
      await tick();
      proc.emit('exit', 0, null);
      await stopPromise;
      await server.deleteServer(DL_ID, { deleteFiles: true, removeDns: true });
      assert.strictEqual(fs.existsSync(dlDir), false);
    });
  }

  // =====================================================================
  // 6. 启动器自愈逻辑（scripts/launch.js 纯函数）
  // =====================================================================
  await test('launch.js 识别 STATUS_BREAKPOINT 退出码', () => {
    const launch = require(path.join(ROOT, 'scripts', 'launch.js'));
    assert.strictEqual(launch.isBreakpointExit(-2147483645), true); // 有符号
    assert.strictEqual(launch.isBreakpointExit(2147483651), true); // 无符号 0x80000003
    assert.strictEqual(launch.isBreakpointExit(0), false);
    assert.strictEqual(launch.isBreakpointExit(null), false);
  });

  await test('launch.js 模式决策：正常 / 粘性降级 / 升级重探 / 显式参数', () => {
    const launch = require(path.join(ROOT, 'scripts', 'launch.js'));

    const normal = launch.decideMode({ argv: [], marker: null, electronVersion: '33.4.11', env: {} });
    assert.strictEqual(normal.mode, 'normal');
    assert.deepStrictEqual(normal.args, []);

    const sticky = launch.decideMode({
      argv: [],
      marker: { state: 'fallback', electron: '33.4.11' },
      electronVersion: '33.4.11',
      env: {},
    });
    assert.strictEqual(sticky.mode, 'safe');
    assert.deepStrictEqual(sticky.args, ['--no-sandbox']);

    const upgraded = launch.decideMode({
      argv: [],
      marker: { state: 'fallback', electron: '33.4.11' },
      electronVersion: '34.0.0',
      env: {},
    });
    assert.strictEqual(upgraded.mode, 'normal', 'Electron 升级后应重新探测沙箱');

    const explicit = launch.decideMode({ argv: ['--enable-logging'], env: { ELECTRON_DISABLE_SANDBOX: '1' } });
    assert.strictEqual(explicit.mode, 'safe');
    assert.deepStrictEqual(explicit.args, ['--enable-logging', '--no-sandbox']);

    const already = launch.decideMode({ argv: ['--no-sandbox'], env: {} });
    assert.strictEqual(already.mode, 'safe');
    assert.deepStrictEqual(already.args, ['--no-sandbox'], '不应重复追加开关');
  });

  // =====================================================================
  // 7. 前端资源一致性
  // =====================================================================
  await test('renderer 脚本引用的 DOM id 都存在于 index.html', () => {
    const html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
    const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
    const scripts = fs
      .readdirSync(path.join(ROOT, 'renderer'))
      .filter((name) => name.endsWith('.js'));
    assert.ok(scripts.length >= 2, `renderer 脚本数量偏少：${scripts.join(', ')}`);
    const missing = [];
    for (const name of scripts) {
      const js = fs.readFileSync(path.join(ROOT, 'renderer', name), 'utf8');
      const usedIds = new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
      for (const id of usedIds) if (!htmlIds.has(id)) missing.push(`${name} → ${id}`);
    }
    assert.deepStrictEqual(missing, [], `index.html 缺少 id: ${missing.join(', ')}`);
  });

  await test('preload 暴露的 API 都在 renderer 中使用且通道已注册', () => {
    const preload = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
    const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    const renderer = fs
      .readdirSync(path.join(ROOT, 'renderer'))
      .filter((name) => name.endsWith('.js'))
      .map((name) => fs.readFileSync(path.join(ROOT, 'renderer', name), 'utf8'))
      .join('\n');
    const invokes = [...preload.matchAll(/invoke\('([^']+)'/g)].map((m) => m[1]);
    assert.ok(invokes.length >= 15, `invokes=${invokes.length}`);
    for (const channel of invokes) {
      assert.ok(main.includes(`'${channel}'`), `main.js 未注册通道 ${channel}`);
    }
    const exposed = [...preload.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]);
    const allowUnused = new Set(['authRefresh', 'removeInstance', 'openExternal']); // 既有 API，界面暂未提供入口
    for (const name of exposed) {
      if (allowUnused.has(name)) continue;
      assert.ok(renderer.includes(`api.${name}`), `renderer 未使用 preload 的 ${name}`);
    }
  });

  // =====================================================================
  // 8. 整合包（.mrpack）解包 + 下载
  // =====================================================================
  const http = require('http');
  const crypto = require('crypto');
  const AdmZip = require(path.join(ROOT, 'node_modules', 'adm-zip'));
  const modpack = require(path.join(ROOT, 'modpack.js'));
  const loader = require(path.join(ROOT, 'loader.js'));
  const store = require(path.join(ROOT, 'store.js'));

  const sha512 = (buffer) => crypto.createHash('sha512').update(buffer).digest('hex');

  // 用本地 HTTP 服务代替 Modrinth / CDN，自检不依赖外网
  const served = {
    '/client.jar': Buffer.from('client-mod-bytes'.repeat(128)),
    '/optional.jar': Buffer.from('optional-mod-bytes'),
    '/bad-hash.jar': Buffer.from('完全不是声明的那个文件'),
    '/pack.mrpack': null, // 稍后填入
  };
  const httpServer = http.createServer((req, res) => {
    const key = String(req.url || '').split('?')[0];
    const body = served[key];
    if (!body) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    res.setHeader('Content-Length', String(body.length));
    res.end(body);
  });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const port = httpServer.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const packRoot = path.join(USER_DATA, 'modpack-instance');
  const packFile = path.join(USER_DATA, 'fixture-pack.mrpack');
  const packIndex = {
    formatVersion: 1,
    game: 'minecraft',
    versionId: '1.0.0',
    name: '自检整合包',
    summary: 'selftest fixture',
    dependencies: { minecraft: '1.20.4', 'fabric-loader': '0.16.5' },
    files: [
      {
        path: 'mods/client.jar',
        hashes: { sha512: sha512(served['/client.jar']) },
        env: { client: 'required', server: 'required' },
        downloads: [`${baseUrl}/client.jar`],
        fileSize: served['/client.jar'].length,
      },
      {
        path: 'mods/optional.jar',
        hashes: { sha512: sha512(served['/optional.jar']) },
        env: { client: 'optional' },
        downloads: [`${baseUrl}/optional.jar`],
        fileSize: served['/optional.jar'].length,
      },
      {
        path: 'mods/server-only.jar',
        hashes: {},
        env: { client: 'unsupported', server: 'required' },
        downloads: [`${baseUrl}/optional.jar`],
        fileSize: served['/optional.jar'].length,
      },
      {
        path: 'mods/bad-hash.jar',
        hashes: { sha512: sha512(Buffer.from('声明的正确内容')) },
        env: { client: 'required' },
        downloads: [`${baseUrl}/bad-hash.jar`],
        fileSize: served['/bad-hash.jar'].length,
      },
      {
        path: 'mods/missing.jar',
        hashes: {},
        env: { client: 'required' },
        downloads: [`${baseUrl}/not-exist.jar`],
        fileSize: 1024,
      },
    ],
  };
  {
    const zip = new AdmZip();
    zip.addFile('modrinth.index.json', Buffer.from(JSON.stringify(packIndex, null, 2), 'utf8'));
    zip.addFile('overrides/config/test.toml', Buffer.from('key = "value"\n', 'utf8'));
    zip.addFile('client-overrides/options.txt', Buffer.from('fov:0.5\n', 'utf8'));
    zip.addFile('server-overrides/ignored.txt', Buffer.from('server only\n', 'utf8'));
    zip.addFile('overrides/../../evil.txt', Buffer.from('zip-slip\n', 'utf8'));
    zip.writeZip(packFile);
    served['/pack.mrpack'] = fs.readFileSync(packFile);
  }

  try {
    await test('modpack.safeJoin 阻止路径穿越', () => {
      assert.strictEqual(modpack.safeJoin(packRoot, 'mods/a.jar'), path.join(packRoot, 'mods', 'a.jar'));
      assert.strictEqual(modpack.safeJoin(packRoot, 'mods\\b.jar'), path.join(packRoot, 'mods', 'b.jar'));
      assert.throws(() => modpack.safeJoin(packRoot, '../evil.jar'), /越界|绝对/);
      assert.throws(() => modpack.safeJoin(packRoot, 'mods/../../evil.jar'), /越界/);
      assert.throws(() => modpack.safeJoin(packRoot, 'C:/Windows/evil.jar'), /绝对/);
      assert.throws(() => modpack.safeJoin(packRoot, '/etc/passwd'), /绝对/);
      assert.throws(() => modpack.safeJoin(packRoot, ''), /空路径/);
    });

    await test('modpack.parseIndex 校验格式 / 推断加载器', () => {
      const parsed = modpack.parseIndex({
        formatVersion: 1,
        game: 'minecraft',
        name: 'P',
        versionId: '1.0',
        dependencies: { minecraft: '1.20.4', 'fabric-loader': '0.16.5' },
        files: [{}],
      });
      assert.strictEqual(parsed.minecraftVersion, '1.20.4');
      assert.strictEqual(parsed.loader, 'fabric');
      assert.strictEqual(parsed.loaderVersion, '0.16.5');
      assert.strictEqual(parsed.totalFiles, 1);

      assert.strictEqual(
        modpack.parseIndex({ game: 'minecraft', dependencies: { minecraft: '1.20.4', neoforge: '20.4.200' } }).loader,
        'neoforge'
      );
      assert.strictEqual(
        modpack.parseIndex({ game: 'minecraft', dependencies: { minecraft: '1.20.4', 'quilt-loader': '0.24.0' } }).loader,
        'quilt'
      );
      assert.strictEqual(modpack.parseIndex({ game: 'minecraft', dependencies: { minecraft: '1.20.4' } }).loader, '');

      assert.throws(() => modpack.parseIndex({ game: 'terraria' }), /不是 Minecraft/);
      assert.throws(() => modpack.parseIndex({ formatVersion: 2, game: 'minecraft' }), /格式版本 2/);
      assert.throws(() => modpack.parseIndex(null), /格式不正确/);
    });

    await test('modpack.clientFiles 过滤服务端专用文件', () => {
      const files = modpack.clientFiles([
        { path: 'mods/client.jar', downloads: ['https://x/1'], env: { client: 'required' } },
        { path: 'mods/server.jar', downloads: ['https://x/2'], env: { client: 'unsupported' } },
        { path: 'mods/optional.jar', downloads: ['https://x/3'], env: { client: 'optional' } },
        { path: 'mods/no-url.jar', downloads: [] },
        { path: '', downloads: ['https://x/4'] },
        null,
      ]);
      assert.deepStrictEqual(files.map((file) => file.path), ['mods/client.jar', 'mods/optional.jar']);
    });

    await test('modpack.readIndex 拒绝非整合包 zip', () => {
      const junk = path.join(USER_DATA, 'not-a-pack.zip');
      const zip = new AdmZip();
      zip.addFile('hello.txt', Buffer.from('hi', 'utf8'));
      zip.writeZip(junk);
      assert.throws(() => modpack.readIndex(junk), /缺少 modrinth\.index\.json/);
      assert.throws(() => modpack.readIndex(path.join(USER_DATA, 'nope.mrpack')), /不存在/);
    });

    await test('modpack.install 解包：下载 / 过滤 / overrides / 标记', async () => {
      const result = await modpack.install({ mrpackPath: packFile, root: packRoot, onProgress: () => {} });

      assert.strictEqual(result.pack.minecraftVersion, '1.20.4');
      assert.strictEqual(result.pack.loader, 'fabric');
      assert.strictEqual(result.stats.downloaded, 2, JSON.stringify(result.stats));
      assert.strictEqual(result.stats.failed.length, 2, JSON.stringify(result.stats.failed));

      // 下好的文件内容与来源一致
      assert.strictEqual(
        fs.readFileSync(path.join(packRoot, 'mods', 'client.jar')).toString(),
        served['/client.jar'].toString()
      );
      assert.strictEqual(fs.existsSync(path.join(packRoot, 'mods', 'optional.jar')), true);

      // 服务端专用 / 校验失败 / 下载失败 的文件都不该留下
      assert.strictEqual(fs.existsSync(path.join(packRoot, 'mods', 'server-only.jar')), false);
      assert.strictEqual(fs.existsSync(path.join(packRoot, 'mods', 'bad-hash.jar')), false);
      assert.strictEqual(fs.existsSync(path.join(packRoot, 'mods', 'missing.jar')), false);
      assert.strictEqual(fs.existsSync(path.join(packRoot, 'mods', 'bad-hash.jar.part')), false, '不留 .part 残片');

      // overrides 解压，server-overrides 跳过，zip-slip 被拦住
      assert.strictEqual(fs.existsSync(path.join(packRoot, 'config', 'test.toml')), true);
      assert.strictEqual(fs.existsSync(path.join(packRoot, 'options.txt')), true);
      assert.strictEqual(fs.existsSync(path.join(packRoot, 'ignored.txt')), false);
      assert.ok(result.stats.overrides >= 2, `overrides=${result.stats.overrides}`);
      assert.ok(result.stats.overridesSkipped.some((item) => item.path.includes('evil.txt')), 'zip-slip 应被拒绝');

      // 标记文件
      const marker = modpack.readMarker(packRoot);
      assert.ok(marker, '应写入 .viskluke-modpack.json');
      assert.strictEqual(marker.minecraftVersion, '1.20.4');
      assert.strictEqual(marker.loader, 'fabric');
      assert.strictEqual(marker.loaderVersion, '0.16.5');
      assert.strictEqual(marker.versionId, '1.0.0');
    });

    await test('modpack.install 重复安装等于续传（跳过已存在文件）', async () => {
      const again = await modpack.install({ mrpackPath: packFile, root: packRoot, onProgress: () => {} });
      assert.strictEqual(again.stats.skipped, 2, JSON.stringify(again.stats));
      assert.strictEqual(again.stats.downloaded, 0);
    });

    await test('modpack.install 全部失败时给出可读错误', async () => {
      const brokenIndex = {
        formatVersion: 1,
        game: 'minecraft',
        name: '全失败',
        dependencies: { minecraft: '1.20.4', 'fabric-loader': '0.16.5' },
        files: [
          { path: 'mods/a.jar', downloads: [`${baseUrl}/not-exist-a.jar`], fileSize: 1 },
          { path: 'mods/b.jar', downloads: [`${baseUrl}/not-exist-b.jar`], fileSize: 1 },
        ],
      };
      const zip = new AdmZip();
      zip.addFile('modrinth.index.json', Buffer.from(JSON.stringify(brokenIndex), 'utf8'));
      const brokenFile = path.join(USER_DATA, 'broken.mrpack');
      zip.writeZip(brokenFile);

      await assert.rejects(
        () => modpack.install({ mrpackPath: brokenFile, root: path.join(USER_DATA, 'broken-root'), onProgress: () => {} }),
        /全部下载失败/
      );
    });

    await test('store.installProject 整合包分支：下载 .mrpack + 解包 + 进度事件', async () => {
      const root = path.join(USER_DATA, 'store-modpack-instance');
      const progress = [];
      const result = await store.installProject({
        projectId: 'selftest-pack',
        projectType: 'modpack',
        projectTitle: '自检整合包',
        gameVersion: '1.20.4',
        loader: 'fabric',
        // gameDir 指到 .selftest-data，别写进真实的 %USERPROFILE%\Viskluke
        instance: { id: 'mp-selftest', name: '自检整合包', gameDir: root },
        onProgress: (payload) => progress.push(payload),
        // 自检注入：跳过真实 Modrinth 请求，文件走本地 HTTP
        resolveVersions: async () => [
          {
            id: 'ver-1',
            version_number: '1.0.0',
            game_versions: ['1.20.4'],
            loaders: ['fabric'],
            files: [
              {
                primary: true,
                url: `${baseUrl}/pack.mrpack`,
                filename: 'selftest-pack-1.0.0.mrpack',
                size: served['/pack.mrpack'].length,
              },
            ],
          },
        ],
      });

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.projectType, 'modpack');
      assert.strictEqual(result.file, 'selftest-pack-1.0.0.mrpack');
      assert.ok(fs.existsSync(path.join(root, 'modpacks', 'selftest-pack-1.0.0.mrpack')), '.mrpack 应保留');
      assert.ok(fs.existsSync(path.join(root, 'mods', 'client.jar')));
      assert.strictEqual(result.pack.minecraftVersion, '1.20.4');
      assert.strictEqual(result.loader, 'fabric');
      assert.ok(progress.some((item) => item.stage === 'pack'), '应有整合包下载阶段');
      assert.ok(progress.some((item) => item.stage === 'read'), '应有清单读取阶段');
    });

    // ---- 整合包 → 自动建实例 → 标注 ----
    const { installModpackInstance } = require(path.join(ROOT, 'modpack-instance.js'));
    const memoryRepo = () => {
      const rows = new Map();
      const snapshot = () => [...rows.values()].map((row) => ({ ...row }));
      return {
        rows,
        list: snapshot,
        save(instance) {
          const previous = rows.get(instance.id) || {};
          rows.set(instance.id, { ...previous, ...instance });
          return snapshot();
        },
      };
    };
    const packVersionResolver = () => async () => [
      {
        id: 'ver-auto',
        version_number: '1.0.0',
        game_versions: ['1.20.4'],
        loaders: ['fabric'],
        files: [
          {
            primary: true,
            url: `${baseUrl}/pack.mrpack`,
            filename: 'auto-pack-1.0.0.mrpack',
            size: served['/pack.mrpack'].length,
          },
        ],
      },
    ];

    await test('modpack-instance 自动建实例并标注「整合包」', async () => {
      const repo = memoryRepo();
      const gameDir = path.join(USER_DATA, 'mp-auto-instance');

      const first = await installModpackInstance(
        {
          projectId: 'auto-pack',
          projectTitle: '自动整合包',
          gameVersion: '1.20.4',
          loader: 'fabric',
          gameDir,
          resolveVersions: packVersionResolver(),
        },
        { repository: repo }
      );

      assert.strictEqual(first.reused, false);
      assert.ok(first.instance.id.startsWith('mp-'), first.instance.id);
      assert.strictEqual(first.instance.name, '自检整合包', '实例名用整合包清单里的 name');
      assert.strictEqual(first.instance.version, '1.20.4', '实例版本跟随整合包');
      assert.strictEqual(first.instance.loader, 'fabric');
      assert.strictEqual(first.instance.loaderVersion, '0.16.5');
      assert.strictEqual(first.instance.modpack.projectId, 'auto-pack');
      assert.strictEqual(first.instance.modpack.status, 'partial', '有文件失败 → partial');
      assert.ok(first.instance.modpack.files >= 2, JSON.stringify(first.instance.modpack));
      assert.ok(repo.rows.size === 1);

      const second = await installModpackInstance(
        { projectId: 'auto-pack', projectTitle: '自动整合包', gameVersion: '1.20.4', gameDir, resolveVersions: packVersionResolver() },
        { repository: repo }
      );
      assert.strictEqual(second.reused, true, '同一整合包应复用实例');
      assert.strictEqual(second.instance.id, first.instance.id);
      assert.strictEqual(repo.rows.size, 1, '不应堆出第二个实例');
      assert.ok(fs.existsSync(path.join(gameDir, 'mods', 'client.jar')));
    });

    await test('modpack-instance 安装失败时保留实例并标记 failed', async () => {
      const repo = memoryRepo();
      const resolveVersions = async () => [
        {
          id: 'ver-bad',
          version_number: '0.1.0',
          game_versions: ['1.20.4'],
          loaders: ['fabric'],
          files: [{ primary: true, url: `${baseUrl}/not-a-pack.mrpack`, filename: 'bad-0.1.0.mrpack' }],
        },
      ];

      // 包本身下不下来 → 抛错
      await assert.rejects(
        () =>
          installModpackInstance(
            { projectId: 'bad-pack', projectTitle: '坏包', gameDir: path.join(USER_DATA, 'mp-bad'), resolveVersions },
            { repository: repo }
          ),
        /404|失败/
      );

      const row = [...repo.rows.values()][0];
      assert.ok(row, '失败也要留一条实例记录，方便重试续传');
      assert.strictEqual(row.modpack.status, 'failed');
      assert.ok(row.modpack.error && row.modpack.error.length > 0);
    });
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }

  // =====================================================================
  // 9. 加载器（Fabric / Quilt 版本 JSON）
  // =====================================================================
  await test('loader.loaderVersionId 生成可被 MCLC 识别的 id', () => {
    assert.strictEqual(loader.loaderVersionId('fabric', '1.20.4', '0.16.5'), '1.20.4-fabric-0.16.5');
    assert.strictEqual(loader.loaderVersionId('Quilt', '1.20.4', '0.24.0'), '1.20.4-quilt-0.24.0');
    assert.throws(() => loader.loaderVersionId('fabric', '', '0.16.5'), /Minecraft 版本号/);
    assert.throws(() => loader.loaderVersionId('', '1.20.4', '0.16.5'), /加载器类型/);
    assert.throws(() => loader.loaderVersionId('fabric', '1.20.4', ''), /加载器版本号/);
    assert.throws(() => loader.assertSupported('liteloader'), /liteloader/);
    assert.strictEqual(loader.assertSupported('forge'), 'forge', 'Forge 现在是支持的');
  });

  await test('loader.mergeProfile 把加载器拍平进原版 JSON', () => {
    const vanilla = {
      id: '1.20.4',
      type: 'release',
      mainClass: 'net.minecraft.client.main.Main',
      libraries: [{ name: 'com.mojang:authlib:1.0' }, { name: 'org.ow2.asm:asm:9.6' }],
      arguments: {
        game: ['--username', '${auth_player_name}'],
        jvm: ['-Djava.library.path=${natives_directory}'],
      },
      downloads: { client: { url: 'https://example/client.jar' } },
      assetIndex: { id: '5', url: 'https://example/assets.json' },
      assets: '5',
      javaVersion: { majorVersion: 17 },
    };
    const profile = {
      id: 'fabric-loader-0.16.5-1.20.4',
      inheritsFrom: '1.20.4',
      mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
      libraries: [{ name: 'net.fabricmc:fabric-loader:0.16.5' }, { name: 'org.ow2.asm:asm:9.6' }],
      arguments: { game: [], jvm: ['-DFabricMcEmu= net.minecraft.client.main.Main '] },
    };

    const merged = loader.mergeProfile(vanilla, profile, {
      id: '1.20.4-fabric-0.16.5',
      loader: 'fabric',
      loaderVersion: '0.16.5',
    });

    assert.strictEqual(merged.id, '1.20.4-fabric-0.16.5');
    assert.strictEqual(merged.mainClass, 'net.fabricmc.loader.impl.launch.knot.KnotClient');
    assert.strictEqual(merged.inheritsFrom, undefined, '拍平后不应再有 inheritsFrom');
    assert.deepStrictEqual(
      merged.libraries.map((lib) => lib.name),
      ['net.fabricmc:fabric-loader:0.16.5', 'org.ow2.asm:asm:9.6', 'com.mojang:authlib:1.0'],
      '加载器库在前 + 重复库只留一份'
    );
    assert.deepStrictEqual(merged.arguments.game, ['--username', '${auth_player_name}']);
    assert.deepStrictEqual(merged.arguments.jvm, [
      '-Djava.library.path=${natives_directory}',
      '-DFabricMcEmu= net.minecraft.client.main.Main ',
    ]);
    assert.deepStrictEqual(merged.downloads, vanilla.downloads);
    assert.deepStrictEqual(merged.assetIndex, vanilla.assetIndex);
    assert.strictEqual(merged.javaVersion.majorVersion, 17);
    assert.deepStrictEqual(merged.loader, { type: 'fabric', version: '0.16.5', parent: '1.20.4' });
  });

  await test('loader.ensureLoaderVersion 真实生成 Fabric 版本 JSON', async () => {
    const root = path.join(USER_DATA, 'loader-instance');
    const logs = [];
    const prepared = await loader.ensureLoaderVersion({
      root,
      loader: 'fabric',
      mcVersion: '1.20.4',
      loaderVersion: '0.16.5',
      onLog: (message) => logs.push(message),
    });

    assert.strictEqual(prepared.id, '1.20.4-fabric-0.16.5');
    assert.strictEqual(prepared.created, true);
    assert.ok(fs.existsSync(prepared.jsonPath), '版本 JSON 应写入 versions/<id>/');
    assert.ok(prepared.jarPath.endsWith(path.join('1.20.4-fabric-0.16.5', '1.20.4-fabric-0.16.5.jar')));

    const json = JSON.parse(fs.readFileSync(prepared.jsonPath, 'utf8'));
    assert.strictEqual(json.id, prepared.id);
    assert.strictEqual(json.mainClass, 'net.fabricmc.loader.impl.launch.knot.KnotClient');
    assert.ok(Array.isArray(json.arguments.game) && json.arguments.game.length > 5, '应带上原版启动参数');
    assert.ok(
      json.arguments.jvm.some((arg) => typeof arg === 'string' && arg.includes('FabricMcEmu')),
      '应带上 Fabric 的 jvm 参数'
    );
    assert.ok(json.libraries.some((lib) => lib.name.startsWith('net.fabricmc:fabric-loader:')), '应包含加载器库');
    assert.ok(json.libraries.some((lib) => lib.name.startsWith('com.mojang:authlib')), '应包含原版库');
    assert.ok(json.assetIndex && json.assetIndex.url, '应保留 assetIndex');
    assert.ok(json.downloads && json.downloads.client && json.downloads.client.url, '应保留 client 下载地址');
    assert.ok(json.javaVersion && json.javaVersion.majorVersion >= 17, '应保留 javaVersion');
    // MCLC 用 id.split('.')[1] 推断大版本，id 必须让这段等于 Minecraft 次版本号
    assert.strictEqual(Number(json.id.split('.')[1]), 20);
    assert.ok(logs.some((line) => line.includes('加载器')), '应有日志输出');

    // 第二次直接复用，不重新生成
    const again = await loader.ensureLoaderVersion({ root, loader: 'fabric', mcVersion: '1.20.4', loaderVersion: '0.16.5' });
    assert.strictEqual(again.created, false);
    assert.strictEqual(loader.isLoaderReady(root, 'fabric', '1.20.4', '0.16.5'), true);
  });

  await test('launcher 走 MCLC 的 Forge 通道（options.forge），Fabric 走 version.custom', async () => {
    const launcher = require(path.join(ROOT, 'launcher.js'));
    const account = { name: 'Steve', uuid: '5627dd98-e6be-3c21-b8a8-e92344183641', type: 'offline' };

    // Forge：给一个假 installer 文件（走 config.forgeInstaller 覆盖，避免真的下载）
    const forgeDir = path.join(USER_DATA, 'forge-instance');
    fs.mkdirSync(forgeDir, { recursive: true });
    const fakeInstaller = path.join(USER_DATA, 'fake-forge-installer.jar');
    fs.writeFileSync(fakeInstaller, Buffer.alloc(1024, 1));

    mcclcLaunches.length = 0;
    const forgeResult = await launcher.launch(
      {
        minecraft: account,
        version: '1.20.1',
        instance: { id: 'forge-inst', name: 'Forge 包', loader: 'forge', loaderVersion: '47.2.20', gameDir: forgeDir },
        forgeInstaller: fakeInstaller,
      },
      null
    );
    assert.strictEqual(forgeResult.ok, true);
    const forgeOpts = mcclcLaunches[0];
    assert.strictEqual(forgeOpts.forge, fakeInstaller, 'Forge 必须把 installer 传给 MCLC');
    assert.strictEqual(forgeOpts.version.custom, undefined, 'Forge 不走 version.custom');
    assert.strictEqual(forgeOpts.version.number, '1.20.1');
    assert.strictEqual(forgeResult.loader.type, 'forge');

    // Fabric：真实生成版本 JSON → version.custom
    const fabricDir = path.join(USER_DATA, 'fabric-instance');
    mcclcLaunches.length = 0;
    const fabricResult = await launcher.launch(
      {
        minecraft: account,
        version: '1.20.4',
        instance: { id: 'fabric-inst', name: 'Fabric 包', loader: 'fabric', loaderVersion: '0.16.5', gameDir: fabricDir },
      },
      null
    );
    assert.strictEqual(fabricResult.ok, true);
    const fabricOpts = mcclcLaunches[0];
    assert.strictEqual(fabricOpts.forge, undefined, 'Fabric 不能带 forge 选项');
    assert.strictEqual(fabricOpts.version.custom, '1.20.4-fabric-0.16.5');
    assert.strictEqual(fabricOpts.version.number, '1.20.4-fabric-0.16.5');

    // 真正不支持的加载器仍然明确报错
    await assert.rejects(
      () =>
        launcher.launch(
          {
            minecraft: account,
            version: '1.20.4',
            instance: { id: 'liteloader-inst', name: 'x', loader: 'liteloader', gameDir: path.join(USER_DATA, 'll') },
          },
          null
        ),
      /只自动处理 Fabric/
    );
  });

  await test('loader.ensureInstaller 下载 installer 并复用缓存', async () => {
    const http = require('http');
    const jar = Buffer.alloc(80 * 1024, 7); // 80KB，过掉"太小"的判定
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Length', String(jar.length));
      res.end(jar);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const root = path.join(USER_DATA, 'installer-root');
    try {
      const progress = [];
      const first = await loader.ensureInstaller({
        root,
        loader: 'forge',
        mcVersion: '1.20.1',
        loaderVersion: '47.2.20',
        installerUrl: `http://127.0.0.1:${port}/forge-installer.jar`,
        onProgress: (p) => progress.push(p),
      });
      assert.strictEqual(first.created, true);
      assert.ok(fs.existsSync(first.installerPath), first.installerPath);
      assert.strictEqual(fs.statSync(first.installerPath).size, jar.length);
      assert.strictEqual(first.loaderVersion, '47.2.20');
      assert.ok(progress.length > 0, '应该报下载进度');
      assert.strictEqual(fs.existsSync(`${first.installerPath}.part`), false, '不该留下 .part');

      const again = await loader.ensureInstaller({
        root,
        loader: 'forge',
        mcVersion: '1.20.1',
        loaderVersion: '47.2.20',
        installerUrl: `http://127.0.0.1:${port}/forge-installer.jar`,
      });
      assert.strictEqual(again.created, false, '第二次应复用缓存');
      assert.strictEqual(again.size, first.size);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  await test('installer URL / 加载器分类正确', () => {
    assert.strictEqual(loader.usesInstaller('forge'), true);
    assert.strictEqual(loader.usesInstaller('neoforge'), true);
    assert.strictEqual(loader.usesInstaller('fabric'), false);
    assert.strictEqual(loader.usesInstaller('quilt'), false);
    assert.strictEqual(loader.SUPPORTED.includes('forge'), true);
    assert.strictEqual(loader.SUPPORTED.includes('neoforge'), true);

    const forgeUrl = loader.INSTALLER_PROVIDERS.forge.installerUrl('1.20.1', '47.2.20');
    assert.strictEqual(
      forgeUrl,
      'https://maven.minecraftforge.net/net/minecraftforge/forge/1.20.1-47.2.20/forge-1.20.1-47.2.20-installer.jar'
    );
    const neoUrl = loader.INSTALLER_PROVIDERS.neoforge.installerUrl('1.20.4', '20.4.200');
    assert.strictEqual(
      neoUrl,
      'https://maven.neoforged.net/releases/net/neoforged/neoforge/20.4.200/neoforge-20.4.200-installer.jar'
    );
    assert.strictEqual(loader.INSTALLER_PROVIDERS.forge.fileName('1.20.1', '47.2.20'), 'forge-1.20.1-47.2.20-installer.jar');
    // NeoForge 的版本号与 MC 版本没有直接的字符串关系，只要求能拼出 URL
    assert.ok(loader.INSTALLER_PROVIDERS.neoforge.fileName('1.20.4', '20.4.200').includes('20.4.200'));
  });

  await test('Forge / NeoForge 版本选择（注入数据源，不打网络）', async () => {
    const promos = {
      promos: { '1.20.1-recommended': '47.2.20', '1.20.1-latest': '47.3.1', '1.12.2-recommended': '14.23.5.2860' },
    };
    const forgeFetcher = async (url) => {
      assert.ok(url.includes('promotions_slim.json'), url);
      return promos;
    };
    assert.strictEqual(await loader.pickForgeVersion('1.20.1', forgeFetcher), '47.2.20', '优先 recommended');
    assert.strictEqual(await loader.pickForgeVersion('1.12.2', forgeFetcher), '14.23.5.2860');
    await assert.rejects(() => loader.pickForgeVersion('1.99', forgeFetcher), /没有支持/);

    const neoFetcher = async (url) => {
      assert.ok(url.includes('neoforged'), url);
      return { versions: ['20.4.200', '20.4.237', '20.6.5', '21.1.66'] };
    };
    assert.strictEqual(await loader.pickNeoForgeVersion('1.20.4', neoFetcher), '20.4.237', '取该 MC 版本下最高的');
    await assert.rejects(() => loader.pickNeoForgeVersion('1.19.4', neoFetcher), /没有支持/);
  });

  await test('main.js 忽略 stderr EPIPE（终端/管道断掉不误报启动失败）', () => {
    const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    assert.ok(/process\.stderr\.on\('error'/.test(main), 'main.js 应监听 stderr 的 error 事件');
    assert.ok(
      /\[.*'EPIPE'.*\]|'EPIPE'/.test(main),
      'uncaughtException 里应跳过 EPIPE（管道被关掉不是启动失败）'
    );
  });

  // =====================================================================
  // 10. 离线皮肤（CustomSkinLoader）
  // =====================================================================
  const skin = require(path.join(ROOT, 'skin.js'));

  /** 造一个只有文件头合法的 PNG（skin.js 只读签名 + IHDR 宽高） */
  function makePng(width, height, marker = 0) {
    const buffer = Buffer.alloc(40);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
    buffer.writeUInt32BE(13, 8);
    buffer.write('IHDR', 12, 'ascii');
    buffer.writeUInt32BE(width, 16);
    buffer.writeUInt32BE(height, 20);
    buffer[24] = 8;
    buffer[25] = 6;
    buffer[39] = marker & 0xff;
    return buffer;
  }

  await test('skin.readPngInfo / isSkinSize 只接受合法皮肤尺寸', () => {
    assert.deepStrictEqual(skin.readPngInfo(makePng(64, 64)), { width: 64, height: 64 });
    assert.deepStrictEqual(skin.readPngInfo(makePng(64, 32)), { width: 64, height: 32 });

    assert.strictEqual(skin.isSkinSize(64, 64), true);
    assert.strictEqual(skin.isSkinSize(64, 32), true);
    assert.strictEqual(skin.isSkinSize(128, 128), true, '高清皮肤');
    assert.strictEqual(skin.isSkinSize(48, 48), false);
    assert.strictEqual(skin.isSkinSize(64, 100), false);
    assert.strictEqual(skin.isSkinSize(0, 0), false);

    assert.throws(() => skin.inspectSkin(makePng(48, 48)), /皮肤尺寸不对/);
    assert.throws(() => skin.readPngInfo(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])), /不是 PNG/);
    assert.throws(() => skin.readPngInfo(Buffer.alloc(8)), /太小/);
  });

  await test('skin.normalizePlayerName 与 Minecraft 用户名规则一致', () => {
    assert.strictEqual(skin.normalizePlayerName(' Steve '), 'Steve');
    assert.strictEqual(skin.normalizePlayerName('a_1'), 'a_1');
    assert.throws(() => skin.normalizePlayerName('ab'), /不合法/);
    assert.throws(() => skin.normalizePlayerName('a'.repeat(17)), /不合法/);
    assert.throws(() => skin.normalizePlayerName('../evil'), /不合法/);
    assert.throws(() => skin.normalizePlayerName('bad name'), /不合法/);
    assert.throws(() => skin.normalizePlayerName(''), /不合法/);
  });

  await test('skin.importSkin 入库 / 去重 / 改模型', () => {
    const first = skin.importSkin({ buffer: makePng(64, 64, 11), name: '我的皮肤' });
    assert.strictEqual(first.ok, true);
    assert.strictEqual(first.duplicated, false);
    assert.strictEqual(first.skin.width, 64);
    assert.strictEqual(first.skin.model, 'classic');
    assert.ok(first.skin.preview.startsWith('data:image/png;base64,'), '应带缩略图');

    const again = skin.importSkin({ buffer: makePng(64, 64, 11) });
    assert.strictEqual(again.duplicated, true, '同一张图应去重');
    assert.strictEqual(again.skin.id, first.skin.id);

    const updated = skin.updateSkin(first.skin.id, { model: 'slim', name: '纤细版' });
    assert.strictEqual(updated.skin.model, 'slim');
    assert.strictEqual(updated.skin.name, '纤细版');
    assert.throws(() => skin.updateSkin(first.skin.id, { model: 'weird' }), /不支持的模型/);

    const list = skin.listSkins();
    assert.ok(list.some((item) => item.id === first.skin.id), '列表里应有这张皮肤');
    assert.strictEqual(list.find((item) => item.id === first.skin.id).model, 'slim');

    assert.throws(() => skin.importSkin({ buffer: makePng(48, 48) }), /皮肤尺寸不对/);
  });

  await test('skin.applySkin 写入 LocalSkin/skins/<玩家名>.png（配置缺失 → ExtraList）', () => {
    const gameDir = path.join(USER_DATA, 'skin-instance');
    const instance = { id: 'skin-test', name: '皮肤测试', gameDir };
    const entry = skin.listSkins()[0];

    const result = skin.applySkin({ instance, skinId: entry.id, playerName: 'Steve' });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.playerName, 'Steve');
    assert.strictEqual(result.model, 'slim', '沿用皮肤条目里的模型');
    assert.strictEqual(result.modelWritten.mode, 'extralist', 'CSL 配置还没有 → 写 ExtraList');

    const target = path.join(gameDir, 'CustomSkinLoader', 'LocalSkin', 'skins', 'Steve.png');
    assert.strictEqual(result.target, target);
    assert.deepStrictEqual(fs.readFileSync(target), makePng(64, 64, 11), '写进去的必须还是原图');
    assert.strictEqual(fs.existsSync(`${target}.tmp`), false, '不留 .tmp');

    const extraFile = path.join(gameDir, 'CustomSkinLoader', 'ExtraList', 'viskluke-skin.json');
    assert.ok(fs.existsSync(extraFile), '配置缺失时应写 ExtraList');
    const extra = JSON.parse(fs.readFileSync(extraFile, 'utf8'));
    assert.strictEqual(extra[0].name, 'LocalSkin');
    assert.strictEqual(extra[0].model, 'slim');
    assert.strictEqual(extra[0].skin, 'LocalSkin/skins/{USERNAME}.png');

    assert.throws(() => skin.applySkin({ instance, skinId: entry.id, playerName: '../evil' }), /不合法/);
  });

  await test('skin.applySkin 已有的 CustomSkinLoader.json 只改 LocalSkin.model', () => {
    const gameDir = path.join(USER_DATA, 'skin-instance');
    const instance = { id: 'skin-test', name: '皮肤测试', gameDir };
    const configFile = path.join(gameDir, 'CustomSkinLoader', 'CustomSkinLoader.json');
    const original = {
      version: '15.1',
      enableCape: true,
      cacheExpiry: 30,
      loadlist: [
        { name: 'Mojang', type: 'MojangAPI', apiRoot: 'https://api.mojang.com/', skin: 'https://x/{USERNAME}.png' },
        {
          name: 'LocalSkin',
          type: 'Legacy',
          checkPNG: true,
          model: 'auto',
          skin: 'LocalSkin/skins/{USERNAME}.png',
          cape: 'LocalSkin/capes/{USERNAME}.png',
        },
      ],
    };
    fs.writeFileSync(configFile, JSON.stringify(original, null, 2), 'utf8');

    const entry = skin.listSkins()[0];
    const result = skin.applySkin({ instance, skinId: entry.id, playerName: 'Alex', model: 'classic' });
    assert.strictEqual(result.modelWritten.mode, 'config');
    assert.strictEqual(result.model, 'classic');

    const patched = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    assert.strictEqual(patched.version, '15.1', '其它字段必须原样保留');
    assert.strictEqual(patched.cacheExpiry, 30);
    assert.strictEqual(patched.loadlist.length, 2);
    assert.strictEqual(patched.loadlist[0].name, 'Mojang', 'Mojang 项不能被改动');
    assert.strictEqual(patched.loadlist[0].model, undefined);
    assert.strictEqual(patched.loadlist[1].name, 'LocalSkin');
    assert.strictEqual(patched.loadlist[1].model, 'default', 'classic → CSL 的 default');
    assert.strictEqual(patched.loadlist[1].skin, 'LocalSkin/skins/{USERNAME}.png');
    assert.ok(fs.existsSync(path.join(gameDir, 'CustomSkinLoader', 'LocalSkin', 'skins', 'Alex.png')));
    assert.strictEqual(skin._internal.readConfiguredModel(path.join(gameDir, 'CustomSkinLoader')), 'classic');
  });

  await test('skin.status / clearSkin 反映真实磁盘状态', () => {
    const gameDir = path.join(USER_DATA, 'skin-instance');
    const instance = { id: 'skin-test', name: '皮肤测试', gameDir, version: '1.20.4', loader: 'fabric' };

    const status = skin.status({ instance });
    assert.strictEqual(status.instance.id, 'skin-test');
    assert.strictEqual(status.instance.configExists, true);
    assert.strictEqual(status.instance.modInstalled, false);
    assert.strictEqual(status.instance.model, 'classic');
    assert.deepStrictEqual(
      status.applied.map((item) => item.playerName).sort(),
      ['Alex', 'Steve'],
      JSON.stringify(status.applied)
    );
    assert.ok(status.library.length >= 1);

    const cleared = skin.clearSkin({ instance, playerName: 'Alex' });
    assert.strictEqual(cleared.removed, true);
    assert.strictEqual(fs.existsSync(path.join(gameDir, 'CustomSkinLoader', 'LocalSkin', 'skins', 'Alex.png')), false);
    assert.strictEqual(skin.clearSkin({ instance, playerName: 'Alex' }).removed, false, '再删一次应为 false');
    assert.throws(() => skin.clearSkin({ instance, playerName: 'x' }), /不合法/);
  });

  await test('skin 能读/改带 BOM 的 CustomSkinLoader.json（记事本改过的配置）', () => {
    const gameDir = path.join(USER_DATA, 'skin-bom');
    const cslDir = path.join(gameDir, 'CustomSkinLoader');
    fs.mkdirSync(cslDir, { recursive: true });
    const configFile = path.join(cslDir, 'CustomSkinLoader.json');
    const body = JSON.stringify(
      {
        version: '15.1',
        loadlist: [{ name: 'LocalSkin', type: 'Legacy', model: 'slim', skin: 'LocalSkin/skins/{USERNAME}.png' }],
      },
      null,
      2
    );
    fs.writeFileSync(configFile, `\uFEFF${body}`, 'utf8'); // 带 BOM

    assert.strictEqual(skin._internal.readConfiguredModel(cslDir), 'slim', '带 BOM 也要能读出来');

    const entry = skin.importSkin({ buffer: makePng(64, 64, 21), name: 'BOM 测试' }).skin;
    const result = skin.applySkin({ instance: { id: 'bom', name: 'BOM', gameDir }, skinId: entry.id, playerName: 'BomTester', model: 'classic' });
    assert.strictEqual(result.modelWritten.mode, 'config', 'BOM 配置也要走改配置，而不是退回 ExtraList');

    const patched = JSON.parse(fs.readFileSync(configFile, 'utf8').replace(/^\uFEFF/, ''));
    assert.strictEqual(patched.loadlist[0].model, 'default');
    assert.strictEqual(fs.existsSync(path.join(cslDir, 'ExtraList', 'viskluke-skin.json')), false, '不该再写 ExtraList');
  });

  await test('skin.status 是只读的：不建目录、目录不存在也能返回', () => {
    const gameDir = path.join(USER_DATA, 'skin-not-yet-created');
    assert.strictEqual(fs.existsSync(gameDir), false);
    const result = skin.status({ instance: { id: 'ghost', name: '幽灵', version: '1.20.4', gameDir } });
    assert.ok(result.instance, '应该有 instance 信息');
    assert.strictEqual(result.instance.id, 'ghost');
    assert.strictEqual(result.instance.rootExists, false);
    assert.strictEqual(result.instance.configExists, false);
    assert.deepStrictEqual(result.applied, []);
    assert.strictEqual(fs.existsSync(gameDir), false, 'status 不能顺手把目录建出来');
    assert.ok(Array.isArray(result.library), '皮肤库照常返回');
  });

  await test('launcher.peekGameRoot 不建目录', () => {
    const launcher = require(path.join(ROOT, 'launcher.js'));
    const gameDir = path.join(USER_DATA, 'peek-target');
    const peek = launcher.peekGameRoot({ id: 'peek', gameDir });
    assert.strictEqual(peek.root, path.resolve(gameDir));
    assert.strictEqual(peek.exists, false);
    assert.strictEqual(fs.existsSync(gameDir), false);
    fs.mkdirSync(gameDir, { recursive: true });
    assert.strictEqual(launcher.peekGameRoot({ id: 'peek', gameDir }).exists, true);
  });

  await test('skin.installCsl 在没加载器 / 没版本时给出可读错误', async () => {
    await assert.rejects(
      () => skin.installCsl({ instance: { id: 'plain', name: '原版', version: '1.20.4', gameDir: path.join(USER_DATA, 'skin-plain') } }),
      /没有加载器/
    );
    await assert.rejects(
      () => skin.installCsl({ instance: { id: 'noloader', name: 'x', loader: 'fabric', gameDir: path.join(USER_DATA, 'skin-plain') } }),
      /没有填写游戏版本/
    );
  });

  await test('skin 披风：尺寸校验 / 入库 / 写入 capes + elytras', () => {
    // 披风只认 64×32（标准）或 22×17（旧版）
    assert.strictEqual(skin.isSkinSize(64, 32, 'cape'), true);
    assert.strictEqual(skin.isSkinSize(22, 17, 'cape'), true);
    assert.strictEqual(skin.isSkinSize(64, 64, 'cape'), false, '64×64 是皮肤不是披风');
    assert.strictEqual(skin.isSkinSize(64, 32, 'skin'), true, '64×32 也是合法皮肤（旧版）');

    const capePng = makePng(64, 32, 33);
    const imported = skin.importSkin({ buffer: capePng, name: '测试披风', kind: 'cape' });
    assert.strictEqual(imported.ok, true);
    assert.strictEqual(imported.skin.kind, 'cape');
    assert.strictEqual(imported.skin.name, '测试披风');

    // 同一张图当皮肤导入：应算作不同条目（kind 参与 id 与文件名）
    const asSkin = skin.importSkin({ buffer: makePng(64, 32, 34), kind: 'skin' });
    assert.strictEqual(asSkin.skin.kind, 'skin');

    const gameDir = path.join(USER_DATA, 'skin-cape-instance');
    const instance = { id: 'skin-cape', name: '披风测试', gameDir };
    const applied = skin.applySkin({ instance, skinId: imported.skin.id, playerName: 'CapeMan' });

    assert.strictEqual(applied.ok, true);
    assert.strictEqual(applied.kind, 'cape');
    const capePath = path.join(gameDir, 'CustomSkinLoader', 'LocalSkin', 'capes', 'CapeMan.png');
    const elytraPath = path.join(gameDir, 'CustomSkinLoader', 'LocalSkin', 'elytras', 'CapeMan.png');
    assert.strictEqual(fs.existsSync(capePath), true, '披风应写进 capes/');
    assert.strictEqual(fs.existsSync(elytraPath), true, '鞘翅应写进 elytras/');
    assert.deepStrictEqual(fs.readFileSync(capePath), capePng, '内容必须是原图');
    assert.strictEqual(applied.modelWritten.mode, 'skipped', '披风不涉及模型');
    assert.ok(/披风/.test(applied.note));

    // 清理由明：皮肤 + 披风 + 鞘翅一起删
    const cleared = skin.clearSkin({ instance, playerName: 'CapeMan' });
    assert.strictEqual(cleared.ok, true);
    assert.strictEqual(cleared.count, 2, `应删掉披风与鞘翅两份：${JSON.stringify(cleared.targets)}`);
    assert.strictEqual(fs.existsSync(capePath), false);
    assert.strictEqual(fs.existsSync(elytraPath), false);
    assert.throws(() => skin.importSkin({ buffer: makePng(64, 64, 35), kind: 'cape' }), /披风尺寸不对/);
  });

  await test('绘制器保存的数据能进皮肤库（source=draw）', () => {
    const png = makePng(64, 64, 66);
    const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
    const match = /^data:image\/png;base64,(.+)$/i.exec(dataUrl);
    assert.ok(match, '画布 toDataURL 的格式必须能解析');
    const buffer = Buffer.from(match[1], 'base64');
    assert.deepStrictEqual(buffer, png, 'base64 往返必须无损');

    const saved = skin.importSkin({ buffer, name: '我画的皮肤', kind: 'skin', source: 'draw' });
    assert.strictEqual(saved.ok, true);
    assert.strictEqual(saved.skin.source, 'draw');
    assert.strictEqual(saved.skin.kind, 'skin');
    assert.ok(skin.listSkins().some((item) => item.id === saved.skin.id));

    // 重复保存同一张（画完没改又存）→ 去重，不产生垃圾
    const again = skin.importSkin({ buffer, kind: 'skin', source: 'draw' });
    assert.strictEqual(again.duplicated, true);
    assert.strictEqual(again.skin.id, saved.skin.id);
  });

  await test('skin.removeSkin 从库里删掉并清文件', () => {
    const entry = skin.listSkins()[0];
    const removed = skin.removeSkin(entry.id);
    assert.strictEqual(removed.ok, true);
    assert.strictEqual(skin.listSkins().some((item) => item.id === entry.id), false);
    assert.throws(() => skin.removeSkin(entry.id), /皮肤不存在/);
    assert.throws(() => skin.findSkin('nope'), /皮肤不存在/);
  });

  // =====================================================================
  // 11. 白名单 / 正版验证 / 局域网地址
  // =====================================================================
  await test('buildMeta 白名单：有域名默认开、纯局域网默认关、正版验证默认开', () => {
    const withDomain = internals.buildMeta({
      core: 'paper',
      version: '1.20.4',
      prefix: 'mymc',
      suffix: 'stde.eu.cc',
      whitelistPlayers: 'Steve Alex',
    });
    assert.strictEqual(withDomain.onlineMode, true, '正版验证默认开');
    assert.strictEqual(withDomain.whitelist, true, '有域名 → 默认开白名单');
    assert.deepStrictEqual(withDomain.whitelistPlayers, ['Steve', 'Alex']);

    const lanOnly = internals.buildMeta({ core: 'paper', version: '1.20.4' });
    assert.strictEqual(lanOnly.whitelist, false, '纯局域网 → 默认不开白名单');
    assert.deepStrictEqual(lanOnly.whitelistPlayers, []);

    const explicitOff = internals.buildMeta({ core: 'paper', version: '1.20.4', prefix: 'mymc', whitelist: false });
    assert.strictEqual(explicitOff.whitelist, false, '显式关掉要尊重');

    const explicitOffline = internals.buildMeta({ core: 'paper', version: '1.20.4', onlineMode: false });
    assert.strictEqual(explicitOffline.onlineMode, false, '正版验证可以手动关');
  });

  await test('normalizePlayerList 去重 / 挡非法 / 限长', () => {
    assert.deepStrictEqual(internals.normalizePlayerList('Steve, Alex steve  bob').players, ['Steve', 'Alex', 'bob']);
    assert.deepStrictEqual(internals.normalizePlayerList(['a', 'Steve', '../evil', 'x'.repeat(17)]).players, ['Steve']);
    assert.deepStrictEqual(internals.normalizePlayerList('ab cd').skipped, ['ab', 'cd']);
    assert.deepStrictEqual(internals.normalizePlayerList('').players, []);
  });

  await test('ensureWhitelist 写 whitelist.json（离线 UUID 可复现）', async () => {
    const auth = require(path.join(ROOT, 'auth.js'));
    const dir = path.join(USER_DATA, 'wl-offline');
    fs.mkdirSync(dir, { recursive: true });
    const meta = { id: 'wl-offline', onlineMode: false, whitelist: true };
    const result = await internals.ensureWhitelist(dir, meta, { players: ['Steve', 'Alex'], enabled: true });

    assert.strictEqual(result.enabled, true);
    assert.strictEqual(result.written, 2);
    const file = path.join(dir, 'whitelist.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(parsed.length, 2);
    assert.strictEqual(parsed[0].name, 'Steve');
    assert.strictEqual(parsed[0].uuid, auth.offlineUuid('Steve'), '离线 UUID 必须与客户端一致');
    assert.strictEqual(parsed[1].name, 'Alex');

    // 手动加的人（不在我们的名单里）不能被冲掉
    fs.writeFileSync(file, JSON.stringify([...parsed, { uuid: 'manual-uuid', name: 'Notch' }]));
    const again = await internals.ensureWhitelist(dir, meta, { players: ['Steve'], enabled: true });
    const merged = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(merged.some((entry) => entry.name === 'Notch'), '手动加的白名单要保留');
    assert.ok(merged.some((entry) => entry.name === 'Steve'));
    assert.strictEqual(again.written, merged.length);
  });

  await test('ensureWhitelist 正版模式查不到 UUID 时跳过并提示', async () => {
    const dir = path.join(USER_DATA, 'wl-online');
    fs.mkdirSync(dir, { recursive: true });
    const meta = { id: 'wl-online', onlineMode: true, whitelist: true };
    const before = mojangLookups.length;
    const result = await internals.ensureWhitelist(dir, meta, {
      players: ['Zzz9FakeAcct'],
      enabled: true,
    });
    assert.ok(mojangLookups.length > before, '正版模式应该去查一次 Mojang');
    assert.strictEqual(result.written, 0, '查不到 UUID 不应该写进去（否则白名单永远不生效）');
    assert.ok(result.warnings.some((w) => /查不到 Mojang UUID/.test(w)), JSON.stringify(result.warnings));
    assert.ok(fs.existsSync(path.join(dir, 'whitelist.json')), '仍应写出（可能为空的）whitelist.json');
  });

  await test('ensureProperties 写入 white-list / enforce-whitelist', async () => {
    const onDir = path.join(USER_DATA, 'props-wl-on');
    fs.mkdirSync(onDir, { recursive: true });
    await internals.ensureProperties(onDir, {
      port: 25565,
      onlineMode: true,
      whitelist: true,
      motd: 'wl',
      maxPlayers: 20,
    });
    const on = internals.readProperties(path.join(onDir, 'server.properties'));
    assert.strictEqual(on['white-list'], 'true');
    assert.strictEqual(on['enforce-whitelist'], 'true');
    assert.strictEqual(on['online-mode'], 'true');

    const offDir = path.join(USER_DATA, 'props-wl-off');
    fs.mkdirSync(offDir, { recursive: true });
    fs.writeFileSync(path.join(offDir, 'server.properties'), 'white-list=true\nenforce-whitelist=true\n');
    await internals.ensureProperties(offDir, {
      port: 25566,
      onlineMode: false,
      whitelist: false,
      motd: 'wl',
      maxPlayers: 20,
    });
    const off = internals.readProperties(path.join(offDir, 'server.properties'));
    assert.strictEqual(off['white-list'], 'false', '关掉白名单要覆盖上次的残留');
    assert.strictEqual(off['online-mode'], 'false');
    assert.strictEqual(off['enforce-secure-profile'], 'false', '离线模式自动关 secure-profile');
    assert.strictEqual(off['server-port'], '25566');
  });

  await test('lanAddress 返回本机非回环 IPv4 或空字符串', () => {
    const ip = internals.lanAddress();
    assert.ok(typeof ip === 'string');
    if (ip) {
      assert.ok(/^\d{1,3}(\.\d{1,3}){3}$/.test(ip), ip);
      assert.strictEqual(ip.startsWith('127.'), false, '不能是回环地址');
    }
  });

  // =====================================================================
  // 12. Cloudflare Worker 代理（零配置开服通道）
  // =====================================================================
  await test('cloudflare.status 在代理模式下的字段', () => {
    process.env.CF_PROXY_URL = 'http://127.0.0.1:9/';
    cloudflare.loadConfig(true);
    const st = cloudflare.status();
    assert.strictEqual(st.transport, 'proxy');
    assert.strictEqual(st.configured, true, '代理模式不需要本地 Token');
    assert.strictEqual(st.proxyUrl, 'http://127.0.0.1:9', '末尾斜杠要去掉');
    assert.deepStrictEqual(st.missingZones, []);
    delete process.env.CF_PROXY_URL;
    cloudflare.loadConfig(true);
  });

  await test('cloudflare.sync 走 Worker 代理（本地假 Worker）', async () => {
    const http = require('http');
    const calls = [];
    const fakeWorker = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        calls.push({ url: req.url, method: req.method, body });
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/health') {
          res.end(JSON.stringify({ ok: true, zones: ['stde.eu.cc'], zoneCount: 1 }));
          return;
        }
        if (req.url === '/sync') {
          const payload = JSON.parse(body || '{}');
          res.end(
            JSON.stringify({
              ok: true,
              mode: 'ip',
              address: `${payload.prefix}.${payload.suffix}`,
              targetIp: '203.0.113.77',
              srvName: `_minecraft._tcp.${payload.prefix}.${payload.suffix}`,
              srvTarget: `${payload.prefix}.${payload.suffix}`,
              port: payload.port,
              ttl: 60,
              records: { a: 'recA', srv: 'recS' },
              warnings: [],
            })
          );
          return;
        }
        if (req.url === '/remove') {
          res.end(JSON.stringify({ ok: true, removed: ['recA', 'recS'] }));
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ ok: false, error: 'nope' }));
      });
    });
    await new Promise((resolve) => fakeWorker.listen(0, '127.0.0.1', resolve));
    const port = fakeWorker.address().port;

    try {
      process.env.CF_PROXY_URL = `http://127.0.0.1:${port}`;
      cloudflare.loadConfig(true);

      const health = await cloudflare.verify();
      assert.strictEqual(health.ok, true);
      assert.strictEqual(health.transport, 'proxy');

      const info = await cloudflare.sync({ prefix: 'proxytest', suffix: 'stde.eu.cc', port: 25570 });
      assert.strictEqual(info.address, 'proxytest.stde.eu.cc');
      assert.strictEqual(info.port, 25570);
      assert.strictEqual(info.targetIp, '203.0.113.77');
      assert.strictEqual(info.viaProxy, true);
      assert.deepStrictEqual(info.records, { a: 'recA', srv: 'recS' });

      const removed = await cloudflare.remove({ address: 'proxytest.stde.eu.cc', suffix: 'stde.eu.cc' });
      assert.deepStrictEqual(removed.removed, ['recA', 'recS']);

      const syncCall = calls.find((c) => c.url === '/sync');
      const sent = JSON.parse(syncCall.body);
      assert.strictEqual(sent.prefix, 'proxytest');
      assert.strictEqual(sent.port, 25570);
      assert.ok(!JSON.stringify(calls).includes('test-token'), '代理请求里绝不能出现 Token');
    } finally {
      delete process.env.CF_PROXY_URL;
      cloudflare.loadConfig(true);
      await new Promise((resolve) => fakeWorker.close(resolve));
    }
  });

  await test('Worker 代码本身：只按名单里的后缀建记录、忽略伪造域名删除', async () => {
    const workerPath = path.join(ROOT, 'worker', 'cloudflare-dns-worker.mjs');
    const worker = (await import(`file:///${workerPath.replace(/\\/g, '/')}`)).default;

    const cfCalls = [];
    const origin = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      const target = String(url);
      const body = init.body ? JSON.parse(init.body) : null;
      cfCalls.push({ target, method: init.method || 'GET', body });
      // 让查询返回空数组（当成新记录），写入返回 id
      const isList = target.includes('/dns_records?name=');
      const payload = isList
        ? { success: true, result: [] }
        : { success: true, result: { id: `rec-${cfCalls.length}` } };
      return { json: async () => payload, status: 200 };
    };

    try {
      const env = {
        CF_API_TOKEN: 'worker-secret',
        CF_ZONES: JSON.stringify({ 'stde.eu.cc': 'zone-1' }),
        RATE_LIMIT_PER_MIN: '0',
      };

      const req = (pathname, body, method = 'POST') =>
        new Request(`https://worker.example${pathname}`, {
          method,
          headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '198.51.100.9' },
          body: body ? JSON.stringify(body) : undefined,
        });

      const sync = await worker.fetch(req('/sync', { prefix: 'abcd', suffix: 'stde.eu.cc', port: 25565 }), env);
      const syncJson = await sync.json();
      assert.strictEqual(syncJson.ok, true, JSON.stringify(syncJson));
      assert.strictEqual(syncJson.address, 'abcd.stde.eu.cc');
      assert.strictEqual(syncJson.targetIp, '198.51.100.9', 'A 记录用请求来源 IP');
      assert.ok(
        cfCalls.some((c) => c.method === 'POST' && c.body.type === 'SRV' && c.body.data.port === 25565),
        '应创建带端口的 SRV'
      );
      assert.ok(!cfCalls.some((c) => c.body && c.body.proxied === true), 'A/SRV 都不能走橙云代理');

      const badSuffix = await worker.fetch(req('/sync', { prefix: 'abcd', suffix: 'evil.com', port: 25565 }), env);
      assert.strictEqual((await badSuffix.json()).ok, false, '没配置的后缀必须拒绝');

      const badPrefix = await worker.fetch(req('/sync', { prefix: 'www', suffix: 'stde.eu.cc', port: 25565 }), env);
      assert.strictEqual((await badPrefix.json()).ok, false, '保留字前缀必须拒绝');

      const badDelete = await worker.fetch(req('/remove', { address: 'other.example.com', suffix: 'stde.eu.cc' }), env);
      assert.strictEqual((await badDelete.json()).ok, false, '不能拿 Worker 删任意域名');

      // 带 IPv6 头 → 双栈
      const dualReq = new Request('https://worker.example/sync', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'CF-Connecting-IP': '198.51.100.9',
          'CF-Connecting-IPv6': '240e:3b0:abcd::5',
        },
        body: JSON.stringify({ prefix: 'dual', suffix: 'stde.eu.cc', port: 25565 }),
      });
      const dual = await (await worker.fetch(dualReq, env)).json();
      assert.strictEqual(dual.ok, true, JSON.stringify(dual));
      assert.strictEqual(dual.mode, 'dual');
      assert.strictEqual(dual.targetIpv6, '240e:3b0:abcd::5');
      assert.ok(
        cfCalls.some((c) => c.body && c.body.type === 'AAAA' && c.body.content === '240e:3b0:abcd::5'),
        'Worker 应建 AAAA 记录'
      );
      assert.ok(dual.records.aaaa && dual.records.a, 'AAAA 与 A 都要有 id');
    } finally {
      globalThis.fetch = origin;
    }
  });

  await test('手动解析域名：登记 / 算记录 / 解绑（DNS 在 GNAME 等）', async () => {
    const added = cloudflare.addManualZone({ suffix: 'MyDomain.CN' });
    assert.strictEqual(added.ok, true);
    assert.strictEqual(added.suffix, 'mydomain.cn');
    assert.deepStrictEqual(added.manualSuffixes, ['mydomain.cn']);

    const st = cloudflare.status();
    assert.ok(st.suffixes.includes('mydomain.cn'), JSON.stringify(st.suffixes));
    assert.deepStrictEqual(st.manualSuffixes, ['mydomain.cn']);
    assert.deepStrictEqual(st.customSuffixes, [], '手动解析的不算 Cloudflare 自定义域名');
    assert.strictEqual(st.transports['mydomain.cn'], 'manual');
    assert.strictEqual(st.configured, true, '有手动域名也算"可用"');
    assert.ok(!st.missingZones.includes('mydomain.cn'), '手动域名不算缺 Zone');

    // 服务器配置认这个后缀
    const meta = internals.buildMeta({ core: 'paper', version: '1.20.4', suffix: 'mydomain.cn', prefix: 'mc' });
    assert.strictEqual(meta.address, 'mc.mydomain.cn');

    // 该填什么记录
    const manual = await cloudflare.manualRecords({ prefix: 'mc', suffix: 'mydomain.cn', port: 25577, ip: '203.0.113.9' });
    assert.strictEqual(manual.address, 'mc.mydomain.cn');
    assert.strictEqual(manual.records[0].type, 'A');
    assert.strictEqual(manual.records[0].name, 'mc.mydomain.cn');
    assert.strictEqual(manual.records[0].value, '203.0.113.9');
    assert.strictEqual(manual.records[1].type, 'SRV');
    assert.strictEqual(manual.records[1].name, '_minecraft._tcp.mc.mydomain.cn');
    assert.strictEqual(manual.records[1].value, '0 5 25577 mc.mydomain.cn');

    // 内网 IP 要能识别出来
    const lanOnly = await cloudflare.manualRecords({ prefix: 'mc', suffix: 'mydomain.cn', port: 25565, ip: '192.168.1.5' });
    assert.strictEqual(lanOnly.privateIp, true);

    // 手动域名不能走 Cloudflare 写入
    await assert.rejects(() => cloudflare.sync({ prefix: 'mc', suffix: 'mydomain.cn', port: 25565 }), /手动|域名/);

    assert.throws(() => cloudflare.addManualZone({ suffix: 'bad domain' }), /域名格式不对/);
    const removed = cloudflare.removeManualZone('mydomain.cn');
    assert.strictEqual(removed.ok, true);
    assert.deepStrictEqual(cloudflare.status().manualSuffixes, []);
    assert.throws(() => cloudflare.removeManualZone('mydomain.cn'), /没有登记过/);
  });

  // =====================================================================
  // 13. 联机可达性诊断（UPnP / NAT）
  // =====================================================================
  const netcheck = require(path.join(ROOT, 'netcheck.js'));
  const relayModule = require(path.join(ROOT, 'relay.js'));
  assert.ok(relayModule);

  await test('netcheck.classify 判断四种网络形态', () => {
    assert.strictEqual(netcheck.isCgnat('100.64.1.2'), true);
    assert.strictEqual(netcheck.isCgnat('100.127.255.1'), true);
    assert.strictEqual(netcheck.isCgnat('100.128.0.1'), false);
    assert.strictEqual(netcheck.isPrivateIpv4('192.168.1.5'), true);
    assert.strictEqual(netcheck.isPrivateIpv4('172.20.0.1'), true);
    assert.strictEqual(netcheck.isPrivateIpv4('122.238.17.108'), false);

    assert.strictEqual(netcheck.classify({ ipv6: '240e:3b0::1' }).nat, 'ipv6');
    assert.strictEqual(
      netcheck.classify({ gatewayFound: true, routerIp: '122.238.17.108', publicIp: '122.238.17.108' }).nat,
      'public'
    );
    assert.strictEqual(netcheck.classify({ gatewayFound: true, routerIp: '100.72.5.9' }).nat, 'cgnat');
    assert.strictEqual(netcheck.classify({ gatewayFound: true, routerIp: '192.168.1.1' }).nat, 'double-nat');
    assert.strictEqual(
      netcheck.classify({ gatewayFound: true, routerIp: '10.0.0.2', publicIp: '122.238.17.108' }).nat,
      'double-nat'
    );
    assert.strictEqual(netcheck.classify({ gatewayFound: false }).nat, 'unknown');
  });

  await test('netcheck.buildAdvice 给出新手能照做的建议', () => {
    const publicOk = netcheck.buildAdvice({
      nat: 'public',
      port: 25565,
      publicIp: '122.238.17.108',
      lanIp: '192.168.1.100',
      mapping: { ok: true },
      ipv6: '',
    });
    assert.ok(publicOk.some((line) => line.includes('已经自动帮你把 25565 端口映射好了')), JSON.stringify(publicOk));
    assert.ok(publicOk.some((line) => line.includes('防火墙')));

    const publicNoMap = netcheck.buildAdvice({
      nat: 'public',
      port: 25565,
      publicIp: '122.238.17.108',
      lanIp: '192.168.1.100',
      mapping: null,
      ipv6: '',
    });
    assert.ok(publicNoMap.some((line) => line.includes('192.168.1.100')), '要告诉新手内部 IP 填什么');

    const cgnat = netcheck.buildAdvice({ nat: 'cgnat', port: 25565, ipv6: '' });
    assert.ok(cgnat.some((line) => line.includes('公网 IP')), JSON.stringify(cgnat));
    assert.ok(cgnat.some((line) => line.includes('IPv6') || line.includes('穿透')));

    const doubleNat = netcheck.buildAdvice({ nat: 'double-nat', port: 25565, ipv6: '' });
    assert.ok(doubleNat.some((line) => line.includes('光猫')), JSON.stringify(doubleNat));

    const ipv6Advice = netcheck.buildAdvice({ nat: 'ipv6', port: 25565, ipv6: '240e:3b0::1' });
    assert.ok(ipv6Advice.some((line) => line.includes('240e:3b0::1')), '要把 IPv6 地址直接写出来');
    assert.ok(ipv6Advice.some((line) => line.includes('AAAA')));
  });

  await test('netcheck 解析网关描述 XML（UPnP）', () => {
    const xml = `<?xml version="1.0"?>
      <root xmlns="urn:schemas-upnp-org:device-1-0">
        <device>
          <friendlyName>Tenda AC23</friendlyName>
          <serviceList>
            <service>
              <serviceType>urn:schemas-upnp-org:service:Layer3Forwarding:1</serviceType>
              <controlURL>/ctl/L3F</controlURL>
            </service>
            <service>
              <serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType>
              <controlURL>/ctl/IPConn</controlURL>
            </service>
          </serviceList>
        </device>
      </root>`;
    const parsed = netcheck._internal.parseDeviceXml(xml, 'http://192.168.1.1:49152/rootDesc.xml');
    assert.strictEqual(parsed.friendlyName, 'Tenda AC23');
    assert.strictEqual(parsed.serviceType, 'urn:schemas-upnp-org:service:WANIPConnection:1');
    assert.strictEqual(parsed.controlUrl, 'http://192.168.1.1:49152/ctl/IPConn');
  });

  await test('netcheck SOAP 请求体符合 UPnP 规范', () => {
    const body = netcheck._internal.envelope('urn:schemas-upnp-org:service:WANIPConnection:1', 'AddPortMapping',
      '<NewExternalPort>25565</NewExternalPort>');
    assert.ok(body.includes('<u:AddPortMapping xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1">'), body);
    assert.ok(body.includes('<NewExternalPort>25565</NewExternalPort>'));
    assert.ok(body.includes('s:Envelope'));
    assert.strictEqual(netcheck._internal.UPNP_HINTS[718].includes('占用'), true);
  });

  await test('netcheck.buildAdvice 会优先推荐虚拟组网（Radmin / ZeroTier）', () => {
    const advice = netcheck.buildAdvice({
      nat: 'unknown',
      port: 25565,
      publicIp: '122.238.17.108',
      lanIp: '192.168.31.211',
      ipv6: '',
      virtualAdapters: [{ iface: 'Radmin VPN', ip: '26.31.144.161', private: false, virtual: true }],
    });
    assert.ok(advice[0].includes('Radmin VPN'), '第一条就应该提组网工具：' + advice[0]);
    assert.ok(advice[0].includes('26.31.144.161'));
  });

  await test('netcheck 网卡识别：虚拟网卡不当成真局域网', () => {
    const all = netcheck.listIpv4();
    assert.ok(Array.isArray(all));
    const lan = netcheck.lanIpv4();
    assert.strictEqual(typeof lan, 'string');
    // 真局域网优先：如果能找到 192.168/10/172 的真网卡，就不应该返回 26.x 这种虚拟网卡地址
    const realPrivate = all.find((item) => item.private && !item.virtual);
    if (realPrivate) assert.strictEqual(lan, realPrivate.ip, `应优先 ${realPrivate.ip}，实际 ${lan}`);
    // 虚拟网卡必须被标记出来（Radmin / vEthernet / VPN 等）
    for (const item of netcheck.virtualAdapters()) assert.strictEqual(item.virtual, true);
    // IPv6 必须是可收连接的（Teredo 2001:0: 与 6to4 2002: 都不能算）
    const v6 = netcheck.globalIpv6();
    assert.ok(!/^2001:0:/i.test(v6), `不能把 Teredo 当公网 IPv6：${v6}`);
    assert.ok(!/^2002:/i.test(v6), `不能把 6to4 当公网 IPv6：${v6}`);
  });

  await test('netcheck.report 不炸（本机无 UPnP 时给出 unknown + 建议）', async () => {
    const report = await netcheck.report({ port: 25599 });
    assert.strictEqual(typeof report.nat, 'string');
    assert.ok(['public', 'double-nat', 'cgnat', 'ipv6', 'unknown'].includes(report.nat), report.nat);
    assert.ok(Array.isArray(report.advice) && report.advice.length > 0);
    assert.strictEqual(report.port, 25599);
    assert.strictEqual(typeof report.lanIp, 'string');
    // 沙箱里通常发现不到 IGD，但绝不能抛错
    assert.strictEqual(typeof report.gateway.found, 'boolean');
  });

  await test('cloudflare.sync 有 IPv6 时建 AAAA（双栈），没有就只建 A', async () => {
    // 先绑一个域名（走直连）
    cloudflare.addZone({ suffix: 'ipv6test.com', zoneId: 'd'.repeat(32) });

    cfCalls.length = 0;
    const dual = await cloudflare.sync({
      prefix: 'v6',
      suffix: 'ipv6test.com',
      port: 25565,
      ipv6: '240e:3b0:1234::1',
    });
    assert.strictEqual(dual.mode, 'dual');
    assert.strictEqual(dual.targetIpv6, '240e:3b0:1234::1');
    assert.ok(dual.records.aaaa, '应该建了 AAAA');
    const aaaa = cfCalls.find((c) => c.method === 'POST' && c.data && c.data.type === 'AAAA');
    assert.ok(aaaa, '应发出 AAAA 创建请求');
    assert.strictEqual(aaaa.data.name, 'v6.ipv6test.com');
    assert.strictEqual(aaaa.data.content, '240e:3b0:1234::1');
    assert.strictEqual(aaaa.data.proxied, false, 'AAAA 也不能走橙云');
    assert.ok(dual.warnings.some((w) => w.includes('IPv6')), JSON.stringify(dual.warnings));

    cfCalls.length = 0;
    const v4 = await cloudflare.sync({ prefix: 'v4', suffix: 'ipv6test.com', port: 25565, ipv6: '' });
    assert.strictEqual(v4.mode, 'ip');
    assert.ok(v4.records.a);
    assert.ok(!cfCalls.some((c) => c.data && c.data.type === 'AAAA'), '没有 IPv6 就不该建 AAAA');

    // 手动解析也要能给出 AAAA 记录
    const manual = await cloudflare.manualRecords({
      prefix: 'mc',
      suffix: 'ipv6test.com',
      port: 25565,
      ip: '203.0.113.10',
      ipv6: '240e:3b0:1234::1',
    });
    const types = manual.records.map((r) => r.type);
    assert.deepStrictEqual(types, ['A', 'AAAA', 'SRV'], JSON.stringify(types));
    assert.strictEqual(manual.records[1].value, '240e:3b0:1234::1');

    cloudflare.removeZone('ipv6test.com');
  });

  await test('netcheck.probeTcp 能判断端口是否真的在监听', async () => {
    const http = require('http');
    const probeServer = http.createServer((req, res) => res.end('ok'));
    await new Promise((resolve) => probeServer.listen(0, '127.0.0.1', resolve));
    const port = probeServer.address().port;
    try {
      const open = await netcheck.probeTcp({ host: '127.0.0.1', port, timeout: 3000 });
      assert.strictEqual(open.state, 'open', JSON.stringify(open));

      const closed = await netcheck.probeTcp({ host: '127.0.0.1', port: port + 1, timeout: 1500 });
      assert.ok(['error', 'timeout'].includes(closed.state), JSON.stringify(closed));
    } finally {
      await new Promise((resolve) => probeServer.close(resolve));
    }
  });

  await test('netcheck.reachability 三种结论都能给对', async () => {
    const http = require('http');
    const srv = http.createServer((req, res) => res.end('ok'));
    await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const port = srv.address().port;
    try {
      // 1) 局域网通 + Worker 说外面也通 → reachable
      const reachable = await netcheck.reachability({
        port,
        lanIp: '127.0.0.1',
        publicIp: '',
        proxyProbe: async () => ({ reachable: true, ms: 42 }),
      });
      assert.strictEqual(reachable.verdict, 'reachable', JSON.stringify(reachable));
      assert.strictEqual(reachable.hasExternal, true);
      assert.ok(reachable.summary.includes('公网可达'));

      // 2) 局域网通 + Worker 说外面不通 → blocked
      const blocked = await netcheck.reachability({
        port,
        lanIp: '127.0.0.1',
        publicIp: '',
        proxyProbe: async () => ({ reachable: false, error: 'ECONNREFUSED' }),
      });
      assert.strictEqual(blocked.verdict, 'blocked', JSON.stringify(blocked));

      // 3) 没有外部视角、只有局域网 → lan-only
      const lanOnly = await netcheck.reachability({ port, lanIp: '127.0.0.1', publicIp: '' });
      assert.strictEqual(lanOnly.verdict, 'lan-only', JSON.stringify(lanOnly));
      assert.strictEqual(lanOnly.hasExternal, false);

      // 4) 端口没人监听 → down
      const down = await netcheck.reachability({ port: port + 1, lanIp: '127.0.0.1', publicIp: '', timeout: 1200 });
      assert.strictEqual(down.verdict, 'down', JSON.stringify(down));
    } finally {
      await new Promise((resolve) => srv.close(resolve));
    }
  });

  await test('Worker /probe 用外部视角验证端口（桩掉 cloudflare:sockets）', async () => {
    const workerPath = path.join(ROOT, 'worker', 'cloudflare-dns-worker.mjs');
    const worker = (await import(`file:///${workerPath.replace(/\\/g, '/')}`)).default;

    const makeReq = (body) =>
      new Request('https://worker.example/probe', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '198.51.100.7' },
        body: JSON.stringify(body),
      });

    // 连得上
    const openEnv = {
      CF_API_TOKEN: 'x',
      CF_ZONES: '{"stde.eu.cc":"zone-1"}',
      RATE_LIMIT_PER_MIN: '0',
      __testConnect: () => ({ opened: Promise.resolve(), close: async () => {} }),
    };
    const opened = await (await worker.fetch(makeReq({ host: '122.238.17.108', port: 25565 }), openEnv)).json();
    assert.strictEqual(opened.ok, true);
    assert.strictEqual(opened.reachable, true, JSON.stringify(opened));
    assert.strictEqual(opened.port, 25565);

    // 连不上
    const closedEnv = {
      ...openEnv,
      __testConnect: () => ({ opened: Promise.reject(new Error('connection refused')), close: async () => {} }),
    };
    const closed = await (await worker.fetch(makeReq({ host: '122.238.17.108', port: 25565 }), closedEnv)).json();
    assert.strictEqual(closed.ok, true, '连不上也是"探测成功"，只是 reachable=false');
    assert.strictEqual(closed.reachable, false);
    assert.ok(/refused/.test(closed.error), closed.error);

    // 参数校验
    const badPort = await (await worker.fetch(makeReq({ host: '1.2.3.4', port: 99999 }), openEnv)).json();
    assert.strictEqual(badPort.ok, false);
    const badHost = await (await worker.fetch(makeReq({ host: 'bad host!', port: 25565 }), openEnv)).json();
    assert.strictEqual(badHost.ok, false);
  });

  await test('relay 端到端：主机隧道 + 玩家代理 + 中继，数据能往返', async () => {
    const net = require('net');
    const relay = require(path.join(ROOT, 'relay.js'));
    const { createRelayServer } = require(path.join(ROOT, 'scripts', 'test-relay.js'));

    // 假 MC 服务器：收到什么回 "ECHO:" + 内容
    const mc = net.createServer((sock) => sock.on('data', (d) => sock.write(Buffer.concat([Buffer.from('ECHO:'), d]))));
    await new Promise((r) => mc.listen(0, '127.0.0.1', r));
    const mcPort = mc.address().port;
    const relayServer = await createRelayServer();
    let host = null;
    let guest = null;
    try {
      host = await relay.startHostTunnel({ relayUrl: relayServer.url, room: 'unit-room', localPort: mcPort });
      guest = await relay.startGuestProxy({ relayUrl: relayServer.url, room: 'unit-room', listenPort: 0 });
      await new Promise((r) => setTimeout(r, 400));

      const echo = await new Promise((resolve, reject) => {
        const client = net.connect({ host: '127.0.0.1', port: guest.port }, () => client.write('ping-from-test'));
        let text = '';
        client.on('data', (d) => {
          text += d.toString();
          if (text.includes('ping-from-test')) {
            client.destroy();
            resolve(text);
          }
        });
        client.on('error', reject);
        setTimeout(() => reject(new Error('中继往返超时：' + JSON.stringify(text))), 6000);
      });
      assert.strictEqual(echo, 'ECHO:ping-from-test');
      assert.ok(relayServer.stats.hosts === 1 && relayServer.stats.guests === 1, JSON.stringify(relayServer.stats));
    } finally {
      if (guest) await guest.close();
      if (host) host.close();
      await relayServer.close();
      await new Promise((r) => mc.close(r));
    }
  });

  await test('relay 口令：一致的能连，不一致的直接被中继拒绝', async () => {
    const net = require('net');
    const relay = require(path.join(ROOT, 'relay.js'));
    const { createRelayServer } = require(path.join(ROOT, 'scripts', 'test-relay.js'));

    const mc = net.createServer((sock) => sock.on('data', (d) => sock.write(d)));
    await new Promise((r) => mc.listen(0, '127.0.0.1', r));
    const relayServer = await createRelayServer();
    let host = null;
    let good = null;
    try {
      host = await relay.startHostTunnel({ relayUrl: relayServer.url, room: 'key-room', key: 'secret123', localPort: mc.address().port });
      assert.strictEqual(host.key, 'secret123');

      // 错误口令：代理能起来，但玩家连不上（中继 1008 拒绝）
      const bad = await relay.startGuestProxy({ relayUrl: relayServer.url, room: 'key-room', key: 'wrong999', listenPort: 0 });
      const badResult = await new Promise((resolve) => {
        const c = net.connect({ host: '127.0.0.1', port: bad.port }, () => c.write('should-not-pass'));
        let buf = '';
        c.on('data', (d) => {
          buf += d.toString();
        });
        c.on('close', () => resolve(buf));
        c.on('error', () => resolve(buf));
        setTimeout(() => resolve(buf), 3000);
      });
      await bad.close();
      assert.strictEqual(badResult, '', '错误口令不该有任何数据回来');

      // 正确口令：通
      good = await relay.startGuestProxy({ relayUrl: relayServer.url, room: 'key-room', key: 'secret123', listenPort: 0 });
      await new Promise((r) => setTimeout(r, 350));
      const echoed = await new Promise((resolve, reject) => {
        const c = net.connect({ host: '127.0.0.1', port: good.port }, () => c.write('with-key'));
        let buf = '';
        c.on('data', (d) => {
          buf += d.toString();
          if (buf.includes('with-key')) {
            c.destroy();
            resolve(buf);
          }
        });
        c.on('error', reject);
        setTimeout(() => reject(new Error('超时: ' + JSON.stringify(buf))), 6000);
      });
      assert.strictEqual(echoed, 'with-key');
    } finally {
      if (good) await good.close();
      if (host) host.close();
      await relayServer.close();
      await new Promise((r) => mc.close(r));
    }
  });

  await test('relay 口令格式校验', () => {
    const relay = require(path.join(ROOT, 'relay.js'));
    assert.strictEqual(relay.normalizeKey(''), '');
    assert.strictEqual(relay.normalizeKey('abc123'), 'abc123');
    assert.throws(() => relay.normalizeKey('ab1'), /6~64/);
    assert.throws(() => relay.normalizeKey('has space'), /6~64/);
    const url = relay.relayUrlOf('wss://r.example.com', 'room-1', 'guest', 'abc123');
    assert.ok(url.includes('key=abc123'), url);
    assert.strictEqual(relay.MAX_GUESTS, 32);
  });

  await test('relay 房间号校验与地址拼接', () => {
    const relay = require(path.join(ROOT, 'relay.js'));
    assert.strictEqual(relay.normalizeRoom('mc-abc_1'), 'mc-abc_1');
    assert.throws(() => relay.normalizeRoom('a'), /3~32/);
    assert.throws(() => relay.normalizeRoom('带中文'), /3~32/);
    assert.throws(() => relay.normalizeRoom('has space'), /3~32/);
    const url = relay.relayUrlOf('wss://relay.example.com/', 'room-1', 'host');
    assert.strictEqual(url, 'wss://relay.example.com/relay?room=room-1&role=host');
    assert.throws(() => relay.relayUrlOf('https://relay.example.com', 'room-1', 'host'), /ws:\/\/|wss:\/\//);
    const room = relay.suggestRoom('My Server!');
    assert.ok(/^myserver-[0-9a-f]{4}$/.test(room), room);
    // 帧编解码往返
    const buf = relay._internal.frame(2, 7, Buffer.from('abc'));
    const parsed = relay._internal.parseFrame(buf);
    assert.strictEqual(parsed.type, 2);
    assert.strictEqual(parsed.streamId, 7);
    assert.strictEqual(parsed.payload.toString(), 'abc');
  });

  // =====================================================================
  // 结果
  // =====================================================================
  console.log('\n----------------------------------------');
  if (failures.length) {
    console.log(`FAILED: ${failures.length}`);
    for (const f of failures) console.log(`- ${f.name}: ${f.err.stack || f.err.message}`);
    process.exit(1);
  }
  console.log('ALL TESTS PASSED');
  fs.rmSync(USER_DATA, { recursive: true, force: true });
})();
