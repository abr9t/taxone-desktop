/**
 * Development launcher — `npm run dev`.
 *
 * The app's API client runs on Node's HTTPS stack, which trusts Node's own
 * bundled CA list and not the Windows certificate store. Laravel Herd installs
 * its local CA into the Windows store only, so a browser trusts
 * https://taxone.test and the app does not.
 *
 * The fix is to add Herd's CA as an extra trust anchor for this process,
 * not to turn verification off: chain and hostname checks stay on, so a dev
 * run exercises the same TLS path as a released build.
 *
 * NODE_EXTRA_CA_CERTS is read once, when the process starts — setting it from
 * inside main.js is too late — so it has to be put in the environment of the
 * Electron process we launch here.
 *
 * This file lives outside src/ on purpose. electron-builder.yml packages
 * src/, assets/, node_modules/ and package.json only, so nothing here can reach
 * a released build. test/dev-launcher.test.js holds that line.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Where Herd for Windows keeps the CA it signs *.test certificates with.
function herdCaPath(home) {
    return path.join(home, '.config', 'herd', 'config', 'valet', 'CA', 'LaravelValetCASelfSigned.crt');
}

/**
 * @returns {{path: string, source: 'environment' | 'herd'} | null}
 */
function resolveExtraCaCerts({ env = process.env, home = os.homedir(), exists = fs.existsSync } = {}) {
    // An explicit choice wins — a developer who already points this at a
    // CA bundle knows something this script does not.
    if (env.NODE_EXTRA_CA_CERTS) {
        return { path: env.NODE_EXTRA_CA_CERTS, source: 'environment' };
    }
    const herd = herdCaPath(home);
    if (exists(herd)) {
        return { path: herd, source: 'herd' };
    }
    return null;
}

function main() {
    const electronPath = require('electron'); // the binary's path, when required from Node
    const env = { ...process.env, NODE_ENV: 'development' };

    const ca = resolveExtraCaCerts();
    if (ca) {
        env.NODE_EXTRA_CA_CERTS = ca.path;
        console.log(`[dev] Trusting extra CA (${ca.source}): ${ca.path}`);
    } else {
        console.warn(`[dev] No Herd CA at ${herdCaPath(os.homedir())} and NODE_EXTRA_CA_CERTS is not set — `
            + 'https://*.test will fail certificate verification. http:// dev hosts and real Quework hosts are unaffected.');
    }

    const child = spawn(electronPath, ['.', ...process.argv.slice(2)], {
        cwd: path.join(__dirname, '..'),
        env,
        stdio: 'inherit',
    });
    child.on('exit', (code, signal) => process.exit(signal ? 1 : code));
}

if (require.main === module) main();

module.exports = { resolveExtraCaCerts, herdCaPath };
