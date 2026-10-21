'use strict';

/**
 * scripts/screenshots.js —— 重新生成 docs/screenshots/ 里的界面截图
 *
 *   npm run screenshots
 *
 * 做法：
 *   1. 用 `--remote-debugging-port` 拉起真实的 Electron 应用（等价于 npm start）；
 *   2. 通过 Chrome DevTools Protocol（Node 自带 WebSocket）点击侧栏切换页面，
 *      再用 Page.captureScreenshot 截图。
 * 好处：截的是真实渲染结果，不受窗口被遮挡 / 分辨率缩放 / 截屏工具影响；
 *      同时顺便检查渲染层有没有 console.error 和未捕获异常（有的话退出码非 0）。
 *
 * 几个坑已处理：
 *   · ELECTRON_RUN_AS_NODE 被继承时 electron 会当纯 node 跑 → 拉起子进程前删掉；
 *   · 子进程用 stdio:'ignore'（沙箱里管道 stdio 会 EPERM），退出时用 taskkill /T 清理进程树；
 *   · 端口被占用 → 先要一个空闲端口。
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'docs', 'screenshots');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const LOG_FILE = path.join(ROOT, 'viskluke_error.log');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function electronBinary() {
  if (fs.existsSync(ELECTRON)) return ELECTRON;
  const fallback = require('electron');
  if (typeof fallback === 'string' && fs.existsSync(fallback)) return fallback;
  throw new Error('找不到 electron.exe，请先 npm install');
}

async function findPage(port, timeoutMs = 40000) {
  const started = Date.now();
  let lastError = '未知';
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const page = list.find((item) => item.type === 'page' && String(item.url).includes('index.html'));
      if (page && page.webSocketDebuggerUrl) return page;
      lastError = '还没有可截图的页面';
    } catch (error) {
      lastError = error.message;
    }
    await sleep(500);
  }
  throw new Error(`等待窗口超时（${lastError}）`);
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    const events = [];
    let seq = 0;
    let closed = false;

    const flush = (reason) => {
      for (const [, item] of pending) item.rej(new Error(reason));
      pending.clear();
    };

    ws.addEventListener('open', () => {
      resolve({
        events,
        send(method, params = {}, timeoutMs = 15000) {
          if (closed) return Promise.reject(new Error('调试连接已断开（窗口被关掉了？）'));
          const id = ++seq;
          return new Promise((res, rej) => {
            // 合成器卡死时 captureScreenshot 会永远不回，必须自己超时
            const timer = setTimeout(() => {
              pending.delete(id);
              rej(new Error(`${method} 超时（${timeoutMs}ms，界面可能卡住了）`));
            }, timeoutMs);
            pending.set(id, {
              res: (value) => {
                clearTimeout(timer);
                res(value);
              },
              rej: (error) => {
                clearTimeout(timer);
                rej(error);
              },
            });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        close: () => ws.close(),
      });
    });
    ws.addEventListener('error', () => {
      closed = true;
      flush('CDP WebSocket 出错');
      reject(new Error('CDP WebSocket 连接失败'));
    });
    ws.addEventListener('close', () => {
      closed = true;
      // 窗口被关掉时连接会断：必须让挂起的 RPC 报错，否则 node 会静默退出（看起来像"成功"）
      flush('调试连接已断开（窗口被关掉了？）');
    });
    ws.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.id && pending.has(message.id)) {
        const { res, rej, method } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) rej(new Error(`${method}: ${message.error.message}`));
        else res(message.result);
      } else if (message.method) {
        events.push(message);
      }
    });
  });
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* ignore */
    }
  }
}

function tailLog(lines = 12) {
  try {
    return fs.readFileSync(LOG_FILE, 'utf8').trim().split(/\r?\n/).slice(-lines).join('\n');
  } catch {
    return '（读不到日志）';
  }
}

