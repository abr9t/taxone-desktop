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

function saveServerUrl(url) {
    // Normalize: strip trailing slash
    store.set('serverUrl', url.replace(/\/+$/, ''));
}

module.exports = { getToken, saveToken, clearToken, getServerUrl, saveServerUrl };
