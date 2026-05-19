import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';

declare global {
  interface Window {
    routerAPI: {
      login: (credentials: { user: string; pass: string }) => Promise<{ success: boolean; message: string }>;
      logout: () => Promise<{ success: boolean }>;
      getDevices: () => Promise<{ success: boolean; data?: any[]; error?: string }>;
      getBlockedDevices: () => Promise<{ success: boolean; data?: any[]; error?: string }>;
      blockDevice: (ipAddress: string) => Promise<{ success: boolean; message: string }>;
      unblockDevice: (ruleId: string) => Promise<{ success: boolean; message: string }>;
      restartRouter: () => Promise<{ success: boolean; message: string }>;
      getWifiPasswords: () => Promise<{ success: boolean; data?: any[]; error?: string }>;
      saveWifiSettings: (networks: any[]) => Promise<{ success: boolean; message: string }>;
    };
  }
}

type DashboardTab = 'devices' | 'wifi' | 'system';

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
  statusMessage = signal('');
  isBusy = signal(false);
  devices = signal<any[]>([]);
  wifiNetworks = signal<any[]>([]);

  loginForm = this.fb.nonNullable.group({
    user: ['', [Validators.required]],
    pass: ['', [Validators.required]],
  });

  get isElectron(): boolean {
    return typeof window !== 'undefined' && !!window.routerAPI;
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

    if (res.success) {
      this.currentUser.set(user);
      this.isAuthenticated.set(true);
      this.loginForm.reset({ user: '', pass: '' });
      this.statusMessage.set('Connected to your router.');
      await this.fetchDevices();
    } else {
      this.loginError.set(res.message || 'Login failed. Check your credentials.');
    }
  }

  async signOut() {
    if (this.isElectron) {
      await window.routerAPI.logout();
    }
    this.isAuthenticated.set(false);
    this.currentUser.set('');
    this.devices.set([]);
    this.wifiNetworks.set([]);
    this.statusMessage.set('');
    this.loginError.set('');
    this.activeTab.set('devices');
    this.loginForm.reset({ user: '', pass: '' });
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

  async fetchDevices() {
    if (!this.isElectron) return;
    this.isBusy.set(true);
    this.statusMessage.set('Loading devices…');

    const deviceRes = await window.routerAPI.getDevices();
    const rulesRes = await window.routerAPI.getBlockedDevices();

    if (deviceRes.success && deviceRes.data) {
      let mergedDevices = deviceRes.data;

      if (rulesRes.success && rulesRes.data) {
        mergedDevices = mergedDevices.map((dev) => {
          const rule = rulesRes.data?.find((r) => r.blockedIp === dev.ip);
          return { ...dev, blockRuleId: rule ? rule.ruleId : null };
        });
      }

      this.devices.set(mergedDevices);
      this.statusMessage.set(`${mergedDevices.length} device(s) loaded.`);
    } else {
      this.statusMessage.set(deviceRes.error ?? 'Could not load devices.');
    }

    this.isBusy.set(false);
  }

  async toggleBlockStatus(device: any) {
    if (!this.isElectron) return;

    if (device.blockRuleId) {
      this.statusMessage.set(`Unblocking ${device.hostname}…`);
      await window.routerAPI.unblockDevice(device.blockRuleId);
    } else {
      const confirmBlock = confirm(`Block internet for ${device.hostname}?`);
      if (!confirmBlock) return;
      this.statusMessage.set(`Blocking ${device.hostname}…`);
      await window.routerAPI.blockDevice(device.ip);
    }

    await this.fetchDevices();
  }

  async triggerRestart() {
    const confirmReboot = confirm(
      'This will reboot your router. Wi‑Fi and internet may be unavailable for a few minutes. Continue?',
    );
    if (!confirmReboot || !this.isElectron) return;

    this.isBusy.set(true);
    this.statusMessage.set('Sending reboot command…');

    const res = await window.routerAPI.restartRouter();
    this.statusMessage.set(res.message);
    this.isBusy.set(false);

    if (res.success) {
      this.devices.set([]);
      this.wifiNetworks.set([]);
    }
  }

  async fetchWifi() {
    if (!this.isElectron) return;
    this.isBusy.set(true);
    this.statusMessage.set('Loading Wi‑Fi settings…');

    const res = await window.routerAPI.getWifiPasswords();

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
    if (!confirmSave || !this.isElectron) return;

    this.isBusy.set(true);
    this.statusMessage.set('Saving Wi‑Fi configuration…');

    const res = await window.routerAPI.saveWifiSettings(this.wifiNetworks());
    this.statusMessage.set(res.message);
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
