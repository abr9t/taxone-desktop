const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const auth = require('./auth');

let apiClient = null;

async function getClient() {
    if (apiClient) return apiClient;

    const serverUrl = auth.getServerUrl();
    const token = await auth.getToken();

    if (!serverUrl || !token) {
        throw new Error('Not authenticated. Please sign in.');
    }

    apiClient = axios.create({
        baseURL: serverUrl,
        timeout: 300000,
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
        },
    });

    return apiClient;
}

function configure(serverUrl, token) {
    apiClient = axios.create({
        baseURL: serverUrl.replace(/\/+$/, ''),
        timeout: 300000,
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
        },
    });
}

async function verifyToken() {
    try {
        const client = await getClient();
        const res = await client.get('/api/desktop/clients', { params: { search: '', limit: 1 } });
        return res.status === 200;
    } catch {
        apiClient = null;
        return false;
    }
}

async function verifyTokenWith(serverUrl, token) {
    try {
        const url = `${serverUrl.replace(/\/+$/, '')}/api/desktop/clients`;
        const res = await axios.get(url, {
            params: { search: '', limit: 1 },
            timeout: 10000,
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/json',
            },
        });
        return res.status === 200;
    } catch {
        return false;
    }
}

async function searchClients(query, limit) {
    const client = await getClient();
    const params = { search: query || '' };
    if (limit) params.limit = limit;
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

module.exports = { configure, verifyToken, verifyTokenWith, searchClients, fetchFolders, uploadFile };
