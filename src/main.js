const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, dialog, shell, Notification } = require('electron');
const path = require('path');
const auth = require('./auth');
const watcher = require('./watcher');
const uploader = require('./uploader');
const { MigrationQueue } = require('./migration');
const { registerMigrationIPC, createMigrationUploadFn } = require('./migration-ipc');
const Store = require('electron-store');
const appStore = new Store();

let tray = null;
let loginWindow = null;
let settingsWindow = null;
let confirmWindow = null;
let migrationWindow = null;
let migrationQueue = null;

// Queue of files pending confirmation — managed here, not in renderer
const pendingFiles = [];

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
}

app.on('second-instance', () => {
    showSettings();
});

// ─── App Lifecycle ────────────────────────────────────────────────

app.setName('TaxOne Desktop');

app.setAppUserModelId('com.taxone.desktop');

app.whenReady().then(async () => {
    if (process.platform === 'darwin') app.dock.hide();

    if (!appStore.get('hasLaunched')) {
        app.setLoginItemSettings({ openAtLogin: true });
        appStore.set('hasLaunched', true);
    }

    createTray();

    const token = await auth.getToken();
    if (!token) {
        showLogin();
    } else {
        const valid = await uploader.verifyToken();
        if (!valid) {
            showLogin();
        } else {
            startWatching();
            initMigrationQueue();
        }
    }
});

app.on('window-all-closed', (e) => {
    e.preventDefault();
});

app.on('before-quit', () => {
    if (migrationQueue) {
        migrationQueue.flushSave();
    }
});

// ─── Tray ─────────────────────────────────────────────────────────

function createTray() {
    const iconPath = path.join(__dirname, '..', 'assets', 'tray-icon.png');
    let trayIcon;
    try {
        trayIcon = nativeImage.createFromPath(iconPath);
    } catch {
        trayIcon = nativeImage.createEmpty();
    }

    tray = new Tray(trayIcon);
    tray.setToolTip('TaxOne Desktop');
    updateTrayMenu('disconnected');
    tray.on('double-click', () => showSettings());
}

function updateTrayMenu(status) {
    const statusLabel = {
        disconnected: '⚪ Not connected',
        watching: '🟢 Watching for files',
        uploading: '🟡 Uploading...',
        error: '🔴 Error — check settings',
    }[status] || status;

    const watchPath = watcher.getWatchPath();
    const queueCount = pendingFiles.length;

    const menu = Menu.buildFromTemplate([
        { label: 'TaxOne Desktop', enabled: false },
        { type: 'separator' },
        { label: statusLabel, enabled: false },
        { type: 'separator' },
        {
            label: '📂 File Upload',
            click: () => showMigrationTool(),
        },
        { type: 'separator' },
        ...(watchPath ? [
            { label: 'WATCH FOLDER', enabled: false },
            { label: `📁 ${watchPath}`, enabled: false },
            {
                label: 'Open Watch Folder',
                enabled: !!watchPath,
                click: () => { if (watchPath) shell.openPath(watchPath); },
            },
            ...(queueCount > 0 ? [{ label: `📋 ${queueCount} file(s) pending`, enabled: false }] : []),
            { type: 'separator' },
        ] : []),
        { label: 'Settings...', click: () => showSettings() },
        { type: 'separator' },
        {
            label: 'Sign Out',
            click: async () => {
                watcher.stop();
                await auth.clearToken();
                updateTrayMenu('disconnected');
                showLogin();
            },
        },
        { label: 'Quit TaxOne Desktop', click: () => app.quit() },
    ]);

    tray.setContextMenu(menu);
}

// ─── Windows ──────────────────────────────────────────────────────

function createWindow(htmlFile, opts = {}) {
    const win = new BrowserWindow({
        width: opts.width || 480,
        height: opts.height || 400,
        resizable: opts.resizable ?? false,
        maximizable: false,
        minimizable: opts.minimizable ?? true,
        icon: path.join(__dirname, '..', 'assets', 'icon.png'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
        },
        ...opts,
    });

    win.setMenuBarVisibility(false);
    win.loadFile(path.join(__dirname, 'renderer', htmlFile));
    return win;
}

