/**
 * Viskluke Address —— Cloudflare Worker 代理
 *
 * 为什么需要它：
 *   启动器客户端一旦内置 Cloudflare API Token，就等于把「你的域名 DNS 写权限」
 *   公开给所有能解包的人。所以 Token 只放在这个 Worker 的环境变量里，
 *   客户端只发 `前缀 / 后缀 / 端口`，Worker 负责真正调 Cloudflare API。
 *
 * 客户端怎么用：启动器 config.json（或环境变量 CF_PROXY_URL）填这个 Worker 的 URL，
 * 之后「一键开服」不需要任何 Token；公网 IP 直接取请求头 CF-Connecting-IP。
 *
 * 部署：见同目录 README.md（控制台粘贴即可，3 分钟）。
 *
 * 环境变量 / 机密绑定：
 *   CF_API_TOKEN  (Secret, 必填)  Cloudflare API Token，权限 Zone.DNS:Edit
 *   CF_ZONES      (Var, 必填)     JSON：{ "stde.eu.cc": "<zoneId>", ... }
 *   ALLOWED_SUFFIXES (Var, 可选)  逗号分隔，默认取 CF_ZONES 的键
 *   MAX_PREFIX_LEN   (Var, 可选)  默认 40
 *   RATE_LIMIT_PER_MIN (Var, 可选) 默认 30（同一 IP 每分钟请求数，0 = 不限）
 *
 * 路由：
 *   GET  /health           → { ok, zones }
 *   POST /sync             → { ok, address, mode, targetIp, srvName, srvTarget, port, ttl, records, warnings }
 *   POST /remove           → { ok, removed: [] }
 */

const API_BASE = 'https://api.cloudflare.com/client/v4';
const PREFIX_RE = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;
const RESERVED = new Set(['www', 'mail', 'ftp', 'api', 'admin', 'root', 'viskluke', 'dns', 'ns1', 'ns2']);
const DEFAULT_TTL = 60;
const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
};

/** 简单的内存限流（每个 isolate 独立，够挡住明显的刷接口） */
const hits = new Map();

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function parseZones(env) {
  let zones = {};
  try {
    zones = typeof env.CF_ZONES === 'string' ? JSON.parse(env.CF_ZONES) : env.CF_ZONES || {};
  } catch {
    zones = {};
  }
  const allowed = env.ALLOWED_SUFFIXES
    ? String(env.ALLOWED_SUFFIXES)
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    : Object.keys(zones);
  return { zones, allowed };
}

function rateLimited(ip, limit) {
  if (!limit) return false;
  const now = Date.now();
  const key = `${ip}:${Math.floor(now / 60000)}`;
  const count = (hits.get(key) || 0) + 1;
  hits.set(key, count);
  if (hits.size > 2000) {
    for (const [k] of hits) {
      if (!k.endsWith(`:${Math.floor(now / 60000)}`)) hits.delete(k);
    }
  }
  return count > limit;
}

async function cf(path, { method = 'GET', body = null, token }) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'Viskluke-Worker/1.0',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  const ok = Boolean(data && data.success);
  return { ok, status: res.status, data, result: data && data.result };
}

function cfError({ status, data }) {
  const list = (data && Array.isArray(data.errors) ? data.errors : []).map(
    (item) => `[${item.code || ''}] ${item.message || 'Cloudflare 返回错误'}`
  );
  return list.join('; ') || `HTTP ${status}`;
}

/** 找同名记录（返回数组） */
async function findRecords(zoneId, name, token) {
  const res = await cf(
    `/zones/${zoneId}/dns_records?name=${encodeURIComponent(name)}`,
    { token }
  );
  if (!res.ok) throw new Error(cfError(res));
  return Array.isArray(res.result) ? res.result : [];
}

