/**
 * Standalone test for auth.enforcePersistedServerUrl() and
 * startup.resolveStartup(): the stored host is validated on read, before the
 * first authenticated request.
 *
 * No test framework — run with `node test/enforce-persisted-host.test.js`.
 * Runs as a packaged build, with keytar present (a stand-in keychain) so both
 * token stores are exercised, and axios replaced by a recorder so "nothing
 * was sent" is checked directly.
 */
const assert = require('assert');
const { installStubs, recordingAxios } = require('./helpers/stubs');

const rec = recordingAxios();
const stubs = installStubs({ isPackaged: true, keytar: true, axios: rec.module });
const auth = require('../src/auth');
const uploader = require('../src/uploader');
const { resolveStartup } = require('../src/startup');

const KEY = 'TaxOneDesktop/api-token';
const NEW = 'https://caputa.quework.app';

function reset({ serverUrl, keychainToken, storeToken, migrated } = {}) {
    stubs.store.clear();
    stubs.keychain.clear();
    stubs.logs.length = 0;
    rec.calls.length = 0;
    if (serverUrl !== undefined) stubs.store.set('serverUrl', serverUrl);
    if (keychainToken) stubs.keychain.set(KEY, keychainToken);
    if (storeToken) stubs.store.set('_token', storeToken);
    if (migrated) stubs.store.set('_hostMigratedV1', true);
}

function assertSignedOut(name) {
    assert.strictEqual(stubs.store.has('serverUrl'), false, `${name}: host cleared`);
    assert.strictEqual(stubs.keychain.has(KEY), false, `${name}: keychain token cleared`);
    assert.strictEqual(stubs.store.has('_token'), false, `${name}: electron-store _token cleared`);
}

let passed = 0;
function ok(name) {
    console.log(`  ok  ${name}`);
    passed++;
}

