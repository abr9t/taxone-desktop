/**
 * Standalone test for src/update-policy.js.
 *
 * No test framework — run with `node test/update-policy.test.js`.
 * Each blocker is checked alone (exactly one reason to refuse, everything
 * else clear), so deleting any one rule from restartBlockers() fails its own
 * case here.
 */
const assert = require('assert');
const { restartBlockers, isFirstLaunchOfVersion, decideAfterCheck } = require('../src/update-policy');

let passed = 0;
function ok(name) {
    console.log(`  ok  ${name}`);
    passed++;
}

const IDLE = { total: 0, completed: 0, failed: 0, pending: 0, uploading: 0, skipped: 0, queueStatus: 'idle' };
function queue(stats = {}, activeUploads = 0) {
    return { getStats: () => ({ ...IDLE, ...stats }), activeUploads };
}

// ─── restartBlockers ──────────────────────────────────────────────

{
    assert.deepStrictEqual(restartBlockers({ queue: null, unconfirmedFiles: 0, directUploads: 0 }), []);
    assert.deepStrictEqual(restartBlockers({ queue: queue(), unconfirmedFiles: 0, directUploads: 0 }), []);
    ok('nothing in flight: safe, signed in or not');
}

{
    // Finished work does not block: completed, failed (the reconnect loop
    // retries those after the restart) and skipped files are all on disk.
    const done = queue({ total: 9, completed: 5, failed: 3, skipped: 1 });
    assert.deepStrictEqual(restartBlockers({ queue: done }), []);
    ok('completed, failed and skipped files do not block');
}

{
    // A 'running' flag with no work behind it must not block forever.
    assert.deepStrictEqual(restartBlockers({ queue: queue({ queueStatus: 'running' }) }), []);
    ok("a stale 'running' flag with nothing pending or uploading does not block");
}

const ALONE = [
    ['a file uploading', { queue: queue({ uploading: 1, queueStatus: 'running' }, 1) }, /1 file\(s\) uploading/],
    ['the throttle/back-off slot', { queue: queue({ queueStatus: 'running' }, 1) }, /about to start or retry/],
    ['a pending file', { queue: queue({ pending: 2, queueStatus: 'running' }) }, /2 file\(s\) waiting in the upload queue/],
    ['a pending file in a paused queue', { queue: queue({ pending: 1, queueStatus: 'paused' }) }, /1 file\(s\) waiting/],
    ['an unconfirmed watched file', { queue: queue(), unconfirmedFiles: 1 }, /1 watched file\(s\) waiting for you to confirm/],
    ['an unconfirmed watched file before sign-in', { queue: null, unconfirmedFiles: 3 }, /3 watched file/],
    ['a confirm-window upload', { queue: queue(), directUploads: 1 }, /1 file\(s\) uploading from the confirm window/],
];

for (const [name, state, why] of ALONE) {
    const reasons = restartBlockers(state);
    assert.strictEqual(reasons.length, 1, `${name}: expected exactly one reason, got ${JSON.stringify(reasons)}`);
    assert.match(reasons[0], why);
    ok(`blocks on ${name}, and says so`);
}

{
    const reasons = restartBlockers({ queue: queue({ uploading: 1, pending: 4 }, 1), unconfirmedFiles: 2, directUploads: 1 });
    assert.strictEqual(reasons.length, 4, JSON.stringify(reasons));
    ok('lists every blocker at once (uploading, pending, unconfirmed, confirm-window upload)');
}

{
    const broken = { getStats: () => { throw new Error('store corrupt'); }, activeUploads: 0 };
    const reasons = restartBlockers({ queue: broken });
    assert.strictEqual(reasons.length, 1);
    assert.match(reasons[0], /could not be read \(store corrupt\)/);
    ok('a queue that cannot be read blocks (fails closed) and does not throw');
}

// ─── isFirstLaunchOfVersion ───────────────────────────────────────

{
    assert.strictEqual(isFirstLaunchOfVersion(undefined, '1.2.0'), true, 'fresh install, or first run of the first updater build');
    assert.strictEqual(isFirstLaunchOfVersion('1.2.0', '1.2.1'), true, 'first run after an update');
    assert.strictEqual(isFirstLaunchOfVersion('1.2.1', '1.2.0'), true, 'first run after a manual downgrade');
    assert.strictEqual(isFirstLaunchOfVersion('1.2.1', '1.2.1'), false);
    ok('first launch of a version: fresh install, after an update, after a manual reinstall — not after a plain restart');
}

// ─── decideAfterCheck ─────────────────────────────────────────────

const success = (isUpdateAvailable, version) => ({ ok: true, result: { isUpdateAvailable, updateInfo: { version } } });
const failure = (message, extra = {}) => ({ ok: false, error: Object.assign(new Error(message), extra) });

{
    assert.strictEqual(decideAfterCheck(null, success(true, '1.2.1')), 'none');
    assert.strictEqual(decideAfterCheck(null, failure('offline')), 'none');
    ok('nothing downloaded: nothing to decide');
}

{
    assert.strictEqual(decideAfterCheck('1.2.1', success(true, '1.2.1')), 'keep');
    ok('a successful check that still offers the downloaded version keeps it');
}

// Direction 1: a successful check that no longer offers it withdraws it.
for (const [name, outcome] of [
    ['the release was withdrawn (latest is now the older 1.2.0)', success(false, '1.2.0')],
    ['latest.yml says stagingPercentage: 0 (same version, not available)', success(false, '1.2.1')],
    ['a newer 1.2.2 replaced it', success(true, '1.2.2')],
]) {
    assert.strictEqual(decideAfterCheck('1.2.1', outcome), 'withdraw', name);
    ok(`withdraws when ${name}`);
}

// Direction 2: anything that is not a successful, well-formed check keeps it.
for (const [name, outcome] of [
    ['offline', failure('net::ERR_INTERNET_DISCONNECTED')],
    ['rate limited (429)', failure('HttpError: 429 Too Many Requests', { statusCode: 429 })],
    ['a TLS failure', failure('net::ERR_CERT_AUTHORITY_INVALID')],
    ['latest.yml missing', failure('Cannot find latest.yml', { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' })],
    ['a corrupt download', failure('sha512 checksum mismatch', { code: 'ERR_CHECKSUM_MISMATCH' })],
    ['no outcome at all', undefined],
    ['an ok flag that is not exactly true', { ok: 'yes', result: { isUpdateAvailable: false, updateInfo: { version: '1.2.0' } } }],
    ['the updater inactive (null result)', { ok: true, result: null }],
    ['an answer without isUpdateAvailable', { ok: true, result: { updateInfo: { version: '1.2.0' } } }],
    ['an answer without a version', { ok: true, result: { isUpdateAvailable: false, updateInfo: {} } }],
]) {
    assert.strictEqual(decideAfterCheck('1.2.1', outcome), 'keep', name);
    ok(`keeps it when the check gave ${name}`);
}

console.log('');
console.log(`${passed} passed`);
