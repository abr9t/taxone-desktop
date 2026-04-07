const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('taxone', {
    // Auth
    login: (data) => ipcRenderer.invoke('auth:login', data),

    // Settings
    getSettings: () => ipcRenderer.invoke('settings:get'),
    saveSettings: (data) => ipcRenderer.invoke('settings:save', data),
    browseFolder: () => ipcRenderer.invoke('settings:browse-folder'),
    getAutoLaunch: () => ipcRenderer.invoke('settings:get-auto-launch'),
    setAutoLaunch: (enabled) => ipcRenderer.invoke('settings:set-auto-launch', enabled),
    showLogin: () => ipcRenderer.invoke('settings:show-login'),

    // Clients
    searchClients: (query) => ipcRenderer.invoke('clients:search', query),

    // Clients
    searchClients: (query) => ipcRenderer.invoke('clients:search', query),
    fetchFolders: (clientId, parentId) => ipcRenderer.invoke('clients:folders', clientId, parentId),

    // Upload
    uploadFile: (data) => ipcRenderer.invoke('upload:file', data),

    // Queue
    queueNext: () => ipcRenderer.invoke('queue:next'),
    getQueueState: () => ipcRenderer.invoke('queue:state'),

    // Events from main process
    onQueueUpdated: (callback) => {
        ipcRenderer.on('queue-updated', (_, data) => callback(data));
    },
});
