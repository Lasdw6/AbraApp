import { contextBridge, ipcRenderer } from 'electron';

import type { TeleportBridge } from '../shared/contracts.js';

const bridge: TeleportBridge = {
  providerConfig: () => ipcRenderer.invoke('abra:provider-config'),
  agentTicket: () => ipcRenderer.invoke('abra:agent-ticket'),
  exportInstaller: () => ipcRenderer.invoke('abra:export-installer'),
  agentList: () => ipcRenderer.invoke('abra:agent-list'),
  agentSelect: id => ipcRenderer.invoke('abra:agent-select', id),
  sandbox: (action, payload) => ipcRenderer.invoke('abra:sandbox', action, payload),
  local: args => ipcRenderer.invoke('abra:local', args),
  chooseWorkspace: () => ipcRenderer.invoke('abra:choose-workspace'),
  appTarget: (name, sessionId) => ipcRenderer.invoke('abra:app-target', name, sessionId),
  appStart: workspace => ipcRenderer.invoke('abra:app-start', workspace),
  appStop: () => ipcRenderer.invoke('abra:app-stop'),
  appStatus: () => ipcRenderer.invoke('abra:app-status'),
  appOpen: () => ipcRenderer.invoke('abra:app-open'),
};

contextBridge.exposeInMainWorld('abra', bridge);
