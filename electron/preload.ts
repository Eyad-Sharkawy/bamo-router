import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('routerAPI', {
  login: (credentials: any) => ipcRenderer.invoke('router:login', credentials),
  logout: () => ipcRenderer.invoke('router:logout'),
  getDevices: () => ipcRenderer.invoke('router:getDevices'),
  blockDevice: (ipAddress: string) => ipcRenderer.invoke('router:blockDevice', ipAddress),
  unblockDevice: (ruleId: string) => ipcRenderer.invoke('router:unblockDevice', ruleId),
  getBlockedDevices: () => ipcRenderer.invoke('router:getBlockedDevices'),
  restartRouter: () => ipcRenderer.invoke('router:restart'),
  getWifiPasswords: () => ipcRenderer.invoke('router:getWifiPasswords'),
  // NEW: Add the master save function
  saveWifiSettings: (networks: any[]) => ipcRenderer.invoke('router:saveWifiSettings', networks)
});
