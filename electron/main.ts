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
ipcMain.handle('router:login', async (event, credentials) => {
  try {
    const routerIP = 'https://192.168.100.1';
    const tokenResponse = await client.get(`${routerIP}/asp/GetRandCount.asp`);
    const csrfToken = tokenResponse.data.match(/[a-f0-9]{64}/i)?.[0];
    if (!csrfToken) return { success: false, message: "Failed to find security token." };

    const loginResponse = await client.post(`${routerIP}/login.cgi`, new URLSearchParams({
      UserName: credentials.user,
      PassWord: Buffer.from(credentials.pass).toString('base64'),
      Language: 'english',
      'x.X_HW_Token': csrfToken
    }).toString());

    const body = typeof loginResponse.data === 'string' ? loginResponse.data : '';
    const failed = body.includes('logfail') || body.includes('Login failed');
    if (failed) {
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
  try {
    const routerIP = 'https://192.168.100.1';
    console.log('Fetching device data from hidden API...');

    const response = await client.post(`${routerIP}/html/bbsp/common/GetLanUserDevInfo.asp`);
    const rawData = response.data;
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
    return { success: false, error: error.message };
  }
});

// ==========================================
// 3. BLOCK DEVICE
// ==========================================
ipcMain.handle('router:blockDevice', async (event, ipAddress: string) => {
  try {
    const page = await client.get('https://192.168.100.1/html/bbsp/ipincoming/ipincoming.asp');
    const token = page.data.match(/id="hwonttoken" value="(.*?)"/i)?.[1];
    if (!token) return { success: false, message: "Token failed" };

    await client.post('https://192.168.100.1/html/bbsp/ipincoming/add.cgi?x=InternetGatewayDevice.X_HW_Security.IpFilterIn&RequestFile=html/bbsp/ipincoming/ipincoming.asp', new URLSearchParams({
      'x.Protocol': 'ALL', 'x.Direction': 'Bidirectional', 'x.Action': 'Drop', 'x.Priority': '1',
      'x.Name': 'Blocked_' + ipAddress.replace(/\./g, '_'),
      'x.SourceIPStart': ipAddress, 'x.SourceIPEnd': ipAddress,
      'x.X_HW_Token': token
    }).toString());
    return { success: true, message: 'Blocked!' };
  } catch (error: any) { return { success: false, message: error.message }; }
});

// ==========================================
// 4. UNBLOCK DEVICE
// ==========================================
ipcMain.handle('router:unblockDevice', async (event, ruleId: string) => {
  try {
    const page = await client.get('https://192.168.100.1/html/bbsp/ipincoming/ipincoming.asp');
    const token = page.data.match(/id="hwonttoken" value="(.*?)"/i)?.[1];
    await client.post('https://192.168.100.1/html/bbsp/ipincoming/del.cgi?RequestFile=html/bbsp/ipincoming/ipincoming.asp', new URLSearchParams({ [ruleId]: '', 'x.X_HW_Token': token! }).toString());
    return { success: true, message: 'Unblocked!' };
  } catch (error: any) { return { success: false, message: error.message }; }
});

// ==========================================
// 5. GET BLOCKED LIST
// ==========================================
ipcMain.handle('router:getBlockedDevices', async () => {
  try {
    const res = await client.get('https://192.168.100.1/html/bbsp/ipincoming/ipincoming.asp?_=' + Date.now());
    const blocks = res.data.matchAll(/new stFilterIn\(([\s\S]*?)\)/g);
    const rules: any[] = [];
    for (const b of blocks) {
      // Explicitly typed hex decoder
      const decoded = b[1].replace(/\\x([0-9A-Fa-f]{2})/g, (_: string, h: string) => String.fromCharCode(parseInt(h, 16)));
      const rule = decoded.match(/InternetGatewayDevice\.X_HW_Security\.IpFilterIn\.\d+/);
      const ip = decoded.match(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/);
      if (rule && ip) rules.push({ ruleId: rule[0], blockedIp: ip[0] });
    }
    return { success: true, data: rules };
  } catch (error: any) { return { success: false, error: error.message }; }
});

// ==========================================
// 6. RESTART
// ==========================================
ipcMain.handle('router:restart', async () => {
  try {
    const page = await client.get('https://192.168.100.1/html/bbsp/ipincoming/ipincoming.asp');
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
  try {
    const routerIP = 'https://192.168.100.1';
    console.log('Fetching Wi-Fi data...');

    const timestamp = Date.now();

    // 1. Fetch all THREE hidden API files simultaneously!
    const [pwdRes, ssidRes, extRes] = await Promise.all([
      client.get(`${routerIP}/html/amp/wlanbasic/simplewificfg.asp?_=${timestamp}`),
      client.get(`${routerIP}/html/amp/common/wlan_list.asp?_=${timestamp}`),
      client.get(`${routerIP}/html/amp/common/wlan_extended.asp?_=${timestamp}`) // The new file!
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
ipcMain.handle('router:saveWifiSettings', async (event, networks: any[]) => {
  try {
    const routerIP = 'https://192.168.100.1';
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
