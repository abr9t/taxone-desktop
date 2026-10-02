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
 * Automatic updates are the exception, on purpose: they go to GitHub, never
 * to the stored host, and must start for a signed-out install too — that is
 * the install a fixed release may be for.
 * A valid-host launch is run through the same harness as the control, so
 * every "did not happen" above is shown to be observable.
 *
 * The last section uses the same harness for the update items in the tray:
 * "Restart to Update" must refuse while main.js's own state says work is in
 * flight (queue, unconfirmed watched files, confirm-window uploads).
 */
const assert = require('assert');
const { EventEmitter } = require('events');
const path = require('path');
const { installStubs, recordingAxios } = require('./helpers/stubs');

const SRC = path.join(__dirname, '..', 'src');
const NEW = 'https://caputa.quework.app';

// What the harness can see.
let seen;
function freshSeen() {
    return {
        windows: [], queues: 0, autoResumes: 0, watchStarts: 0, intervals: [], notifications: [], updateChecks: 0,
        menu: null, dialogs: [], installs: [], onFile: null,
        order: [],
    };
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
        getVersion: () => '1.2.0',
    },
    BrowserWindow: class {
        constructor(opts) { this.opts = opts; this.webContents = { on() {}, send() {} }; seen.windows.push(this); }
        loadFile(f) { this.file = path.basename(f); }
        on() {} setMenuBarVisibility() {} focus() {} close() {}
        isDestroyed() { return false; }
        static getFocusedWindow() { return null; }
    },
    Tray: class { constructor() { seen.order.push('tray'); } setToolTip() {} on() {} popUpContextMenu() {} },
    Menu: { buildFromTemplate: t => { seen.menu = t; return t; } },
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } },
    nativeImage: { createFromPath: () => ({}), createEmpty: () => ({}) },
    dialog: {
        showMessageBox: async o => { seen.dialogs.push(o); return { response: 0 }; },
        showErrorBox() {}, showOpenDialog: async () => ({ canceled: true }),
    },
    shell: { openExternal() {}, openPath() {} },
    Notification: class { constructor(o) { seen.notifications.push(o); } show() {} },
};

// ─── Stand-ins for the modules that would touch disk, registry or chokidar
const watcherStub = {
    migrateLegacyWatchPath: () => false,
    getWatchPath: () => 'C:/fake/QueworkWatch',
    start: cb => { seen.watchStarts++; seen.onFile = cb; },
    stop() {}, getMoveAfterUpload: () => false,
    setWatchPath() {}, setMoveAfterUpload() {}, moveToUploaded() {}, moveToCancelled() {},
};
let queueStats = {};
class FakeMigrationQueue {
    constructor() { seen.queues++; this.files = []; this.activeUploads = 0; }
    autoResume() { seen.autoResumes++; }
    getStats() { return { failed: 0, pending: 0, uploading: 0, queueStatus: 'idle', ...queueStats }; }
    flushSave() {}
}

// electron-updater's autoUpdater, recording instead of reaching GitHub. A
// fresh one per launch, so one launch's listeners never see the next's events.
let autoUpdater;
let updaterLoadError = null;
function freshAutoUpdater() {
    const u = new EventEmitter();
    u.checkForUpdates = async () => { seen.updateChecks++; return null; };
    u.quitAndInstall = (...args) => { seen.installs.push(args); };
    return u;
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
        'electron-updater': {
            get autoUpdater() {
                seen.order.push('updaterLoaded');
                if (updaterLoadError) throw updaterLoadError;
                return autoUpdater;
            },
        },
    },
});

// Store reads and the lastLaunchedVersion write go into seen.order, so the
// launch sequence can be checked: startUpdates() records the version first
// thing, and resolveStartup() starts with a read of serverUrl.
const mapHas = stubs.store.has;
stubs.store.has = function (key) {
    if (seen) seen.order.push(`read:${key}`);
    return mapHas.call(this, key);
};
const mapSet = stubs.store.set;
stubs.store.set = function (key, val) {
    if (seen && key === 'lastLaunchedVersion') seen.order.push('startUpdates');
    return mapSet.call(this, key, val);
};

