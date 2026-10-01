const chokidar = require('chokidar');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');

const store = new Store({ name: 'taxone-settings' });

let watcher = null;

// The default for NEW installs only. Existing installs are pinned to the
// legacy folder by migrateLegacyWatchPath() below.
const DEFAULT_WATCH_PATH = path.join(require('os').homedir(), 'QueworkWatch');
const LEGACY_DEFAULT_WATCH_PATH = path.join(require('os').homedir(), 'TaxoneWatch');

// Allowed file extensions (matches Laravel's allowed upload list)
const ALLOWED_EXTENSIONS = new Set([
    '.pdf', '.jpg', '.jpeg', '.png', '.heic', '.tiff', '.gif', '.webp',
    '.xlsx', '.xls', '.csv', '.doc', '.docx', '.txt', '.zip', '.msg', '.eml',
]);

function getWatchPath() {
    return store.get('watchPath', DEFAULT_WATCH_PATH);
}

function setWatchPath(p) {
    store.set('watchPath', p);
}

// getWatchPath() falls back to DEFAULT_WATCH_PATH rather than persisting it,
// and setWatchPath() only ever runs from the Settings window — so an install
// whose owner never opened Settings has no watchPath key at all and is
// watching whatever the default happened to be when it was built. Renaming
// that default from TaxoneWatch to QueworkWatch silently moves those installs
// off the folder they have been dropping files into for months. The userData
// pin does not help here: there is no stored value to preserve.
//
// So persist the legacy default for anyone who is demonstrably using it.
// A fresh install has no ~/TaxoneWatch and gets QueworkWatch as intended.
function migrateLegacyWatchPath() {
    if (store.get('_watchPathMigratedV1')) return false;

    let migrated = false;
    if (!store.get('watchPath') && fs.existsSync(LEGACY_DEFAULT_WATCH_PATH)) {
        store.set('watchPath', LEGACY_DEFAULT_WATCH_PATH);
        migrated = true;
    }

    store.set('_watchPathMigratedV1', true);
    return migrated;
}

function getMoveAfterUpload() {
    return store.get('moveAfterUpload', true);
}

function setMoveAfterUpload(v) {
    store.set('moveAfterUpload', !!v);
}

/**
 * Check if a file path is inside an "Uploaded" folder at any level.
 * Handles both forward and back slashes (Windows compatibility).
 */
function isInUploadedFolder(filePath) {
    const normalized = filePath.replace(/\\/g, '/');
    return /\/Uploaded\//i.test(normalized);
}

function isInCancelledFolder(filePath) {
    const normalized = filePath.replace(/\\/g, '/');
    return /\/Cancelled\//i.test(normalized);
}

/**
 * Parse folder structure to extract client hint and folder hint.
 */
function parseFileInfo(filePath) {
    // Skip files in Uploaded/Cancelled folders (Windows backslash-safe)
    if (isInUploadedFolder(filePath) || isInCancelledFolder(filePath)) {
        return null;
    }

    const watchPath = getWatchPath();
    const relative = path.relative(watchPath, filePath);
    const parts = relative.split(path.sep);
    const fileName = parts.pop();

    // Skip hidden/temp files
    if (fileName.startsWith('.') || fileName.startsWith('~')) {
        return null;
    }

    // Check extension
    const ext = path.extname(fileName).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
        return null;
    }

    let clientHint = null;
    let folderHint = null;

    if (parts.length >= 1) {
        if (parts[0].toLowerCase() === 'uploaded' || parts[0].toLowerCase() === 'cancelled') return null;
        clientHint = parts[0];
    }
    if (parts.length >= 2) {
        folderHint = parts.slice(1).join('/');
    }

    return { filePath, fileName, clientHint, folderHint };
}

function start(onFile) {
    stop();

    const watchPath = getWatchPath();

    if (!fs.existsSync(watchPath)) {
        try {
            fs.mkdirSync(watchPath, { recursive: true });
        } catch (err) {
            console.error('Failed to create watch folder:', err);
            return;
        }
    }

    watcher = chokidar.watch(watchPath, {
        ignored: [
            /(^|[\/\\])\./,
            '**/*.tmp',
            '**/*.crdownload',
            '**/*~',
        ],
        persistent: true,
        ignoreInitial: true,
        awaitWriteFinish: {
            stabilityThreshold: 1500,
            pollInterval: 200,
        },
        depth: 5,
    });

    watcher.on('add', (filePath) => {
        const info = parseFileInfo(filePath);
        if (info) {
            console.log(`[watcher] New file: ${info.fileName} (client: ${info.clientHint || 'none'})`);
            onFile(info);
        }
    });

    watcher.on('error', (err) => {
        console.error('[watcher] Error:', err);
    });

    console.log(`[watcher] Watching: ${watchPath}`);
}

function stop() {
    if (watcher) {
        watcher.close();
        watcher = null;
    }
}

function moveToUploaded(filePath) {
    try {
        const dir = path.dirname(filePath);
        const uploadedDir = path.join(dir, 'Uploaded');

        if (!fs.existsSync(uploadedDir)) {
            fs.mkdirSync(uploadedDir, { recursive: true });
        }

        let finalDest = path.join(uploadedDir, path.basename(filePath));
        let i = 1;
        while (fs.existsSync(finalDest)) {
            const ext = path.extname(filePath);
            const stem = path.basename(filePath, ext);
            finalDest = path.join(uploadedDir, `${stem} (${i})${ext}`);
            i++;
        }

        fs.renameSync(filePath, finalDest);
        console.log(`[watcher] Moved to: ${finalDest}`);
    } catch (err) {
        console.error('[watcher] Failed to move file:', err);
    }
}

function moveToCancelled(filePath) {
    try {
        const dir = path.dirname(filePath);
        const cancelledDir = path.join(dir, 'Cancelled');

        if (!fs.existsSync(cancelledDir)) {
            fs.mkdirSync(cancelledDir, { recursive: true });
        }

        let finalDest = path.join(cancelledDir, path.basename(filePath));
        let i = 1;
        while (fs.existsSync(finalDest)) {
            const ext = path.extname(filePath);
            const stem = path.basename(filePath, ext);
            finalDest = path.join(cancelledDir, `${stem} (${i})${ext}`);
            i++;
        }

        fs.renameSync(filePath, finalDest);
        console.log(`[watcher] Cancelled to: ${finalDest}`);
    } catch (err) {
        console.error('[watcher] Failed to cancel file:', err);
    }
}

module.exports = { start, stop, getWatchPath, setWatchPath, migrateLegacyWatchPath, getMoveAfterUpload, setMoveAfterUpload, moveToUploaded, moveToCancelled };