function showLogin() {
    if (loginWindow && !loginWindow.isDestroyed()) {
        loginWindow.focus();
        return;
    }
    loginWindow = createWindow('login.html', { width: 420, height: 520 });
    loginWindow.on('closed', () => { loginWindow = null; });
}

function showSettings() {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.focus();
        return;
    }
    settingsWindow = createWindow('settings.html', { width: 520, height: 640, resizable: true });
    settingsWindow.on('closed', () => { settingsWindow = null; });
}

function showConfirmUpload() {
    if (pendingFiles.length === 0) return;

    if (confirmWindow && !confirmWindow.isDestroyed()) {
        // Window already open — tell it to refresh its current file
        confirmWindow.webContents.send('queue-updated', {
            total: pendingFiles.length,
            current: pendingFiles[0],
        });
        confirmWindow.focus();
        return;
    }

    confirmWindow = createWindow('confirm-upload.html', {
        width: 540,
        height: 580,
        minimizable: false,
    });

    confirmWindow.webContents.on('did-finish-load', () => {
        confirmWindow.webContents.send('queue-updated', {
            total: pendingFiles.length,
            current: pendingFiles[0],
        });
    });

    confirmWindow.on('closed', () => { confirmWindow = null; });
}

function showMigrationTool() {
    if (migrationWindow && !migrationWindow.isDestroyed()) {
        migrationWindow.focus();
        return;
    }

    migrationWindow = new BrowserWindow({
        width: 900,
        height: 700,
        minWidth: 700,
        minHeight: 400,
        maxHeight: 900,
        title: 'TaxOne — File Upload',
        icon: path.join(__dirname, '..', 'assets', 'icon.png'),
        webPreferences: {
            preload: path.join(__dirname, 'preload-migration.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    migrationWindow.setMenuBarVisibility(false);
    migrationWindow.loadFile(path.join(__dirname, 'renderer', 'migration.html'));
    migrationWindow.on('closed', () => { migrationWindow = null; });
}

// ─── File Queue ───────────────────────────────────────────────────

function enqueueFile(fileInfo) {
    pendingFiles.push(fileInfo);
    console.log(`[queue] Added: ${fileInfo.fileName} (${pendingFiles.length} pending)`);
    updateTrayMenu('watching');
    showConfirmUpload();
}

function initMigrationQueue() {
    if (migrationQueue) return; // already initialized

    const uploadFn = createMigrationUploadFn(uploader);

    migrationQueue = new MigrationQueue({
        uploadFn,
        concurrency: 3,
        maxRetries: 5,
        onProgress: (stats) => {
            if (migrationWindow && !migrationWindow.isDestroyed()) {
                migrationWindow.webContents.send('migration:progress', stats);
            }
            if (stats.queueStatus === 'running' && tray) {
                tray.setToolTip(`TaxOne — Migrating: ${stats.completed}/${stats.total} (${stats.percent}%)`);
            }
        },
        onFileUpdate: (file) => {
            if (migrationWindow && !migrationWindow.isDestroyed()) {
                migrationWindow.webContents.send('migration:file-update', file);
            }
        },
        onComplete: (stats) => {
            new Notification({
                title: 'TaxOne — Upload Complete',
                body: `${stats.completed} files uploaded, ${stats.skipped} skipped, ${stats.failed} failed.`,
            }).show();
        },
    });

    registerMigrationIPC(migrationQueue, () => migrationWindow, uploader);
    migrationQueue.autoResume();

    // Network reconnection: auto-retry failed files when connection is restored
    setInterval(async () => {
        if (!migrationQueue) return;
        const stats = migrationQueue.getStats();
        if (stats.failed > 0 && stats.queueStatus === 'idle') {
            try {
                const isOnline = await uploader.verifyToken();
                if (isOnline) {
                    migrationQueue.retryAllFailed();
                }
            } catch {
                // still offline, do nothing
            }
        }
    }, 30000);
}

function dequeueFile() {
    pendingFiles.shift();
    console.log(`[queue] Remaining: ${pendingFiles.length}`);
    updateTrayMenu('watching');

    if (pendingFiles.length > 0) {
        // Show next file
        if (confirmWindow && !confirmWindow.isDestroyed()) {
            confirmWindow.webContents.send('queue-updated', {
                total: pendingFiles.length,
                current: pendingFiles[0],
            });
        }
    } else {
        // All done — close window
        if (confirmWindow && !confirmWindow.isDestroyed()) {
            confirmWindow.close();
        }
    }
}

// ─── File Watching ────────────────────────────────────────────────

function startWatching() {
    const watchPath = watcher.getWatchPath();
    if (!watchPath) {
        updateTrayMenu('disconnected');
        return;
    }

    watcher.start((fileInfo) => {
        enqueueFile(fileInfo);
    });

    updateTrayMenu('watching');
}

// ─── IPC Handlers ─────────────────────────────────────────────────

// Login
ipcMain.handle('auth:login', async (_, { serverUrl, token }) => {
    try {
        const isValid = await uploader.verifyTokenWith(serverUrl, token);
        if (!isValid) {
            return { success: false, error: 'Invalid token. Check your token and server URL.' };
        }
        await auth.saveToken(token);
        await auth.saveServerUrl(serverUrl);
        uploader.configure(serverUrl, token);

        startWatching();
        initMigrationQueue();
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

// Settings
ipcMain.handle('settings:get', async () => {
    return {
        serverUrl: await auth.getServerUrl(),
        watchPath: watcher.getWatchPath(),
        moveAfterUpload: watcher.getMoveAfterUpload(),
        hasToken: !!(await auth.getToken()),
    };
});

ipcMain.handle('settings:save', async (_, { watchPath, moveAfterUpload }) => {
    try {
        watcher.setWatchPath(watchPath);
        watcher.setMoveAfterUpload(moveAfterUpload);
        watcher.stop();
        startWatching();
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('settings:get-auto-launch', async () => {
    return app.getLoginItemSettings().openAtLogin;
});

ipcMain.handle('settings:set-auto-launch', async (_event, enabled) => {
    app.setLoginItemSettings({ openAtLogin: enabled });
    return { success: true };
});

ipcMain.handle('settings:browse-folder', async () => {
    const result = await dialog.showOpenDialog({
        properties: ['openDirectory', 'createDirectory'],
        title: 'Select Watch Folder',
    });
    if (result.canceled) return null;
    return result.filePaths[0];
});

// Clients
ipcMain.handle('clients:search', async (_, query) => {
    try {
        return await uploader.searchClients(query);
    } catch (err) {
        console.error('Search error:', err.message);
        return { error: err.message };
    }
});

// Folders for a client
ipcMain.handle('clients:folders', async (_, clientId, parentId) => {
    try {
        return await uploader.fetchFolders(clientId, parentId);
    } catch (err) {
        console.error('Folder fetch error:', err.message);
        return { folders: [], breadcrumb: [], parent_id: null };
    }
});

// Upload
ipcMain.handle('upload:file', async (_, { filePath, clientId, folderPath, filename }) => {
    try {
        updateTrayMenu('uploading');
        const result = await uploader.uploadFile(filePath, clientId, folderPath, filename);
        updateTrayMenu('watching');

        if (watcher.getMoveAfterUpload()) {
            watcher.moveToUploaded(filePath);
        }

        new Notification({
            title: 'TaxOne — Upload Complete',
            body: `${result.filename} uploaded successfully.`,
        }).show();

        return { success: true, ...result };
    } catch (err) {
        updateTrayMenu('watching');
        return { success: false, error: err.message };
    }
});

// Next file in queue (after upload success or skip)
ipcMain.handle('queue:next', async () => {
    dequeueFile();
    return { remaining: pendingFiles.length };
});

// Get current queue state
ipcMain.handle('queue:state', async () => {
    return {
        total: pendingFiles.length,
        current: pendingFiles[0] || null,
    };
});
