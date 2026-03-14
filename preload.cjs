const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  sendNotification: (title, body) => {
    new Notification(title, { body });
  },
  windowControl: {
    minimize: () => ipcRenderer.send('window-minimize'),
    maximize: () => ipcRenderer.send('window-maximize'),
    close: () => ipcRenderer.send('window-close')
  },
  audioControl: {
    start: (host, port) => ipcRenderer.send('audio-start', { host, port }),
    stop: () => ipcRenderer.send('audio-stop'),
    mute: (value) => ipcRenderer.send('audio-mute', value),
    onLog: (callback) => ipcRenderer.on('audio-engine-log', (event, data) => callback(data))
  },
  updateControl: {
    onAvailable: (callback) => ipcRenderer.on('update-available', (event, info) => callback(info)),
    onProgress: (callback) => ipcRenderer.on('update-download-progress', (event, progress) => callback(progress)),
    onDownloaded: (callback) => ipcRenderer.on('update-downloaded', (event, info) => callback(info)),
    download: () => ipcRenderer.send('start-download-update'),
    install: () => ipcRenderer.send('restart-app-for-update')
  }
});
