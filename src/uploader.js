const axios = require('axios');
const fs = require('fs');
const https = require('https');
const path = require('path');
const FormData = require('form-data');
const auth = require('./auth');
const { debugLog } = require('./debug-log');

// ─── The one place an API client is built ─────────────────────────
//
// Every request this app makes to a Quework server goes through
// createApiClient(). Two guarantees live here and nowhere else:
//
//  1. The host is validated every time a client is built, not only when it
//     is saved. The stored serverUrl is where the bearer token goes, and an
//     install can be carrying one that predates validation.
//  2. Certificate verification is pinned on. An explicit rejectUnauthorized
//     on the agent wins over NODE_TLS_REJECT_UNAUTHORIZED=0 inherited from the
//     user's environment, which would otherwise switch verification off for
//     every Node HTTPS call. Dev servers are reached by adding a trust anchor
//     (NODE_EXTRA_CA_CERTS, set by scripts/dev.js), never by relaxing this.
//
// keepAlive matches the Node 20 global agent this replaces.
const httpsAgent = new https.Agent({ keepAlive: true, rejectUnauthorized: true });

// Node's codes for a server certificate it would not accept. On a network that
// re-signs TLS (corporate inspection, some firewalls and antivirus) every
// request fails with one of these, because Node does not read the Windows
// store the inspecting CA was pushed to. Without a name for it, that reads as
// "Invalid token" at sign-in and as a raw OpenSSL string in the upload queue.
const CERTIFICATE_ERROR_CODES = new Set([
    'UNABLE_TO_GET_ISSUER_CERT',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'CERT_UNTRUSTED',
    'CERT_HAS_EXPIRED',
    'CERT_NOT_YET_VALID',
    'CERT_REVOKED',
    'CERT_SIGNATURE_FAILURE',
    'ERR_TLS_CERT_ALTNAME_INVALID',
]);

function isCertificateError(err) {
    return !!err && CERTIFICATE_ERROR_CODES.has(err.code);
}

// Kept clear of the words MigrationQueue._isRetryableError() looks for
// ("SSL", "timeout"): retrying cannot fix a certificate.
function describeCertificateError(host, code) {
    return `Quework Desktop could not verify the security certificate of ${host}`
        + `${code ? ` (${code})` : ''}, so nothing was sent. If your office network inspects `
        + `encrypted traffic, ask your IT team to exempt ${host}.`;
}

class HostRejectedError extends Error {
    constructor(message) {
        super(message);
        this.name = 'HostRejectedError';
        this.code = 'E_HOST_REJECTED';
    }
}

/**
 * @throws {HostRejectedError} if serverUrl fails validateServerUrl — before
 *         anything is sent anywhere.
 */
function createApiClient(serverUrl, token, { timeout = 300000 } = {}) {
    const check = auth.validateServerUrl(serverUrl);
    if (!check.ok) throw new HostRejectedError(check.error);

    const client = axios.create({
        baseURL: check.url,
        timeout,
        httpsAgent,
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
        },
    });

    // Every caller shows err.message somewhere — the sign-in window, the
    // confirm window, a queue row — so name the problem here, once. err.code
    // is left alone for code that branches on it.
    const host = new URL(check.url).host;
    client.interceptors.response.use(undefined, (err) => {
        if (isCertificateError(err)) {
            debugLog(`[tls] Certificate verification failed for ${host}: ${err.code}`);
            err.message = describeCertificateError(host, err.code);
        }
        return Promise.reject(err);
    });

    return client;
}

let apiClient = null;

async function getClient() {
    if (apiClient) return apiClient;

    const serverUrl = auth.getServerUrl();
    const token = await auth.getToken();

    if (!serverUrl || !token) {
        const err = new Error('Not authenticated. Please sign in.');
        err.code = 'E_NOT_AUTHENTICATED';
        throw err;
    }

    apiClient = createApiClient(serverUrl, token);
    return apiClient;
}

function configure(serverUrl, token) {
    apiClient = createApiClient(serverUrl, token);
}

// Never throws: the 30s reconnect loop and startup both call this, and a
// rejection there has nowhere to go.
async function verifyToken() {
    try {
        const client = await getClient();
        const res = await client.get('/api/desktop/clients', { params: { search: '', limit: 1 } });
        return res.status === 200 ? 'ok' : 'auth_error';
    } catch (err) {
        apiClient = null;
        if (err.code === 'E_HOST_REJECTED') {
            debugLog(`[verifyToken] Stored server URL rejected, nothing sent: ${err.message}`);
            return 'host_rejected';
        }
        if (err.code === 'E_NOT_AUTHENTICATED') return 'auth_error';
        // Not a bad token and not "offline": the token may be fine, but no
        // request will get through until the certificate problem is fixed.
        if (isCertificateError(err)) return 'tls_error';
        const status = err.response?.status;
        console.error('[verifyToken] failed:', status || err.code || err.message);
        // 401/403 = token is invalid → must re-login
        if (status === 401 || status === 403) return 'auth_error';
        // Network/SSL/timeout = server unreachable → don't force re-login
        return 'network_error';
    }
}

/**
 * @returns {Promise<{ok: boolean, error: string|null}>} error is set only
 *          when there is something more specific to say than "invalid token".
 */
async function verifyTokenWith(serverUrl, token) {
    try {
        const client = createApiClient(serverUrl, token, { timeout: 10000 });
        const res = await client.get('/api/desktop/clients', { params: { search: '', limit: 1 } });
        return { ok: res.status === 200, error: null };
    } catch (err) {
        return { ok: false, error: isCertificateError(err) ? err.message : null };
    }
}

async function searchClients(query, limit, includeAll) {
    const client = await getClient();
    const params = { search: query || '' };
    if (limit) params.limit = limit;
    if (includeAll) params.include_all = true;
    const res = await client.get('/api/desktop/clients', { params });
    return res.data;
}

/**
 * Fetch folder tree for a client.
 * @returns {{ folders: Array<{ id, name, path }> }}
 */
async function fetchFolders(clientId, parentId) {
    const client = await getClient();
    const params = {};
    if (parentId) params.parent_id = parentId;
    const res = await client.get(`/api/desktop/clients/${clientId}/folders`, { params });
    return res.data;
}

async function uploadFile(filePath, clientId, folderPath, filename) {
    const client = await getClient();

    const form = new FormData();
    form.append('client_id', String(clientId));
    if (folderPath) {
        form.append('folder_path', folderPath);
    }
    if (filename) {
        form.append('filename', filename);
    }
    form.append('file', fs.createReadStream(filePath), {
        filename: filename || path.basename(filePath),
    });

    const res = await client.post('/api/desktop/upload', form, {
        headers: {
            ...form.getHeaders(),
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
    });

    return res.data;
}

module.exports = {
    createApiClient, HostRejectedError, isCertificateError, describeCertificateError,
    configure, verifyToken, verifyTokenWith, searchClients, fetchFolders, uploadFile,
};