// tray < startUpdates < host check < electron-updater loaded. The host check
// is the first serverUrl read after the tray exists (the migrations before it
// read serverUrl too).
function assertLaunchOrder(when) {
    const o = seen.order;
    const tray = o.indexOf('tray');
    const start = o.indexOf('startUpdates');
    const hostCheck = o.indexOf('read:serverUrl', tray);
    const loaded = o.indexOf('updaterLoaded');
    for (const [name, i] of [['tray', tray], ['startUpdates', start], ['host check', hostCheck], ['electron-updater load', loaded]]) {
        assert.ok(i !== -1, `${when}: no ${name} in ${JSON.stringify(o)}`);
    }
    assert.ok(tray < start, `${when}: startUpdates ran before the tray existed`);
    assert.ok(start < hostCheck, `${when}: startUpdates ran after the host check started`);
    assert.ok(hostCheck < loaded, `${when}: electron-updater was loaded before the host check started`);
}

const realSetInterval = global.setInterval;
global.setInterval = (fn, ms) => { seen.intervals.push(ms); return { unref() {} }; };

const tick = () => new Promise(r => setTimeout(r, 50));

const RECONNECT_MS = 30000;
const { CHECK_INTERVAL_MS } = require('../src/updater');
const reconnectLoops = () => seen.intervals.filter(ms => ms === RECONNECT_MS).length;
function assertUpdatesStarted(when) {
    assert.ok(seen.intervals.includes(CHECK_INTERVAL_MS), `${when}: the periodic update check is scheduled`);
    assert.ok(stubs.logs.some(l => l.includes('[updater] Started for 1.2.0')), `${when}: updates started`);
    assert.ok(!stubs.logs.some(l => l.includes('[updater] Not started')), `${when}: no updater failure logged`);
    // A fresh store is a first launch of this version: nothing checks early.
    assert.strictEqual(seen.updateChecks, 0, `${when}: no check at launch`);
}