/** 建或更新一条记录：同类型同名就 PUT，否则 POST */
async function upsertRecord(zoneId, record, token) {
  const existing = (await findRecords(zoneId, record.name, token)).filter(
    (item) => item.type === record.type
  );
  const body = {
    type: record.type,
    name: record.name,
    content: record.content,
    ttl: record.ttl,
    proxied: false, // 游戏流量必须直连
  };
  if (record.type === 'SRV') {
    body.data = record.data;
    delete body.content;
  }
  if (existing.length) {
    const res = await cf(`/zones/${zoneId}/dns_records/${existing[0].id}`, {
      method: 'PUT',
      body,
      token,
    });
    if (!res.ok) throw new Error(cfError(res));
    return res.result;
  }
  const res = await cf(`/zones/${zoneId}/dns_records`, { method: 'POST', body, token });
  if (!res.ok) throw new Error(cfError(res));
  return res.result;
}

async function deleteRecords(zoneId, name, token, types = null) {
  const found = await findRecords(zoneId, name);
  const removed = [];
  for (const record of found) {
    if (types && !types.includes(record.type)) continue;
    const res = await cf(`/zones/${zoneId}/dns_records/${record.id}`, { method: 'DELETE', token });
    if (!res.ok) throw new Error(cfError(res));
    removed.push(record.id);
  }
  return removed;
}

function normalizePrefix(input) {
  const raw = String(input || '').trim().toLowerCase();
  if (!PREFIX_RE.test(raw)) throw new Error('前缀不合法（1~40 位小写字母/数字/中划线）');
  if (RESERVED.has(raw)) throw new Error(`前缀「${raw}」是保留字，换一个`);
  return raw;
}

async function handleSync(request, env) {
  const body = await request.json().catch(() => ({}));
  const { zones, allowed } = parseZones(env);
  const suffix = String(body.suffix || '').trim().toLowerCase();
  if (!allowed.includes(suffix)) throw new Error(`不支持的后缀：${suffix}（可用：${allowed.join(' / ')}）`);
  const zoneId = zones[suffix];
  if (!zoneId) throw new Error(`缺少 ${suffix} 的 Zone ID（Worker 变量 CF_ZONES）`);

  const prefix = normalizePrefix(body.prefix);
  const port = Number(body.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`端口不合法：${body.port}`);
  const ttl = Math.max(60, Math.min(86400, Number(body.ttl) || DEFAULT_TTL));

  // 客户端的公网 IP：Cloudflare 会带上，不用客户端自己探测
  const clientIp = request.headers.get('CF-Connecting-IP') || '';
  const clientIpv6 = request.headers.get('CF-Connecting-IPv6') || '';
  const fqdn = `${prefix}.${suffix}`;
  const warnings = [];
  if (!clientIp && !clientIpv6) throw new Error('拿不到你的公网 IP（缺少 CF-Connecting-IP）');

  // 1) 主机记录：有 IPv6 就双栈（AAAA + A），只建游戏能直连的记录
  const records = {};
  if (clientIpv6) {
    const aaaa = await upsertRecord(zoneId, { type: 'AAAA', name: fqdn, content: clientIpv6, ttl }, env.CF_API_TOKEN);
    records.aaaa = aaaa && aaaa.id;
  }
  if (clientIp) {
    await deleteRecords(zoneId, fqdn, env.CF_API_TOKEN, ['CNAME']);
    const a = await upsertRecord(zoneId, { type: 'A', name: fqdn, content: clientIp, ttl }, env.CF_API_TOKEN);
    records.a = a && a.id;
  }
  if (clientIpv6 && clientIp) warnings.push('已按双栈创建（AAAA + A）：IPv6 玩家直连，IPv4 玩家仍需端口可用');

  // 2) SRV：省得玩家记端口
  const srvName = `_minecraft._tcp.${fqdn}`;
  let srvRecord;
  try {
    srvRecord = await upsertRecord(
      zoneId,
      {
        type: 'SRV',
        name: srvName,
        ttl,
        data: { service: '_minecraft', proto: '_tcp', name: fqdn, priority: 0, weight: 5, port, target: fqdn },
      },
      env.CF_API_TOKEN
    );
  } catch (error) {
    warnings.push(`SRV 记录创建失败（不影响直连）：${error.message}`);
    srvRecord = null;
  }

  return json({
    ok: true,
    mode: clientIpv6 && clientIp ? 'dual' : clientIpv6 ? 'ipv6' : 'ip',
    address: fqdn,
    targetIp: clientIp || null,
    targetIpv6: clientIpv6 || null,
    targetHost: null,
    srvName,
    srvTarget: fqdn,
    port,
    ttl,
    zoneId,
    records: { ...records, ...(srvRecord ? { srv: srvRecord.id } : {}) },
    warnings,
  });
}

