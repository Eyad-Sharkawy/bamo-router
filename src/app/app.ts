import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';

type BlockMethod = 'ipv4' | 'mac' | 'wifiMac';

type FilterSettings = {
  ipv4Enabled: boolean;
  macEnabled: boolean;
  macPolicy: number;
  wifiMacEnabled: boolean;
  wifiMacPolicy: number;
};

type BlockedDevicesData = {
  ipv4: { ruleId: string; blockedIp: string; name: string; action: string }[];
  mac: { ruleId: string; blockedMac: string; deviceAlias?: string }[];
  wifiMac: { ruleId: string; blockedMac: string; deviceAlias: string; ssidName: string }[];
  settings: FilterSettings;
};

type DeviceRow = {
  mac: string;
  ip: string;
  hostname: string;
  status: string;
  connection?: string;
  blockRuleId: string | null;
  macBlockRuleId: string | null;
  wifiMacBlockRuleId: string | null;
  wifiSsidName: string | null;
  isConnected: boolean;
};

type RouterApiResult = {
  success: boolean;
  message?: string;
  error?: string;
  sessionExpired?: boolean;
};

declare global {
  interface Window {
    routerAPI: {
      login: (credentials: { user: string; pass: string }) => Promise<RouterApiResult>;
      logout: () => Promise<{ success: boolean }>;
      getDevices: () => Promise<RouterApiResult & { data?: any[] }>;
      getBlockedDevices: () => Promise<RouterApiResult & { data?: BlockedDevicesData }>;
      setFilterEnabled: (payload: {
        method: BlockMethod;
        enabled: boolean;
      }) => Promise<RouterApiResult>;
      blockDevice: (payload: {
        method: BlockMethod;
        ip?: string;
        mac?: string;
        alias?: string;
        ssidName?: string;
      }) => Promise<RouterApiResult>;
      unblockDevice: (payload: {
        method: BlockMethod;
        ruleId: string;
      }) => Promise<RouterApiResult>;
      restartRouter: () => Promise<RouterApiResult>;
      getWifiPasswords: () => Promise<RouterApiResult & { data?: any[] }>;
      saveWifiSettings: (networks: any[]) => Promise<RouterApiResult>;
    };
  }
}

type DashboardTab = 'devices' | 'wifi' | 'system';

/** Default SSID instance for new Wi‑Fi MAC filter rules (2.4 GHz on this router). */
const DEFAULT_WIFI_MAC_SSID = 'SSID-1';

const BLOCK_METHOD_OPTIONS: { value: BlockMethod; label: string }[] = [
  { value: 'ipv4', label: 'IPv4' },
  { value: 'mac', label: 'LAN MAC' },
  { value: 'wifiMac', label: 'Wi‑Fi MAC' },
];

