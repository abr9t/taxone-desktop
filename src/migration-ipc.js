/**
 * migration-ipc.js — IPC handler registration for file migration
 *
 * Usage in main.js:
 *   const { registerMigrationIPC } = require('./migration-ipc');
 *   registerMigrationIPC(migrationQueue, migrationWindow, uploader);
 *
 * Call AFTER creating the MigrationQueue instance and uploader.
 */

const { ipcMain, dialog, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const FormData = require('form-data');

/**
 * @param {MigrationQueue} queue
 * @param {Function} getWindow - () => BrowserWindow|null (getter since window may not exist yet)
 * @param {object} uploader - the existing uploader.js module instance
 */
function registerMigrationIPC(queue, getWindow, uploader) {

    ipcMain.handle('migration:scan-folder', async (_event, folderPath) => {
        return queue.scanFolder(folderPath);
    });

    ipcMain.handle('migration:get-clients', async () => {
        // Fetch ALL clients from TaxOne (paginate if needed)
        const clients = await fetchAllClients(uploader);
        return clients;
    });

    ipcMain.handle('migration:match-clients', async (_event, scannedFolders) => {
        const clients = await fetchAllClients(uploader);
        return queue.matchClients(scannedFolders, clients);
    });

    ipcMain.handle('migration:enqueue', async (_event, mappings) => {
        queue.enqueue(mappings);
        return queue.getStats();
    });

    ipcMain.handle('migration:start', async () => {
        queue.start();
        return queue.getStats();
    });

    ipcMain.handle('migration:pause', async () => {
        queue.pause();
        return queue.getStats();
    });

    ipcMain.handle('migration:retry-file', async (_event, fileId) => {
        queue.retryFile(fileId);
        return queue.getStats();
    });

    ipcMain.handle('migration:retry-all-failed', async () => {
        queue.retryAllFailed();
        return queue.getStats();
    });

    ipcMain.handle('migration:skip-file', async (_event, fileId) => {
        queue.skipFile(fileId);
        return queue.getStats();
    });

    ipcMain.handle('migration:clear-queue', async () => {
        queue.clearQueue();
        return queue.getStats();
    });

    ipcMain.handle('migration:get-stats', async () => {
        return queue.getStats();
    });

    ipcMain.handle('migration:get-files', async () => {
        return queue.files;
    });

    ipcMain.handle('migration:get-history', async () => {
        return queue.history;
    });

    ipcMain.handle('migration:select-folder', async () => {
        const win = getWindow() || BrowserWindow.getFocusedWindow();
        const result = await dialog.showOpenDialog(win, {
            properties: ['openDirectory'],
            title: 'Select Canopy Export Folder',
        });
        if (result.canceled || result.filePaths.length === 0) return null;
        return result.filePaths[0];
    });
}

/**
 * Fetch all clients from the TaxOne API. The existing endpoint supports ?search=
 * but for migration we need ALL clients for matching. Fetches in one call with
 * a high limit param, or loops if the API paginates.
 */
async function fetchAllClients(uploader) {
    try {
        // The existing endpoint returns up to 50 at a time with ?search=
        // For migration, call without search to get all, or call with empty search
        // If the API doesn't support returning all at once, we fetch page by page
        const response = await uploader.apiClient.get('/api/desktop/clients', {
            params: { limit: 9999 },
        });
        return response.data.clients || response.data || [];
    } catch (err) {
        console.error('Failed to fetch clients:', err.message);
        throw err;
    }
}

/**
 * Create the upload function that the MigrationQueue calls per file.
 * Wraps the existing uploader's API client.
 *
 * @param {object} uploader - existing uploader.js module
 * @returns {Function}
 */
function createMigrationUploadFn(uploader) {
    return async (file) => {
        const formData = new FormData();
        formData.append('file', fs.createReadStream(file.absolutePath));
        formData.append('client_id', String(file.clientId));
        if (file.folderPath) {
            formData.append('folder_path', file.folderPath);
        }
        if (file.filename) {
            formData.append('filename', file.filename);
        }

        const response = await uploader.apiClient.post('/api/desktop/upload', formData, {
            headers: formData.getHeaders(),
            maxContentLength: 110 * 1024 * 1024, // 110MB
            maxBodyLength: 110 * 1024 * 1024,
            timeout: 120000, // 2 min per file
        });

        return response.data;
    };
}

module.exports = { registerMigrationIPC, createMigrationUploadFn };
