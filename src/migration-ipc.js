/**
 * migration-ipc.js — IPC handler registration for file upload
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
const { MAX_FILE_SIZE } = require('./migration');

/**
 * @param {MigrationQueue} queue
 * @param {Function} getWindow - () => BrowserWindow|null (getter since window may not exist yet)
 * @param {object} uploader - the existing uploader.js module instance
 */
function registerMigrationIPC(queue, getWindow, uploader) {

    ipcMain.handle('migration:scan-folders', async (_event, folderPaths) => {
        const clientFolders = folderPaths.map(p => queue.scanClientFolder(p));
        return { clientFolders };
    });

    ipcMain.handle('migration:scan-files', async (_event, filePaths) => {
        const files = filePaths.map(fp => {
            let size = 0;
            try { size = fs.statSync(fp).size; } catch { /* ignore */ }
            const entry = {
                relativePath: path.basename(fp),
                absolutePath: fp,
                size,
            };
            if (size > MAX_FILE_SIZE) entry.oversized = true;
            return entry;
        });
        return { name: '(loose files)', path: null, files };
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

    ipcMain.handle('migration:clear-by-status', async (_event, status) => {
        queue.clearByStatus(status);
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

    ipcMain.handle('migration:flush-save', async () => {
        queue.flushSave();
    });

    ipcMain.handle('migration:get-last-client', async () => {
        return queue.getLastClient();
    });

    ipcMain.handle('migration:set-last-client', async (_event, client) => {
        queue.setLastClient(client);
    });

    ipcMain.handle('migration:select-folder', async () => {
        const win = getWindow() || BrowserWindow.getFocusedWindow();
        const result = await dialog.showOpenDialog(win, {
            properties: ['openDirectory'],
            title: 'Select Folder',
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
        const data = await uploader.searchClients('', 9999);
        return data.clients || data || [];
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
        return uploader.uploadFile(file.absolutePath, file.clientId, file.folderPath || '', file.filename);
    };
}

module.exports = { registerMigrationIPC, createMigrationUploadFn };
