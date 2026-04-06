/**
 * migration.js — File Migration Tool queue engine
 *
 * Manages a persistent queue of files for bulk migration from Canopy → TaxOne.
 * Queue is saved to disk via electron-store and survives restarts.
 *
 * Lifecycle: scan folder → match clients → enqueue → upload (concurrent) → done
 */

const path = require('path');
const fs = require('fs');
const Store = require('electron-store');
const { randomUUID } = require('crypto');

// Fuzzy matching — simple Levenshtein-based
function levenshtein(a, b) {
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i][j] = a[i - 1] === b[j - 1]
                ? dp[i - 1][j - 1]
                : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
        }
    }
    return dp[m][n];
}

function normalizeForMatch(str) {
    return str.toLowerCase().replace(/[^a-z0-9]/g, '').trim();
}

/**
 * Status flow: pending → uploading → completed | failed
 * Failed items can be retried → back to pending
 */
const FILE_STATUS = {
    PENDING: 'pending',
    UPLOADING: 'uploading',
    COMPLETED: 'completed',
    FAILED: 'failed',
    SKIPPED: 'skipped',
};

const QUEUE_STATUS = {
    IDLE: 'idle',
    RUNNING: 'running',
    PAUSED: 'paused',
};

class MigrationQueue {
    /**
     * @param {object} opts
     * @param {Function} opts.uploadFn - (file) => Promise<{document_id, filename, path}>
     * @param {Function} opts.onProgress - (stats) => void — called on every status change
     * @param {Function} opts.onFileUpdate - (file) => void — called when a single file changes
     * @param {number} [opts.concurrency=3] - max simultaneous uploads
     * @param {number} [opts.maxRetries=3] - max retries per file before giving up
     */
    constructor(opts) {
        this.store = new Store({
            name: 'migration-queue',
            defaults: {
                files: [],        // Array of file entries
                status: QUEUE_STATUS.IDLE,
                history: [],      // Completed upload records (kept separate for perf)
            },
        });

        this.uploadFn = opts.uploadFn;
        this.onProgress = opts.onProgress || (() => {});
        this.onFileUpdate = opts.onFileUpdate || (() => {});
        this.concurrency = opts.concurrency || 3;
        this.maxRetries = opts.maxRetries || 3;

        this.activeUploads = 0;
        this._status = this.store.get('status', QUEUE_STATUS.IDLE);

        // On construct, reset any files stuck in 'uploading' (from a crash) back to pending
        this._recoverCrashedUploads();
    }

    // ── Getters ──────────────────────────────────────────────────────────

    get files() {
        return this.store.get('files', []);
    }

    get history() {
        return this.store.get('history', []);
    }

    get status() {
        return this._status;
    }

    getStats() {
        const files = this.files;
        const total = files.length;
        const completed = files.filter(f => f.status === FILE_STATUS.COMPLETED).length;
        const failed = files.filter(f => f.status === FILE_STATUS.FAILED).length;
        const pending = files.filter(f => f.status === FILE_STATUS.PENDING).length;
        const uploading = files.filter(f => f.status === FILE_STATUS.UPLOADING).length;
        const skipped = files.filter(f => f.status === FILE_STATUS.SKIPPED).length;

        return {
            total,
            completed,
            failed,
            pending,
            uploading,
            skipped,
            queueStatus: this._status,
            percent: total > 0 ? Math.round((completed / total) * 100) : 0,
        };
    }

    // ── Scanning & Enqueueing ────────────────────────────────────────────

    /**
     * Scan a dropped folder and return a tree of discovered files grouped by client folder name.
     * Does NOT enqueue yet — returns the scan result for client matching UI.
     *
     * Expected structure: rootFolder/ClientName/optional-subfolder/file.pdf
     *
     * @param {string} rootPath - path to the dropped root folder
     * @returns {{ clientFolders: Array<{name, files: Array<{relativePath, absolutePath, size}>}> }}
     */
    scanFolder(rootPath) {
        const clientFolders = [];
        const entries = fs.readdirSync(rootPath, { withFileTypes: true });

        for (const entry of entries) {
            if (!entry.isDirectory()) continue; // skip loose files at root
            if (entry.name.startsWith('.')) continue; // skip hidden

            const clientDir = path.join(rootPath, entry.name);
            const files = this._walkDir(clientDir, clientDir);

            if (files.length > 0) {
                clientFolders.push({
                    name: entry.name,
                    path: clientDir,
                    files,
                });
            }
        }

        return { clientFolders };
    }

