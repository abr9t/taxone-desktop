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

    return axios.create({
        baseURL: check.url,
        timeout,
        httpsAgent,
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
        },
    });
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
        const status = err.response?.status;
        console.error('[verifyToken] failed:', status || err.code || err.message);
        // 401/403 = token is invalid → must re-login
        if (status === 401 || status === 403) return 'auth_error';
        // Network/SSL/timeout = server unreachable → don't force re-login
        return 'network_error';
    }
}

async function verifyTokenWith(serverUrl, token) {
    try {
        const client = createApiClient(serverUrl, token, { timeout: 10000 });
        const res = await client.get('/api/desktop/clients', { params: { search: '', limit: 1 } });
        return res.status === 200;
    } catch {
        return false;
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
    createApiClient, HostRejectedError,
    configure, verifyToken, verifyTokenWith, searchClients, fetchFolders, uploadFile,
};
