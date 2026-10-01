/**
 * Standalone test for src/reconnect.js, the body of main.js's 30s loop.
 *
 * No test framework — run with `node test/reconnect.test.js`.
 * axios is replaced with a recorder, so "no request" is checked directly
 * rather than inferred from an error.
 */
const assert = require('assert');
const { installStubs, recordingAxios } = require('./helpers/stubs');

const rec = recordingAxios();
const stubs = installStubs({ isPackaged: true, axios: rec.module });
const uploader = require('../src/uploader');
const { retryFailedIfOnline } = require('../src/reconnect');

function fakeQueue(stats) {
    const q = { retried: 0 };
    q.getStats = () => stats;
    q.retryAllFailed = () => { q.retried++; };
    return q;
}
const IDLE_WITH_FAILURES = { failed: 3, queueStatus: 'idle' };

let passed = 0;
function ok(name) {
    console.log(`  ok  ${name}`);
    passed++;
}

async function main() {
    // A stored host that fails validation: the real uploader, nothing sent.
    for (const bad of ['https://evil.example', 'https://caputa.quework.app.evil.com']) {
        stubs.store.set('serverUrl', bad);
        stubs.store.set('_token', 'tok');
        rec.calls.length = 0;
        const q = fakeQueue(IDLE_WITH_FAILURES);
        const outcome = await retryFailedIfOnline(q, uploader);
        assert.strictEqual(outcome, 'host_rejected');
        assert.strictEqual(q.retried, 0, 'uploads must not be retried');
        assert.deepStrictEqual(rec.calls, [], 'no client may be built and nothing sent');
        ok(`stored ${bad}: the tick resolves, sends nothing, retries nothing`);
    }

    // Anything that throws inside the tick ends there.
    {
        const log = [];
        const throwing = { verifyToken: async () => { throw new Error('boom'); } };
        const outcome = await retryFailedIfOnline(fakeQueue(IDLE_WITH_FAILURES), throwing, m => log.push(m));
        assert.strictEqual(outcome, 'error');
        assert.ok(log[0].includes('boom'), 'the failure is logged');
        ok('a throwing verifyToken is logged, not rethrown');
    }
    {
        const log = [];
        const brokenQueue = { getStats: () => { throw new Error('store corrupt'); } };
        assert.strictEqual(await retryFailedIfOnline(brokenQueue, uploader, m => log.push(m)), 'error');
        assert.ok(log[0].includes('store corrupt'));
        ok('a throwing queue is logged, not rethrown');
    }

    // The happy path still works, so the guards above are not just "never retry".
    {
        stubs.store.set('serverUrl', 'https://caputa.quework.app');
        rec.calls.length = 0;
        const q = fakeQueue(IDLE_WITH_FAILURES);
        assert.strictEqual(await retryFailedIfOnline(q, uploader), 'retried');
        assert.strictEqual(q.retried, 1);
        assert.strictEqual(rec.calls[0].baseURL, 'https://caputa.quework.app');
        ok('a valid host that answers: failed files are retried');
    }
    {
        const q = fakeQueue({ failed: 0, queueStatus: 'idle' });
        assert.strictEqual(await retryFailedIfOnline(q, uploader), 'nothing-to-retry');
        assert.strictEqual(await retryFailedIfOnline(null, uploader), 'no-queue');
        ok('nothing failed / no queue: no check at all');
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
