const path = require('path');
const Store = require('electron-store');

const store = new Store({ name: 'taxone-settings' });

// Tripwire for the userData pin in main.js. The Store above has already
// resolved its directory: if the pin did not run first, it resolved to the
// productName-derived folder, this install looks brand new, and there is
// nothing for migrateLegacyHost() below to find. That failure is otherwise
// completely silent, so make noise about it here.
const EXPECTED_USER_DATA_DIR = 'TaxOne Desktop';
try {
    const actual = require('electron').app.getPath('userData');
    if (path.basename(actual) !== EXPECTED_USER_DATA_DIR) {
        console.error(
            `[auth] userData resolved to "${actual}" but must be pinned to ` +
            `"${EXPECTED_USER_DATA_DIR}" — every existing install's settings and ` +
            'upload queue live there. Check that main.js calls ' +
            "app.setPath('userData', ...) before it requires this module."
        );
    }
} catch {
    // Not running under Electron (unit tests) — nothing to check.
}

const SERVICE_NAME = 'TaxOneDesktop';
const ACCOUNT_NAME = 'api-token';

let keytar = null;

// Try to load keytar — falls back to electron-store if unavailable
// (keytar requires native compilation; electron-store works everywhere)
try {
    keytar = require('keytar');
} catch {
    console.warn('keytar not available — using encrypted electron-store for token storage');
}

async function getToken() {
    if (keytar) {
        try {
            return await keytar.getPassword(SERVICE_NAME, ACCOUNT_NAME);
        } catch {
            // Fall through to store
        }
    }
    return store.get('_token', null);
}

async function saveToken(token) {
    // Always save to electron-store as fallback
    store.set('_token', token);
    if (keytar) {
        try {
            await keytar.setPassword(SERVICE_NAME, ACCOUNT_NAME, token);
        } catch {
            // keytar failed — token is still in electron-store
        }
    }
}

async function clearToken() {
    if (keytar) {
        try {
            await keytar.deletePassword(SERVICE_NAME, ACCOUNT_NAME);
        } catch {
            // ignore
        }
    }
    store.delete('_token');
}

function getServerUrl() {
    return store.get('serverUrl', '');
}

// One-time migration for existing installs persisted against the old
// taxone.cpa host. App updates never touch electron-store (it lives in
// userData, not the install dir), so without this an upgraded install
// keeps calling the old host until the user re-pairs.
//
// Scoped tightly on purpose: exact hostname match only (not a substring
// replace), run once via the _hostMigratedV1 guard, and hardcoded to the
// single firm currently deployed. This stops being universally correct
// once multi-tenant subdomains land, so it must not grow into a general
// rewrite — retire it before then.
const LEGACY_HOSTS = ['taxone.cpa', 'www.taxone.cpa'];
const MIGRATED_HOST = 'https://caputa.quework.app';

function migrateLegacyHost() {
    if (store.get('_hostMigratedV1')) return false;

    const current = store.get('serverUrl', '');
    let migrated = false;
    if (current) {
        try {
            const host = new URL(current).hostname.toLowerCase();
            if (LEGACY_HOSTS.includes(host)) {
                store.set('serverUrl', MIGRATED_HOST);
                migrated = true;
            }
        } catch {
            // Not a parseable URL — leave it untouched.
        }
    }

    store.set('_hostMigratedV1', true);
    return migrated;
}

// ─── Server URL validation ────────────────────────────────────────
//
// The single gate every serverUrl passes through before it is persisted.
//
// taxone-desktop:// is a protocol anyone can put behind a link, and the
// stored host is where the app sends its bearer token on the next launch —
// uploader.configure(serverUrl, token) runs unprompted from whenReady. So an
// unvalidated taxone-desktop://connect?url=https://evil.example is a
// one-click token exfiltration primitive, and the normalisation this
// replaces (force https, strip trailing slashes) did nothing to stop it.
//
// Allowlist, not denylist: a Quework server is https on a single-label
// subdomain of quework.app, full stop.
const QUEWORK_APEX = 'quework.app';
const HOSTNAME_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function devHostsAllowed() {
    try {
        return !require('electron').app.isPackaged;
    } catch {
        return false; // Fail closed if we cannot tell.
    }
}

/**
 * @param {string} input
 * @param {{allowDevHosts?: boolean}} [opts]
 * @returns {{ok: true, url: string} | {ok: false, error: string}}
 *          On success, `url` is the canonical origin to store — callers must
 *          use it rather than the string they passed in.
 */
function validateServerUrl(input, opts = {}) {
    const allowDevHosts = opts.allowDevHosts !== undefined ? opts.allowDevHosts : devHostsAllowed();

    if (typeof input !== 'string' || !input.trim()) {
        return { ok: false, error: 'Enter your Quework URL.' };
    }

    let parsed;
    try {
        parsed = new URL(input.trim());
    } catch {
        return { ok: false, error: `Not a valid URL: ${input.trim()}` };
    }

    // Credentials in the authority exist only to make a hostile host look
    // like a trusted one: https://caputa.quework.app@evil.com is evil.com.
    // new URL() resolves that correctly on its own, but reject it outright
    // so nothing downstream reading the raw string can be fooled either.
    if (parsed.username || parsed.password) {
        return { ok: false, error: 'A Quework URL never contains a username or password.' };
    }

    const host = parsed.hostname.toLowerCase();

    // Same rewrite as migrateLegacyHost(), for links and hand-typed URLs
    // rather than persisted settings. The result is a fixed constant, so
    // accepting either scheme here gives an attacker nothing.
    if (LEGACY_HOSTS.includes(host)) {
        return { ok: true, url: MIGRATED_HOST };
    }

    if (host === 'localhost' || host.endsWith('.test')) {
        if (!allowDevHosts) {
            return { ok: false, error: `Development servers are not allowed in a released build: ${host}` };
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return { ok: false, error: `Unsupported scheme: ${parsed.protocol}` };
        }
        return { ok: true, url: parsed.origin };
    }

    if (parsed.protocol !== 'https:') {
        return { ok: false, error: 'A Quework URL must use https.' };
    }

    const labels = host.split('.');
    if (labels.length !== 3
        || `${labels[1]}.${labels[2]}` !== QUEWORK_APEX
        || !HOSTNAME_LABEL.test(labels[0])) {
        return { ok: false, error: `Not a Quework server: ${host}` };
    }

    return { ok: true, url: `https://${host}` };
}

/**
 * Throws on an invalid URL. Callers that can put a message in front of the
 * user should call validateServerUrl() first and report result.error.
 * @returns {string} the canonical URL that was stored
 */
function saveServerUrl(url) {
    const result = validateServerUrl(url);
    if (!result.ok) throw new Error(result.error);
    store.set('serverUrl', result.url);
    return result.url;
}

module.exports = {
    getToken, saveToken, clearToken,
    getServerUrl, saveServerUrl, validateServerUrl,
    migrateLegacyHost,
};
