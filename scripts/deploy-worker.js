'use strict';

/**
 * 用 Cloudflare REST API 直接部署中继 Worker（不依赖 wrangler）
 *
 * 为什么不用 `wrangler deploy`：
 *   本机沙箱里 wrangler 启动 esbuild 需要 spawn 子进程 + 管道 stdio，会被 EPERM 拦掉。
 *   直接调 API 只有一个 HTTPS 请求，稳定且快。
 *
 * 凭据（二选一，按顺序）：
 *   1. 环境变量 CLOUDFLARE_API_TOKEN（需要 Workers Scripts:Edit 权限）
 *   2. wrangler 的登录态（`npx wrangler login` 之后）：
 *      %APPDATA%\xdg.config\.wrangler\config\default.toml 里的 oauth_token
 *
 * 账号 ID：环境变量 CLOUDFLARE_ACCOUNT_ID，否则用令牌能看到的第一个账号。
 *
 * 用法：
 *   node scripts/deploy-worker.js           部署
 *   node scripts/deploy-worker.js --dry-run 只打印要上传的 metadata，不发请求
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const API = 'https://api.cloudflare.com/client/v4';
const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'worker', 'wrangler-relay.toml');

function fail(message) {
  process.stderr.write(`❌ ${message}\n`);
  process.exit(1);
}

function log(message) {
  process.stdout.write(`${message}\n`);
}

function readWranglerConfig() {
  const text = fs.readFileSync(CONFIG_PATH, 'utf8');
  const pick = (pattern, label) => {
    const match = text.match(pattern);
    if (!match) fail(`worker/wrangler-relay.toml 里读不到 ${label}`);
    return match[1];
  };
  const name = pick(/^name\s*=\s*"([^"]+)"/m, 'name');
  const main = pick(/^main\s*=\s*"([^"]+)"/m, 'main');
  const compatibilityDate = pick(/^compatibility_date\s*=\s*"([^"]+)"/m, 'compatibility_date');
  const bindingName = pick(/\[\[durable_objects\.bindings\]\][\s\S]*?^name\s*=\s*"([^"]+)"/m, 'DO binding name');
  const className = pick(/\[\[durable_objects\.bindings\]\][\s\S]*?^class_name\s*=\s*"([^"]+)"/m, 'DO class_name');
  return { name, main, compatibilityDate, bindingName, className };
}

function resolveToken() {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN.trim();
  const candidates = [
    path.join(os.homedir(), 'AppData', 'Roaming', 'xdg.config', '.wrangler', 'config', 'default.toml'),
    path.join(os.homedir(), '.config', '.wrangler', 'config', 'default.toml'),
    path.join(os.homedir(), '.wrangler', 'config', 'default.toml'),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const match = fs.readFileSync(file, 'utf8').match(/^oauth_token\s*=\s*"([^"]+)"/m);
    if (match) {
      log(`使用 wrangler 登录态：${file}`);
      return match[1];
    }
  }
  fail('没有凭据：设置 CLOUDFLARE_API_TOKEN，或先跑一次 npx wrangler login');
}

async function callApi(token, method, endpoint, body) {
  const response = await fetch(`${API}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    fail(`${method} ${endpoint} 返回非 JSON（HTTP ${response.status}）：${text.slice(0, 300)}`);
  }
  if (!json.success) {
    const detail = (json.errors || []).map((item) => `[${item.code}] ${item.message}`).join('; ') || '未知错误';
    fail(`${method} ${endpoint} 失败（HTTP ${response.status}）：${detail}`);
  }
  return json.result;
}

async function resolveAccountId(token) {
  if (process.env.CLOUDFLARE_ACCOUNT_ID) return process.env.CLOUDFLARE_ACCOUNT_ID.trim();
  const memberships = await callApi(token, 'GET', '/memberships');
  const account = memberships && memberships[0] && memberships[0].account;
  if (!account || !account.id) fail('这个令牌看不到任何账号，请显式设置 CLOUDFLARE_ACCOUNT_ID');
  log(`账号：${account.name}（${account.id}）`);
  return account.id;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const config = readWranglerConfig();
  const sourcePath = path.join(ROOT, 'worker', config.main.replace(/^worker\//, ''));
  if (!fs.existsSync(sourcePath)) fail(`找不到 Worker 源码：${sourcePath}`);
  const source = fs.readFileSync(sourcePath, 'utf8');
  const fileName = path.basename(sourcePath);

  const metadata = {
    main_module: fileName,
    compatibility_date: config.compatibilityDate,
    bindings: [
      {
        type: 'durable_object_namespace',
        name: config.bindingName,
        class_name: config.className,
      },
    ],
  };

  log(`Worker：${config.name}  ←  ${path.relative(ROOT, sourcePath)}（${(Buffer.byteLength(source) / 1024).toFixed(1)} KB）`);
  log(`Durable Object 绑定：${config.bindingName} → ${config.className}`);
  if (dryRun) {
    log(`\nmetadata:\n${JSON.stringify(metadata, null, 2)}`);
    log('\n--dry-run：没有发请求');
    return;
  }

  const token = resolveToken();
  const accountId = await resolveAccountId(token);

  const form = new FormData();
  form.set('metadata', JSON.stringify(metadata));
  form.set(fileName, new Blob([source], { type: 'application/javascript+module' }), fileName);

  log('正在上传…');
  const response = await fetch(`${API}/accounts/${accountId}/workers/scripts/${config.name}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 下面统一报错 */
  }
  if (!response.ok || !json || !json.success) {
    const detail = json && json.errors ? json.errors.map((item) => `[${item.code}] ${item.message}`).join('; ') : text;
    fail(`上传失败（HTTP ${response.status}）：${String(detail).slice(0, 500)}`);
  }

  log(`✅ 已部署：${config.name}`);
  const etag = json.result && json.result.etag;
  if (etag) log(`版本 etag：${etag}`);

  // 部署完成后再探一次 /health，确认新代码真的生效
  const url = process.env.RELAY_URL || 'https://relay.stde.eu.cc';
  const healthUrl = `${url.replace(/^ws/, 'http').replace(/\/+$/, '')}/health`;
  try {
    const health = await fetch(healthUrl, { signal: AbortSignal.timeout(15000) });
    const body = await health.text();
    log(`健康检查：${health.status} ${body.slice(0, 120)}`);
  } catch (error) {
    log(`健康检查失败（不影响部署结果）：${error.message}`);
  }
}

main().catch((error) => fail(error && (error.stack || error.message || String(error))));
