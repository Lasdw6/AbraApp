import { contextBridge, ipcRenderer } from 'electron';

import type { TeleportBridge } from '../shared/contracts.js';

const bridge: TeleportBridge = {
  providerConfig: () => ipcRenderer.invoke('abra:provider-config'),
  agentTicket: () => ipcRenderer.invoke('abra:agent-ticket'),
  exportInstaller: () => ipcRenderer.invoke('abra:export-installer'),
  connectionHealth: () => ipcRenderer.invoke('abra:connection-health'),
  agentList: () => ipcRenderer.invoke('abra:agent-list'),
  agentSelect: id => ipcRenderer.invoke('abra:agent-select', id),
  sandbox: (action, payload) => ipcRenderer.invoke('abra:sandbox', action, payload),
  local: args => ipcRenderer.invoke('abra:local', args),

};

contextBridge.exposeInMainWorld('abra', bridge);
