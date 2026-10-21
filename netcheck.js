'use strict';

/**
 * netcheck.js —— 「别人到底能不能连到我」的自动诊断
 *
 * 新手开服最大的墙不是游戏，是网络：
 *   家里路由器要不要映射？我是不是在运营商大内网？IPv6 能不能用？
 * 这个模块负责把这些问题一次性查清楚，能用 UPnP 的就顺手把端口映射做掉。
 *
 * 结论分四种（nat 字段）：
 *   public      有公网 IP，映射成功就能被外网连
 *   double-nat  路由器 WAN 是私网地址 → 两级 NAT（光猫 + 路由器），需要在光猫上再映射
 *   cgnat       入口是 100.64/10 之类的运营商大内网 → 自己怎么映射都没用
 *   unknown     查不到（路由器不支持 UPnP / 关了）
 *
 * 只用 Node 内置模块（dgram / http / net），不引第三方依赖。
 */

const dgram = require('dgram');
const http = require('http');
const os = require('os');
const net = require('net');
const https = require('https');

const SSDP_HOST = '239.255.255.250';
const SSDP_PORT = 1900;
const SERVICE_TYPES = [
  'urn:schemas-upnp-org:service:WANIPConnection:2',
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANPPPConnection:1',
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// 基础网络信息
// ---------------------------------------------------------------------------

/** 列出所有 IPv4 网卡地址（区分真局域网 / 虚拟网卡） */
function listIpv4() {
  const out = [];
  try {
    for (const [name, list] of Object.entries(os.networkInterfaces())) {
      for (const item of list || []) {
        if (item.family !== 'IPv4' || item.internal) continue;
        if (String(item.address).startsWith('169.254.')) continue; // APIPA
        out.push({
          ip: item.address,
          iface: name,
          private: isPrivateIpv4(item.address),
          virtual: /radmin|zerotier|tailscale|hamachi|tap|wintun|tun|vpn|vmware|virtualbox|hyper-v|vethernet/i.test(name),
        });
      }
    }
  } catch {
    /* ignore */
  }
  return out;
}

/** 真局域网 IPv4：优先 RFC1918 且非虚拟网卡 */
function lanIpv4() {
  const all = listIpv4();
  const real = all.find((item) => item.private && !item.virtual);
  if (real) return real.ip;
  const anyPrivate = all.find((item) => item.private);
  if (anyPrivate) return anyPrivate.ip;
  const anyReal = all.find((item) => !item.virtual);
  return anyReal ? anyReal.ip : '';
}

/** 虚拟网卡（Radmin / ZeroTier / Tailscale 这类"组网"工具，本身就能让朋友连进来） */
function virtualAdapters() {
  return listIpv4().filter((item) => item.virtual);
}

/**
 * 本机可用的公网 IPv6（真能收连接的那种）。
 * 排除：链路本地 fe80、唯一本地 fd/fc、Teredo 2001:0:、6to4 2002:、文档地址 2001:db8。
 */
function globalIpv6() {
  const list = [];
  try {
    for (const detail of Object.values(os.networkInterfaces())) {
      for (const item of detail || []) {
        if (item.family !== 'IPv6' || item.internal) continue;
        const addr = String(item.address || '').split('%')[0].toLowerCase();
        if (/^(fe80|fd|fc|::1)/.test(addr)) continue;
        if (/^2001:0:/.test(addr)) continue; // Teredo 隧道，不能监听入站
        if (/^2002:/.test(addr)) continue; // 6to4
        if (/^2001:db8/.test(addr)) continue; // 文档地址
        if (!/^[23]/.test(addr)) continue;
        list.push(addr);
      }
    }
  } catch {
    /* ignore */
  }
  return list[0] || '';
}

function isPrivateIpv4(ip) {
  if (!net.isIPv4(ip)) return false;
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

/** 运营商级 NAT（RFC6598 100.64/10） */
function isCgnat(ip) {
  if (!net.isIPv4(ip)) return false;
  const [a, b] = ip.split('.').map(Number);
  return a === 100 && b >= 64 && b <= 127;
}

/** 公网出口 IP（多个源，谁先通用谁） */
async function publicIpv4() {
  const sources = [
    { url: 'https://api.ipify.org?format=json', pick: (d) => d && d.ip },
    { url: 'https://api64.ipify.org?format=json', pick: (d) => d && d.ip },
    { url: 'https://ipinfo.io/json', pick: (d) => d && d.ip },
  ];
  for (const source of sources) {
    try {
      const res = await fetchJson(source.url, 6000);
      const ip = source.pick(res);
      if (ip && net.isIPv4(ip)) return ip;
    } catch {
      /* 换下一个 */
    }
  }
  return '';
}

function fetchJson(url, timeout) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': 'Viskluke-Launcher/0.6' } }, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.setTimeout(timeout, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// UPnP：发现网关
// ---------------------------------------------------------------------------

/** SSDP 广播找 IGD（家用路由器） */
function discoverGateway(options = {}) {
  const { timeout = 2500, tries = 2 } = options;
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const seen = [];
    let finished = false;

    const finish = (value) => {
      if (finished) return;
      finished = true;
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      resolve(value);
    };

    socket.on('message', (msg, rinfo) => {
      const text = msg.toString('utf8');
      const location = /^LOCATION:\s*(.+)$/im.exec(text);
      if (!location) return;
      seen.push({ location: location[1].trim(), from: rinfo.address, raw: text });
      // 拿到第一个就够用，但多等一会能拿到更好的（有的路由器回多个 ST）
      setTimeout(() => finish(seen[0]), 200);
    });
    socket.on('error', () => finish(null));

    socket.bind(() => {
      try {
        socket.setBroadcast(true);
        socket.addMembership(SSDP_HOST);
      } catch {
        /* 某些环境不允许组播，仍可发广播 */
      }
      const send = (count) => {
        if (finished || count >= tries) return;
        const message = Buffer.from(
          [
            'M-SEARCH * HTTP/1.1',
            `HOST: ${SSDP_HOST}:${SSDP_PORT}`,
            'MAN: "ssdp:discover"',
            `MX: 2`,
            'ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1',
            '',
            '',
          ].join('\r\n')
        );
        try {
          socket.send(message, 0, message.length, SSDP_PORT, SSDP_HOST);
        } catch {
          /* ignore */
        }
        setTimeout(() => send(count + 1), 900);
      };
      send(0);
    });

    setTimeout(() => finish(seen[0] || null), timeout);
  });
}