    /**
     * Recursively walk a directory and return relative file paths.
     */
    _walkDir(dir, baseDir) {
        const results = [];
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return results;
        }

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (!entry.name.startsWith('.')) {
                    results.push(...this._walkDir(fullPath, baseDir));
                }
            } else {
                const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
                let size = 0;
                try { size = fs.statSync(fullPath).size; } catch { /* ignore */ }
                results.push({ relativePath, absolutePath: fullPath, size });
            }
        }

        return results;
    }

    /**
     * Match scanned client folder names against TaxOne clients.
     *
     * @param {Array<{name}>} scannedFolders - from scanFolder result
     * @param {Array<{id, name}>} taxoneClients - from API
     * @returns {Array<{folderName, matchType, client: {id, name}|null, candidates: Array}>}
     */
    matchClients(scannedFolders, taxoneClients) {
        const results = [];

        for (const folder of scannedFolders) {
            const normalizedFolder = normalizeForMatch(folder.name);

            // Exact match (case-insensitive, stripped)
            const exact = taxoneClients.find(c => normalizeForMatch(c.name) === normalizedFolder);
            if (exact) {
                results.push({
                    folderName: folder.name,
                    matchType: 'exact',
                    client: exact,
                    candidates: [],
                });
                continue;
            }

            // Fuzzy match — find top 3 closest
            const scored = taxoneClients.map(c => ({
                ...c,
                distance: levenshtein(normalizedFolder, normalizeForMatch(c.name)),
            }));
            scored.sort((a, b) => a.distance - b.distance);

            // Threshold: distance <= 30% of folder name length = "close enough" to suggest
            const threshold = Math.max(3, Math.ceil(normalizedFolder.length * 0.3));
            const candidates = scored.filter(c => c.distance <= threshold).slice(0, 3);

            if (candidates.length === 1 && candidates[0].distance <= 2) {
                // Very close single match — auto-suggest but still mark fuzzy
                results.push({
                    folderName: folder.name,
                    matchType: 'fuzzy',
                    client: candidates[0],
                    candidates,
                });
            } else {
                results.push({
                    folderName: folder.name,
                    matchType: candidates.length > 0 ? 'fuzzy' : 'unmatched',
                    client: null,
                    candidates,
                });
            }
        }

        return results;
    }

    /**
     * Enqueue files for upload after client matching is confirmed.
     *
     * @param {Array<{clientId, clientName, folderName, files: Array<{relativePath, absolutePath, size}>}>} mappings
     */
    enqueue(mappings) {
        const existing = this.files;

        for (const mapping of mappings) {
            for (const file of mapping.files) {
                // Dedupe by absolutePath
                if (existing.some(e => e.absolutePath === file.absolutePath)) continue;

                existing.push({
                    id: randomUUID(),
                    absolutePath: file.absolutePath,
                    relativePath: file.relativePath,
                    size: file.size,
                    clientId: mapping.clientId,
                    clientName: mapping.clientName,
                    folderName: mapping.folderName,
                    // folder_path sent to API: the subfolder portion within the client folder
                    // e.g. if relativePath is "2024/Tax Returns/1040.pdf", folderPath = "2024/Tax Returns"
                    folderPath: path.dirname(file.relativePath).replace(/\\/g, '/'),
                    filename: path.basename(file.relativePath),
                    status: FILE_STATUS.PENDING,
                    retries: 0,
                    error: null,
                    documentId: null,   // set after successful upload
                    uploadedAt: null,
                });
            }
        }

        this.store.set('files', existing);
        this.onProgress(this.getStats());
    }

    // ── Queue Control ────────────────────────────────────────────────────

    start() {
        if (this._status === QUEUE_STATUS.RUNNING) return;
        this._status = QUEUE_STATUS.RUNNING;
        this.store.set('status', QUEUE_STATUS.RUNNING);
        this.onProgress(this.getStats());
        this._processNext();
    }

    pause() {
        this._status = QUEUE_STATUS.PAUSED;
        this.store.set('status', QUEUE_STATUS.PAUSED);
        this.onProgress(this.getStats());
    }

    /**
     * Auto-resume: call on app start to pick up where we left off.
     */
    autoResume() {
        const stats = this.getStats();
        if (stats.pending > 0 || stats.uploading > 0) {
            this.start();
            return true;
        }
        return false;
    }

    /**
     * Retry a single failed file.
     */
    retryFile(fileId) {
        const files = this.files;
        const file = files.find(f => f.id === fileId);
        if (!file || file.status !== FILE_STATUS.FAILED) return;

        file.status = FILE_STATUS.PENDING;
        file.error = null;
        this.store.set('files', files);
        this.onFileUpdate(file);
        this.onProgress(this.getStats());

        if (this._status === QUEUE_STATUS.RUNNING) {
            this._processNext();
        }
    }

    /**
     * Retry all failed files.
     */
    retryAllFailed() {
        const files = this.files;
        let changed = false;

        for (const file of files) {
            if (file.status === FILE_STATUS.FAILED) {
                file.status = FILE_STATUS.PENDING;
                file.error = null;
                changed = true;
            }
        }

        if (changed) {
            this.store.set('files', files);
            this.onProgress(this.getStats());
            if (this._status === QUEUE_STATUS.RUNNING) {
                this._processNext();
            }
        }
    }

    /**
     * Skip a file (won't be uploaded).
     */
    skipFile(fileId) {
        const files = this.files;
        const file = files.find(f => f.id === fileId);
        if (!file || file.status === FILE_STATUS.COMPLETED) return;

        file.status = FILE_STATUS.SKIPPED;
        this.store.set('files', files);
        this.onFileUpdate(file);
        this.onProgress(this.getStats());
    }

    /**
     * Clear the queue (completed + failed + pending). Keeps history.
     */
    clearQueue() {
        this._status = QUEUE_STATUS.IDLE;
        this.store.set('status', QUEUE_STATUS.IDLE);
        this.store.set('files', []);
        this.onProgress(this.getStats());
    }

    // ── Internal Processing ──────────────────────────────────────────────

    _recoverCrashedUploads() {
        const files = this.files;
        let changed = false;

        for (const file of files) {
            if (file.status === FILE_STATUS.UPLOADING) {
                file.status = FILE_STATUS.PENDING;
                changed = true;
            }
        }

        if (changed) {
            this.store.set('files', files);
        }
    }

    _processNext() {
        if (this._status !== QUEUE_STATUS.RUNNING) return;

        const files = this.files;
        const pending = files.filter(f => f.status === FILE_STATUS.PENDING);

        // Fill up to concurrency limit
        while (this.activeUploads < this.concurrency && pending.length > 0) {
            const file = pending.shift();
            this.activeUploads++;
            this._uploadFile(file);
        }

        // Check if we're done
        if (this.activeUploads === 0 && pending.length === 0) {
            const stats = this.getStats();
            if (stats.pending === 0 && stats.uploading === 0) {
                this._status = QUEUE_STATUS.IDLE;
                this.store.set('status', QUEUE_STATUS.IDLE);
                this.onProgress(this.getStats());
            }
        }
    }

    async _uploadFile(file) {
        // Mark as uploading
        this._updateFile(file.id, { status: FILE_STATUS.UPLOADING, error: null });

        try {
            // Check file still exists on disk
            if (!fs.existsSync(file.absolutePath)) {
                throw new Error('File no longer exists on disk');
            }

            const result = await this.uploadFn({
                absolutePath: file.absolutePath,
                clientId: file.clientId,
                folderPath: file.folderPath === '.' ? '' : file.folderPath,
                filename: file.filename,
            });

            // Success
            this._updateFile(file.id, {
                status: FILE_STATUS.COMPLETED,
                documentId: result.document_id,
                uploadedAt: new Date().toISOString(),
            });

            // Add to history
            const history = this.history;
            history.unshift({
                id: file.id,
                filename: file.filename,
                clientName: file.clientName,
                clientId: file.clientId,
                documentId: result.document_id,
                uploadedAt: new Date().toISOString(),
            });
            // Keep history capped at 5000
            if (history.length > 5000) history.length = 5000;
            this.store.set('history', history);

        } catch (err) {
            const retries = (file.retries || 0) + 1;
            const isRetryable = this._isRetryableError(err);

            if (isRetryable && retries <= this.maxRetries) {
                // Exponential backoff: 2s, 4s, 8s
                const delay = Math.pow(2, retries) * 1000;
                this._updateFile(file.id, {
                    status: FILE_STATUS.PENDING,
                    retries,
                    error: `Retry ${retries}/${this.maxRetries}: ${err.message}`,
                });

                setTimeout(() => {
                    this.activeUploads--;
                    this._processNext();
                }, delay);
                return; // Don't decrement activeUploads below
            }

            // Permanent failure
            this._updateFile(file.id, {
                status: FILE_STATUS.FAILED,
                retries,
                error: err.message || 'Upload failed',
            });
        }

        this.activeUploads--;
        this._processNext();
    }

    _isRetryableError(err) {
        if (!err) return false;
        // Network errors, timeouts, 5xx
        if (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT') return true;
        if (err.code === 'ENOTFOUND') return true;
        if (err.response && err.response.status >= 500) return true;
        if (err.message && err.message.includes('timeout')) return true;
        return false;
    }

    _updateFile(fileId, updates) {
        const files = this.files;
        const idx = files.findIndex(f => f.id === fileId);
        if (idx === -1) return;

        Object.assign(files[idx], updates);
        this.store.set('files', files);
        this.onFileUpdate(files[idx]);
        this.onProgress(this.getStats());
    }
}

module.exports = { MigrationQueue, FILE_STATUS, QUEUE_STATUS };
