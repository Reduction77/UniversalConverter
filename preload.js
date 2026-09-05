const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('converterAPI', {
  resultAction: (output,action) => ipcRenderer.invoke('result-action',{output,action}),
  exportLogs: (data) => ipcRenderer.invoke('export-logs',data),
  chooseFiles: () => ipcRenderer.invoke('choose-files'),
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),
  chooseOutput: () => ipcRenderer.invoke('choose-output'),
  scanPaths: (paths) => ipcRenderer.invoke('scan-paths', paths),
  detectEngines: () => ipcRenderer.invoke('detect-engines'),
  chooseEngine: (key) => ipcRenderer.invoke('choose-engine', key),
  installEngine: (key) => ipcRenderer.invoke('install-engine', key),
  installCommon: () => ipcRenderer.invoke('install-common'),
  startConversion: (payload) => ipcRenderer.invoke('start-conversion', payload),
  cancelConversion: () => ipcRenderer.invoke('cancel-conversion'),
  openFolder: (path) => ipcRenderer.invoke('open-folder', path),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  onQueueEvent: (callback) => ipcRenderer.on('queue-event', (_event, data) => callback(data)),
  onInstallEvent: (callback) => ipcRenderer.on('install-event', (_event, data) => callback(data)),
});
