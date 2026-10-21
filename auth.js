const axios = require('axios');
const crypto = require('crypto');
const { shell } = require('electron');

// ⚠️ 替换成你自己的 Azure 应用 client_id
const CLIENT_ID = 'YOUR_AZURE_CLIENT_ID';

const DEVICE_CODE_URL =
  'https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode';
const TOKEN_URL =
  'https://login.microsoftonline.com/consumers/oauth2/v2.0/token';
const XBOX_AUTH_URL = 'https://user.auth.xboxlive.com/user/authenticate';
const XSTS_URL = 'https://xsts.auth.xboxlive.com/xsts/authorize';
const MC_AUTH_URL = 'https://api.minecraftservices.com/authentication/login_with_xbox';
const MC_PROFILE_URL = 'https://api.minecraftservices.com/minecraft/profile';

async function startDeviceFlow(win) {
  // 1. 请求 device code
  const dcRes = await axios.post(
    DEVICE_CODE_URL,
    new URLSearchParams({
      client_id: CLIENT_ID,
      scope: 'XboxLive.signin offline_access',
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  const { device_code, user_code, verification_uri, interval, expires_in } = dcRes.data;

  // 2. 展示给用户
  win.webContents.send('auth:device-code', {
    userCode: user_code,
    verificationUri: verification_uri,
  });
  shell.openExternal(verification_uri);

  // 3. 轮询直到拿到 access_token
  const deadline = Date.now() + expires_in * 1000;
  let pollInterval = (interval || 5) * 1000;

  while (Date.now() < deadline) {
    await sleep(pollInterval);

    try {
      const tokenRes = await axios.post(
        TOKEN_URL,
        new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          client_id: CLIENT_ID,
          device_code,
        }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );

      const tokens = tokenRes.data;
      // 4. 走 Xbox → XSTS → Minecraft 链路
      const mc = await exchangeToMinecraft(tokens.access_token);
      return {
        ok: true,
        type: 'msa',
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        minecraft: { ...mc, type: 'msa' },
      };
    } catch (err) {
      const error = err.response?.data?.error;
      if (error === 'authorization_pending') continue;
      if (error === 'slow_down') {
        pollInterval += 5000;
        continue;
      }
      return { ok: false, error: error || err.message };
    }
  }

  return { ok: false, error: 'device_code_expired' };
}

async function exchangeToMinecraft(msAccessToken) {
  // Xbox Live
  const xbl = await axios.post(XBOX_AUTH_URL, {
    Properties: {
      AuthMethod: 'RPS',
      SiteName: 'user.auth.xboxlive.com',
      RpsTicket: `d=${msAccessToken}`,
    },
    RelyingParty: 'http://auth.xboxlive.com',
    TokenType: 'JWT',
  });

  // XSTS
  const xsts = await axios.post(XSTS_URL, {
    Properties: { SandboxId: 'RETAIL', UserTokens: [xbl.data.Token] },
    RelyingParty: 'rp://api.minecraftservices.com/',
    TokenType: 'JWT',
  });

  // Minecraft
  const mcRes = await axios.post(MC_AUTH_URL, {
    identityToken: `XBL3.0 x=${xsts.data.DisplayClaims.xui[0].uhs};${xsts.data.Token}`,
  });

  // 档案
  const profile = await axios.get(MC_PROFILE_URL, {
    headers: { Authorization: `Bearer ${mcRes.data.access_token}` },
  });

  return {
    accessToken: mcRes.data.access_token,
    uuid: profile.data.id,
    name: profile.data.name,
  };
}

async function refresh(refreshToken) {
  const res = await axios.post(
    TOKEN_URL,
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
      scope: 'XboxLive.signin offline_access',
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  const mc = await exchangeToMinecraft(res.data.access_token);
  return { accessToken: res.data.access_token, refreshToken: res.data.refresh_token, minecraft: mc };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// 离线登录
//
// 离线账号不需要任何在线验证：
//   · UUID 用与官方一致的算法由用户名推导 —— md5("OfflinePlayer:" + name)，
//     并按 UUID v3 规范修正版本位/变体位。这样单机存档、离线服务器的玩家数据
//     与 HMCL / PCL / Prism 等启动器完全互通。
//   · access_token 填占位值，MCLC 会原样传给 --accessToken；离线服务器不校验。
// ---------------------------------------------------------------------------

const OFFLINE_NAME_RE = /^[A-Za-z0-9_]{3,16}$/;

function validateOfflineName(name) {
  const value = String(name || '').trim();
  if (!OFFLINE_NAME_RE.test(value)) {
    throw new Error('用户名需为 3-16 位，只能包含字母、数字、下划线');
  }
  return value;
}

/** 由用户名推导离线 UUID（UUID v3，与 Minecraft 离线模式一致） */
function offlineUuid(name) {
  const value = validateOfflineName(name);
  const hash = crypto.createHash('md5').update(`OfflinePlayer:${value}`, 'utf8').digest();
  hash[6] = (hash[6] & 0x0f) | 0x30; // version 3
  hash[8] = (hash[8] & 0x3f) | 0x80; // variant RFC 4122
  const hex = hash.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 离线登录：不联网、立即成功 */
function offlineLogin(name) {
  try {
    const username = validateOfflineName(name);
    return {
      ok: true,
      type: 'offline',
      minecraft: {
        name: username,
        uuid: offlineUuid(username),
        accessToken: '0',
        clientToken: '',
        type: 'offline',
      },
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

module.exports = { startDeviceFlow, refresh, offlineLogin, offlineUuid, validateOfflineName };