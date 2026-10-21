'use strict';

/**
 * 真实中继端到端测试（会走公网 Cloudflare，不是本地夹具）
 *
 *   假 MC 服务器（本地 TCP 回声）
 *        ▲
 *        │ TCP
 *   主机隧道（relay.startHostTunnel）
 *        ▲
 *        │ WSS
 *   relay.stde.eu.cc（Cloudflare Worker + Durable Object）
 *        ▲
 *        │ WSS
 *   玩家本地代理（relay.startGuestProxy）
 *        ▲
 *        │ TCP 127.0.0.1:<随机端口>
 *   测试客户端
 *
 * 覆盖：小包往返、256KB 大包、两个玩家并发、房间口令错误被拒、没有主机时被拒。
 *
 * 用法：
 *   npm run test:relay
 *   set RELAY_URL=wss://自己的中继 && npm run test:relay
 */

const crypto = require('crypto');
const net = require('net');
const path = require('path');

const relay = require(path.join(__dirname, '..', 'relay.js'));
const cloudflare = require(path.join(__dirname, '..', 'cloudflare.js'));

const RELAY_URL = String(process.env.RELAY_URL || cloudflare.BUILTIN_RELAY_URL || '').trim();
const KEY = 'liveKey123';
const HELLO = Buffer.from('VISKLUKE_RELAY_HELLO');
const TIMEOUT = 30000;

function log(message) {
  process.stdout.write(`${message}\n`);
}

