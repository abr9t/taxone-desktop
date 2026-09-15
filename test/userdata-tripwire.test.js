/**
 * Standalone smoke test for the userData tripwire at the top of auth.js.
 *
 * No test framework — run with `node test/userdata-tripwire.test.js`.
 * The tripwire runs at module load, so each scenario clears auth.js from the
 * require cache and loads it again against a different electron stub.
 */
const Module = require('module');
const assert = require('assert');

const PINNED = 'C:/Users/x/AppData/Roaming/TaxOne Desktop';
const UNPINNED = 'C:/Users/x/AppData/Roaming/Quework Desktop';

class MockStore {
    get(key, def) { return def; }
    set() {}
    delete() {}
}

let electronStub = null;   // null => require('electron') throws, as outside Electron
let recorded = [];

const origLoad = Module._load;
Module._load = function (request, ...rest) {
    if (request === 'electron-store') return MockStore;
    if (request === 'keytar') throw new Error('keytar stubbed off for test');
    if (request === 'electron') {
        if (electronStub === null) throw new Error('electron not available');
        return electronStub;
    }
    if (request === './debug-log') {
        return {
            debugLog: (...a) => recorded.push(a.join(' ')),
            debugError: (...a) => recorded.push(a.join(' ')),
        };
    }
    return origLoad.call(this, request, ...rest);
};

const AUTH = require.resolve('../src/auth');

function loadAuth({ userDataDir, isPackaged }) {
    recorded = [];
    electronStub = userDataDir === null
        ? null
        : { app: { getPath: () => userDataDir, isPackaged } };
    delete require.cache[AUTH];
    return require(AUTH);
}

let passed = 0;

// ─── The negative path: the pin was bypassed ──────────────────────
{
    loadAuth({ userDataDir: UNPINNED, isPackaged: true });
    assert.strictEqual(recorded.length, 1, 'a packaged bypass records exactly one line');
    assert.ok(recorded[0].includes('Quework Desktop'), 'the record names what it actually got');
    assert.ok(recorded[0].includes('TaxOne Desktop'), 'and what it expected');
    console.log('  ok  packaged + unpinned userData records the bypass without throwing');
    passed++;
}

{
    assert.throws(
        () => loadAuth({ userDataDir: UNPINNED, isPackaged: false }),
        /userData resolved to/,
        'an unpackaged bypass must throw, not merely log',
    );
    console.log('  ok  unpackaged + unpinned userData throws');
    passed++;
}

// ─── The paths that must stay quiet ───────────────────────────────
{
    loadAuth({ userDataDir: PINNED, isPackaged: true });
    assert.strictEqual(recorded.length, 0, 'a correctly pinned packaged build says nothing');
    console.log('  ok  packaged + pinned userData is silent');
    passed++;
}

{
    loadAuth({ userDataDir: PINNED, isPackaged: false });
    assert.strictEqual(recorded.length, 0, 'a correctly pinned dev build says nothing');
    console.log('  ok  unpackaged + pinned userData is silent');
    passed++;
}

{
    // How the other suites load this module: no Electron runtime at all.
    loadAuth({ userDataDir: null, isPackaged: false });
    assert.strictEqual(recorded.length, 0, 'no Electron runtime means nothing to check');
    console.log('  ok  outside Electron the tripwire neither throws nor records');
    passed++;
}

Module._load = origLoad;
console.log('');
console.log(`${passed} passed`);