@Component({
  selector: 'app-root',
  imports: [CommonModule, ReactiveFormsModule],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  private readonly fb = inject(FormBuilder);

  isAuthenticated = signal(false);
  currentUser = signal('');
  isLoggingIn = signal(false);
  loginError = signal('');
  activeTab = signal<DashboardTab>('devices');
  blockMethod = signal<BlockMethod>('ipv4');
  readonly blockMethodOptions = BLOCK_METHOD_OPTIONS;
  statusMessage = signal('');
  isBusy = signal(false);
  devices = signal<DeviceRow[]>([]);
  wifiNetworks = signal<any[]>([]);
  filterSettings = signal<FilterSettings>({
    ipv4Enabled: false,
    macEnabled: false,
    macPolicy: 0,
    wifiMacEnabled: false,
    wifiMacPolicy: 0,
  });

  loginForm = this.fb.nonNullable.group({
    user: ['', [Validators.required]],
    pass: ['', [Validators.required]],
  });

  get isElectron(): boolean {
    return typeof window !== 'undefined' && !!window.routerAPI;
  }

  private handleSessionExpired(message?: string) {
    this.resetAppState();
    this.loginError.set(message ?? 'Your router session expired. Please sign in again.');
  }

  /** Returns true when the response indicates the router session is no longer valid. */
  private handleApiResponse(res: RouterApiResult): boolean {
    if (!res.sessionExpired) return false;
    this.handleSessionExpired(res.message ?? res.error);
    return true;
  }

  private resetAppState() {
    this.isAuthenticated.set(false);
    this.currentUser.set('');
    this.isLoggingIn.set(false);
    this.isBusy.set(false);
    this.devices.set([]);
    this.wifiNetworks.set([]);
    this.filterSettings.set({
      ipv4Enabled: false,
      macEnabled: false,
      macPolicy: 0,
      wifiMacEnabled: false,
      wifiMacPolicy: 0,
    });
    this.statusMessage.set('');
    this.loginError.set('');
    this.activeTab.set('devices');
    this.blockMethod.set('ipv4');
    this.loginForm.reset({ user: '', pass: '' });
  }

  async onLoginSubmit() {
    this.loginForm.markAllAsTouched();
    if (this.loginForm.invalid) return;

    if (!this.isElectron) {
      this.loginError.set('Router API is only available in the desktop app.');
      return;
    }

    const { user, pass } = this.loginForm.getRawValue();
    this.isLoggingIn.set(true);
    this.loginError.set('');

    const res = await window.routerAPI.login({ user, pass });

    this.isLoggingIn.set(false);

    if (!res.success) {
      this.loginError.set(res.message || 'Login failed. Check your credentials.');
      return;
    }

    this.currentUser.set(user);
    this.isAuthenticated.set(true);
    this.loginForm.reset({ user: '', pass: '' });
    this.statusMessage.set('Connected to your router.');
    await this.fetchDevices();
    if (!this.isAuthenticated()) {
      this.loginError.set('Could not verify router access. Check your credentials.');
    }
  }

  async signOut() {
    try {
      if (this.isElectron) {
        await window.routerAPI.logout();
      }
    } catch {
      // Clear local state even when the router logout call fails.
    } finally {
      this.resetAppState();
    }
  }

  setTab(tab: DashboardTab) {
    this.activeTab.set(tab);
    if (tab === 'devices' && this.devices().length === 0) {
      void this.fetchDevices();
    }
    if (tab === 'wifi' && this.wifiNetworks().length === 0) {
      void this.fetchWifi();
    }
  }

  setBlockMethod(method: BlockMethod) {
    this.blockMethod.set(method);
  }

  /** Selected filter mode on the Connected devices tab. */
  blockTab(): BlockMethod {
    return this.blockMethod();
  }

  devicesForTab(method: BlockMethod): DeviceRow[] {
    return this.devices().filter((d) => {
      if (method === 'ipv4') return d.isConnected || !!d.blockRuleId;
      if (method === 'mac') return d.isConnected || !!d.macBlockRuleId;
      return d.isConnected || !!d.wifiMacBlockRuleId;
    });
  }

  deviceTrackId(device: DeviceRow): string {
    if (device.mac && device.mac !== '—') return `mac-${device.mac}`;
    if (device.blockRuleId) return `ipv4-${device.blockRuleId}`;
    if (device.macBlockRuleId) return `macrule-${device.macBlockRuleId}`;
    if (device.wifiMacBlockRuleId) return `wifimac-${device.wifiMacBlockRuleId}`;
    return `ip-${device.ip}-${device.hostname}`;
  }

  mergeDevicesWithBlocks(connected: any[], rules: BlockedDevicesData): DeviceRow[] {
    const list: DeviceRow[] = connected.map((dev) => ({
      mac: dev.mac,
      ip: dev.ip,
      hostname: dev.hostname,
      status: dev.status,
      connection: dev.connection,
      blockRuleId: null as string | null,
      macBlockRuleId: null as string | null,
      wifiMacBlockRuleId: null as string | null,
      wifiSsidName: null as string | null,
      isConnected: true,
    }));

    const findByIp = (ip: string) => list.find((d) => d.ip === ip);
    const findByMac = (mac: string) => list.find((d) => this.macsEqual(d.mac, mac));

    for (const rule of rules.ipv4) {
      if (rule.action && rule.action !== 'Drop') continue;
      const existing = findByIp(rule.blockedIp);
      if (existing) {
        existing.blockRuleId = rule.ruleId;
      } else {
        list.push({
          mac: '—',
          ip: rule.blockedIp,
          hostname: rule.name || rule.blockedIp,
          status: 'offline',
          connection: '—',
          blockRuleId: rule.ruleId,
          macBlockRuleId: null,
          wifiMacBlockRuleId: null,
          wifiSsidName: null,
          isConnected: false,
        });
      }
    }

    for (const rule of rules.mac) {
      const existing = findByMac(rule.blockedMac);
      if (existing) {
        existing.macBlockRuleId = rule.ruleId;
        const alias = rule.deviceAlias?.trim();
        if (alias && alias !== '--') {
          existing.hostname = alias;
        }
      } else {
        const alias = rule.deviceAlias?.trim();
        list.push({
          mac: rule.blockedMac,
          ip: '—',
          hostname: alias && alias !== '--' ? alias : rule.blockedMac,
          status: 'offline',
          connection: '—',
          blockRuleId: null,
          macBlockRuleId: rule.ruleId,
          wifiMacBlockRuleId: null,
          wifiSsidName: null,
          isConnected: false,
        });
      }
    }

    for (const rule of rules.wifiMac) {
      const existing = findByMac(rule.blockedMac);
      if (existing) {
        existing.wifiMacBlockRuleId = rule.ruleId;
        existing.wifiSsidName = rule.ssidName;
        const alias = rule.deviceAlias?.trim();
        if (alias && alias !== '--') {
          existing.hostname = alias;
        }
      } else {
        const alias = rule.deviceAlias?.trim();
        list.push({
          mac: rule.blockedMac,
          ip: '—',
          hostname: alias && alias !== '--' ? alias : rule.blockedMac,
          status: 'offline',
          connection: '—',
          blockRuleId: null,
          macBlockRuleId: null,
          wifiMacBlockRuleId: rule.ruleId,
          wifiSsidName: rule.ssidName,
          isConnected: false,
        });
      }
    }

    return list;
  }

  async fetchDevices() {
    if (!this.isElectron || !this.isAuthenticated()) return;
    this.isBusy.set(true);
    this.statusMessage.set('Loading devices…');

    const deviceRes = await window.routerAPI.getDevices();
    const rulesRes = await window.routerAPI.getBlockedDevices();

    if (!this.isAuthenticated()) return;
    if (this.handleApiResponse(deviceRes) || this.handleApiResponse(rulesRes)) return;

    if (deviceRes.success && deviceRes.data) {
      if (rulesRes.success && rulesRes.data) {
        this.filterSettings.set(rulesRes.data.settings);
        this.devices.set(this.mergeDevicesWithBlocks(deviceRes.data, rulesRes.data));
      } else {
        this.devices.set(
          deviceRes.data.map((dev) => ({
            mac: dev.mac,
            ip: dev.ip,
            hostname: dev.hostname,
            status: dev.status,
            connection: dev.connection,
            blockRuleId: null,
            macBlockRuleId: null,
            wifiMacBlockRuleId: null,
            wifiSsidName: null,
            isConnected: true,
          })),
        );
      }
      if (this.isAuthenticated()) {
        this.statusMessage.set(`${this.devices().length} device(s) loaded.`);
      }
    } else if (this.isAuthenticated()) {
      this.statusMessage.set(deviceRes.error ?? 'Could not load devices.');
    }

    if (this.isAuthenticated()) {
      this.isBusy.set(false);
    }
  }

  blockMethodLabel(method: BlockMethod): string {
    if (method === 'ipv4') return 'IPv4 filter';
    if (method === 'wifiMac') return 'Wi‑Fi MAC filter';
    return 'LAN MAC filter';
  }

  filterPolicyLabel(policy: number): string {
    return policy === 1 ? 'Whitelist' : 'Blacklist';
  }

  filterHint(method: BlockMethod): string {
    const s = this.filterSettings();
    if (method === 'ipv4') {
      return s.ipv4Enabled ? 'Enabled on router' : 'Disabled on router';
    }
    if (method === 'mac') {
      if (s.macEnabled) {
        return `Enabled · ${this.filterPolicyLabel(s.macPolicy)} mode`;
      }
      return 'Disabled on router';
    }
    if (s.wifiMacEnabled) {
      return `Enabled · ${this.filterPolicyLabel(s.wifiMacPolicy)} mode`;
    }
    return 'Disabled on router';
  }

  isFilterEnabled(method: BlockMethod): boolean {
    const s = this.filterSettings();
    if (method === 'ipv4') return s.ipv4Enabled;
    if (method === 'mac') return s.macEnabled;
    return s.wifiMacEnabled;
  }

  async toggleFilterEnabled(method: BlockMethod) {
    if (!this.isElectron || !this.isAuthenticated()) return;

    const next = !this.isFilterEnabled(method);
    const label = this.blockMethodLabel(method);
    if (!confirm(`${next ? 'Enable' : 'Disable'} ${label} on the router?`)) return;

    this.isBusy.set(true);
    this.statusMessage.set(`${next ? 'Enabling' : 'Disabling'} ${label}…`);
    const res = await window.routerAPI.setFilterEnabled({ method, enabled: next });
    if (!this.isAuthenticated()) return;
    if (this.handleApiResponse(res)) return;

    this.statusMessage.set(res.message ?? '');
    this.isBusy.set(false);

    if (res.success) {
      await this.fetchDevices();
    }
  }

  macsEqual(a: string, b: string): boolean {
    const normalize = (mac: string) => mac.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
    const na = normalize(a);
    const nb = normalize(b);
    if (!na || !nb) return false;
    return na === nb;
  }

  isBlockedByMethod(device: DeviceRow, method: BlockMethod): boolean {
    if (method === 'ipv4') return !!device.blockRuleId;
    if (method === 'mac') return !!device.macBlockRuleId;
    return !!device.wifiMacBlockRuleId;
  }

  blockActionLabel(device: DeviceRow, method: BlockMethod): string {
    const label =
      method === 'ipv4' ? 'IPv4' : method === 'wifiMac' ? 'Wi‑Fi MAC' : 'LAN MAC';
    return this.isBlockedByMethod(device, method) ? `Unblock ${label}` : `Block ${label}`;
  }

  canBlockDevice(device: DeviceRow, method: BlockMethod): boolean {
    if (this.isBlockedByMethod(device, method)) return true;
    if (method === 'ipv4') return !!device.ip && device.ip !== '—';
    return !!device.mac && device.mac !== '—';
  }

  blockPanelDesc(method: BlockMethod): string {
    if (method === 'ipv4') {
      return 'Connected devices and blocked IPs not currently on the network.';
    }
    if (method === 'wifiMac') {
      return `Connected devices and Wi‑Fi MAC rules. New blocks use ${DEFAULT_WIFI_MAC_SSID} (2.4 GHz).`;
    }
    return 'Connected devices and blocked LAN MACs not currently on the network.';
  }

  filterSettingName(method: BlockMethod): string {
    if (method === 'ipv4') return 'IPv4 incoming filter';
    if (method === 'wifiMac') return 'Wi‑Fi MAC filter';
    return 'LAN MAC filter';
  }

  blockedRuleLabel(method: BlockMethod): string {
    if (method === 'ipv4') return 'IPv4 rule active';
    if (method === 'wifiMac') return 'Wi‑Fi MAC rule active';
    return 'LAN MAC rule active';
  }

  async toggleBlockStatus(device: DeviceRow, method: BlockMethod) {
    if (!this.isElectron || !this.isAuthenticated()) return;

    const methodLabel = this.blockMethodLabel(method);
    const blockedByMethod = this.isBlockedByMethod(device, method);

    if (blockedByMethod) {
      const ruleId =
        method === 'ipv4'
          ? device.blockRuleId!
          : method === 'mac'
            ? device.macBlockRuleId!
            : device.wifiMacBlockRuleId!;
      if (!confirm(`Remove ${methodLabel} for ${device.hostname}?`)) return;
      this.statusMessage.set(`Removing ${methodLabel} for ${device.hostname}…`);
      const res = await window.routerAPI.unblockDevice({ method, ruleId });
      if (this.handleApiResponse(res)) return;
      if (!res.success) {
        this.statusMessage.set(res.message ?? `Failed to remove ${methodLabel}.`);
        return;
      }
    } else {
      if (!this.canBlockDevice(device, method)) {
        this.statusMessage.set(
          method === 'ipv4' ? 'No IP address available to block.' : 'No MAC address available to block.',
        );
        return;
      }
      if (!confirm(`Block ${device.hostname} using ${methodLabel}?`)) return;
      this.statusMessage.set(`Blocking ${device.hostname} (${methodLabel})…`);
      const blockPayload =
        method === 'mac'
          ? { method: 'mac' as const, mac: device.mac, alias: device.hostname }
          : method === 'wifiMac'
            ? {
                method: 'wifiMac' as const,
                mac: device.mac,
                alias: device.hostname,
                ssidName: DEFAULT_WIFI_MAC_SSID,
              }
            : { method: 'ipv4' as const, ip: device.ip, alias: device.hostname };
      const res = await window.routerAPI.blockDevice(blockPayload);
      if (this.handleApiResponse(res)) return;
      if (!res.success) {
        this.statusMessage.set(res.message ?? `Failed to apply ${methodLabel}.`);
        return;
      }
    }

    if (this.isAuthenticated()) {
      await this.fetchDevices();
    }
  }

  async triggerRestart() {
    const confirmReboot = confirm(
      'This will reboot your router. Wi‑Fi and internet may be unavailable for a few minutes. Continue?',
    );
    if (!confirmReboot || !this.isElectron || !this.isAuthenticated()) return;

    this.isBusy.set(true);
    this.statusMessage.set('Sending reboot command…');

    const res = await window.routerAPI.restartRouter();
    if (!this.isAuthenticated()) return;
    if (this.handleApiResponse(res)) return;

    this.statusMessage.set(res.message ?? '');
    this.isBusy.set(false);

    if (res.success) {
      this.devices.set([]);
      this.wifiNetworks.set([]);
    }
  }

  async fetchWifi() {
    if (!this.isElectron || !this.isAuthenticated()) return;
    this.isBusy.set(true);
    this.statusMessage.set('Loading Wi‑Fi settings…');

    const res = await window.routerAPI.getWifiPasswords();
    if (!this.isAuthenticated()) return;
    if (this.handleApiResponse(res)) return;

    if (res.success && res.data) {
      this.wifiNetworks.set(res.data);
      this.statusMessage.set('Wi‑Fi settings loaded.');
    } else {
      this.statusMessage.set('Could not load Wi‑Fi settings.');
    }

    this.isBusy.set(false);
  }

  async saveWifiChanges() {
    const confirmSave = confirm(
      'Apply these Wi‑Fi changes? Devices may disconnect if passwords or networks change.',
    );
    if (!confirmSave || !this.isElectron || !this.isAuthenticated()) return;

    this.isBusy.set(true);
    this.statusMessage.set('Saving Wi‑Fi configuration…');

    const res = await window.routerAPI.saveWifiSettings(this.wifiNetworks());
    if (!this.isAuthenticated()) return;
    if (this.handleApiResponse(res)) return;

    this.statusMessage.set(res.message ?? '');
    this.isBusy.set(false);

    if (res.success) {
      await this.fetchWifi();
    }
  }

  isDeviceOnline(status: string): boolean {
    const s = (status ?? '').toLowerCase();
    return s.includes('online') || s === '1' || s === 'connected';
  }
}
