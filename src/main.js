process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, dialog, shell, Notification } = require('electron');
const path = require('path');
const fs = require('fs');

// ─── userData pin ─────────────────────────────────────────────────
//
// This directory name is an IDENTIFIER, not branding. Do not "fix" it to
// match the Quework display name.
//
// Electron derives userData from productName, and electron-store resolves
// its directory once, at construction time, from app.getPath('userData').
// Every store in this app is constructed at module load, so the pin has to
// run before the first require() below that pulls one in — which is why it
// sits here rather than next to app.setName().
//
// Every existing install keeps its serverUrl, watch folder, token fallback
// and upload queue under "TaxOne Desktop". Letting the renamed productName
// pick the directory instead points the app at a new, empty one: the legacy
// host migration finds nothing to migrate, and every user lands on the login
// screen with their upload queue gone.
const USER_DATA_DIR = 'TaxOne Desktop';
app.setPath('userData', path.join(app.getPath('appData'), USER_DATA_DIR));

const auth = require('./auth');
const watcher = require('./watcher');
const uploader = require('./uploader');
const { MigrationQueue } = require('./migration');
const { registerMigrationIPC, createMigrationUploadFn } = require('./migration-ipc');
const Store = require('electron-store');
const appStore = new Store();

// Debug log to file (Windows Electron doesn't pipe to terminal).
//
// Written to userData, not next to __dirname: in a packaged build __dirname
// is inside app.asar, so appendFileSync there throws. The only caller is on
// the legacy-host upgrade path, inside the whenReady handler — an exception
// would reject that promise and take the rest of startup (tray, watcher,
// upload queue) down with it, on exactly the installs this release targets.
const _debugLog = path.join(app.getPath('userData'), 'debug.log');
function debugLog(...args) {
    const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
    try {
        fs.appendFileSync(_debugLog, line);
    } catch {
        // Logging must never be the thing that breaks startup.
    }
    console.log(...args);
}

let tray = null;
let trayMenu = null;
let loginWindow = null;
let settingsWindow = null;
let confirmWindow = null;
let migrationWindow = null;
let migrationQueue = null;

// Queue of files pending confirmation — managed here, not in renderer
const pendingFiles = [];

// ─── Custom Protocol ─────────────────────────────────────────────

if (process.defaultApp) {
    app.setAsDefaultProtocolClient('taxone-desktop',
        process.execPath, [path.resolve(process.argv[1])]);
} else {
    app.setAsDefaultProtocolClient('taxone-desktop');
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
}

app.on('second-instance', (event, commandLine) => {
    const url = commandLine.find(arg => arg.startsWith('taxone-desktop://'));
    if (url) {
        handleAuthUrl(url);
    } else {
        showMigrationTool();
    }
});

// A protocol link is attacker-supplyable, and even a well-formed Quework URL
// points at some other firm's server. Re-pointing an install that is already
// paired would send the next upload — and the bearer token behind it — to
// whoever sent the link, so ask first.
async function confirmHostChange(nextUrl) {
    const current = auth.getServerUrl();
    if (!current || current === nextUrl) return true;

    const { response } = await dialog.showMessageBox({
        type: 'warning',
        buttons: ['Cancel', 'Change server'],
        defaultId: 0,
        cancelId: 0,
        title: 'Change Quework server?',
        message: 'This link wants to point Quework Desktop at a different server.',
        detail: `Currently connected to:\n${current}\n\n`
            + `The link asks for:\n${nextUrl}\n\n`
            + "Only continue if you started this from your own firm's Quework site.",
    });
    return response === 1;
}

// Returns the canonical URL that was stored, or null if the link was
// rejected or the user declined. Every protocol-borne URL goes through here.
async function applyServerUrlFromLink(rawUrl) {
    const result = auth.validateServerUrl(rawUrl);
    if (!result.ok) {
        debugLog(`[protocol] Rejected server URL: ${result.error}`);
        dialog.showErrorBox('Quework Desktop', `This link was ignored.\n\n${result.error}`);
        return null;
    }
    if (!(await confirmHostChange(result.url))) {
        debugLog('[protocol] Server change declined by the user');
        return null;
    }
    auth.saveServerUrl(result.url);
    return result.url;
}

