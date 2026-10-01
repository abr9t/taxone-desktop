const { debugLog } = require('./debug-log');

/**
 * One tick of the reconnect loop main.js runs every 30s: once the server
 * answers again, retry the files that failed while it did not.
 *
 * Never rejects. It runs from setInterval in the main process, where a
 * rejection has no handler — and uploader.verifyToken() builds its client
 * through createApiClient(), which refuses a stored host that fails
 * validation. That refusal has to end here as a quiet "not now", not as an
 * unhandled rejection, and it must never lead to retrying uploads.
 *
 * @returns {Promise<string>} what happened, for tests and logs
 */
async function retryFailedIfOnline(queue, uploader, log = debugLog) {
    try {
        if (!queue) return 'no-queue';
        const stats = queue.getStats();
        if (!(stats.failed > 0 && stats.queueStatus === 'idle')) return 'nothing-to-retry';

        const status = await uploader.verifyToken();
        if (status === 'ok') {
            queue.retryAllFailed();
            return 'retried';
        }
        return status;
    } catch (err) {
        log(`[reconnect] Check failed, will try again: ${err && err.message}`);
        return 'error';
    }
}

module.exports = { retryFailedIfOnline };
