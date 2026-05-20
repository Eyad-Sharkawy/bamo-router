import { app, BrowserWindow, ipcMain, Menu, nativeImage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';

// CRITICAL FIX: Tells Node.js to ignore self-signed certificate errors globally.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

let mainWindow: BrowserWindow;
let jar = new CookieJar();
let client = wrapper(axios.create({ jar, withCredentials: true, timeout: 5000 }));

function resetRouterSession() {
  jar = new CookieJar();
  client = wrapper(axios.create({ jar, withCredentials: true, timeout: 5000 }));
}

const ROUTER_IP = 'https://192.168.100.1';
const SESSION_PROBE_URL = `${ROUTER_IP}/html/bbsp/common/GetLanUserDevInfo.asp`;

function responseBodyAsString(data: unknown): string {
  return typeof data === 'string' ? data : String(data ?? '');
}

function looksLikeLoginPage(html: string): boolean {
  if (!html) return true;
  const lower = html.toLowerCase();
  if (lower.includes('logfail')) return true;
  if (lower.includes('login failed')) return true;
  if (lower.includes('invalid password') || lower.includes('invalid username')) return true;
  if (lower.includes('authentication failed')) return true;
  const hasLoginForm =
    (lower.includes('name="username"') || lower.includes('id="username"')) &&
    (lower.includes('name="password"') || lower.includes('type="password"'));
  const hasAuthedPayload = html.includes('USERDevice') || html.includes('hwonttoken');
  return hasLoginForm && !hasAuthedPayload;
}

function looksLikeAuthenticatedSession(html: string): boolean {
  if (!html || html.length < 10) return false;
  if (looksLikeLoginPage(html)) return false;
  return html.includes('USERDevice');
}

async function verifyRouterSession(): Promise<boolean> {
  try {
    const res = await client.post(SESSION_PROBE_URL);
    if (looksLikeAuthenticatedSession(responseBodyAsString(res.data))) {
      return true;
    }
    const page = await client.get(`${ROUTER_IP}/html/bbsp/ipincoming/ipincoming.asp`);
    const pageHtml = responseBodyAsString(page.data);
    return pageHtml.includes('hwonttoken') && !looksLikeLoginPage(pageHtml);
  } catch {
    return false;
  }
}

function notAuthenticatedResponse() {
  return {
    success: false as const,
    message: 'Not signed in to the router. Please sign in again.',
    sessionExpired: true as const,
  };
}

async function ensureRouterSession() {
  return (await verifyRouterSession()) ? null : notAuthenticatedResponse();
}

function decodeHexEscapes(value: string): string {
  return value.replace(/\\x([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function normalizeMac(mac: string): string {
  const hex = mac.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  if (hex.length !== 12) return mac.toUpperCase();
  return hex.match(/.{2}/g)!.join(':');
}

async function scrapeHwToken(pageUrl: string): Promise<string | null> {
  const page = await client.get(pageUrl);
  return page.data.match(/id="hwonttoken" value="(.*?)"/i)?.[1] ?? null;
}

function getAppIcon() {
  const names = ['icon.ico', 'icon.png'];
  const roots = app.isPackaged
    ? [path.join(process.resourcesPath, 'assets')]
    : [path.join(__dirname, '..', 'electron', 'assets')];

  for (const root of roots) {
    for (const name of names) {
      const iconPath = path.join(root, name);
      if (fs.existsSync(iconPath)) {
        return nativeImage.createFromPath(iconPath);
      }
    }
  }
  return undefined;
}

function getIndexHtmlPath() {
  const roots = app.isPackaged
    ? [app.getAppPath(), path.join(process.resourcesPath, 'app.asar.unpacked')]
    : [path.join(__dirname, '..')];

  const candidates = roots.flatMap((root) => [
    path.join(root, 'dist/bamo-router/browser/index.html'),
    path.join(root, 'dist/router-manager/browser/index.html'),
  ]);

  return candidates.find((p) => fs.existsSync(p)) ?? candidates[0];
}

function createWindow() {
  Menu.setApplicationMenu(null);

  const icon = getAppIcon();
  if (icon && process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(icon);
  }

  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    title: 'Bamo Router',
    icon,
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });

  const isDev = !app.isPackaged && process.env['NODE_ENV'] === 'development';

  if (isDev) {
    mainWindow.loadURL('http://localhost:4200');
  } else {
    const indexPath = getIndexHtmlPath();
    if (!fs.existsSync(indexPath)) {
      console.error('index.html not found:', indexPath);
    }
    void mainWindow.loadFile(indexPath);
  }
}

app.whenReady().then(createWindow);

// ==========================================
// 1. LOGIN
// ==========================================
ipcMain.handle('router:login', async (_event, credentials) => {
  try {
    resetRouterSession();

    const tokenResponse = await client.get(`${ROUTER_IP}/asp/GetRandCount.asp`);
    const csrfToken = tokenResponse.data.match(/[a-f0-9]{64}/i)?.[0];
    if (!csrfToken) return { success: false, message: 'Failed to reach the router.' };

    const loginResponse = await client.post(
      `${ROUTER_IP}/login.cgi`,
      new URLSearchParams({
        UserName: credentials.user,
        PassWord: Buffer.from(credentials.pass).toString('base64'),
        Language: 'english',
        'x.X_HW_Token': csrfToken,
      }).toString(),
    );

    const body = responseBodyAsString(loginResponse.data);
    if (looksLikeLoginPage(body)) {
      resetRouterSession();
      return { success: false, message: 'Invalid username or password.' };
    }

    if (!(await verifyRouterSession())) {
      resetRouterSession();
      return { success: false, message: 'Invalid username or password.' };
    }

    return { success: true, message: 'Logged in successfully!' };
  } catch (error: any) {
    resetRouterSession();
    return { success: false, message: error.message };
  }
});

ipcMain.handle('router:logout', async () => {
  resetRouterSession();
  return { success: true };
});

// ==========================================
// 2. GET DEVICES (DIAGNOSTIC FIX)
// ==========================================
ipcMain.handle('router:getDevices', async () => {
  const sessionErr = await ensureRouterSession();
  if (sessionErr) return sessionErr;

  try {
    console.log('Fetching device data from hidden API...');

    const response = await client.post(SESSION_PROBE_URL);
    const rawData = response.data;
    const rawText = responseBodyAsString(rawData);
    if (!looksLikeAuthenticatedSession(rawText)) {
      return notAuthenticatedResponse();
    }
    const devices: any[] = [];
    const deviceBlocks = rawData.matchAll(/new USERDevice(?:New)?\((.*?)\)/g);

    for (const block of deviceBlocks) {
      const rawArgs = [...block[1].matchAll(/"(.*?)"/g)].map((m) => m[1]);

      if (rawArgs.length >= 10) {
        const cleanString = (str: string) => {
          return str.replace(/\\x([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
        };

        const rawStatus = cleanString(rawArgs[6]);

        // DEBUG: Let's print exactly what the router is giving us for the first device!
        console.log(`Device: ${cleanString(rawArgs[9])} | Raw Status: [${rawStatus}]`);

        const device = {
          ip: cleanString(rawArgs[1]),
          mac: cleanString(rawArgs[2]),
          connection: cleanString(rawArgs[3]),
          ipType: cleanString(rawArgs[4]),
          // THE FIX: Pass the raw status straight to the frontend so we can see it!
          status: rawStatus,
          network: cleanString(rawArgs[7]),
          hostname: cleanString(rawArgs[9]) || 'Unknown Device',
        };

        if (device.mac && device.mac !== '--') devices.push(device);
      }
    }

    const uniqueDevices = Array.from(new Map(devices.map((item) => [item.mac, item])).values());
    console.log(`Successfully parsed ${uniqueDevices.length} unique devices!`);

    return { success: true, data: uniqueDevices };
  } catch (error: any) {
    return { success: false, error: error.message, message: error.message };
  }
});

type BlockMethod = 'ipv4' | 'mac' | 'wifiMac';

const WLAN_MAC_FILTER_PAGE = `${ROUTER_IP}/html/bbsp/wlanmacfilter/wlanmacfilter.asp`;

function parseIpv4BlockedRules(html: string) {
  const rules: { ruleId: string; blockedIp: string; name: string; action: string }[] = [];
  for (const b of html.matchAll(/new stFilterIn\(([\s\S]*?)\)/g)) {
    const decoded = decodeHexEscapes(b[1]);
    const parts = [...decoded.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
    if (parts.length < 9) continue;
    const ruleId = parts[0];
    const blockedIp = parts[4] || parts[5];
    if (!ruleId.includes('IpFilterIn') || !blockedIp) continue;
    if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(blockedIp)) continue;
    rules.push({
      ruleId,
      blockedIp,
      name: parts[13] ?? '',
      action: parts[8] ?? '',
    });
  }
  return rules;
}

function parseMacBlockedRules(html: string) {
  const rules: { ruleId: string; blockedMac: string; deviceAlias: string }[] = [];
  for (const b of html.matchAll(/new stMacFilter\(([\s\S]*?)\)/g)) {
    const decoded = decodeHexEscapes(b[1]);
    const parts = [...decoded.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
    if (parts.length < 2) continue;
    const ruleId = parts[0];
    const blockedMac = normalizeMac(parts[1]);
    const deviceAlias = parts[2] ?? '';
    if (ruleId.includes('MacFilter') && !ruleId.includes('WLANMacFilter') && blockedMac) {
      rules.push({ ruleId, blockedMac, deviceAlias });
    }
  }
  return rules;
}

function parseIpv4FilterSettings(html: string) {
  const match = html.match(/new stPortFilter\(([\s\S]*?)\)/);
  if (!match) return { enabled: false, policy: 0 };
  const parts = [...decodeHexEscapes(match[1]).matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  return {
    enabled: parts[1] === '1',
    policy: parseInt(parts[2] ?? '0', 10),
  };
}

function parseMacFilterSettings(html: string) {
  const enabled = html.match(/var enableFilter = '(\d)'/)?.[1] === '1';
  const policy = parseInt(html.match(/var Mode = '(\d)'/)?.[1] ?? '0', 10);
  return { enabled, policy };
}

function parseWlanMacBlockedRules(html: string) {
  const rules: {
    ruleId: string;
    blockedMac: string;
    deviceAlias: string;
    ssidName: string;
  }[] = [];
  for (const b of html.matchAll(/new stMacFilter\(([\s\S]*?)\)/g)) {
    const decoded = decodeHexEscapes(b[1]);
    if (!decoded.includes('WLANMacFilter')) continue;
    const parts = [...decoded.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
    if (parts.length < 4) continue;
    const ruleId = parts[0];
    const ssidName = parts[1];
    const deviceAlias = parts[2] ?? '';
    const blockedMac = normalizeMac(parts[3]);
    if (ruleId.includes('WLANMacFilter') && blockedMac) {
      rules.push({ ruleId, blockedMac, deviceAlias, ssidName });
    }
  }
  return rules;
}

function parseWlanMacFilterSettings(html: string) {
  const enabled = html.match(/var enableFilter = '(\d)'/)?.[1] === '1';
  const policy = parseInt(html.match(/var Mode = '(\d)'/)?.[1] ?? '0', 10);
  return { enabled, policy };
}

async function setIpv4FilterEnabled(enabled: boolean) {
  const token = await scrapeHwToken(`${ROUTER_IP}/html/bbsp/ipincoming/ipincoming.asp`);
  if (!token) return { success: false, message: 'Token failed' };

  await client.post(
    `${ROUTER_IP}/html/bbsp/ipincoming/set.cgi?x=InternetGatewayDevice.X_HW_Security&RequestFile=html/bbsp/ipincoming/ipincoming.asp`,
    new URLSearchParams({
      'x.IpFilterInRight': enabled ? '1' : '0',
      'x.X_HW_Token': token,
    }).toString(),
  );
  return { success: true, message: enabled ? 'IPv4 filter enabled.' : 'IPv4 filter disabled.' };
}

async function setMacFilterEnabled(enabled: boolean) {
  const token = await scrapeHwToken(`${ROUTER_IP}/html/bbsp/macfilter/macfilter.asp`);
  if (!token) return { success: false, message: 'Token failed' };

  await client.post(
    `${ROUTER_IP}/html/bbsp/macfilter/set.cgi?x=InternetGatewayDevice.X_HW_Security&RequestFile=html/bbsp/macfilter/macfilter.asp`,
    new URLSearchParams({
      'x.MacFilterRight': enabled ? '1' : '0',
      'x.X_HW_Token': token,
    }).toString(),
  );
  return { success: true, message: enabled ? 'MAC filter enabled.' : 'MAC filter disabled.' };
}

async function setWlanMacFilterEnabled(enabled: boolean) {
  const token = await scrapeHwToken(WLAN_MAC_FILTER_PAGE);
  if (!token) return { success: false, message: 'Token failed' };

  await client.post(
    `${ROUTER_IP}/html/bbsp/wlanmacfilter/set.cgi?x=InternetGatewayDevice.X_HW_Security&RequestFile=html/bbsp/wlanmacfilter/wlanmacfilter.asp`,
    new URLSearchParams({
      'x.WlanMacFilterRight': enabled ? '1' : '0',
      'x.X_HW_Token': token,
    }).toString(),
  );
  return {
    success: true,
    message: enabled ? 'Wi‑Fi MAC filter enabled.' : 'Wi‑Fi MAC filter disabled.',
  };
}

async function blockByIpv4(ipAddress: string, deviceAlias: string) {
  const token = await scrapeHwToken(`${ROUTER_IP}/html/bbsp/ipincoming/ipincoming.asp`);
  if (!token) return { success: false, message: 'Token failed' };

  const name = (deviceAlias || ipAddress).slice(0, 64);

  await client.post(
    `${ROUTER_IP}/html/bbsp/ipincoming/add.cgi?x=InternetGatewayDevice.X_HW_Security.IpFilterIn&RequestFile=html/bbsp/ipincoming/ipincoming.asp`,
    new URLSearchParams({
      'x.Protocol': 'ALL',
      'x.Direction': 'Bidirectional',
      'x.Action': 'Drop',
      'x.Priority': '1',
      'x.Name': name,
      'x.SourceIPStart': ipAddress,
      'x.SourceIPEnd': ipAddress,
      'x.X_HW_Token': token,
    }).toString(),
  );
  return { success: true, message: 'Blocked by IPv4 filter.' };
}

async function blockByMac(macAddress: string, deviceAlias: string) {
  const token = await scrapeHwToken(`${ROUTER_IP}/html/bbsp/macfilter/macfilter.asp`);
  if (!token) return { success: false, message: 'Token failed' };

  const mac = normalizeMac(macAddress);
  const alias = (deviceAlias || mac).slice(0, 64);

  await client.post(
    `${ROUTER_IP}/html/bbsp/macfilter/add.cgi?x=InternetGatewayDevice.X_HW_Security.MacFilter&RequestFile=html/bbsp/macfilter/macfilter.asp`,
    new URLSearchParams({
      'x.SourceMACAddress': mac,
      'x.DeviceAlias': alias,
      'x.X_HW_Token': token,
    }).toString(),
  );
  return { success: true, message: 'Blocked by MAC filter.' };
}

async function unblockByIpv4(ruleId: string) {
  const token = await scrapeHwToken(`${ROUTER_IP}/html/bbsp/ipincoming/ipincoming.asp`);
  if (!token) return { success: false, message: 'Token failed' };

  await client.post(
    `${ROUTER_IP}/html/bbsp/ipincoming/del.cgi?RequestFile=html/bbsp/ipincoming/ipincoming.asp`,
    new URLSearchParams({ [ruleId]: '', 'x.X_HW_Token': token }).toString(),
  );
  return { success: true, message: 'Unblocked IPv4 filter.' };
}

async function unblockByMac(ruleId: string) {
  const token = await scrapeHwToken(`${ROUTER_IP}/html/bbsp/macfilter/macfilter.asp`);
  if (!token) return { success: false, message: 'Token failed' };

  await client.post(
    `${ROUTER_IP}/html/bbsp/macfilter/del.cgi?x=InternetGatewayDevice.X_HW_Security.MacFilter&RequestFile=html/bbsp/macfilter/macfilter.asp`,
    new URLSearchParams({ [ruleId]: '', 'x.X_HW_Token': token }).toString(),
  );
  return { success: true, message: 'Unblocked MAC filter.' };
}

async function blockByWlanMac(macAddress: string, deviceAlias: string, ssidName: string) {
  const token = await scrapeHwToken(WLAN_MAC_FILTER_PAGE);
  if (!token) return { success: false, message: 'Token failed' };

  const mac = normalizeMac(macAddress);
  const alias = (deviceAlias || mac).slice(0, 32);
  const ssid = (ssidName || 'SSID-1').slice(0, 32);

  await client.post(
    `${ROUTER_IP}/html/bbsp/wlanmacfilter/add.cgi?x=InternetGatewayDevice.X_HW_Security.WLANMacFilter&RequestFile=html/bbsp/wlanmacfilter/wlanmacfilter.asp`,
    new URLSearchParams({
      'x.SourceMACAddress': mac,
      'x.SSIDName': ssid,
      'x.DeviceName': alias,
      'x.Enable': '1',
      'x.X_HW_Token': token,
    }).toString(),
  );
  return { success: true, message: 'Blocked on Wi‑Fi MAC filter.' };
}

async function unblockByWlanMac(ruleId: string) {
  const token = await scrapeHwToken(WLAN_MAC_FILTER_PAGE);
  if (!token) return { success: false, message: 'Token failed' };

  await client.post(
    `${ROUTER_IP}/html/bbsp/wlanmacfilter/del.cgi?x=InternetGatewayDevice.X_HW_Security.WLANMacFilter&RequestFile=html/bbsp/wlanmacfilter/wlanmacfilter.asp`,
    new URLSearchParams({ [ruleId]: '', 'x.X_HW_Token': token }).toString(),
  );
  return { success: true, message: 'Unblocked Wi‑Fi MAC filter.' };
}

// ==========================================
// 3. BLOCK DEVICE (IPv4 or MAC)
// ==========================================
ipcMain.handle(
  'router:blockDevice',
  async (
    _event,
    payload: {
      method: BlockMethod;
      ip?: string;
      mac?: string;
      alias?: string;
      ssidName?: string;
    },
  ) => {
    const sessionErr = await ensureRouterSession();
    if (sessionErr) return sessionErr;

    try {
      if (payload.method === 'wifiMac') {
        if (!payload.mac) return { success: false, message: 'MAC address is required.' };
        return await blockByWlanMac(payload.mac, payload.alias ?? '', payload.ssidName ?? 'SSID-1');
      }
      if (payload.method === 'mac') {
        if (!payload.mac) return { success: false, message: 'MAC address is required.' };
        return await blockByMac(payload.mac, payload.alias ?? '');
      }
      if (!payload.ip) return { success: false, message: 'IP address is required.' };
      return await blockByIpv4(payload.ip, payload.alias ?? '');
    } catch (error: any) {
      return { success: false, message: error.message };
    }
  },
);

// ==========================================
// 4. UNBLOCK DEVICE (IPv4 or MAC)
// ==========================================
ipcMain.handle(
  'router:unblockDevice',
  async (_event, payload: { method: BlockMethod; ruleId: string }) => {
    const sessionErr = await ensureRouterSession();
    if (sessionErr) return sessionErr;

    try {
      if (payload.method === 'wifiMac') return await unblockByWlanMac(payload.ruleId);
      if (payload.method === 'mac') return await unblockByMac(payload.ruleId);
      return await unblockByIpv4(payload.ruleId);
    } catch (error: any) {
      return { success: false, message: error.message };
    }
  },
);

// ==========================================
// 5. GET BLOCKED LIST (IPv4 + MAC)
// ==========================================
ipcMain.handle('router:getBlockedDevices', async () => {
  const sessionErr = await ensureRouterSession();
  if (sessionErr) return sessionErr;

  try {
    const ts = Date.now();
    const [ipRes, macRes, wlanMacRes] = await Promise.all([
      client.get(`${ROUTER_IP}/html/bbsp/ipincoming/ipincoming.asp?_=${ts}`),
      client.get(`${ROUTER_IP}/html/bbsp/macfilter/macfilter.asp?_=${ts}`),
      client.get(`${WLAN_MAC_FILTER_PAGE}?_=${ts}`),
    ]);
    const ipv4Settings = parseIpv4FilterSettings(ipRes.data);
    const macSettings = parseMacFilterSettings(macRes.data);
    const wlanMacSettings = parseWlanMacFilterSettings(wlanMacRes.data);
    return {
      success: true,
      data: {
        ipv4: parseIpv4BlockedRules(ipRes.data),
        mac: parseMacBlockedRules(macRes.data),
        wifiMac: parseWlanMacBlockedRules(wlanMacRes.data),
        settings: {
          ipv4Enabled: ipv4Settings.enabled,
          macEnabled: macSettings.enabled,
          macPolicy: macSettings.policy,
          wifiMacEnabled: wlanMacSettings.enabled,
          wifiMacPolicy: wlanMacSettings.policy,
        },
      },
    };
  } catch (error: any) {
    return { success: false, error: error.message, message: error.message };
  }
});

// ==========================================
// 5b. ENABLE / DISABLE FILTER MASTER SWITCH
// ==========================================
ipcMain.handle(
  'router:setFilterEnabled',
  async (_event, payload: { method: BlockMethod; enabled: boolean }) => {
    const sessionErr = await ensureRouterSession();
    if (sessionErr) return sessionErr;

    try {
      if (payload.method === 'wifiMac') return await setWlanMacFilterEnabled(payload.enabled);
      if (payload.method === 'mac') return await setMacFilterEnabled(payload.enabled);
      return await setIpv4FilterEnabled(payload.enabled);
    } catch (error: any) {
      return { success: false, message: error.message };
    }
  },
);

// ==========================================
// 6. RESTART
// ==========================================
ipcMain.handle('router:restart', async () => {
  const sessionErr = await ensureRouterSession();
  if (sessionErr) return sessionErr;

  try {
    const page = await client.get(`${ROUTER_IP}/html/bbsp/ipincoming/ipincoming.asp`);
    const token = page.data.match(/id="hwonttoken" value="(.*?)"/i)?.[1];
    await client.post('https://192.168.100.1/html/ssmp/accoutcfg/set.cgi?x=InternetGatewayDevice.X_HW_DEBUG.SMP.DM.ResetBoard&RequestFile=html/bbsp/ipincoming/ipincoming.asp',
      new URLSearchParams({ 'x.X_HW_Token': token! }).toString(),
      { headers: { 'Referer': 'https://192.168.100.1/html/ssmp/accoutcfg/ontmngt.asp' } }
    );
    return { success: true, message: 'Restarting...' };
  } catch (error: any) { return { success: true, message: 'Restarting...' }; }
});

// ==========================================
// 7. GET WIFI PASSWORDS, SSIDs & VISIBILITY
// ==========================================
ipcMain.handle('router:getWifiPasswords', async () => {
  const sessionErr = await ensureRouterSession();
  if (sessionErr) return sessionErr;

  try {
    console.log('Fetching Wi-Fi data...');

    const timestamp = Date.now();

    // 1. Fetch all THREE hidden API files simultaneously!
    const [pwdRes, ssidRes, extRes] = await Promise.all([
      client.get(`${ROUTER_IP}/html/amp/wlanbasic/simplewificfg.asp?_=${timestamp}`),
      client.get(`${ROUTER_IP}/html/amp/common/wlan_list.asp?_=${timestamp}`),
      client.get(`${ROUTER_IP}/html/amp/common/wlan_extended.asp?_=${timestamp}`),
    ]);

    // Explicitly typed hex decoder
    const clean = (s: string) => s.replace(/\\x([0-9A-Fa-f]{2})/g, (_: string, h: string) => String.fromCharCode(parseInt(h, 16)));

    // 2. Parse Passwords (from simplewificfg.asp)
    const passwords: { domain: string, password: string }[] = [];
    const pskBlock = pwdRes.data.match(/allPsk = new Array\(([\s\S]*?)\);/);
    if (pskBlock) {
      const decodedText = clean(pskBlock[1]);
      const keys = decodedText.matchAll(/new stPreSharedKey\("(.*?)","(.*?)",/g);
      for (const key of keys) {
        passwords.push({ domain: key[1], password: key[2] });
      }
    }

    // 3. Parse Hidden Status (from wlan_extended.asp)
    const visibilityMap = new Map<string, boolean>();
    const extBlocks = extRes.data.matchAll(/new stWlan\(([\s\S]*?)\)/g);
    for (const block of extBlocks) {
      const args = [...block[1].matchAll(/"(.*?)"/g)].map(m => clean(m[1]));
      if (args.length >= 6) {
        const domain = args[0];
        const isHidden = args[5] === "0"; // "0" means Advertisement Disabled (Hidden)
        visibilityMap.set(domain, isHidden);
      }
    }

    // 4. Parse SSIDs and Merge Everything (from wlan_list.asp)
    const wifiNetworks: any[] = [];
    const wlanBlocks = ssidRes.data.matchAll(/new stWlanInfo\(([\s\S]*?)\)/g);

    for (const block of wlanBlocks) {
      const args = [...block[1].matchAll(/"(.*?)"/g)].map(m => clean(m[1]));

      if (args.length >= 6) {
        const domain = args[0];
        const ssid = args[2];
        const isEnabled = args[4] === "1";
        const band = args[5];

        // Match the password and the hidden status using the domain string!
        const matchingPwd = passwords.find(p => p.domain.includes(domain));
        const isHidden = visibilityMap.get(domain) || false;

        if (ssid && ssid !== '--') {
          wifiNetworks.push({
            domain: domain,
            ssid: ssid,
            band: band,
            enabled: isEnabled,
            hidden: isHidden, // Attached the hidden status here!
            password: matchingPwd ? matchingPwd.password : 'No Password / WEP',
            showPassword: false
          });
        }
      }
    }

    console.log(`Successfully merged ${wifiNetworks.length} Wi-Fi networks.`);
    return { success: true, data: wifiNetworks };

  } catch (error: any) {
    console.error("Fetch Wi-Fi error:", error.message);
    return { success: false, error: error.message };
  }
});

// ==========================================
// 8. SAVE ALL WIFI SETTINGS (Master Function)
// ==========================================
ipcMain.handle('router:saveWifiSettings', async (_event, networks: any[]) => {
  const sessionErr = await ensureRouterSession();
  if (sessionErr) return sessionErr;

  try {
    const routerIP = ROUTER_IP;
    console.log('Pushing master Wi-Fi configuration...');

    // 1. Grab a fresh token
    const pageRes = await client.get(`${routerIP}/html/amp/wlanbasic/simplewificfg.asp`);
    const tokenMatch = pageRes.data.match(/id="hwonttoken" value="(.*?)"/i);
    const csrfToken = tokenMatch ? tokenMatch[1] : null;

    if (!csrfToken) return { success: false, message: "Failed to scrape the security token." };

    // 2. Separate the 2.4G and 5G networks from the data Angular sends us
    const net2G = networks.find(n => n.band === '2.4GHz') || { ssid: 'EZK2MS', hidden: false, enabled: true, password: '' };
    const net5G = networks.find(n => n.band === '5GHz') || { ssid: 'EZK2MS-5G', hidden: false, enabled: true, password: '' };

    // 3. Build the massive payload exactly as Huawei expects it
    const payload = new URLSearchParams({
      // --- 2.4GHz Settings ---
      'w0.SSID': net2G.ssid,
      'w0.SSIDAdvertisementEnabled': net2G.hidden ? '0' : '1',
      'w0.Enable': net2G.enabled ? '1' : '0',
      'r1.Enable': net2G.enabled ? '1' : '0',
      'psk0.PreSharedKey': net2G.password,

      'm.SSID': net2G.ssid,
      'm.SSIDAdvertisementEnabled': net2G.hidden ? '0' : '1',
      'm.Enable': net2G.enabled ? '1' : '0',
      'm.Key': net2G.password,
      'm.SsidInst': '1',
      'm.WMMEnable': '1',
      'm.STAIsolation': '0',
      'm.MaxAssociateNum': '32',

      // --- 5GHz Settings ---
      'w1.SSID': net5G.ssid,
      'w1.SSIDAdvertisementEnabled': net5G.hidden ? '0' : '1',
      'w1.Enable': net5G.enabled ? '1' : '0',
      'r2.Enable': net5G.enabled ? '1' : '0',
      'psk1.PreSharedKey': net5G.password,

      'm.SSID5G': net5G.ssid,
      'm.SSIDAdvertisementEnabled5G': net5G.hidden ? '0' : '1',
      'm.Enable5G': net5G.enabled ? '1' : '0',
      'm.Key5G': net5G.password,
      'm.SsidInst5G': '5',
      'm.WMMEnable5G': '1',
      'm.STAIsolation5G': '0',
      'm.MaxAssociateNum5G': '32',

      'x.X_HW_Token': csrfToken
    }).toString();

    // 4. The URL must contain ALL the specific TR-069 domains we are modifying
    const targetUrl = `${routerIP}/html/amp/wlanbasic/set.cgi?m=InternetGatewayDevice.X_HW_DEBUG.AMP.WifiCoverSetWlanBasic&w0=InternetGatewayDevice.LANDevice.1.WLANConfiguration.1&w1=InternetGatewayDevice.LANDevice.1.WLANConfiguration.5&r1=InternetGatewayDevice.LANDevice.1.WiFi.Radio.1&r2=InternetGatewayDevice.LANDevice.1.WiFi.Radio.2&psk0=InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1&psk1=InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.PreSharedKey.1&RequestFile=html/amp/wlanbasic/simplewificfg.asp`;

    const saveResponse = await client.post(targetUrl, payload, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': `${routerIP}/html/amp/wlanbasic/simplewificfg.asp`
      }
    });

    if (saveResponse.status === 200 || saveResponse.status === 302 || saveResponse.data.includes('success')) {
      console.log('Success! Wi-Fi settings updated.');
      return { success: true, message: 'Wi-Fi settings saved successfully!' };
    } else {
      return { success: false, message: 'Router rejected the save request.' };
    }
  } catch (error: any) {
    console.error("Save Wi-Fi error:", error.message);
    return { success: false, message: `Connection Error: ${error.message}` };
  }
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