async function handleAuthUrl(url) {
    try {
        const parsed = new URL(url);

        if (parsed.hostname === 'connect') {
            const rawServerUrl = parsed.searchParams.get('url');
            if (rawServerUrl && !(await applyServerUrlFromLink(rawServerUrl))) {
                return;
            }
            const token = await auth.getToken();
            if (token) {
                // Already signed in — just open File Upload
                showMigrationTool();
            } else {
                showLogin();
                if (loginWindow && !loginWindow.isDestroyed()) {
                    loginWindow.focus();
                }
            }
            return;
        }

        // Default: auth handler (taxone-desktop://auth?token=X&url=Y)
        const token = parsed.searchParams.get('token');
        const rawServerUrl = parsed.searchParams.get('url');

        if (!token || !rawServerUrl) return;

        // Host first: a token that arrived alongside a rejected host has no
        // business being persisted.
        const serverUrl = await applyServerUrlFromLink(rawServerUrl);
        if (!serverUrl) return;

        await auth.saveToken(token);
        uploader.configure(serverUrl, token);

        if (loginWindow && !loginWindow.isDestroyed()) {
            loginWindow.close();
        }

        startWatching();
        initMigrationQueue();
        showMigrationTool();

        if (migrationWindow && !migrationWindow.isDestroyed()) {
            migrationWindow.webContents.send('migration:auth-changed', true);
        }

        new Notification({
            title: 'Quework Desktop',
            body: 'Successfully signed in.',
        }).show();
    } catch (err) {
        console.error('Auth URL handling failed:', err);
    }
}

// ─── App Lifecycle ────────────────────────────────────────────────

app.setName('Quework Desktop');

// Also the registry value name Electron writes the autostart entry under —
// see reconcileAutoLaunch(). Unchanged by the rebrand, deliberately.
const AUTO_LAUNCH_ENTRY_NAME = 'com.taxone.desktop';
app.setAppUserModelId(AUTO_LAUNCH_ENTRY_NAME);

app.whenReady().then(async () => {
    if (process.platform === 'darwin') app.dock.hide();

    if (!appStore.get('hasLaunched')) {
        app.setLoginItemSettings({ openAtLogin: true, path: process.execPath });
        appStore.set('hasLaunched', true);
    }

    reconcileAutoLaunch();

    // Both migrations run before createTray(), which reads the watch path
    // into the tray menu, and before anything reads serverUrl. One-time,
    // guarded (see auth.js and watcher.js).
    if (auth.migrateLegacyHost()) {
        debugLog('[migration] Re-pointed persisted host taxone.cpa -> caputa.quework.app');
    }
    if (watcher.migrateLegacyWatchPath()) {
        debugLog('[migration] Pinned watch folder to the legacy ~/TaxoneWatch');
    }

    createTray();

    const token = await auth.getToken();
    const serverUrl = auth.getServerUrl();
    if (!token) {
        showLogin();
    } else {
        const result = await uploader.verifyToken();
        if (result === 'auth_error') {
            showLogin();
        } else {
            // 'ok' or 'network_error' — proceed with cached credentials
            uploader.configure(serverUrl, token);
            startWatching();
            initMigrationQueue();
            showMigrationTool();
        }
    }
});

// productName drives the executable name and the install directory, so the
// rebrand moves the exe — but the Run-key entry recording its absolute path
// does not move with it. Electron writes that entry under the
// AppUserModelId, which is unchanged (com.taxone.desktop), so it survives
// the upgrade pointing at an executable the installer has just removed.
//
// Re-assert it whenever the recorded path has drifted. Only when an entry
// already exists: someone who turned autostart off in Settings has none, and
// resurrecting it would be worse than the stale path.
function reconcileAutoLaunch() {
    if (!app.isPackaged) return;

    try {
        const settings = app.getLoginItemSettings();
        const entry = (settings.launchItems || []).find(item => item.name === AUTO_LAUNCH_ENTRY_NAME);
        if (!entry && !settings.openAtLogin) return;

        const registered = entry ? entry.path : '';
        if (!registered || samePath(registered, process.execPath)) return;

        app.setLoginItemSettings({ openAtLogin: true, path: process.execPath });
        debugLog(`[autostart] Re-registered: ${registered} -> ${process.execPath}`);
    } catch (err) {
        debugLog(`[autostart] Reconcile failed: ${err.message}`);
    }
}

function samePath(a, b) {
    return path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();
}

app.on('window-all-closed', (e) => {
    e.preventDefault();
});