/** 拉网关描述 XML，找出 WANIPConnection 的控制地址 */
function loadGateway(location) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(location);
    } catch {
      return resolve(null);
    }
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.get(location, { timeout: 4000 }, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => resolve(parseDeviceXml(body, location)));
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
  });
}

/** 从 DEVICE 描述里抽出 friendlyName + WAN 服务的 controlURL */
function parseDeviceXml(xml, location) {
  const text = String(xml || '');
  const friendly = /<friendlyName>([^<]*)<\/friendlyName>/i.exec(text);
  let base = '';
  try {
    const url = new URL(location);
    base = `${url.protocol}//${url.host}`;
  } catch {
    base = '';
  }
  const baseMatch = /<URLBase>([^<]*)<\/URLBase>/i.exec(text);
  if (baseMatch) base = baseMatch[1].trim().replace(/\/$/, '');

  for (const type of SERVICE_TYPES) {
    // service 块里同时包含 serviceType 与 controlURL
    const blocks = text.split(/<service>/i).slice(1);
    for (const block of blocks) {
      if (!block.toLowerCase().includes(type.toLowerCase())) continue;
      const control = /<controlURL>([^<]*)<\/controlURL>/i.exec(block);
      if (!control) continue;
      const url = control[1].trim();
      return {
        location,
        friendlyName: friendly ? friendly[1].trim() : '',
        serviceType: type,
        base,
        controlUrl: url.startsWith('http') ? url : `${base}${url.startsWith('/') ? '' : '/'}${url}`,
      };
    }
  }
  return { location, friendlyName: friendly ? friendly[1].trim() : '', serviceType: '', base, controlUrl: '' };
}

// ---------------------------------------------------------------------------
// UPnP SOAP
// ---------------------------------------------------------------------------

function envelope(serviceType, action, inner) {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">',
    '<s:Body>',
    `<u:${action} xmlns:u="${serviceType}">${inner}</u:${action}>`,
    '</s:Body>',
    '</s:Envelope>',
  ].join('');
}