async function handleRemove(request, env) {
  const body = await request.json().catch(() => ({}));
  const { zones, allowed } = parseZones(env);
  const suffix = String(body.suffix || '').trim().toLowerCase();
  if (!allowed.includes(suffix)) throw new Error(`不支持的后缀：${suffix}`);
  const zoneId = zones[suffix];
  if (!zoneId) throw new Error(`缺少 ${suffix} 的 Zone ID`);

  const address = String(body.address || '').trim().toLowerCase();
  const expected = `.${suffix}`;
  if (!address.endsWith(expected)) throw new Error('域名与后缀不匹配');
  const prefix = address.slice(0, -expected.length);
  normalizePrefix(prefix); // 顺带校验一下，防止拿任意域名来删记录

  const removed = [
    ...(await deleteRecords(zoneId, address, env.CF_API_TOKEN, ['A', 'AAAA', 'CNAME'])),
    ...(await deleteRecords(zoneId, `_minecraft._tcp.${address}`, env.CF_API_TOKEN, ['SRV'])),
  ];
  return json({ ok: true, removed });
}

/**
 * 从 Worker（= 公网）这一侧 TCP 连一下某个 host:port，回答"外面到底能不能连进来"。
 * 用 Cloudflare 的 connect()（cloudflare:sockets）；连上就立刻关掉，只测可达性。
 */
async function handleProbe(request, env) {
  const body = await request.json().catch(() => ({}));
  const host = String(body.host || '').trim();
  const port = Number(body.port);
  if (!host) throw new Error('缺少 host');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`端口不合法：${body.port}`);
  if (!/^[0-9a-fA-F:.]+$/.test(host) && !/^[a-z0-9.-]+$/i.test(host)) throw new Error('host 不合法');

  const connect = env.__testConnect || (await import('cloudflare:sockets')).connect;
  const started = Date.now();
  let socket = null;
  try {
    socket = connect({ hostname: host, port }, { allowHalfOpen: false });
    // 连上即视为可达（不需要真的读数据）
    await socket.opened;
    const ms = Date.now() - started;
    return json({ ok: true, reachable: true, host, port, ms });
  } catch (error) {
    return json({
      ok: true,
      reachable: false,
      host,
      port,
      ms: Date.now() - started,
      error: (error && error.message) || '连接失败',
    });
  } finally {
    try {
      if (socket && socket.close) await socket.close();
    } catch {
      /* ignore */
    }
  }
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: JSON_HEADERS });

    const url = new URL(request.url);
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const limit = Number(env.RATE_LIMIT_PER_MIN);

    try {
      if (!env.CF_API_TOKEN) return json({ ok: false, error: 'Worker 没有配置 CF_API_TOKEN（Secret）' }, 500);

      if (url.pathname === '/health') {
        const { zones, allowed } = parseZones(env);
        return json({ ok: true, zones: allowed, zoneCount: Object.keys(zones).length });
      }

      if (rateLimited(ip, Number.isFinite(limit) ? limit : 30)) {
        return json({ ok: false, error: '请求太频繁，请稍后再试' }, 429);
      }

      if (url.pathname === '/sync' && request.method === 'POST') return await handleSync(request, env);
      if (url.pathname === '/remove' && request.method === 'POST') return await handleRemove(request, env);
      // 可达性探测不需要 Token（只是从公网连一下），但仍在限流之内
      if (url.pathname === '/probe' && request.method === 'POST') return await handleProbe(request, env);

      return json({ ok: false, error: `未知路由：${request.method} ${url.pathname}` }, 404);
    } catch (error) {
      return json({ ok: false, error: (error && error.message) || 'Worker 内部错误' }, 400);
    }
  },
};
