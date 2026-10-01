/**
 * Standalone test for certificate verification in the API client.
 *
 * No test framework — run with `node test/tls-verification.test.js`.
 * Local HTTPS servers present the TEST-ONLY certificates in
 * test/fixtures/tls/ (see the README there). Scenarios that depend on the
 * process environment — NODE_EXTRA_CA_CERTS, NODE_TLS_REJECT_UNAUTHORIZED —
 * run in a child process (test/helpers/tls-client.js), because Node reads
 * them from the environment it was started with.
 *
 * Every scenario counts what reached the server, so "rejected" means nothing
 * was sent, not merely that an error came back.
 */
const assert = require('assert');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { execFile } = require('child_process');
const { installStubs } = require('./helpers/stubs');

const FIXTURES = path.join(__dirname, 'fixtures', 'tls');
const TEST_CA = path.join(FIXTURES, 'ca.crt');
const CLIENT = path.join(__dirname, 'helpers', 'tls-client.js');

// Node's codes for "could not build a trusted chain".
const UNTRUSTED = ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT'];

const stubs = installStubs({ isPackaged: true });
const uploader = require('../src/uploader');

function startServer(name) {
    const counts = { connections: 0, requests: 0 };
    const server = https.createServer({
        key: fs.readFileSync(path.join(FIXTURES, `${name}.key`)),
        cert: fs.readFileSync(path.join(FIXTURES, `${name}.crt`)),
    }, (req, res) => {
        counts.requests++;
        res.setHeader('Content-Type', 'application/json');
        res.end('{"clients":[]}');
    });
    server.on('connection', () => counts.connections++);
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
        resolve({ server, counts, origin: `https://localhost:${server.address().port}` });
    }));
}

function childEnv(extra) {
    const env = { ...process.env };
    delete env.NODE_EXTRA_CA_CERTS;
    delete env.NODE_TLS_REJECT_UNAUTHORIZED;
    return { ...env, ...extra };
}

function runChild(mode, url, extraEnv = {}) {
    return new Promise((resolve, reject) => {
        execFile(process.execPath, [CLIENT, mode, url], { env: childEnv(extraEnv), timeout: 20000 }, (err, stdout) => {
            if (err) return reject(err);
            resolve(JSON.parse(stdout.trim().split('\n').pop()));
        });
    });
}

const tick = () => new Promise(r => setTimeout(r, 50));

let passed = 0;
function ok(name) {
    console.log(`  ok  ${name}`);
    passed++;
}

async function main() {
    const good = await startServer('localhost');
    const wrong = await startServer('mismatch');

    // ─── Released build: a dev host is refused before any connection ──

    stubs.electron.app.isPackaged = true;

    assert.throws(() => uploader.createApiClient(good.origin, 'tok'),
        err => err.code === 'E_HOST_REJECTED');
    await tick();
    assert.strictEqual(good.counts.connections, 0);
    ok('packaged: createApiClient refuses a dev host and never connects');

    assert.strictEqual(await uploader.verifyTokenWith(good.origin, 'tok'), false);
    await tick();
    assert.strictEqual(good.counts.connections, 0, 'verifyTokenWith must build its client through the factory');
    ok('packaged: verifyTokenWith goes through the factory and never connects');

    stubs.store.set('serverUrl', good.origin);
    stubs.store.set('_token', 'tok');
    assert.strictEqual(await uploader.verifyToken(), 'host_rejected');
    await tick();
    assert.strictEqual(good.counts.connections, 0);
    assert.ok(stubs.logs.some(l => l.includes('[verifyToken] Stored server URL rejected')), 'rejection is logged');
    ok('packaged: verifyToken reports host_rejected for a stored dev host and never connects');

    // ─── Unpackaged, no extra CA: verification is on ───────────────

    stubs.electron.app.isPackaged = false;

    const before = good.counts.requests;
    await assert.rejects(uploader.createApiClient(good.origin, 'tok').get('/api/desktop/clients'),
        err => UNTRUSTED.includes(err.code));
    assert.strictEqual(good.counts.requests, before, 'no request may be sent over an unverified connection');
    ok('unpackaged: a certificate from an untrusted CA is rejected and no request is sent');

    {
        const r = await runChild('factory', `${good.origin}/ping`);
        assert.ok(!r.ok && UNTRUSTED.includes(r.code), JSON.stringify(r));
        ok('unpackaged child without NODE_EXTRA_CA_CERTS: rejected');
    }

    // ─── An inherited NODE_TLS_REJECT_UNAUTHORIZED=0 does not win ──

    {
        const control = await runChild('plain', `${good.origin}/ping`, { NODE_TLS_REJECT_UNAUTHORIZED: '0' });
        assert.deepStrictEqual(control, { ok: true, status: 200 },
            'control: the env var must actually disable verification for a default agent, or the next check proves nothing');
        const r = await runChild('factory', `${good.origin}/ping`, { NODE_TLS_REJECT_UNAUTHORIZED: '0' });
        assert.ok(!r.ok && UNTRUSTED.includes(r.code), `factory accepted under the env override: ${JSON.stringify(r)}`);
        ok('NODE_TLS_REJECT_UNAUTHORIZED=0 in the environment: a default agent accepts, the factory still rejects');
    }

    // ─── Dev mechanism: an extra trust anchor, nothing relaxed ─────

    {
        const r = await runChild('factory', `${good.origin}/ping`, { NODE_EXTRA_CA_CERTS: TEST_CA });
        assert.deepStrictEqual(r, { ok: true, status: 200 });
        ok('unpackaged child with NODE_EXTRA_CA_CERTS: a localhost certificate from that CA is accepted');
    }

    {
        const r = await runChild('factory', `${wrong.origin}/ping`, { NODE_EXTRA_CA_CERTS: TEST_CA });
        assert.deepStrictEqual(r, { ok: false, code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
        ok('with the extra CA, a certificate for another hostname is still rejected (hostname check stays on)');
    }

    good.server.close();
    wrong.server.close();
}

main().then(() => {
    stubs.restore();
    console.log('');
    console.log(`${passed} passed`);
    process.exit(0);
}).catch(err => {
    console.error(err);
    process.exit(1);
});