function soap(controlUrl, serviceType, action, inner, timeout = 5000) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(controlUrl);
    } catch {
      return resolve({ ok: false, error: '控制地址无效' });
    }
    const body = envelope(serviceType, action, inner);
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method: 'POST',
        timeout,
        headers: {
          'Content-Type': 'text/xml; charset="utf-8"',
          SOAPAction: `"${serviceType}#${action}"`,
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) return resolve({ ok: true, body: text });
          const code = /<errorCode>(\d+)<\/errorCode>/i.exec(text) || /<errorCode>(\d+)<\/errorCode>/i.exec(text);
          resolve({ ok: false, code: code ? Number(code[1]) : null, status: res.statusCode, body: text });
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: '路由器没响应' });
    });
    req.on('error', (error) => resolve({ ok: false, error: error.message }));
    req.write(body);
    req.end();
  });
}

const UPNP_HINTS = {
  401: '路由器拒绝（可能没开 UPnP 权限）',
  606: '路由器拒绝了这条映射',
  718: '这个端口已被别的映射占用',
  724: '需要同端口映射（换个端口试试）',
  725: '这台路由器只允许同端口映射',
  501: '路由器不支持这个操作',
};

function addPortMapping(gateway, options = {}) {
  const { port, internalIp, description = 'Viskluke Launcher', lease = 0 } = options;
  const inner = [
    '<NewRemoteHost></NewRemoteHost>',
    `<NewExternalPort>${port}</NewExternalPort>`,
    '<NewProtocol>TCP</NewProtocol>',
    `<NewInternalPort>${port}</NewInternalPort>`,
    `<NewInternalClient>${internalIp}</NewInternalClient>`,
    '<NewEnabled>1</NewEnabled>',
    `<NewPortMappingDescription>${description}</NewPortMappingDescription>`,
    `<NewLeaseDuration>${lease}</NewLeaseDuration>`,
  ].join('');
  return soap(gateway.controlUrl, gateway.serviceType, 'AddPortMapping', inner).then((result) => {
    if (result.ok) return { ok: true };
    return {
      ok: false,
      code: result.code || null,
      error: UPNP_HINTS[result.code] || result.error || `路由器返回 ${result.status || '错误'}`,
    };
  });
}

function deletePortMapping(gateway, port) {
  const inner = ['<NewRemoteHost></NewRemoteHost>', `<NewExternalPort>${port}</NewExternalPort>`, '<NewProtocol>TCP</NewProtocol>'].join('');
  return soap(gateway.controlUrl, gateway.serviceType, 'DeletePortMapping', inner).then((result) => ({
    ok: result.ok,
    error: result.ok ? '' : UPNP_HINTS[result.code] || result.error || '删除失败',
  }));
}

function getExternalIp(gateway) {
  return soap(gateway.controlUrl, gateway.serviceType, 'GetExternalIPAddress', '').then((result) => {
    if (!result.ok) return { ok: false, ip: '', error: UPNP_HINTS[result.code] || result.error || '查不到' };
    const ip = /<NewExternalIPAddress>([^<]*)<\/NewExternalIPAddress>/i.exec(result.body || '');
    return ip ? { ok: true, ip: ip[1].trim() } : { ok: false, ip: '', error: '路由器没返回外网 IP' };
  });
}

// ---------------------------------------------------------------------------
// 结论
// ---------------------------------------------------------------------------

/**
 * @param {{ publicIp: string, routerIp: string, lanIp: string, ipv6: string, gatewayFound: boolean }} input
 */
function classify(input) {
  const { publicIp = '', routerIp = '', ipv6 = '', gatewayFound = false } = input;
  if (ipv6) return { nat: 'ipv6', reason: '你有公网 IPv6，可以直接给朋友用 IPv6 地址' };
  if (!gatewayFound) return { nat: 'unknown', reason: '路由器不支持（或关掉了）UPnP，查不到真实情况' };
  if (!routerIp) return { nat: 'unknown', reason: '路由器没返回外网 IP' };
  if (isCgnat(routerIp)) {
    return { nat: 'cgnat', reason: `路由器的外网地址是 ${routerIp}，属于运营商大内网（CGNAT）` };
  }
  if (isPrivateIpv4(routerIp)) {
    return { nat: 'double-nat', reason: `路由器的外网地址是 ${routerIp}（私网），说明你家是两级 NAT` };
  }
  if (publicIp && routerIp && publicIp !== routerIp) {
    return { nat: 'double-nat', reason: `路由器外网 ${routerIp} 与真实公网 ${publicIp} 不一致，被上一层 NAT 挡着` };
  }
  return { nat: 'public', reason: `你有公网 IP（${routerIp || publicIp}）` };
}

