/**
 * Child process for test/tls-verification.test.js.
 *
 * NODE_EXTRA_CA_CERTS is read once at process start, and the point of the
 * NODE_TLS_REJECT_UNAUTHORIZED case is a value inherited from the environment,
 * so those scenarios need a fresh process with that environment.
 *
 *   node tls-client.js <factory|plain> <url>
 *
 * factory — a GET through uploader.createApiClient(), as an unpackaged build
 * plain   — a GET through a default https.Agent, i.e. whatever the
 *           environment says; the control that proves the env var was live
 *
 * Prints one JSON line: {"ok":true,"status":200} or {"ok":false,"code":"..."}.
 */
const https = require('https');
const { installStubs } = require('./stubs');

const [mode, url] = process.argv.slice(2);

function done(result) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(0); // keep-alive sockets would otherwise hold the process open
}

if (mode === 'plain') {
    https.get(url, { agent: new https.Agent() }, res => done({ ok: true, status: res.statusCode }))
        .on('error', err => done({ ok: false, code: err.code }));
} else if (mode === 'factory') {
    installStubs({ isPackaged: false });
    const { createApiClient } = require('../../src/uploader');
    createApiClient(new URL(url).origin, 'test-token').get(new URL(url).pathname)
        .then(res => done({ ok: true, status: res.status }))
        .catch(err => done({ ok: false, code: err.code }));
} else {
    done({ ok: false, code: `unknown mode ${mode}` });
}
