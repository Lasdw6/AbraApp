import { contextBridge, ipcRenderer } from 'electron';

import type { TeleportBridge } from '../shared/contracts.js';

const bridge: TeleportBridge = {
  providerConfig: () => ipcRenderer.invoke('abra:provider-config'),
  agentTicket: () => ipcRenderer.invoke('abra:agent-ticket'),
  exportInstaller: () => ipcRenderer.invoke('abra:export-installer'),
  connectionHealth: () => ipcRenderer.invoke('abra:connection-health'),
  agentList: () => ipcRenderer.invoke('abra:agent-list'),
  agentSelect: id => ipcRenderer.invoke('abra:agent-select', id),
  agentRename: (id, name) => ipcRenderer.invoke('abra:agent-rename', id, name),
  agentRemove: id => ipcRenderer.invoke('abra:agent-remove', id),
  sandbox: (action, payload, agentId) => ipcRenderer.invoke('abra:sandbox', action, payload, agentId),
  local: args => ipcRenderer.invoke('abra:local', args),
  onIncoming: callback => {
    const listener = (_event: Electron.IpcRendererEvent, message: string) => callback(message);
    ipcRenderer.on('abra:incoming', listener);
    return () => { ipcRenderer.removeListener('abra:incoming', listener); };
  },

};

contextBridge.exposeInMainWorld('abra', bridge);
