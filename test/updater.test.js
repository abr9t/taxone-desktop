/**
 * Standalone test for src/updater.js.
 *
 * No test framework — run with `node test/updater.test.js`.
 *
 * Part 1 drives the controller with a fake updater and a fake clock: when
 * checks run, that nothing rejects or throws, what a check does to an
 * already-downloaded update (both directions), and when "Restart to
 * Update" may install.
 *
 * Part 2 runs configureUpdater() on electron-updater's real NsisUpdater
 * (with a stand-in app, no Electron needed) and pins the library behaviour
 * the design leans on: no prerelease even for a -beta build, no downgrade,
 * stagingPercentage: 0 means "not available", assigning `channel` would
 * turn downgrades on, and an install on quit is skipped once
 * autoInstallOnAppQuit is false. A dependency bump that changes any of that
 * fails here.
 */
const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createUpdateController, configureUpdater, FIRST_CHECK_DELAY_MS, CHECK_INTERVAL_MS } = require('../src/updater');

let passed = 0;
function ok(name) {
    console.log(`  ok  ${name}`);
    passed++;
}

const unhandled = [];
process.on('unhandledRejection', err => unhandled.push(err));
const settle = () => new Promise(r => setTimeout(r, 20));

const IDLE = { total: 0, completed: 0, failed: 0, pending: 0, uploading: 0, skipped: 0, queueStatus: 'idle' };

function fakeUpdater() {
    const u = new EventEmitter();
    u.nextCheck = async () => null;
    u.checkForUpdates = () => u.nextCheck();
    u.installs = [];
    u.quitAndInstall = (...args) => { u.installs.push(args); };
    return u;
}

function setup({ state = {}, onChange, notify } = {}) {
    const updater = fakeUpdater();
    const logs = [];
    const notices = [];
    const timers = { timeouts: [], intervals: [] };
    let changes = 0;
    const controller = createUpdateController({
        updater,
        getRestartState: typeof state === 'function' ? state : () => ({ queue: null, unconfirmedFiles: 0, directUploads: 0, ...state }),
        onChange: onChange || (() => { changes++; }),
        notify: notify || (body => notices.push(body)),
        log: m => logs.push(m),
        timers: {
            setTimeout: (fn, ms) => timers.timeouts.push({ fn, ms }),
            setInterval: (fn, ms) => timers.intervals.push({ fn, ms }),
        },
    });
    return { updater, controller, logs, notices, timers, changes: () => changes };
}

const available = version => ({ isUpdateAvailable: true, updateInfo: { version }, downloadPromise: Promise.resolve([]) });
const notAvailable = version => ({ isUpdateAvailable: false, updateInfo: { version } });
const rejectWith = (msg, extra = {}) => async () => { throw Object.assign(new Error(msg), extra); };