async function main() {
    // ─── Rejected hosts: host and both token copies go ─────────────

    for (const bad of ['https://evil.example', 'https://caputa.quework.app.evil.com']) {
        reset({ serverUrl: bad, keychainToken: 'kc-tok', storeToken: 'st-tok' });
        const r = await auth.enforcePersistedServerUrl();
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.rejected, bad);
        assertSignedOut(bad);
        assert.ok(stubs.logs.some(l => l.includes('[startup] Stored server URL rejected') && l.includes(bad)),
            'the rejection is logged with the host');
        ok(`stored ${bad} -> host and token cleared, logged`);
    }

    {
        // v1.1.5's saveServerUrl only forced https, so a plain-http
        // lookalike could not be stored, but a dev host could.
        reset({ serverUrl: 'https://taxone.test', storeToken: 'st-tok' });
        assert.strictEqual((await auth.enforcePersistedServerUrl()).ok, false);
        assertSignedOut('dev host in a packaged build');
        ok('stored https://taxone.test in a packaged build -> cleared');
    }

    // ─── clearToken reaches both stores ────────────────────────────

    {
        reset({ serverUrl: 'https://evil.example', storeToken: 'only-in-store' });
        assert.strictEqual(await auth.getToken(), null, 'precondition: keytar present, keychain empty');
        await auth.enforcePersistedServerUrl();
        assert.strictEqual(stubs.store.has('_token'), false);
        ok('a token that exists only in the electron-store _token fallback is cleared');
    }
    {
        reset({ serverUrl: 'https://evil.example', keychainToken: 'only-in-keychain' });
        await auth.enforcePersistedServerUrl();
        assert.strictEqual(stubs.keychain.has(KEY), false);
        ok('a token that exists only in the keychain is cleared');
    }
    {
        // keytar present but failing must not leave the fallback behind.
        reset({ serverUrl: 'https://evil.example', keychainToken: 'kc', storeToken: 'st' });
        const keytar = require('keytar');
        const orig = keytar.deletePassword;
        keytar.deletePassword = async () => { throw new Error('keychain locked'); };
        try {
            await auth.enforcePersistedServerUrl();
        } finally {
            keytar.deletePassword = orig;
        }
        assert.strictEqual(stubs.store.has('_token'), false);
        ok('a failing keychain delete still clears the _token fallback');

        // The keychain half: the entry is still there, but it is never read.
        assert.strictEqual(stubs.keychain.get(KEY), 'kc', 'precondition: the delete really failed');
        assert.strictEqual(await auth.getToken(), null, 'the revoked keychain token must not come back');
        assert.strictEqual(stubs.store.get('_keychainTokenRevoked'), true);
        assert.ok(stubs.logs.some(l => l.includes('[auth] Could not delete the keychain token') && l.includes('keychain locked')),
            'the failure is logged, not swallowed');
        ok('a failing keychain delete: logged, and getToken() no longer returns that token');

        // Signing in again stores a new token and lifts the revocation.
        await auth.saveToken('fresh');
        assert.strictEqual(await auth.getToken(), 'fresh');
        assert.strictEqual(stubs.store.has('_keychainTokenRevoked'), false);
        ok('a later successful saveToken() lifts the revocation and returns the new token');
    }
    {
        // …but not if the new token never reached the keychain: the old one
        // would be read back in its place.
        reset({ serverUrl: 'https://evil.example', keychainToken: 'old', storeToken: 'old' });
        const keytar = require('keytar');
        const origDelete = keytar.deletePassword;
        const origSet = keytar.setPassword;
        keytar.deletePassword = async () => { throw new Error('keychain locked'); };
        keytar.setPassword = async () => { throw new Error('keychain locked'); };
        try {
            await auth.enforcePersistedServerUrl();
            await auth.saveToken('fresh');
        } finally {
            keytar.deletePassword = origDelete;
            keytar.setPassword = origSet;
        }
        assert.strictEqual(stubs.keychain.get(KEY), 'old', 'precondition: the old token is still in the keychain');
        assert.strictEqual(await auth.getToken(), 'fresh', 'the new token, from the fallback — never the revoked one');
        ok('a failed keychain write keeps the revocation: the fallback token is used, not the revoked one');
        await auth.saveToken('lift'); // the keychain works again: lift this run's revocation for the cases below
    }
    {
        // The keychain delete fails AND the store refuses the flag write.
        // _token is deleted first, so it is gone; the revocation holds in
        // memory, so getToken() still returns nothing; clearToken() resolves.
        reset({ serverUrl: NEW, keychainToken: 'kc', storeToken: 'st' });
        const keytar = require('keytar');
        const origDelete = keytar.deletePassword;
        keytar.deletePassword = async () => { throw new Error('keychain locked'); };
        const realSet = stubs.store.set;
        stubs.store.set = function (key, val) {
            if (key === '_keychainTokenRevoked') throw new Error('EPERM: settings file locked');
            return realSet.call(this, key, val);
        };
        try {
            await auth.clearToken();
        } finally {
            keytar.deletePassword = origDelete;
            stubs.store.set = realSet;
        }
        assert.strictEqual(stubs.keychain.get(KEY), 'kc', 'precondition: the keychain delete really failed');
        assert.strictEqual(stubs.store.has('_keychainTokenRevoked'), false, 'precondition: the flag write really failed');
        assert.strictEqual(stubs.store.has('_token'), false, '_token is gone');
        assert.strictEqual(await auth.getToken(), null, 'getToken() returns nothing');
        assert.ok(stubs.logs.some(l => l.includes('Could not persist the keychain revocation')), 'the flag failure is logged');
        ok('keychain delete and flag write both fail: _token gone, getToken() returns nothing, both logged');
        await auth.saveToken('lift');
    }
    {
        // Order, observed in time: with a keychain call that never returns (a
        // hung Credential Manager), the plain-text _token must already be gone.
        reset({ keychainToken: 'kc', storeToken: 'st' });
        const keytar = require('keytar');
        const origDelete = keytar.deletePassword;
        keytar.deletePassword = () => new Promise(() => {});
        try {
            auth.clearToken(); // deliberately not awaited: it never settles
            await new Promise(r => setImmediate(r));
            assert.strictEqual(stubs.store.has('_token'), false, '_token deleted before the keychain is touched');
        } finally {
            keytar.deletePassword = origDelete;
        }
        ok('a hung keychain delete: _token is already gone (deleted first)');
    }

    // ─── Accepted hosts ────────────────────────────────────────────

    {
        reset({ serverUrl: 'https://taxone.cpa', storeToken: 'st', migrated: true });
        assert.strictEqual(auth.migrateLegacyHost(), false, 'precondition: the guard makes the migration a no-op');
        assert.strictEqual(auth.getServerUrl(), 'https://taxone.cpa');
        const r = await auth.enforcePersistedServerUrl();
        assert.deepStrictEqual(r, { ok: true, url: NEW });
        assert.strictEqual(auth.getServerUrl(), NEW, 'mapped and persisted');
        assert.strictEqual(stubs.store.get('_token'), 'st', 'token kept');
        ok('stored taxone.cpa after the migration flag is set -> mapped to caputa.quework.app');
    }
    {
        reset({ serverUrl: NEW, keychainToken: 'kc', storeToken: 'st' });
        const r = await auth.enforcePersistedServerUrl();
        assert.deepStrictEqual(r, { ok: true, url: NEW });
        assert.strictEqual(auth.getServerUrl(), NEW);
        assert.strictEqual(stubs.keychain.get(KEY), 'kc');
        assert.strictEqual(stubs.store.get('_token'), 'st');
        assert.deepStrictEqual(stubs.logs, [], 'nothing to log');
        ok('valid host -> untouched, token kept');
    }
    {
        reset({ serverUrl: 'https://Caputa.Quework.app/', storeToken: 'st' });
        assert.deepStrictEqual(await auth.enforcePersistedServerUrl(), { ok: true, url: NEW });
        assert.strictEqual(auth.getServerUrl(), NEW);
        ok('non-canonical valid host -> canonical form persisted');
    }
    {
        reset({});
        assert.deepStrictEqual(await auth.enforcePersistedServerUrl(), { ok: true, url: '' });
        assert.strictEqual(stubs.store.has('serverUrl'), false, 'nothing written for a fresh install');
        ok('nothing stored -> nothing to do');
    }

    // ─── resolveStartup: the decision main.js acts on ──────────────

    {
        reset({ serverUrl: 'https://evil.example', keychainToken: 'kc', storeToken: 'st' });
        const d = await resolveStartup({ auth, uploader, log: () => {} });
        assert.strictEqual(d.action, 'login');
        assert.ok(d.notice.includes('evil.example'), `the notice names the host: ${d.notice}`);
        assert.ok(/signed (you )?out/.test(d.notice), 'and says the user was signed out');
        assert.deepStrictEqual(rec.calls, [], 'no client built, nothing sent');
        assertSignedOut('resolveStartup');
        ok('startup with a rejected host: login with a notice naming it, nothing sent');
    }
    {
        // And after that, the surfaces IPC can still reach send nothing.
        await assert.rejects(uploader.searchClients('a'));
        await assert.rejects(uploader.fetchFolders(1));
        await assert.rejects(uploader.uploadFile(__filename, 1, '', 'x.pdf'));
        assert.strictEqual(await uploader.verifyToken(), 'auth_error');
        assert.deepStrictEqual(rec.calls, [], 'still nothing sent');
        ok('after a rejected startup, search/folders/upload/verify send nothing');
    }
    {
        // Seeded the way saveToken() writes it: keychain and fallback both.
        reset({ serverUrl: NEW, keychainToken: 'tok', storeToken: 'tok' });
        const d = await resolveStartup({ auth, uploader, log: () => {} });
        assert.deepStrictEqual(d, { action: 'resume', serverUrl: NEW, token: 'tok', status: 'ok' });
        assert.strictEqual(rec.calls[0].baseURL, NEW);
        ok('startup with a valid host: resume, and the first request goes to that host');
    }
    // A failed token check is not a reason to sign out: the token may be
    // fine, and the host has already passed validation. Through the real
    // verifyToken, so neither it nor resolveStartup can drop the token.
    for (const [status, failure] of [
        ['tls_error', Object.assign(new Error('unable to verify the first certificate'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' })],
        ['network_error', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })],
    ]) {
        reset({ serverUrl: NEW, keychainToken: 'tok', storeToken: 'tok' });
        rec.control.failWith = failure;
        try {
            const d = await resolveStartup({ auth, uploader, log: () => {} });
            assert.deepStrictEqual(d, { action: 'resume', serverUrl: NEW, token: 'tok', status });
        } finally {
            rec.control.failWith = null;
        }
        assert.strictEqual(stubs.store.get('serverUrl'), NEW, `${status}: host kept`);
        assert.strictEqual(stubs.keychain.get(KEY), 'tok', `${status}: keychain token kept`);
        assert.strictEqual(stubs.store.get('_token'), 'tok', `${status}: _token fallback kept`);
        assert.strictEqual(await auth.getToken(), 'tok', `${status}: still signed in`);
        ok(`startup with ${status}: resume, host and token kept in both stores`);
    }
    {
        reset({ serverUrl: NEW });
        const d = await resolveStartup({ auth, uploader, log: () => {} });
        assert.deepStrictEqual(d, { action: 'login' });
        assert.deepStrictEqual(rec.calls, []);
        ok('no token: login, no notice, nothing sent');
    }
    {
        reset({ storeToken: 'st' });
        assert.deepStrictEqual(await resolveStartup({ auth, uploader, log: () => {} }), { action: 'login' });
        assert.deepStrictEqual(rec.calls, []);
        ok('a token but no host: login, nothing sent');
    }
    {
        // A rejected host whose removal partly fails is still a rejection:
        // the user gets the rejection notice, and the token still goes.
        reset({ serverUrl: 'https://evil.example', keychainToken: 'kc', storeToken: 'st' });
        const realDelete = stubs.store.delete;
        stubs.store.delete = function (key) {
            if (key === 'serverUrl') throw new Error('EPERM: settings file locked');
            return realDelete.call(this, key);
        };
        let d;
        try {
            d = await resolveStartup({ auth, uploader, log: () => {} });
        } finally {
            stubs.store.delete = realDelete;
        }
        assert.strictEqual(d.action, 'login');
        assert.ok(d.notice.includes('was not accepted'), `the rejection notice, not "nothing was removed": ${d.notice}`);
        assert.strictEqual(stubs.keychain.has(KEY), false, 'keychain token still cleared');
        assert.strictEqual(stubs.store.has('_token'), false, '_token still cleared');
        assert.ok(stubs.logs.some(l => l.includes('Removal incomplete') && l.includes('EPERM')), 'the partial failure is logged');
        assert.deepStrictEqual(rec.calls, []);
        ok('rejected host, host delete throws: still the rejection notice, token still cleared, logged');
    }
    {
        // STOP, not DELETE. A store read that throws once is not a host we
        // have rejected: nothing is sent and nothing is removed, and once the
        // read works again startup carries on as if nothing happened.
        reset({ serverUrl: NEW, keychainToken: 'tok', storeToken: 'tok' });
        const realGet = stubs.store.get;
        let thrown = 0;
        stubs.store.get = function (key) {
            if (key === 'serverUrl' && thrown === 0) {
                thrown++;
                throw new Error('EBUSY: settings file locked');
            }
            return realGet.call(this, key);
        };
        const logged = [];
        let d;
        try {
            d = await resolveStartup({ auth, uploader, log: m => logged.push(m) });
        } finally {
            stubs.store.get = realGet;
        }
        assert.strictEqual(thrown, 1, 'precondition: the read threw once');
        assert.strictEqual(d.action, 'login', 'not resumed');
        assert.ok(d.notice.includes('Nothing was removed'), `the notice says nothing was removed: ${d.notice}`);
        assert.ok(logged.some(m => m.includes('EBUSY')), 'logged');
        assert.deepStrictEqual(rec.calls, [], 'nothing sent');
        assert.strictEqual(stubs.store.get('serverUrl'), NEW, 'host kept');
        assert.strictEqual(stubs.keychain.get(KEY), 'tok', 'keychain token kept');
        assert.strictEqual(stubs.store.get('_token'), 'tok', '_token kept');
        ok('store read throws once: sign-in window, nothing sent, host and both tokens kept');

        const again = await resolveStartup({ auth, uploader, log: () => {} });
        assert.deepStrictEqual(again, { action: 'resume', serverUrl: NEW, token: 'tok', status: 'ok' });
        ok('…and the next read succeeds: startup resumes with everything intact');
    }
    // Last: resuming leaves uploader's cached client behind, which the
    // "nothing sent after a rejected startup" case above must not inherit.
    {
        // Persisting the canonical form fails: a valid host must still pass,
        // keep its token, and let startup continue on the canonical URL.
        const RAW = 'https://Caputa.Quework.app/';
        reset({ serverUrl: RAW, keychainToken: 'tok', storeToken: 'tok' });
        const realSet = stubs.store.set;
        stubs.store.set = function (key, val) {
            if (key === 'serverUrl') throw new Error('EPERM: settings file locked');
            return realSet.call(this, key, val);
        };
        let r;
        let d;
        try {
            // Startup first, as main.js runs it: without the try/catch the
            // throw reaches resolveStartup's fail-closed path and the token goes.
            d = await resolveStartup({ auth, uploader, log: () => {} });
            r = await auth.enforcePersistedServerUrl().catch(err => ({ threw: err.message }));
        } finally {
            stubs.store.set = realSet;
        }
        assert.deepStrictEqual(d, { action: 'resume', serverUrl: NEW, token: 'tok', status: 'ok' });
        assert.deepStrictEqual(r, { ok: true, url: NEW });
        assert.strictEqual(stubs.store.get('serverUrl'), RAW, 'host kept (as stored — the write failed)');
        assert.strictEqual(stubs.keychain.get(KEY), 'tok', 'keychain token kept');
        assert.strictEqual(stubs.store.get('_token'), 'tok', '_token fallback kept');
        assert.ok(stubs.logs.some(l => l.includes('Could not persist the canonical server URL')), 'logged');
        assert.strictEqual(rec.calls.find(c => c.baseURL).baseURL, NEW, 'startup talks to the canonical URL');
        ok('canonical-form write throws: host and token survive, startup continues on the canonical URL');
    }
}

main().then(() => {
    stubs.restore();
    console.log('');
    console.log(`${passed} passed`);
}).catch(err => {
    console.error(err);
    process.exit(1);
});
