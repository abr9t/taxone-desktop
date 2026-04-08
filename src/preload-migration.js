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
      scanFolders: (folderPaths) => ipcRenderer.invoke('migration:scan-folders', folderPaths),
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
        scanFolders: (folderPaths) => ipcRenderer.invoke('migration:scan-folders', folderPaths),
        scanFiles: (filePaths) => ipcRenderer.invoke('migration:scan-files', filePaths),
        getClients: () => ipcRenderer.invoke('migration:get-clients'),
        matchClients: (scannedFolders) => ipcRenderer.invoke('migration:match-clients', scannedFolders),
        enqueue: (mappings) => ipcRenderer.invoke('migration:enqueue', mappings),
        start: () => ipcRenderer.invoke('migration:start'),
        pause: () => ipcRenderer.invoke('migration:pause'),
        retryFile: (fileId) => ipcRenderer.invoke('migration:retry-file', fileId),
        retryAllFailed: () => ipcRenderer.invoke('migration:retry-all-failed'),
        skipFile: (fileId) => ipcRenderer.invoke('migration:skip-file', fileId),
        clearQueue: () => ipcRenderer.invoke('migration:clear-queue'),
        clearByStatus: (status) => ipcRenderer.invoke('migration:clear-by-status', status),
        getStats: () => ipcRenderer.invoke('migration:get-stats'),
        getFiles: () => ipcRenderer.invoke('migration:get-files'),
        getHistory: () => ipcRenderer.invoke('migration:get-history'),
        selectFolder: () => ipcRenderer.invoke('migration:select-folder'),
        getFolders: (clientId, parentId) => ipcRenderer.invoke('clients:folders', clientId, parentId),
        getImportRows: () => ipcRenderer.invoke('migration:get-import-rows'),
        setImportRows: (rows) => ipcRenderer.invoke('migration:set-import-rows', rows),
        getLastClient: () => ipcRenderer.invoke('migration:get-last-client'),
        setLastClient: (client) => ipcRenderer.invoke('migration:set-last-client', client),
        getPathForFile: (file) => webUtils.getPathForFile(file),
        openPath: (filePath) => ipcRenderer.invoke('migration:open-path', filePath),
        isAuthenticated: () => ipcRenderer.invoke('migration:is-authenticated'),
        getServerUrl: () => ipcRenderer.invoke('get-server-url'),
        onProgress: (callback) => {
            ipcRenderer.on('migration:progress', (_event, stats) => callback(stats));
        },
        onFileUpdate: (callback) => {
            ipcRenderer.on('migration:file-update', (_event, file) => callback(file));
        },
        onAuthChanged: (callback) => {
            ipcRenderer.on('migration:auth-changed', (_event, authed) => callback(authed));
        },
        showLogin: () => ipcRenderer.invoke('settings:show-login'),
    },
});