/** 新手看得懂的建议 */
function buildAdvice(report) {
  const advice = [];
  const port = report.port;

  // 虚拟组网工具（Radmin / ZeroTier / Tailscale）本身就是"零映射"方案，优先告诉新手
  if (Array.isArray(report.virtualAdapters) && report.virtualAdapters.length) {
    const item = report.virtualAdapters[0];
    advice.push(
      `你还装了组网工具（${item.iface}，地址 ${item.ip}）：让朋友装同一个软件、加进你的网络，` +
        `然后连 ${item.ip}:${port} 就能进，完全不用管路由器`
    );
  }

  if (report.nat === 'ipv6') {
    advice.push(`把 IPv6 地址发朋友：[${report.ipv6}]:${port}（对方网络也要有 IPv6，手机流量一般都有）`);
    advice.push('想更好看就加一条 AAAA 记录，用域名连（比 IPv4 更省事，完全不用改路由器）');
  }

  if (report.nat === 'public') {
    if (report.mapping && report.mapping.ok) {
      advice.push(`已经自动帮你把 ${port} 端口映射好了，朋友连 ${report.publicIp}:${port} 就能进`);
    } else {
      advice.push(`你有公网 IP，只差在路由器上把 TCP ${port} 转发给 ${report.lanIp}`);
      advice.push('点上面的「自动映射端口」让我用 UPnP 试试；不行的话登录路由器加一条端口映射（内部 IP 填上面那个）');
    }
  }

  if (report.nat === 'double-nat') {
    advice.push('你家用的是「光猫 + 路由器」两层 NAT：只在自己路由器上映射还不够');
    advice.push('最简单的做法：登录光猫（一般是 192.168.1.1，账号在光猫背面），也加一条同样端口的映射到你的路由器');
    advice.push('或者在光猫里把它设成桥接、由自己的路由器拨号（一次性设置，之后就不用了）');
  }

  if (report.nat === 'cgnat') {
    advice.push('运营商给你的是大内网地址（很多宽带默认这样），端口映射做了也没用');
    advice.push('出路只有三条：① 打客服要公网 IP（电信 10000，免费，说"需要公网 IP 做个人服务器"）；② 用 IPv6；③ 用内网穿透');
  }

  if (report.nat === 'unknown') {
    advice.push(`查不到路由器的信息，先用最直接的验证：手机开 4G（关 WiFi）试着连 ${report.publicIp || '你的公网 IP'}:${port}`);
    advice.push('能连 = 已经通了；连不上 = 需要登录路由器做端口映射（内部 IP 填本机的局域网地址）');
  }

  advice.push('Windows 防火墙记得放行 Java：控制面板 → 防火墙 → 允许应用通过 → 勾上 java.exe（专用+公用）');
  return advice;
}

/**
 * 一次完整的诊断（给界面用）
 * @param {{ port?: number, tryMap?: boolean }} options
 */
/** 从本机直连一个 TCP 端口（局域网 / 回环 / 公网回环都走这里） */
function probeTcp(options = {}) {
  const { host, port, timeout = 5000, label = '' } = options;
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect({ host, port });
    let settled = false;
    const done = (state, extra = {}) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve({ host, port, label, state, ms: Date.now() - started, ...extra });
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => done('open'));
    socket.once('timeout', () => done('timeout'));
    socket.once('error', (error) => done('error', { code: error.code || '' }));
  });
}

/**
 * 「外面到底连不连得进来」——三个视角依次试：
 *   1. 局域网 IP（验证服务器本身在跑）
 *   2. 公网 IP 回环（验证端口映射，某些路由器不支持 hairpin 会误报）
 *   3. Worker 代理（真正的外部视角，需要部署 Worker）
 */