app.on('activate', () => {
    showMigrationTool();
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
    tray.setToolTip('Quework Desktop');
    updateTrayMenu('disconnected');
    tray.on('click', () => showMigrationTool());
    tray.on('double-click', () => showMigrationTool());
    tray.on('right-click', () => {
        if (trayMenu) tray.popUpContextMenu(trayMenu);
    });
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
        { label: 'Quework Desktop', enabled: false },
        { type: 'separator' },
        {
            label: '⬆ File Upload',
            click: () => showMigrationTool(),
        },
        { type: 'separator' },
        { label: 'WATCH FOLDER', enabled: false },
        { label: statusLabel, enabled: false },
        ...(watchPath ? [
            { label: `📁 ${watchPath}`, enabled: false },
            {
                label: 'Open Watch Folder',
                enabled: !!watchPath,
                click: () => { if (watchPath) shell.openPath(watchPath); }
            },
        ] : []),
        ...(queueCount > 0 ? [{ label: `📋 ${queueCount} file(s) pending`, enabled: false }] : []),
        { type: 'separator' },
        { label: 'Settings...', click: () => showSettings() },
        { type: 'separator' },
        ...(status === 'disconnected' ? [
            {
                label: 'Sign In',
                click: () => showLogin(),
            },
        ] : [
            {
                label: 'Sign Out',
                click: async () => {
                    watcher.stop();
                    await auth.clearToken();
                    updateTrayMenu('disconnected');

                    if (migrationWindow && !migrationWindow.isDestroyed()) {
                        migrationWindow.webContents.send('migration:auth-changed', false);
                    }

                    showLogin();
                },
            },
        ]),
        { label: 'Quit Quework Desktop', click: () => app.quit() },
    ]);

    trayMenu = menu;
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
    settingsWindow = createWindow('settings.html', { width: 520, height: 720, resizable: true, minHeight: 600 });
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
        title: 'Quework — File Upload',
        icon: path.join(__dirname, '..', 'assets', 'icon.png'),
        webPreferences: {
            preload: path.join(__dirname, 'preload-migration.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    migrationWindow.setMenuBarVisibility(false);
    migrationWindow.loadFile(path.join(__dirname, 'renderer', 'migration.html'));
    migrationWindow.on('close', () => {
        if (!appStore.get('hasClosedUploadWindow')) {
            appStore.set('hasClosedUploadWindow', true);
            new Notification({
                title: 'Quework Desktop',
                body: 'The app is still running in the system tray. Right-click the tray icon for options.',
            }).show();
        }
    });
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
        concurrency: 1,
        maxRetries: 5,
        onProgress: (stats) => {
            if (migrationWindow && !migrationWindow.isDestroyed()) {
                migrationWindow.webContents.send('migration:progress', stats);
            }
            if (stats.queueStatus === 'running' && tray) {
                tray.setToolTip(`Quework — Migrating: ${stats.completed}/${stats.total} (${stats.percent}%)`);
            }
        },
        onFileUpdate: (file) => {
            if (migrationWindow && !migrationWindow.isDestroyed()) {
                migrationWindow.webContents.send('migration:file-update', file);
            }
        },
        onComplete: (stats) => {
            if (stats.completed === 0 && stats.skipped === 0) return;
            new Notification({
                title: 'Quework — Upload Complete',
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
                if (isOnline === 'ok') {
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
        // Before verifyTokenWith, not after: that call sends the token to the
        // host, so an unvalidated URL leaks it just as effectively as a
        // malicious protocol link would.
        const check = auth.validateServerUrl(serverUrl);
        if (!check.ok) {
            return { success: false, error: check.error };
        }
        const canonicalUrl = check.url;

        const isValid = await uploader.verifyTokenWith(canonicalUrl, token);
        if (!isValid) {
            return { success: false, error: 'Invalid token. Check your token and server URL.' };
        }
        await auth.saveToken(token);
        auth.saveServerUrl(canonicalUrl);
        uploader.configure(canonicalUrl, token);

        startWatching();
        initMigrationQueue();

        if (migrationWindow && !migrationWindow.isDestroyed()) {
            migrationWindow.webContents.send('migration:auth-changed', true);
        }

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

ipcMain.handle('auth:sign-out', async () => {
    watcher.stop();
    await auth.clearToken();
    updateTrayMenu('disconnected');

    if (migrationWindow && !migrationWindow.isDestroyed()) {
        migrationWindow.webContents.send('migration:auth-changed', false);
    }

    showLogin();
    return { success: true };
});

ipcMain.handle('settings:show-login', async () => {
    showLogin();
});

ipcMain.handle('settings:get-auto-launch', async () => {
    return app.getLoginItemSettings().openAtLogin;
});

ipcMain.handle('settings:set-auto-launch', async (_event, enabled) => {
    // Explicit path so enabling always records the running executable,
    // rather than whatever process.execPath defaulted to at the time.
    app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath });
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
            title: 'Quework — Upload Complete',
            body: `${result.filename} uploaded successfully.`,
        }).show();

        return { success: true, ...result };
    } catch (err) {
        updateTrayMenu('watching');
        return { success: false, error: err.message };
    }
});

// Cancel file (move to Cancelled/ and dequeue)
ipcMain.handle('upload:cancel', async (_, { filePath }) => {
    try {
        watcher.moveToCancelled(filePath);
        dequeueFile();
        return { success: true };
    } catch (err) {
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

// Server URL (for pre-filling login)
ipcMain.handle('get-server-url', async () => {
    return auth.getServerUrl();
});

// Browser sign-in handoff. This used to be a general "open any URL the
// renderer asks for" channel; it has only ever had one caller, so narrow it
// to that caller and put the server URL through the same allowlist as the
// persisted host.
ipcMain.handle('auth:open-browser-sign-in', async (_event, serverUrl) => {
    const result = auth.validateServerUrl(serverUrl);
    if (!result.ok) return { success: false, error: result.error };
    shell.openExternal(`${result.url}/desktop/authorize`);
    return { success: true };
});
