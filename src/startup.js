const { debugLog } = require('./debug-log');

/**
 * What the app does at launch, once the one-time migrations have run.
 * main.js acts on the answer; keeping the decision here lets it be tested
 * without an Electron runtime.
 *
 *   { action: 'login', notice? }
 *       Open the sign-in window and start nothing else: no API client, no
 *       watcher, no upload queue — so no autoResume and no 30s reconnect
 *       loop — until a sign-in stores a valid host again.
 *   { action: 'resume', serverUrl, token, status }
 *       serverUrl has passed validation; status is verifyToken()'s answer
 *       ('ok', 'network_error' or 'tls_error').
 *
 * The stored host is checked before the token is read, and nothing here
 * sends a request until it has passed.
 */
async function resolveStartup({ auth, uploader, log = debugLog }) {
    let host;
    try {
        host = await auth.enforcePersistedServerUrl();
    } catch (err) {
        // A store we cannot read or write is not a host we have checked.
        // Fail closed: nothing is sent, and the token goes if it can.
        log(`[startup] Could not check the stored server URL, signing out to be safe: ${err.message}`);
        try {
            await auth.clearToken();
        } catch {
            // Already failing closed; the login window is the next step either way.
        }
        return {
            action: 'login',
            notice: 'Quework Desktop could not read its saved server settings and has signed you out. '
                + "Sign in again with your firm's Quework URL.",
        };
    }

    if (!host.ok) {
        return {
            action: 'login',
            notice: `Your saved server address was not accepted — ${host.error}. `
                + 'It has been removed and you have been signed out to protect your account. '
                + "Sign in again with your firm's Quework URL.",
        };
    }

    const token = await auth.getToken();
    if (!token || !host.url) return { action: 'login' };

    const status = await uploader.verifyToken();
    if (status === 'auth_error' || status === 'host_rejected') return { action: 'login' };

    return { action: 'resume', serverUrl: host.url, token, status };
}

module.exports = { resolveStartup };