async function reachability(options = {}) {
  const { port = 25565, lanIp = '', publicIp = '', proxyProbe = null, timeout = 4000 } = options;
  const attempts = [];

  if (lanIp) {
    attempts.push(await probeTcp({ host: lanIp, port, timeout, label: '局域网' }));
  }
  if (publicIp) {
    attempts.push(await probeTcp({ host: publicIp, port, timeout, label: '公网直连' }));
  }
  if (typeof proxyProbe === 'function') {
    try {
      const remote = await proxyProbe({ host: publicIp || lanIp, port });
      attempts.push({
        host: publicIp || lanIp,
        port,
        label: '外部视角（Worker）',
        state: remote && remote.reachable ? 'open' : 'closed',
        ms: (remote && remote.ms) || 0,
        code: (remote && remote.error) || '',
        external: true,
      });
    } catch (error) {
      attempts.push({
        label: '外部视角（Worker）',
        state: 'error',
        code: (error && error.message) || 'Worker 探测失败',
        external: true,
      });
    }
  }

  const lanOk = attempts.find((item) => item.label === '局域网' && item.state === 'open');
  const publicOk = attempts.find((item) => item.label === '公网直连' && item.state === 'open');
  const external = attempts.find((item) => item.external);

  let verdict = 'unknown';
  let summary = '';
  if (external && external.state === 'open') {
    verdict = 'reachable';
    summary = `公网可达：外部已经能连上 ${external.host}:${port}`;
  } else if (external && external.state === 'closed') {
    verdict = 'blocked';
    summary = `外部连不上 ${external.host}:${port} —— 端口映射没生效，或被防火墙/运营商拦了`;
  } else if (publicOk) {
    verdict = 'likely-reachable';
    summary = '公网 IP 回环能连上，大概率外面也能连（严格结论建议用「外部视角」或让朋友试）';
  } else if (lanOk) {
    verdict = 'lan-only';
    summary = lanOk && !publicOk
      ? '服务器在跑，但只有局域网能连：公网 IP 的回环测不通（可能没做映射，也可能路由器不支持回环）'
      : '服务器在跑，只有局域网能连';
  } else if (attempts.length) {
    verdict = 'down';
    summary = '服务器好像没在监听这个端口，先确认「一键开服」点成功了';
  }

  return { port, verdict, summary, attempts, hasExternal: Boolean(external) };
}

async function report(options = {}) {
  const { port = 25565, tryMap = false } = options;
  const lanIp = lanIpv4();
  const ipv6 = globalIpv6();
  const publicIp = await publicIpv4();

  const ssdp = await discoverGateway();
  const gateway = ssdp ? await loadGateway(ssdp.location) : null;
  const usable = Boolean(gateway && gateway.controlUrl && gateway.serviceType);
  const routerIp = usable ? (await getExternalIp(gateway)).ip : '';

  const verdict = classify({ publicIp, routerIp, ipv6, gatewayFound: usable });

  let mapping = null;
  if (tryMap && usable) {
    const result = await addPortMapping(gateway, { port, internalIp: lanIp, description: `Viskluke ${port}` });
    mapping = { ...result, port, internalIp: lanIp };
  }

  const result = {
    port,
    lanIp,
    ipv6,
    publicIp,
    virtualAdapters: virtualAdapters(),
    gateway: {
      found: usable,
      name: gateway && gateway.friendlyName ? gateway.friendlyName : ssdp ? '(未知型号)' : '',
      externalIp: routerIp,
      upnp: usable,
    },
    nat: verdict.nat,
    reason: verdict.reason,
    mapping,
  };
  result.advice = buildAdvice(result);
  return result;
}

/** 关服时把之前自动加的映射删掉（不删也不会坏事，只是路由器里留个条目） */
async function unmap(port) {
  const ssdp = await discoverGateway({ timeout: 1500, tries: 1 });
  if (!ssdp) return { ok: false, error: '找不到路由器' };
  const gateway = await loadGateway(ssdp.location);
  if (!gateway || !gateway.controlUrl) return { ok: false, error: '路由器不支持 UPnP' };
  return deletePortMapping(gateway, port);
}

module.exports = {
  report,
  reachability,
  probeTcp,
  unmap,
  classify,
  buildAdvice,
  discoverGateway,
  loadGateway,
  addPortMapping,
  deletePortMapping,
  getExternalIp,
  lanIpv4,
  listIpv4,
  virtualAdapters,
  globalIpv6,
  publicIpv4,
  isPrivateIpv4,
  isCgnat,
  _internal: { parseDeviceXml, envelope, UPNP_HINTS, soap },
};
