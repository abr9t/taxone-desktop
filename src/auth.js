const Store = require('electron-store');

const store = new Store({ name: 'taxone-settings' });
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

function saveServerUrl(url) {
    if (url && !url.includes('localhost') && !url.includes('.test')) {
        url = url.replace(/^http:\/\//, 'https://');
    }
    store.set('serverUrl', url.replace(/\/+$/, ''));
}

module.exports = { getToken, saveToken, clearToken, getServerUrl, saveServerUrl, migrateLegacyHost };