function step(message) {
  log(`  ✓ ${message}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function waitFor(check, description, timeout = TIMEOUT) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      let value = false;
      try {
        value = check();
      } catch (error) {
        return reject(error);
      }
      if (value) return resolve(value);
      if (Date.now() - started > timeout) return reject(new Error(`等待超时：${description}`));
      setTimeout(tick, 50);
    };
    tick();
  });
}

function makeRoom(label) {
  return `live-${label}-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`;
}

function startEchoServer() {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      socket.on('error', () => {});
      socket.write(HELLO);
      socket.on('data', (chunk) => {
        if (!socket.destroyed) socket.write(chunk);
      });
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/**
 * 连上本地代理，发 payload，等「HELLO + 原样回声」。
 * @returns {Promise<{bytes:number}>}
 */
function roundTrip(port, payload, timeout = TIMEOUT) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const expected = Buffer.concat([HELLO, payload]);
    let received = Buffer.alloc(0);
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`数据没有在 ${timeout}ms 内回来（收到 ${received.length}/${expected.length} 字节）`)), timeout);
    socket.on('error', (error) => finish(error));
    socket.on('close', () => {
      if (!settled) finish(new Error(`连接提前关闭（收到 ${received.length}/${expected.length} 字节）`));
    });
    socket.on('connect', () => socket.write(payload));
    socket.on('data', (chunk) => {
      received = Buffer.concat([received, chunk]);
      if (received.length < expected.length) return;
      if (!received.subarray(0, expected.length).equals(expected)) {
        return finish(new Error(`回声内容不一致（收到 ${received.length} 字节）`));
      }
      finish(null, { bytes: received.length });
    });
  });
}

/** 连本地代理，预期它被中继拒绝（连上后很快断开） */
function expectRejected(port, logs, pattern, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      // 有些平台 close 事件来得慢，日志里已经能证明被拒也算通过
      if (logs.some((line) => pattern.test(line))) finish(null);
      else finish(new Error(`没有被拒绝，也没有等到日志：${pattern}`));
    }, timeout);
    socket.on('error', () => {});
    socket.on('close', () => {
      if (logs.some((line) => pattern.test(line))) finish(null);
      else setTimeout(() => {
        if (logs.some((line) => pattern.test(line))) finish(null);
        else finish(new Error(`连接被关闭，但没有出现预期日志：${pattern}；实际：${logs.slice(-3).join(' | ')}`));
      }, 500);
    });
  });
}

async function main() {
  if (!RELAY_URL) throw new Error('RELAY_URL 为空：config.json 的 RELAY_URL 和内置默认值都没配');
  assert(/^wss?:\/\//.test(RELAY_URL), `中继地址必须是 ws:// 或 wss://：${RELAY_URL}`);

  log(`真实中继端到端测试 → ${RELAY_URL}`);
  const mc = await startEchoServer();
  const mcPort = mc.address().port;
  step(`假 MC 服务器已就绪 127.0.0.1:${mcPort}`);

  const room = makeRoom('main');
  const hostLogs = [];
  const guestLogs = [];
  let host = null;
  let guest = null;

  try {
    host = await relay.startHostTunnel({
      relayUrl: RELAY_URL,
      room,
      key: KEY,
      localPort: mcPort,
      onLog: (line) => hostLogs.push(line),
    });
    step(`主机隧道已连上中继（房间 ${room}）`);

    guest = await relay.startGuestProxy({
      relayUrl: RELAY_URL,
      room,
      key: KEY,
      listenPort: 0,
      onLog: (line) => guestLogs.push(line),
    });
    step(`玩家本地代理已监听 ${guest.address}`);

    const small = crypto.randomBytes(4096);
    const first = await roundTrip(guest.port, small);
    step(`小包往返成功（${first.bytes} 字节，含服务器问候）`);

    const big = crypto.randomBytes(256 * 1024);
    const second = await roundTrip(guest.port, big);
    step(`256KB 大包往返成功（收到 ${second.bytes} 字节）`);

    const [a, b] = await Promise.all([
      roundTrip(guest.port, crypto.randomBytes(2048)),
      roundTrip(guest.port, crypto.randomBytes(2048)),
    ]);
    step(`两个玩家并发成功（分别收到 ${a.bytes} / ${b.bytes} 字节）`);

    assert(host.active, '主机隧道意外关闭');
    assert(hostLogs.some((line) => line.includes('玩家接入')), `主机没有看到玩家接入：${hostLogs.slice(-3).join(' | ')}`);
    step(`主机侧记录到 ${hostLogs.filter((line) => line.includes('玩家接入')).length} 次玩家接入`);
  } finally {
    if (guest) await guest.close().catch(() => {});
    if (host) host.close();
  }

  // ---- 口令错误：另一个房间，口令由主机第一个设定 ----
  const keyRoom = makeRoom('key');
  const keyLogs = [];
  let keyHost = null;
  let wrongGuest = null;
  try {
    keyHost = await relay.startHostTunnel({
      relayUrl: RELAY_URL,
      room: keyRoom,
      key: KEY,
      localPort: mcPort,
      onLog: () => {},
    });
    wrongGuest = await relay.startGuestProxy({
      relayUrl: RELAY_URL,
      room: keyRoom,
      key: 'wrongKey999',
      listenPort: 0,
      onLog: (line) => keyLogs.push(line),
    });
    await expectRejected(wrongGuest.port, keyLogs, /403|口令/);
    step('错误口令被中继拒绝（403 / 房间口令不对）');
  } finally {
    if (wrongGuest) await wrongGuest.close().catch(() => {});
    if (keyHost) keyHost.close();
  }

  // ---- 房间没有主机：新房间直接连玩家代理 ----
  const emptyRoom = makeRoom('empty');
  const emptyLogs = [];
  let emptyGuest = null;
  try {
    emptyGuest = await relay.startGuestProxy({
      relayUrl: RELAY_URL,
      room: emptyRoom,
      listenPort: 0,
      onLog: (line) => emptyLogs.push(line),
    });
    await expectRejected(emptyGuest.port, emptyLogs, /409|主机|不存在/, 20000);
    step('房间没有主机时玩家被拒绝（409）');
  } finally {
    if (emptyGuest) await emptyGuest.close().catch(() => {});
    await new Promise((resolve) => mc.close(resolve));
  }

  log('\n全部通过：真实 Worker 中继的三段链路可以往返数据，口令与房间状态也符合预期。');
}

main().catch((error) => {
  log(`\n❌ 真实中继测试失败：${error && (error.stack || error.message || error)}`);
  process.exitCode = 1;
  // 失败路径上回声服务器/本地代理可能还占着端口，node 不会自己退出；
  // 直接收尾退出，免得 CI 或手工测试卡在那里（之前排查时踩过）。
  setTimeout(() => process.exit(1), 200);
});
