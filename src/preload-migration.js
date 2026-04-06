/**
 * preload-migration.js — contextBridge for the migration window
 *
 * Add this to your existing preload.js OR load it as a separate preload
 * for the migration window only. If merging, add the `migration` namespace
 * to your existing contextBridge.exposeInMainWorld() call.
 *
 * Usage in main.js when creating migration window:
 *   webPreferences: { preload: path.join(__dirname, 'preload.js') }
 *
 * Then in preload.js, add these to the existing bridge:
 */

// ── Paste these into your existing preload.js contextBridge ──────────

/*
  migration: {
      scanFolder: (folderPath) => ipcRenderer.invoke('migration:scan-folder', folderPath),
      getClients: () => ipcRenderer.invoke('migration:get-clients'),
      matchClients: (scannedFolders) => ipcRenderer.invoke('migration:match-clients', scannedFolders),
      enqueue: (mappings) => ipcRenderer.invoke('migration:enqueue', mappings),
      start: () => ipcRenderer.invoke('migration:start'),
      pause: () => ipcRenderer.invoke('migration:pause'),
      retryFile: (fileId) => ipcRenderer.invoke('migration:retry-file', fileId),
      retryAllFailed: () => ipcRenderer.invoke('migration:retry-all-failed'),
      skipFile: (fileId) => ipcRenderer.invoke('migration:skip-file', fileId),
      clearQueue: () => ipcRenderer.invoke('migration:clear-queue'),
      getStats: () => ipcRenderer.invoke('migration:get-stats'),
      getFiles: () => ipcRenderer.invoke('migration:get-files'),
      getHistory: () => ipcRenderer.invoke('migration:get-history'),
      selectFolder: () => ipcRenderer.invoke('migration:select-folder'),
      onProgress: (callback) => {
          ipcRenderer.on('migration:progress', (event, stats) => callback(stats));
      },
      onFileUpdate: (callback) => {
          ipcRenderer.on('migration:file-update', (event, file) => callback(file));
      },
  },
*/

// ── Full standalone preload (if using separate preload for migration window) ──

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    migration: {
        scanFolder: (folderPath) => ipcRenderer.invoke('migration:scan-folder', folderPath),
        getClients: () => ipcRenderer.invoke('migration:get-clients'),
        matchClients: (scannedFolders) => ipcRenderer.invoke('migration:match-clients', scannedFolders),
        enqueue: (mappings) => ipcRenderer.invoke('migration:enqueue', mappings),
        start: () => ipcRenderer.invoke('migration:start'),
        pause: () => ipcRenderer.invoke('migration:pause'),
        retryFile: (fileId) => ipcRenderer.invoke('migration:retry-file', fileId),
        retryAllFailed: () => ipcRenderer.invoke('migration:retry-all-failed'),
        skipFile: (fileId) => ipcRenderer.invoke('migration:skip-file', fileId),
        clearQueue: () => ipcRenderer.invoke('migration:clear-queue'),
        getStats: () => ipcRenderer.invoke('migration:get-stats'),
        getFiles: () => ipcRenderer.invoke('migration:get-files'),
        getHistory: () => ipcRenderer.invoke('migration:get-history'),
        selectFolder: () => ipcRenderer.invoke('migration:select-folder'),
        getPathForFile: (file) => webUtils.getPathForFile(file),
        getServerUrl: () => ipcRenderer.invoke('get-server-url'),
        onProgress: (callback) => {
            ipcRenderer.on('migration:progress', (_event, stats) => callback(stats));
        },
        onFileUpdate: (callback) => {
            ipcRenderer.on('migration:file-update', (_event, file) => callback(file));
        },
    },
});