async function main() {
    // ─── Part 1: the controller ────────────────────────────────────

    {
        const { updater, logs } = setup();
        assert.strictEqual(updater.autoDownload, true);
        assert.strictEqual(updater.autoInstallOnAppQuit, true);
        assert.strictEqual(updater.disableWebInstaller, true);
        assert.strictEqual(updater.allowPrerelease, false);
        assert.strictEqual(updater.allowDowngrade, false);
        assert.ok(!('channel' in updater), 'channel is never assigned');
        updater.logger.info('Checking for update');
        updater.logger.error('boom');
        assert.deepStrictEqual(logs, ['[updater] Checking for update', '[updater] error: boom']);
        ok('configured: background download, install on quit, no web installer, no prerelease, no downgrade; logs to debug.log');
    }

    {
        const s = setup();
        s.controller.start({ firstLaunchOfVersion: true });
        assert.deepStrictEqual(s.timers.timeouts, [], 'no early check on the first launch of a version');
        assert.deepStrictEqual(s.timers.intervals.map(t => t.ms), [CHECK_INTERVAL_MS]);
        assert.ok(s.logs.some(l => l.includes('First launch of this version')));

        const t = setup();
        t.controller.start({ firstLaunchOfVersion: false });
        assert.deepStrictEqual(t.timers.timeouts.map(x => x.ms), [FIRST_CHECK_DELAY_MS]);
        assert.deepStrictEqual(t.timers.intervals.map(x => x.ms), [CHECK_INTERVAL_MS]);
        assert.strictEqual(FIRST_CHECK_DELAY_MS, 5 * 60 * 1000);
        assert.strictEqual(CHECK_INTERVAL_MS, 6 * 60 * 60 * 1000);

        let checks = 0;
        t.updater.nextCheck = async () => { checks++; return null; };
        await t.timers.timeouts[0].fn();
        await t.timers.intervals[0].fn();
        assert.strictEqual(checks, 2, 'both timers run a check');
        ok('first launch of a version: only the 6-hour check; otherwise also one 5 minutes after launch');
    }

    // Nothing rejects, nothing throws.
    for (const [name, nextCheck] of [
        ['offline', rejectWith('net::ERR_INTERNET_DISCONNECTED')],
        ['rate limited', rejectWith('HttpError: 429 Too Many Requests', { statusCode: 429 })],
        ['a synchronous throw', () => { throw new Error('sync boom'); }],
    ]) {
        const s = setup();
        s.updater.nextCheck = nextCheck;
        const outcome = await s.controller.check('test');
        assert.strictEqual(outcome.ok, false);
        assert.ok(s.logs.some(l => l.includes('[updater] Check (test) failed')), `${name} is logged`);
        assert.strictEqual(s.controller.checking, false, 'not stuck in checking');
        ok(`a check that fails (${name}) resolves, is logged and does not stick`);
    }

    {
        const s = setup();
        s.updater.nextCheck = async () => ({
            isUpdateAvailable: true,
            updateInfo: { version: '1.2.1' },
            downloadPromise: Promise.reject(Object.assign(new Error('sha512 checksum mismatch'), { code: 'ERR_CHECKSUM_MISMATCH' })),
        });
        await s.controller.check('test');
        await settle();
        assert.deepStrictEqual(unhandled, [], 'the download rejection is handled');
        assert.ok(s.logs.some(l => l.includes('Download failed') && l.includes('checksum mismatch')));
        assert.strictEqual(s.controller.downloadedVersion, null, 'nothing offered');
        ok('a failed download (checksum mismatch) is logged, offers nothing and is not an unhandled rejection');
    }

    {
        const s = setup();
        assert.doesNotThrow(() => s.updater.emit('error', new Error('feed unreachable')));
        ok("an 'error' event never throws");
    }

    {
        const s = setup();
        let release;
        s.updater.nextCheck = () => new Promise(r => { release = r; });
        const first = s.controller.check('a');
        const second = await s.controller.check('b');
        assert.deepStrictEqual(second, { ok: false, skipped: true });
        release(null);
        assert.strictEqual((await first).ok, true);
        ok('a check while one is running is skipped');
    }

    {
        const s = setup();
        s.updater.emit('update-downloaded', { version: '1.2.1' });
        assert.strictEqual(s.controller.downloadedVersion, '1.2.1');
        assert.strictEqual(s.updater.autoInstallOnAppQuit, true);
        assert.strictEqual(s.notices.length, 1);
        assert.match(s.notices[0], /1\.2\.1 is ready/);
        assert.ok(s.changes() > 0, 'the tray is rebuilt');
        // electron-updater emits it again on each later check (cached file).
        s.updater.emit('update-downloaded', { version: '1.2.1' });
        assert.strictEqual(s.notices.length, 1, 'one notification per version');
        ok('a download is offered in the tray and announced once');
    }

    {
        const s = setup({ onChange: () => { throw new Error('tray gone'); }, notify: () => { throw new Error('no notifications'); } });
        assert.doesNotThrow(() => s.updater.emit('update-downloaded', { version: '1.2.1' }));
        s.updater.nextCheck = async () => notAvailable('1.2.0');
        assert.strictEqual((await s.controller.check('test')).ok, true);
        assert.ok(s.logs.some(l => l.includes('Tray update failed')) && s.logs.some(l => l.includes('Notification failed')));
        ok('a failing tray or notification is logged and does not break a check or a download');
    }

    // Withdrawal, direction 1: a successful check that no longer offers it.
    for (const [name, result] of [
        ['the release was withdrawn (latest is the older 1.2.0)', notAvailable('1.2.0')],
        ['latest.yml says stagingPercentage: 0', notAvailable('1.2.1')],
        ['a newer 1.2.2 replaced it', available('1.2.2')],
    ]) {
        const s = setup();
        s.updater.emit('update-downloaded', { version: '1.2.1' });
        s.updater.nextCheck = async () => result;
        await s.controller.check('test');
        assert.strictEqual(s.updater.autoInstallOnAppQuit, false, `${name}: not installed on quit`);
        assert.strictEqual(s.controller.downloadedVersion, null, `${name}: out of the tray`);
        assert.ok(s.logs.some(l => l.includes('1.2.1 is no longer offered')));
        assert.deepStrictEqual(s.controller.restartToUpdate(), { ok: false, reasons: ['no update is ready to install'] });
        assert.deepStrictEqual(s.updater.installs, []);
        ok(`withdrawn after a successful check: ${name}`);
    }

    // Withdrawal, direction 2: anything else leaves it installable.
    for (const [name, nextCheck] of [
        ['offline', rejectWith('net::ERR_INTERNET_DISCONNECTED')],
        ['rate limited (429)', rejectWith('HttpError: 429', { statusCode: 429 })],
        ['a certificate failure', rejectWith('net::ERR_CERT_AUTHORITY_INVALID')],
        ['latest.yml missing', rejectWith('Cannot find latest.yml', { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' })],
        ['the same version still offered', async () => available('1.2.1')],
        ['an inactive updater (null)', async () => null],
    ]) {
        const s = setup();
        s.updater.emit('update-downloaded', { version: '1.2.1' });
        s.updater.nextCheck = nextCheck;
        await s.controller.check('test');
        assert.strictEqual(s.updater.autoInstallOnAppQuit, true, `${name}: still installs on quit`);
        assert.strictEqual(s.controller.downloadedVersion, '1.2.1', `${name}: still in the tray`);
        ok(`kept after ${name}`);
    }

    // The same keep cases, asserted on the controller's own state rather than
    // on update-policy's answer: after each, the downloaded update still
    // installs on quit and from the tray, nothing was withdrawn, and the
    // decision was made without throwing — a throw would also leave it
    // armed (the controller catches it), which must not pass for a keep.
    for (const [name, nextCheck] of [
        ['a failed check', rejectWith('net::ERR_NAME_NOT_RESOLVED')],
        ['a null result', async () => null],
        ['a result without isUpdateAvailable', async () => ({ updateInfo: { version: '1.2.0' } })],
        ['a result without a version (not available)', async () => ({ isUpdateAvailable: false, updateInfo: {} })],
        ['a result without a version (available)', async () => ({ isUpdateAvailable: true, updateInfo: { version: '' } })],
        ['a result without updateInfo', async () => ({ isUpdateAvailable: false })],
    ]) {
        const s = setup();
        s.updater.emit('update-downloaded', { version: '1.2.1' });
        s.updater.nextCheck = nextCheck;
        await s.controller.check('test');
        assert.strictEqual(s.updater.autoInstallOnAppQuit, true, `${name}: install on quit still armed`);
        assert.strictEqual(s.controller.downloadedVersion, '1.2.1', `${name}: still offered`);
        assert.ok(!s.logs.some(l => l.includes('no longer offered')), `${name}: nothing withdrawn`);
        assert.ok(!s.logs.some(l => l.includes('Could not apply the check result')), `${name}: decided without throwing`);
        assert.deepStrictEqual(s.controller.restartToUpdate(), { ok: true }, `${name}: Restart to Update still installs`);
        assert.deepStrictEqual(s.updater.installs, [[true, true]]);
        ok(`controller: ${name} leaves the downloaded update armed and installable`);
    }

    {
        const s = setup();
        s.updater.emit('update-downloaded', { version: '1.2.1' });
        s.updater.nextCheck = async () => notAvailable('1.2.0');
        await s.controller.check('test');
        assert.strictEqual(s.updater.autoInstallOnAppQuit, false);
        s.updater.emit('update-downloaded', { version: '1.2.1' });
        assert.strictEqual(s.updater.autoInstallOnAppQuit, true, 're-armed');
        assert.strictEqual(s.controller.downloadedVersion, '1.2.1');
        ok('offered again after a withdrawal: installable on quit again');
    }

    // Restart to Update.
    {
        const s = setup();
        assert.deepStrictEqual(s.controller.restartToUpdate(), { ok: false, reasons: ['no update is ready to install'] });
        assert.deepStrictEqual(s.updater.installs, []);
        ok('Restart to Update with nothing downloaded does nothing');
    }

    for (const [name, state] of [
        ['a pending queue file', { queue: { getStats: () => ({ ...IDLE, pending: 1, queueStatus: 'paused' }), activeUploads: 0 } }],
        ['a file uploading', { queue: { getStats: () => ({ ...IDLE, uploading: 1, queueStatus: 'running' }), activeUploads: 1 } }],
        ['an unconfirmed watched file', { unconfirmedFiles: 1 }],
        ['a confirm-window upload', { directUploads: 1 }],
        ['a state that cannot be read', () => { throw new Error('boom'); }],
    ]) {
        const s = setup({ state });
        s.updater.emit('update-downloaded', { version: '1.2.1' });
        const r = s.controller.restartToUpdate();
        assert.strictEqual(r.ok, false, name);
        assert.ok(r.reasons.length > 0);
        assert.deepStrictEqual(s.updater.installs, [], `${name}: no install`);
        assert.ok(s.logs.some(l => l.includes('Restart to install 1.2.1 refused')));
        assert.strictEqual(s.controller.downloadedVersion, '1.2.1', 'still ready');
        ok(`Restart to Update refuses with ${name}`);
    }

    {
        const s = setup({ state: { queue: { getStats: () => ({ ...IDLE, completed: 4, failed: 1 }), activeUploads: 0 } } });
        s.updater.emit('update-downloaded', { version: '1.2.1' });
        assert.deepStrictEqual(s.controller.restartToUpdate(), { ok: true });
        assert.deepStrictEqual(s.updater.installs, [[true, true]], 'silent install, then relaunch');
        ok('Restart to Update with nothing in flight installs silently and relaunches');
    }

    {
        const s = setup();
        s.updater.quitAndInstall = () => { throw new Error('installer missing'); };
        s.updater.emit('update-downloaded', { version: '1.2.1' });
        const r = s.controller.restartToUpdate();
        assert.strictEqual(r.ok, false);
        assert.ok(s.logs.some(l => l.includes('Could not start the installer: installer missing')));
        ok('an installer that will not start is logged, not thrown');
    }

    // ─── Part 2: the real NsisUpdater ──────────────────────────────

    const { NsisUpdater } = require('electron-updater');
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'quework-updater-test-'));
    function realUpdater(version) {
        const app = {
            version,
            name: 'Quework Desktop',
            isPackaged: true,
            appUpdateConfigPath: path.join(userData, 'app-update.yml'),
            userDataPath: userData,
            baseCachePath: userData,
            quitHandlers: [],
            whenReady: () => Promise.resolve(),
            quit() {}, relaunch() {},
            onQuit(fn) { this.quitHandlers.push(fn); },
        };
        const u = new NsisUpdater(null, app);
        u.logger = null;
        u.testApp = app;
        return u;
    }
    const silent = () => {};

    {
        const u = realUpdater('1.3.0-beta.1');
        assert.strictEqual(u.allowPrerelease, true, 'precondition: electron-updater enables prerelease for a -beta build');
        configureUpdater(u, silent);
        assert.strictEqual(u.allowPrerelease, false);
        ok('real NsisUpdater: a -beta build is held to releases');
    }

    {
        const u = realUpdater('1.2.0');
        configureUpdater(u, silent);
        assert.strictEqual(u.channel, null, 'no channel');
        assert.strictEqual(await u.isUpdateAvailable({ version: '1.2.1', files: [] }), true);
        assert.strictEqual(await u.isUpdateAvailable({ version: '1.2.0', files: [] }), false);
        assert.strictEqual(await u.isUpdateAvailable({ version: '1.1.5', files: [] }), false, 'no downgrade');
        assert.strictEqual(await u.isUpdateAvailable({ version: '1.2.1', files: [], stagingPercentage: 0 }), false,
            'stagingPercentage: 0 is the kill switch');
        assert.strictEqual(await u.isUpdateAvailable({ version: '1.2.1', files: [], stagingPercentage: 100 }), true);
        ok('real NsisUpdater: newer only, never older; stagingPercentage: 0 offers nothing');
    }

    {
        // Why configureUpdater never assigns `channel`.
        const u = realUpdater('1.2.0');
        configureUpdater(u, silent);
        u.channel = 'latest';
        assert.strictEqual(u.allowDowngrade, true);
        assert.strictEqual(await u.isUpdateAvailable({ version: '1.1.5', files: [] }), true);
        ok('real NsisUpdater: assigning channel would turn downgrades on (so we never do)');
    }

    {
        // The withdrawal works by switching autoInstallOnAppQuit off; the
        // quit handler reads it at quit time.
        const u = realUpdater('1.2.0');
        configureUpdater(u, silent);
        const installs = [];
        u.install = (...args) => { installs.push(args); return true; };
        u.addQuitHandler();
        assert.strictEqual(u.testApp.quitHandlers.length, 1);
        u.autoInstallOnAppQuit = false;
        u.testApp.quitHandlers[0](0);
        assert.deepStrictEqual(installs, [], 'withdrawn: nothing installs on quit');
        u.autoInstallOnAppQuit = true;
        u.testApp.quitHandlers[0](0);
        assert.deepStrictEqual(installs, [[true, false]], 'armed: silent install on quit, no relaunch');
        ok('real NsisUpdater: install on quit follows autoInstallOnAppQuit at quit time; silent, no relaunch');
    }

    {
        // electron-updater keeps a random id beside the app's settings, for
        // staged rollouts. It adds a file to %APPDATA%\TaxOne Desktop and
        // changes nothing else there.
        const u = realUpdater('1.2.0');
        const before = fs.readdirSync(userData).filter(f => f !== '.updaterId');
        await u.isUpdateAvailable({ version: '1.2.1', files: [], stagingPercentage: 50 });
        const after = fs.readdirSync(userData);
        assert.ok(after.includes('.updaterId'));
        assert.deepStrictEqual(after.filter(f => f !== '.updaterId'), before);
        ok('real NsisUpdater: the only thing it writes in userData is .updaterId');
    }

    fs.rmSync(userData, { recursive: true, force: true });
    await settle();
    assert.deepStrictEqual(unhandled, [], 'no unhandled rejections anywhere above');
}

main().then(() => {
    console.log('');
    console.log(`${passed} passed`);
}).catch(err => {
    console.error(err);
    process.exit(1);
});
