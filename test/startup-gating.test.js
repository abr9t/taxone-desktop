/**
 * Loads the real src/main.js against a fake Electron and checks what runs
 * at launch when the stored host is rejected.
 *
 * No test framework — run with `node test/startup-gating.test.js`.
 *
 * When enforcePersistedServerUrl() rejects the stored host, nothing may send
 * a request or start an upload until a valid host is stored again:
 *   - uploader.configure        -> no API client is built
 *   - initMigrationQueue        -> no MigrationQueue, so no autoResume
 *   - the 30s reconnect loop    -> never registered (it lives in initMigrationQueue)
 *   - the watcher               -> never started, so nothing is enqueued
 *   - IPC (search, folders, upload) -> answered without a request
 * A valid-host launch is run through the same harness as the control, so
 * every "did not happen" above is shown to be observable.
 */
const assert = require('assert');
const path = require('path');
const { installStubs, recordingAxios } = require('./helpers/stubs');

const SRC = path.join(__dirname, '..', 'src');
const NEW = 'https://caputa.quework.app';

// What the harness can see.
let seen;
function freshSeen() {
    return { windows: [], queues: 0, autoResumes: 0, watchStarts: 0, intervals: [], notifications: [] };
}

// ─── Fake Electron ────────────────────────────────────────────────
let readyResolve;
let handlers;
let appListeners;
const electron = {
    app: {
        isPackaged: true,
        getPath: n => (n === 'appData' ? 'C:/fake/AppData/Roaming' : 'C:/fake/AppData/Roaming/TaxOne Desktop'),
        setPath() {}, setAsDefaultProtocolClient() {}, requestSingleInstanceLock: () => true,
        quit() {}, on: (ev, fn) => { appListeners[ev] = fn; }, setName() {}, setAppUserModelId() {},
        whenReady: () => new Promise(r => { readyResolve = r; }),
        setLoginItemSettings() {}, getLoginItemSettings: () => ({ openAtLogin: false, launchItems: [] }),
    },
    BrowserWindow: class {
        constructor(opts) { this.opts = opts; this.webContents = { on() {}, send() {} }; seen.windows.push(this); }
        loadFile(f) { this.file = path.basename(f); }
        on() {} setMenuBarVisibility() {} focus() {} close() {}
        isDestroyed() { return false; }
        static getFocusedWindow() { return null; }
    },
    Tray: class { setToolTip() {} on() {} popUpContextMenu() {} },
    Menu: { buildFromTemplate: t => t },
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } },
    nativeImage: { createFromPath: () => ({}), createEmpty: () => ({}) },
    dialog: { showMessageBox: async () => ({ response: 0 }), showErrorBox() {}, showOpenDialog: async () => ({ canceled: true }) },
    shell: { openExternal() {}, openPath() {} },
    Notification: class { constructor(o) { seen.notifications.push(o); } show() {} },
};

// ─── Stand-ins for the modules that would touch disk, registry or chokidar
const watcherStub = {
    migrateLegacyWatchPath: () => false,
    getWatchPath: () => 'C:/fake/QueworkWatch',
    start: () => { seen.watchStarts++; },
    stop() {}, getMoveAfterUpload: () => false,
    setWatchPath() {}, setMoveAfterUpload() {}, moveToUploaded() {}, moveToCancelled() {},
};
class FakeMigrationQueue {
    constructor() { seen.queues++; this.files = []; }
    autoResume() { seen.autoResumes++; }
    getStats() { return { failed: 0, queueStatus: 'idle' }; }
    flushSave() {}
}

const rec = recordingAxios();
const stubs = installStubs({
    keytar: true,
    axios: rec.module,
    electron,
    modules: {
        './watcher': watcherStub,
        './migration': { MigrationQueue: FakeMigrationQueue, MAX_FILE_SIZE: 100 * 1024 * 1024 },
        './auto-launch': { reconcileAutoLaunch() {}, AUTO_LAUNCH_ENTRY_NAME: 'com.taxone.desktop' },
    },
});

const realSetInterval = global.setInterval;
global.setInterval = (fn, ms) => { seen.intervals.push(ms); return { unref() {} }; };

const tick = () => new Promise(r => setTimeout(r, 50));

