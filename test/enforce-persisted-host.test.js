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
        // A store that throws is not a host we have checked: fail closed.
        reset({ serverUrl: 'https://evil.example', storeToken: 'st' });
        const logged = [];
        const brokenAuth = {
            ...auth,
            enforcePersistedServerUrl: async () => { throw new Error('EPERM: settings file locked'); },
        };
        const d = await resolveStartup({ auth: brokenAuth, uploader, log: m => logged.push(m) });
        assert.strictEqual(d.action, 'login');
        assert.ok(d.notice, 'the user is told');
        assert.ok(logged[0].includes('EPERM'), 'and it is logged');
        assert.strictEqual(stubs.store.has('_token'), false, 'the token is cleared anyway');
        assert.deepStrictEqual(rec.calls, []);
        ok('enforcement throws: fail closed — login, token cleared, nothing sent');
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