async function launch({ serverUrl, token }) {
    for (const key of Object.keys(require.cache)) {
        if (key.startsWith(SRC)) delete require.cache[key];
    }
    stubs.store.clear();
    stubs.keychain.clear();
    stubs.logs.length = 0;
    rec.calls.length = 0;
    seen = freshSeen();
    autoUpdater = freshAutoUpdater();
    queueStats = {};
    rec.control.gate = null;
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
    assert.strictEqual(reconnectLoops(), 1);
    assertUpdatesStarted('valid host');
    assertLaunchOrder('valid host');
    assert.ok(rec.calls.some(c => c.baseURL === NEW), 'the token check went to the stored host');
    assert.strictEqual(await handlers['auth:get-startup-notice'](), null);
    ok('control: a valid host configures the client, starts the watcher, the queue and the 30s loop');
    ok('launch order: tray, then startUpdates, then the host check, and only then electron-updater is loaded');

    // ─── A rejected host starts none of it ─────────────────────────
    for (const bad of ['https://evil.example', 'https://caputa.quework.app.evil.com']) {
        await launch({ serverUrl: bad, token: 'tok' });
        assert.deepStrictEqual(seen.windows.map(w => w.file), ['login.html'], 'only the sign-in window opens');
        assert.deepStrictEqual(rec.calls, [], 'no API client built, nothing sent');
        assert.strictEqual(seen.queues, 0, 'no MigrationQueue');
        assert.strictEqual(seen.autoResumes, 0, 'no autoResume');
        assert.strictEqual(reconnectLoops(), 0, 'no 30s reconnect loop');
        assertUpdatesStarted(`stored ${bad}`);
        assertLaunchOrder(`stored ${bad}`);
        assert.strictEqual(seen.watchStarts, 0, 'no watcher');
        assert.strictEqual(stubs.store.has('serverUrl'), false, 'host cleared');
        assert.strictEqual(stubs.store.has('_token'), false, 'fallback token cleared');
        assert.strictEqual(stubs.keychain.size, 0, 'keychain token cleared');
        const notice = await handlers['auth:get-startup-notice']();
        assert.ok(notice && notice.includes(new URL(bad).hostname), `the sign-in window names the host: ${notice}`);
        assert.ok(stubs.logs.some(l => l.includes('[startup] Stored server URL rejected')), 'logged');
        ok(`stored ${bad}: sign-in window with notice; no client, queue, loop, watcher or request; updates still start`);

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
        assert.strictEqual(seen.queues + seen.watchStarts + reconnectLoops(), 0, 'nothing started');
        assertUpdatesStarted('startup threw');
        assert.strictEqual(stubs.store.get('serverUrl'), NEW, 'host kept');
        assert.strictEqual(stubs.store.get('_token'), 'tok', '_token kept');
        assert.strictEqual(stubs.keychain.get('TaxOneDesktop/api-token'), 'tok', 'keychain token kept');
        ok("getToken's flag read throws: sign-in window with the error, nothing cleared, nothing sent; updates still start");
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
        assert.strictEqual(reconnectLoops(), 1);
        assert.strictEqual(await handlers['auth:get-startup-notice'](), null, 'the notice is cleared');
        ok('signing in with a valid host starts the watcher, queue and loop, and clears the notice');
    }

    // ─── An updater that will not load costs updates, nothing else ─
    {
        updaterLoadError = new Error("Cannot find module 'electron-updater'");
        try {
            await launch({ serverUrl: NEW, token: 'tok' });
        } finally {
            updaterLoadError = null;
        }
        assert.deepStrictEqual(seen.windows.map(w => w.file), ['migration.html']);
        assert.strictEqual(seen.queues, 1);
        assert.strictEqual(seen.watchStarts, 1);
        assert.strictEqual(reconnectLoops(), 1);
        assert.ok(stubs.logs.some(l => l.includes("[updater] Not started: Cannot find module 'electron-updater'")), 'logged');
        assert.ok(!seen.intervals.includes(CHECK_INTERVAL_MS), 'no update checks scheduled');
        assert.ok(!(seen.menu || []).some(i => /Update/.test(i.label || '')), 'no update items in the tray');
        ok('electron-updater failing to load is logged; the window, watcher, queue and loop all start as normal');
    }

    // ─── Updates in the tray ───────────────────────────────────────
    {
        await launch({ serverUrl: NEW, token: 'tok' });
        const item = prefix => (seen.menu || []).find(i => typeof i.label === 'string' && i.label.startsWith(prefix));
        assert.ok(item('Check for Updates'), 'Check for Updates is in the tray');
        assert.strictEqual(item('Restart to Update'), undefined, 'nothing to restart for yet');

        item('Check for Updates').click();
        await tick();
        assert.strictEqual(seen.updateChecks, 1, 'the tray item checks');
        assert.ok(seen.notifications.some(n => /1\.2\.0 is up to date/.test(n.body)), 'and says the result');
        ok('Check for Updates checks on demand and reports the result');

        autoUpdater.emit('update-downloaded', { version: '1.2.1' });
        assert.ok(item('Restart to Update (1.2.1)'), 'offered once downloaded');
        const restart = async () => { item('Restart to Update').click(); await tick(); };

        queueStats = { pending: 1, queueStatus: 'paused' };
        await restart();
        assert.deepStrictEqual(seen.installs, [], 'not with a pending queue file');
        assert.match(seen.dialogs.pop().detail, /1 file\(s\) waiting in the upload queue/);
        queueStats = {};

        seen.onFile({ fileName: 'a.pdf', filePath: 'C:/fake/QueworkWatch/a.pdf' });
        await restart();
        assert.deepStrictEqual(seen.installs, [], 'not with an unconfirmed watched file');
        assert.match(seen.dialogs.pop().detail, /1 watched file\(s\) waiting for you to confirm/);
        await handlers['queue:next']();

        let release;
        rec.control.gate = new Promise(r => { release = r; });
        const upload = handlers['upload:file']({}, { filePath: __filename, clientId: 1, folderPath: '', filename: 'x.pdf' });
        await tick();
        await restart();
        assert.deepStrictEqual(seen.installs, [], 'not with a confirm-window upload in flight');
        assert.match(seen.dialogs.pop().detail, /1 file\(s\) uploading from the confirm window/);
        release();
        await upload;
        rec.control.gate = null;

        await restart();
        assert.deepStrictEqual(seen.installs, [[true, true]], 'installs once nothing is in flight');
        assert.deepStrictEqual(seen.dialogs, []);
        ok("Restart to Update refuses for main.js's queue, unconfirmed files and confirm-window uploads, then installs");
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
