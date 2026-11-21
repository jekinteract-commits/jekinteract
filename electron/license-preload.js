'use strict';

/** Preload khusus jendela Auth Key (isolated dari dashboard). */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__licenseBridge__', {
  getStatus: () => ipcRenderer.invoke('license:get-status'),
  submit: (key) => ipcRenderer.invoke('license:submit', String(key || '')),
  retry: () => ipcRenderer.invoke('license:retry'),
  quit: () => ipcRenderer.invoke('license:quit')
});
