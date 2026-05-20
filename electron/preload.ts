import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('routerAPI', {
  login: (credentials: any) => ipcRenderer.invoke('router:login', credentials),
  logout: () => ipcRenderer.invoke('router:logout'),
  getDevices: () => ipcRenderer.invoke('router:getDevices'),
  blockDevice: (payload: {
    method: 'ipv4' | 'mac' | 'wifiMac';
    ip?: string;
    mac?: string;
    alias?: string;
    ssidName?: string;
  }) => ipcRenderer.invoke('router:blockDevice', payload),
  unblockDevice: (payload: { method: 'ipv4' | 'mac' | 'wifiMac'; ruleId: string }) =>
    ipcRenderer.invoke('router:unblockDevice', payload),
  getBlockedDevices: () => ipcRenderer.invoke('router:getBlockedDevices'),
  setFilterEnabled: (payload: { method: 'ipv4' | 'mac' | 'wifiMac'; enabled: boolean }) =>
    ipcRenderer.invoke('router:setFilterEnabled', payload),
  restartRouter: () => ipcRenderer.invoke('router:restart'),
  getWifiPasswords: () => ipcRenderer.invoke('router:getWifiPasswords'),
  // NEW: Add the master save function
  saveWifiSettings: (networks: any[]) => ipcRenderer.invoke('router:saveWifiSettings', networks)
});