async function launch({ serverUrl, token }) {
    for (const key of Object.keys(require.cache)) {
        if (key.startsWith(SRC)) delete require.cache[key];
    }
    stubs.store.clear();
    stubs.keychain.clear();
    stubs.logs.length = 0;
    rec.calls.length = 0;
    seen = freshSeen();
    handlers = {};
    appListeners = {};
    if (serverUrl) stubs.store.set('serverUrl', serverUrl);
    if (token) {
        stubs.store.set('_token', token);
        stubs.keychain.set('TaxOneDesktop/api-token', token);
    }

    require(path.join(SRC, 'main.js'));
    readyResolve();
    await tick();
}

let passed = 0;
function ok(name) {
    console.log(`  ok  ${name}`);
    passed++;
}

async function main() {
    // ─── Control: a valid host starts everything ───────────────────
    await launch({ serverUrl: NEW, token: 'tok' });
    assert.deepStrictEqual(seen.windows.map(w => w.file), ['migration.html']);
    assert.strictEqual(seen.queues, 1);
    assert.strictEqual(seen.autoResumes, 1);
    assert.strictEqual(seen.watchStarts, 1);
    assert.deepStrictEqual(seen.intervals, [30000]);
    assert.ok(rec.calls.some(c => c.baseURL === NEW), 'the token check went to the stored host');
    assert.strictEqual(await handlers['auth:get-startup-notice'](), null);
    ok('control: a valid host configures the client, starts the watcher, the queue and the 30s loop');

    // ─── A rejected host starts none of it ─────────────────────────
    for (const bad of ['https://evil.example', 'https://caputa.quework.app.evil.com']) {
        await launch({ serverUrl: bad, token: 'tok' });
        assert.deepStrictEqual(seen.windows.map(w => w.file), ['login.html'], 'only the sign-in window opens');
        assert.deepStrictEqual(rec.calls, [], 'no API client built, nothing sent');
        assert.strictEqual(seen.queues, 0, 'no MigrationQueue');
        assert.strictEqual(seen.autoResumes, 0, 'no autoResume');
        assert.deepStrictEqual(seen.intervals, [], 'no 30s reconnect loop');
        assert.strictEqual(seen.watchStarts, 0, 'no watcher');
        assert.strictEqual(stubs.store.has('serverUrl'), false, 'host cleared');
        assert.strictEqual(stubs.store.has('_token'), false, 'fallback token cleared');
        assert.strictEqual(stubs.keychain.size, 0, 'keychain token cleared');
        const notice = await handlers['auth:get-startup-notice']();
        assert.ok(notice && notice.includes(new URL(bad).hostname), `the sign-in window names the host: ${notice}`);
        assert.ok(stubs.logs.some(l => l.includes('[startup] Stored server URL rejected')), 'logged');
        ok(`stored ${bad}: sign-in window with notice; no client, queue, loop, watcher or request`);

        // The IPC handlers registered at load are still reachable from a window.
        const search = await handlers['clients:search']({}, 'smith');
        assert.ok(search.error, 'search answers with an error');
        const folders = await handlers['clients:folders']({}, 1);
        assert.deepStrictEqual(folders.folders, []);
        const upload = await handlers['upload:file']({}, { filePath: __filename, clientId: 1, folderPath: '', filename: 'x.pdf' });
        assert.strictEqual(upload.success, false, 'upload refused');
        assert.strictEqual(handlers['migration:start'], undefined, 'no queue IPC registered');
        assert.deepStrictEqual(rec.calls, [], 'still nothing sent');
        ok(`stored ${bad}: search, folders and upload IPC answer without a request`);

        // Settings > Save is not gated on a valid host: it does start the
        // watcher. What keeps that harmless is the API side — a watched file
        // can only reach upload:file, which refuses without a request.
        const saved = await handlers['settings:save']({}, { watchPath: 'C:/fake/QueworkWatch', moveAfterUpload: true });
        assert.deepStrictEqual(saved, { success: true });
        assert.strictEqual(seen.watchStarts, 1, 'Settings > Save starts the watcher even signed out');
        const again = await handlers['upload:file']({}, { filePath: __filename, clientId: 1, folderPath: '', filename: 'x.pdf' });
        assert.strictEqual(again.success, false);
        assert.ok(/Not authenticated/.test(again.error), `refused as not authenticated: ${again.error}`);
        assert.ok((await handlers['clients:search']({}, 'smith')).error);
        assert.deepStrictEqual(rec.calls, [], 'a running watcher still sends nothing');
        ok(`stored ${bad}: Settings > Save starts the watcher, but upload and search still send nothing`);
    }

    // ─── A throw after the host check ──────────────────────────────
    {
        // getToken()'s read of the revocation flag throws. That is past
        // resolveStartup's own catch, so only the whenReady wrapper stands
        // between it and a startup with no window.
        // The stub store asks has() before get(), so the read is made to
        // throw at has() — as electron-store's own get() would.
        const realHas = stubs.store.has;
        let flagReads = 0;
        stubs.store.has = function (key) {
            if (key === '_keychainTokenRevoked') {
                flagReads++;
                throw new Error('EIO: settings file unreadable');
            }
            return realHas.call(this, key);
        };
        try {
            await launch({ serverUrl: NEW, token: 'tok' });
        } finally {
            stubs.store.has = realHas;
        }
        assert.ok(flagReads >= 1, 'precondition: the flag read really threw');
        assert.deepStrictEqual(seen.windows.map(w => w.file), ['login.html'], 'the sign-in window opens');
        const notice = await handlers['auth:get-startup-notice']();
        assert.ok(notice && notice.includes('EIO') && notice.includes('Nothing was removed'), `the notice carries the error: ${notice}`);
        assert.ok(stubs.logs.some(l => l.includes('[startup] Startup check failed') && l.includes('EIO')), 'logged');
        assert.deepStrictEqual(rec.calls, [], 'nothing sent');
        assert.strictEqual(seen.queues + seen.watchStarts + seen.intervals.length, 0, 'nothing started');
        assert.strictEqual(stubs.store.get('serverUrl'), NEW, 'host kept');
        assert.strictEqual(stubs.store.get('_token'), 'tok', '_token kept');
        assert.strictEqual(stubs.keychain.get('TaxOneDesktop/api-token'), 'tok', 'keychain token kept');
        ok("getToken's flag read throws: sign-in window with the error, nothing cleared, nothing sent");
    }

    // ─── A keychain that will not let go of the token ──────────────
    {
        const keytar = require('keytar');
        const origDelete = keytar.deletePassword;
        keytar.deletePassword = async () => { throw new Error('keychain locked'); };
        try {
            await launch({ serverUrl: 'https://evil.example', token: 'tok' });
        } finally {
            keytar.deletePassword = origDelete;
        }
        assert.strictEqual(stubs.keychain.size, 1, 'precondition: the keychain delete really failed');
        assert.deepStrictEqual(seen.windows.map(w => w.file), ['login.html']);

        // A connect link afterwards must not find a signed-in user: it opens
        // File Upload for one, the sign-in window otherwise.
        appListeners['second-instance']({}, ['Quework Desktop.exe', 'taxone-desktop://connect']);
        await tick();
        assert.deepStrictEqual(seen.windows.map(w => w.file), ['login.html'],
            'the link must not open File Upload on the strength of the revoked keychain token');
        assert.deepStrictEqual(rec.calls, [], 'nothing sent');
        ok('keychain delete fails: a later connect link still finds the user signed out');
    }

    // ─── Until a valid host is stored again ────────────────────────
    {
        const r = await handlers['auth:login']({}, { serverUrl: NEW, token: 'new-tok' });
        assert.deepStrictEqual(r, { success: true });
        assert.strictEqual(stubs.store.get('serverUrl'), NEW);
        assert.strictEqual(seen.queues, 1, 'the queue starts after a valid sign-in');
        assert.strictEqual(seen.watchStarts, 1);
        assert.deepStrictEqual(seen.intervals, [30000]);
        assert.strictEqual(await handlers['auth:get-startup-notice'](), null, 'the notice is cleared');
        ok('signing in with a valid host starts the watcher, queue and loop, and clears the notice');
    }
}

main().then(() => {
    global.setInterval = realSetInterval;
    stubs.restore();
    console.log('');
    console.log(`${passed} passed`);
    process.exit(0);
}).catch(err => {
    console.error(err);
    process.exit(1);
});
