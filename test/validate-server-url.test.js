/**
 * Standalone smoke test for auth.validateServerUrl().
 *
 * No test framework — run with `node test/validate-server-url.test.js`.
 * electron-store, keytar and electron are stubbed via Module._load so auth.js
 * can be required outside an Electron runtime. allowDevHosts is always passed
 * explicitly so both the packaged and the unpackaged rule are exercised here,
 * rather than inherited from whatever app.isPackaged happens to be.
 */
const Module = require('module');
const assert = require('assert');

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
    if (request === 'electron') {
        return { app: { getPath: () => 'C:/Users/test/AppData/Roaming/TaxOne Desktop', isPackaged: true } };
    }
    return origLoad.call(this, request, ...rest);
};

const auth = require('../src/auth');

const NEW = 'https://caputa.quework.app';
const PACKAGED = { allowDevHosts: false };
const DEV = { allowDevHosts: true };
let passed = 0;

function accepts(input, expectedUrl, opts = PACKAGED) {
    const result = auth.validateServerUrl(input, opts);
    assert.ok(result.ok, `expected ${input} to be accepted, got: ${result.error}`);
    assert.strictEqual(result.url, expectedUrl, `canonical URL for ${input}`);
    console.log(`  ok  accepts ${input} -> ${result.url}`);
    passed++;
}

function rejects(input, opts = PACKAGED) {
    const result = auth.validateServerUrl(input, opts);
    assert.ok(!result.ok, `expected ${input} to be REJECTED, was accepted as ${result.url}`);
    assert.ok(result.error && result.error.length, `${input}: a rejection needs a message`);
    console.log(`  ok  rejects ${input}`);
    passed++;
}

// ─── Accepted ─────────────────────────────────────────────────────
accepts('https://caputa.quework.app', NEW);
accepts('https://caputa.quework.app/', NEW);
accepts('https://CAPUTA.Quework.App', NEW);
accepts('https://otherfirm.quework.app', 'https://otherfirm.quework.app');
accepts('https://firm-with-hyphens.quework.app', 'https://firm-with-hyphens.quework.app');

// The legacy host maps to the migrated one, matching migrateLegacyHost().
accepts('https://taxone.cpa', NEW);
accepts('https://www.taxone.cpa', NEW);
accepts('https://taxone.cpa/some/path', NEW);

// Dev hosts, unpackaged builds only.
accepts('http://localhost:8000', 'http://localhost:8000', DEV);
accepts('https://quework.test', 'https://quework.test', DEV);

// ─── Rejected: the counterfactuals ────────────────────────────────
rejects('https://caputa.quework.app.evil.com');       // suffix lookalike
rejects('https://evil.com/?x=caputa.quework.app');    // trusted host in the query string
rejects('https://caputa.quework.app@evil.com');       // userinfo trick — the host is evil.com
rejects('https://caputa.quework.app:pass@evil.com');  // userinfo with a password
rejects('https://user@caputa.quework.app');           // userinfo on a host that IS ours
rejects('https://ca_puta.quework.app');               // underscore is not a hostname character
rejects('https://-caputa.quework.app');               // a label cannot start with a hyphen
rejects('http://caputa.quework.app');                 // right host, wrong scheme
rejects('https://a.b.quework.app');                   // two-label subdomain
rejects('https://quework.app');                       // the apex is not a firm
rejects('http://localhost:8000', PACKAGED);           // dev host in a packaged build
rejects('https://quework.test', PACKAGED);            // .test host in a packaged build

// A port is dropped by the canonicalisation, so accepting one would mean the
// allowlist silently passed something it never checked.
rejects('https://caputa.quework.app:8443');
rejects('https://taxone.cpa:8443');
rejects('https://caputa.quework.app:80');
// Ports the scheme implies are not explicit — new URL() normalises them away.
accepts('https://caputa.quework.app:443', NEW);

// ─── Rejected: everything else ────────────────────────────────────
rejects('https://evil.com');
rejects('https://quework.app.evil.com');
rejects('https://caputa.quework.app.');               // trailing dot is not the apex
rejects('file:///C:/windows/system32');
rejects('javascript:alert(1)');
rejects('taxone-desktop://connect');
rejects('ftp://caputa.quework.app');
rejects('not a url');
rejects('');
rejects('   ');
rejects(null);
rejects(undefined);
rejects(42);

// ─── saveServerUrl is gated by the same rule ──────────────────────
backing.clear();
assert.throws(() => auth.saveServerUrl('https://evil.com'), /Not a Quework server/);
assert.strictEqual(auth.getServerUrl(), '', 'a rejected URL must not be persisted');
console.log('  ok  saveServerUrl throws and persists nothing for a rejected URL');
passed++;

backing.clear();
assert.strictEqual(auth.saveServerUrl('https://caputa.quework.app/'), NEW);
assert.strictEqual(auth.getServerUrl(), NEW, 'the canonical URL is what gets stored');
console.log('  ok  saveServerUrl stores the canonical URL');
passed++;

Module._load = origLoad;
console.log('');
console.log(`${passed} passed`);
