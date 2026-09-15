/**
 * Standalone smoke test for watcher.migrateLegacyWatchPath().
 *
 * No test framework — run with `node test/migrate-watch-path.test.js`.
 * electron-store, chokidar and electron are stubbed via Module._load so
 * watcher.js can be required outside an Electron runtime, and the home
 * directory is redirected into a temp folder so the fs.existsSync() probe
 * for ~/TaxoneWatch is exercised for real rather than mocked away.
 */
const Module = require('module');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'watchmig-'));
os.homedir = () => HOME;

const LEGACY = path.join(HOME, 'TaxoneWatch');
const FRESH = path.join(HOME, 'QueworkWatch');

const backing = new Map();
class MockStore {
    get(key, def) { return backing.has(key) ? backing.get(key) : def; }
    set(key, val) { backing.set(key, val); }
    delete(key) { backing.delete(key); }
}

const origLoad = Module._load;
Module._load = function (request, ...rest) {
    if (request === 'electron-store') return MockStore;
    if (request === 'chokidar') return { watch: () => { throw new Error('not used in this test'); } };
    return origLoad.call(this, request, ...rest);
};

const watcher = require('../src/watcher');

let passed = 0;
function scenario(name, { legacyFolderExists, seed, expectWatchPath, expectReturn }) {
    backing.clear();
    fs.rmSync(LEGACY, { recursive: true, force: true });
    if (legacyFolderExists) fs.mkdirSync(LEGACY, { recursive: true });
    if (seed && 'watchPath' in seed) backing.set('watchPath', seed.watchPath);
    if (seed && seed._watchPathMigratedV1) backing.set('_watchPathMigratedV1', true);

    const ret = watcher.migrateLegacyWatchPath();

    assert.strictEqual(ret, expectReturn, `${name}: return value`);
    assert.strictEqual(watcher.getWatchPath(), expectWatchPath, `${name}: watchPath`);
    assert.strictEqual(backing.get('_watchPathMigratedV1'), true, `${name}: guard flag set`);
    console.log(`  ok  ${name}`);
    passed++;
}

scenario('upgraded install that never opened Settings keeps its legacy folder', {
    legacyFolderExists: true,
    seed: {},
    expectWatchPath: LEGACY, expectReturn: true,
});

scenario('fresh install with no legacy folder gets the new default', {
    legacyFolderExists: false,
    seed: {},
    expectWatchPath: FRESH, expectReturn: false,
});

scenario('an explicitly chosen watch folder is never overwritten', {
    legacyFolderExists: true,
    seed: { watchPath: path.join(HOME, 'Somewhere Else') },
    expectWatchPath: path.join(HOME, 'Somewhere Else'), expectReturn: false,
});

scenario('an explicit choice of the NEW default is not dragged back', {
    legacyFolderExists: true,
    seed: { watchPath: FRESH },
    expectWatchPath: FRESH, expectReturn: false,
});

scenario('guard makes it a no-op on the second run', {
    legacyFolderExists: true,
    seed: { _watchPathMigratedV1: true },
    expectWatchPath: FRESH, expectReturn: false,
});

// Running twice in one process must be a no-op the second time, whatever the
// first run decided — the guard is written by the first call, not seeded.
backing.clear();
fs.mkdirSync(LEGACY, { recursive: true });
assert.strictEqual(watcher.migrateLegacyWatchPath(), true, 'run-twice: first run migrates');
assert.strictEqual(watcher.migrateLegacyWatchPath(), false, 'run-twice: second run is a no-op');
assert.strictEqual(watcher.getWatchPath(), LEGACY, 'run-twice: watchPath is stable');
console.log('  ok  running it twice migrates once and then stops');
passed++;

Module._load = origLoad;
fs.rmSync(HOME, { recursive: true, force: true });
console.log(`
${passed} passed`);