async function main() {
  const port = await freePort();
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // 否则 electron 会以纯 Node 运行，不建窗口
  env.VISKLUKE_DISABLE_GPU = env.VISKLUKE_DISABLE_GPU || '1';

  console.log(`[screenshots] 启动应用（调试端口 ${port}）…`);
  const child = spawn(electronBinary(), [ROOT, '--no-sandbox', `--remote-debugging-port=${port}`], {
    cwd: ROOT,
    env,
    stdio: 'ignore', // 管道 stdio 在某些沙箱下会 EPERM
    windowsHide: false,
  });

  let cdp = null;
  try {
    const page = await findPage(port);
    console.log(`[screenshots] 已连接：${page.url}`);
    cdp = await connect(page.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await sleep(2500); // 等渲染层 bootstrap（实例 / CF / 服务器列表）

    const evaluate = (expression) =>
      cdp.send('Runtime.evaluate', { expression, userGesture: true, awaitPromise: false });

    const evaluateValue = async (expression) => {
      const result = await evaluate(expression);
      return result && result.result ? result.result.value : undefined;
    };

    const shots = [];
    const failed = [];
    const shot = async (name) => {
      console.log(`[screenshots] 截 ${name}…`);
      // 先逼一次布局/重绘：刚切换页面时合成器可能还没出帧，直接截会卡住
      await cdp.send('Runtime.evaluate', { expression: 'document.body.offsetHeight' }, 8000).catch(() => {});
      let lastError = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, 12000);
          const buffer = Buffer.from(data, 'base64');
          if (buffer.length < 5000) throw new Error(`${name} 截图是空的（${buffer.length} 字节）`);
          fs.mkdirSync(OUT_DIR, { recursive: true });
          fs.writeFileSync(path.join(OUT_DIR, name), buffer);
          console.log(`  ✔ ${name}  ${(buffer.length / 1024).toFixed(0)} KB`);
          shots.push(name);
          return true;
        } catch (error) {
          lastError = error;
          if (attempt === 1) await sleep(1500);
        }
      }
      // 单张挂了不要连累后面的页面
      console.log(`  ✘ ${name} 失败：${lastError && lastError.message}（继续下一张）`);
      failed.push(name);
      return false;
    };

    // 1) 游戏页（选中第一个实例）
    await evaluate(`(() => { const b = document.querySelector('#sub-instances .sub-item'); if (b) b.click(); return !!b; })()`);
    await sleep(700);
    await shot('instances.png');

    // 2) 下载 → 游戏版本
    await evaluate(`document.querySelector('.menu-item[data-page="downloads"]').click()`);
    await sleep(1000);
    await evaluate(`document.querySelector('.tab[data-tab="versions"]').click()`);
    await sleep(3200);
    await shot('downloads.png');

    // 3) 下载 → Mod
    await evaluate(`document.querySelector('.tab[data-tab="mods"]').click()`);
    await sleep(4200);
    await shot('downloads-mod.png');

    // 4) 下载 → 整合包
    await evaluate(`document.querySelector('.tab[data-tab="modpacks"]').click()`);
    await sleep(4200);
    await shot('downloads-modpacks.png');

    // 5-early) 服务器
    await evaluate(`document.querySelector('.menu-item[data-page="servers"]').click()`);
    await sleep(3200); // 等局域网/公网 IP 探测回来
    await shot('servers.png');

    // 5b-early) 域名管理（二级面板）
    await evaluate(`(() => { const b = document.getElementById('btn-toggle-domains'); if (b) b.click(); return true; })()`);
    await sleep(600);
    if (await evaluateValue(`!document.getElementById('cf-domains').classList.contains('hidden')`)) {
      await shot('servers-domains.png');
    } else {
      console.log('[screenshots] 跳过域名管理面板（没有展开）');
    }
    await evaluate(`(() => { const b = document.getElementById('btn-toggle-domains'); if (b) b.click(); return true; })()`);

    // 6) 登录弹窗
    await evaluate(`document.getElementById('account-card').click()`);
    await sleep(700);
    await shot('auth.png');

    // 7) 皮肤弹窗（需要先选中一个实例；没有实例就跳过）
    await evaluate(`document.getElementById('btn-close-auth').click()`);
    await sleep(300);
    await evaluate(`(() => { const b = document.getElementById('btn-skin'); if (b) b.click(); return !!b; })()`);
    await sleep(1600);
    if (await evaluateValue(`!document.getElementById('skin-modal').classList.contains('hidden')`)) {
      await shot('skin.png');
    } else {
      console.log('[screenshots] 跳过皮肤弹窗（当前没有选中的实例）');
    }
    await evaluate(`(() => { const b = document.getElementById('btn-close-skin'); if (b) b.click(); return true; })()`);

    const errors = cdp.events
      .filter((event) => event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error')
      .map((event) => (event.params.args || []).map((arg) => arg.value || arg.description).join(' '));
    const exceptions = cdp.events
      .filter((event) => event.method === 'Runtime.exceptionThrown')
      .map((event) => event.params.exceptionDetails.text);

    console.log(`[screenshots] 完成 ${shots.length} 张`);
    console.log(`[screenshots] 渲染层 console.error：${errors.length} 条，未捕获异常：${exceptions.length} 条`);
    [...errors, ...exceptions].slice(0, 10).forEach((message) => console.log(`  ! ${message}`));
    if (failed.length) console.log(`[screenshots] 有 ${failed.length} 张失败：${failed.join('、')}（其余已更新）`);
    if (shots.length < 5) throw new Error(`只截到 ${shots.length} 张，界面中途被关掉了`);    if (errors.length || exceptions.length) process.exitCode = 2;
  } catch (error) {
    console.error(`[screenshots] 失败：${error.message}`);
    console.error(`[screenshots] 应用日志尾部：\n${tailLog()}`);
    process.exitCode = 1;
  } finally {
    if (cdp) {
      try {
        cdp.close();
      } catch {
        /* ignore */
      }
    }
    killTree(child.pid);
  }
}

main().catch((error) => {
  console.error(`[screenshots] 未捕获错误：${error.message}`);
  process.exit(1);
});
