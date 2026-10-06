/**
 * Decisions the auto-updater acts on, kept free of Electron and of
 * electron-updater so they can be tested on their own. src/updater.js does
 * the wiring.
 */

/**
 * Why restarting now to install an update would lose or disturb work. An
 * empty list means it is safe.
 *
 * Only ever consulted for a restart the app starts itself ("Restart to
 * update" in the tray). Quitting is the user's call and is not gated; an
 * install on quit does not relaunch anything.
 *
 * @param {object} state
 * @param {object|null} state.queue - the MigrationQueue, or null before sign-in
 * @param {number} state.unconfirmedFiles - watch-folder files waiting in the
 *     confirm window. They live only in memory (main.js pendingFiles), so a
 *     restart drops them.
 * @param {number} state.directUploads - confirm-window uploads in flight
 * @returns {string[]} one plain-language reason per blocker
 */
function restartBlockers({ queue, unconfirmedFiles = 0, directUploads = 0 }) {
    const reasons = [];

    if (queue) {
        let stats;
        try {
            stats = queue.getStats();
        } catch (err) {
            // A queue we cannot read is not a queue we know to be empty.
            return [`the upload queue could not be read (${err && err.message})`];
        }
        if (stats.uploading > 0) {
            reasons.push(`${stats.uploading} file(s) uploading`);
        }
        // Between files the queue holds a slot open: the 500 ms throttle
        // before an upload, and the back-off before a retry. No file says
        // "uploading" then, but one is about to.
        if (stats.uploading === 0 && queue.activeUploads > 0) {
            reasons.push('an upload is about to start or retry');
        }
        // Paused counts. autoResume() starts any pending file at launch and
        // ignores a saved pause (BACKLOG.md), so a restart would un-pause.
        if (stats.pending > 0) {
            reasons.push(`${stats.pending} file(s) waiting in the upload queue`);
        }
        // Deliberately not the queue's 'running' flag. MigrationQueue loads
        // its persisted status at construction (migration.js:94), and a quit
        // or crash mid-run leaves 'running' saved. On the next launch
        // autoResume() calls start(), which returns early because the status
        // already says running (migration.js:341): _processNext() never runs
        // and nothing uploads. start() cannot clear it; only pause() (to
        // paused) or clearQueue() (to idle) does. Gating on it would refuse
        // every restart on that install until the user pauses or clears the
        // queue. The three counts above are the work. (BACKLOG.md: reset a
        // persisted 'running' in the constructor.)
    }

    if (unconfirmedFiles > 0) {
        reasons.push(`${unconfirmedFiles} watched file(s) waiting for you to confirm`);
    }
    if (directUploads > 0) {
        reasons.push(`${directUploads} file(s) uploading from the confirm window`);
    }
    return reasons;
}

/**
 * True on the first launch of this version — a fresh install, or the first
 * run after any upgrade, automatic or manual. That session does not check
 * for updates before its first periodic tick, so first sign-in and the first
 * look at a new version are never interrupted by an update notice.
 */
function isFirstLaunchOfVersion(lastLaunchedVersion, currentVersion) {
    return lastLaunchedVersion !== currentVersion;
}

/**
 * What a finished update check means for an update that is already
 * downloaded and waiting to install.
 *
 *   'none'     nothing is downloaded; nothing to decide
 *   'keep'     leave it installable
 *   'withdraw' stop installing it on quit and take it out of the tray
 *
 * Only a SUCCESSFUL check can withdraw, and only when it no longer offers
 * that exact version: the release was deleted or marked prerelease (the
 * latest is now older), latest.yml says stagingPercentage: 0, or a newer
 * version replaced it (offered again once that one has downloaded).
 *
 * A failed check — offline, a 429, a TLS failure, a corrupt latest.yml —
 * says nothing about the release and never withdraws. Neither does a check
 * that did not run (null: the updater is inactive) or an answer without a
 * usable version.
 *
 * @param {string|null} downloadedVersion
 * @param {{ok: true, result: object|null} | {ok: false, error: any}} outcome
 */
function decideAfterCheck(downloadedVersion, outcome) {
    if (!downloadedVersion) return 'none';
    if (!outcome || outcome.ok !== true) return 'keep';

    const result = outcome.result;
    if (!result || typeof result.isUpdateAvailable !== 'boolean') return 'keep';
    const offered = result.updateInfo && result.updateInfo.version;
    if (typeof offered !== 'string' || offered === '') return 'keep';

    return result.isUpdateAvailable && offered === downloadedVersion ? 'keep' : 'withdraw';
}

module.exports = { restartBlockers, isFirstLaunchOfVersion, decideAfterCheck };
