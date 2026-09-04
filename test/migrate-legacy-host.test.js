/**
 * Standalone smoke test for auth.migrateLegacyHost().
 *
 * No test framework — run with `node test/migrate-legacy-host.test.js`.
 * electron-store and keytar are stubbed via Module._load so auth.js can be
 * required outside an Electron runtime. Only the settings store is exercised.
 */
const Module = require('module');
const assert = require('assert');

// In-memory stand-in for electron-store, shared across the module under test.
const backing = new Map();
class MockStore {
    get(key, def) { return backing.has(key) ? backing.get(key) : def; }
    set(key, val) { backing.set(key, val); }
    delete(key) { backing.delete(key); }
}

const origLoad = Module._load;
Module._load = function (request, ...rest) {
    if (request === 'electron-store') return MockStore;
    if (request === 'keytar') throw new Error('keytar stubbed off for test');
    return origLoad.call(this, request, ...rest);
};

const auth = require('../src/auth');

let passed = 0;
function scenario(name, { seed, expectServerUrl, expectReturn }) {
    backing.clear();
    if (seed && 'serverUrl' in seed) backing.set('serverUrl', seed.serverUrl);
    if (seed && seed._hostMigratedV1) backing.set('_hostMigratedV1', true);

    const ret = auth.migrateLegacyHost();

    assert.strictEqual(ret, expectReturn, `${name}: return value`);
    assert.strictEqual(auth.getServerUrl(), expectServerUrl, `${name}: serverUrl`);
    assert.strictEqual(backing.get('_hostMigratedV1'), true, `${name}: guard flag set`);
    console.log(`  ok  ${name}`);
    passed++;
}

const NEW = 'https://caputa.quework.app';

scenario('legacy apex host is rewritten', {
    seed: { serverUrl: 'https://taxone.cpa' },
    expectServerUrl: NEW, expectReturn: true,
});

scenario('legacy www host is rewritten', {
    seed: { serverUrl: 'https://www.taxone.cpa' },
    expectServerUrl: NEW, expectReturn: true,
});

scenario('legacy host with trailing path is rewritten (hostname match)', {
    seed: { serverUrl: 'https://taxone.cpa/' },
    expectServerUrl: NEW, expectReturn: true,
});

scenario('already-migrated guard makes it a no-op even if host is legacy', {
    seed: { serverUrl: 'https://taxone.cpa', _hostMigratedV1: true },
    expectServerUrl: 'https://taxone.cpa', expectReturn: false,
});

scenario('unrelated host is left untouched', {
    seed: { serverUrl: 'https://otherfirm.quework.app' },
    expectServerUrl: 'https://otherfirm.quework.app', expectReturn: false,
});

scenario('new host is left untouched', {
    seed: { serverUrl: NEW },
    expectServerUrl: NEW, expectReturn: false,
});

scenario('lookalike host (taxone.cpa.evil.com) is NOT rewritten', {
    seed: { serverUrl: 'https://taxone.cpa.evil.com' },
    expectServerUrl: 'https://taxone.cpa.evil.com', expectReturn: false,
});

scenario('empty serverUrl just sets the guard', {
    seed: { serverUrl: '' },
    expectServerUrl: '', expectReturn: false,
});

scenario('non-URL garbage is left untouched', {
    seed: { serverUrl: 'not a url' },
    expectServerUrl: 'not a url', expectReturn: false,
});

Module._load = origLoad;
console.log(`\n${passed} passed`);
