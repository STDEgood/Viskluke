'use strict';

/** 自检用：本地 WebSocket 中继（协议与 Worker 版一致），用于端到端验证 */

const { WebSocketServer } = require('ws');
const path = require('path');
const relay = require(path.join(__dirname, '..', 'relay.js'));

const { TYPE_OPEN, TYPE_DATA, TYPE_CLOSE } = relay;

/**
 * 起一个本地中继：房间 -> { host: WebSocket, guests: Set<WebSocket> }
 * 每个 guest 分配一个流号，转发给 host 时加上 5 字节头。
 */
function createRelayServer(options = {}) {
  const { port = 0, host = '127.0.0.1' } = options;
  const wss = new WebSocketServer({ port, host, perMessageDeflate: false });
  const rooms = new Map(); // room -> { host, guests: Map<ws, streamId>, nextStream }
  let nextStreamId = 1;

  const stats = { hosts: 0, guests: 0, frames: 0, closed: 0 };

  wss.on('connection', (socket, request) => {
    let url;
    try {
      url = new URL(request.url, 'http://localhost');
    } catch {
      socket.close(1008, 'bad url');
      return;
    }
    const room = relay.normalizeRoom(url.searchParams.get('room'));
    const role = url.searchParams.get('role');
    const key = url.searchParams.get('key') || '';
    if (!rooms.has(room)) rooms.set(room, { host: null, guests: new Map(), nextStream: 1, key: '' });
    const entry = rooms.get(room);
    void nextStreamId;

    // 口令：第一次连接设定，之后必须一致（房间号不再是唯一凭据）
    if (!entry.key) entry.key = key;
    else if (entry.key !== key) {
      stats.rejected = (stats.rejected || 0) + 1;
      socket.close(1008, 'bad key');
      return;
    }

    if (role === 'host') {
      if (entry.host) {
        socket.close(1013, 'room already has a host');
        return;
      }
      entry.host = socket;
      stats.hosts += 1;
      socket.on('message', (raw) => {
        const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        const parsed = relay._internal.parseFrame(buffer);
        if (!parsed) return;
        stats.frames += 1;
        // 转给对应 guest（去掉 5 字节头）
        let target = null;
        for (const [guest, streamId] of entry.guests) {
          if (streamId === parsed.streamId) {
            target = guest;
            break;
          }
        }
        if (!target || target.readyState !== 1) return;
        if (parsed.type === TYPE_DATA && parsed.payload.length) target.send(parsed.payload, { binary: true });
        if (parsed.type === TYPE_CLOSE) target.close(1000, 'host closed stream');
      });
      socket.on('close', () => {
        stats.closed += 1;
        if (entry.host === socket) entry.host = null;
        for (const guest of entry.guests.keys()) {
          try {
            guest.close(1001, 'host gone');
          } catch {
            /* ignore */
          }
        }
        entry.guests.clear();
      });
      return;
    }

    if (role === 'guest') {
      if (entry.guests.size >= relay.MAX_GUESTS) {
        stats.rejected = (stats.rejected || 0) + 1;
        socket.close(1013, 'room full');
        return;
      }
      const streamId = entry.nextStream++;
      entry.guests.set(socket, streamId);
      stats.guests += 1;
      if (!entry.host || entry.host.readyState !== 1) {
        socket.close(1013, 'no host in room');
        return;
      }
      // 通知 host：新流
      entry.host.send(relay._internal.frame(TYPE_OPEN, streamId), { binary: true });
      socket.on('message', (raw) => {
        const payload = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        stats.frames += 1;
        if (!entry.host || entry.host.readyState !== 1) return;
        entry.host.send(relay._internal.frame(TYPE_DATA, streamId, payload), { binary: true });
      });
      socket.on('close', () => {
        stats.closed += 1;
        entry.guests.delete(socket);
        if (entry.host && entry.host.readyState === 1) {
          entry.host.send(relay._internal.frame(TYPE_CLOSE, streamId), { binary: true });
        }
      });
      return;
    }

    socket.close(1008, 'unknown role');
  });

  return new Promise((resolve) => {
    wss.once('listening', () => {
      const address = wss.address();
      resolve({
        url: `ws://${host}:${address.port}`,
        port: address.port,
        stats,
        rooms,
        close: () =>
          new Promise((done) => {
            for (const client of wss.clients) {
              try {
                client.close(1001, 'server closing');
              } catch {
                /* ignore */
              }
            }
            wss.close(() => done());
          }),
      });
    });
  });
}

module.exports = { createRelayServer };
