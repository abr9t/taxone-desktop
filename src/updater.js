/**
 * Automatic updates through electron-updater — see ARCHITECTURE.md,
 * "Releases and auto-update".
 *
 * Downloads in the background and never restarts the app on its own. A
 * downloaded update installs when the user quits, or when they pick
 * "Restart to Update" in the tray and nothing is uploading or waiting
 * (update-policy.restartBlockers).
 *
 * Nothing here may throw into the main process or reject unhandled: every
 * entry point catches, logs to debug.log and carries on. Main.js wires it
 * up; the updater, the clock and the UI hooks are injected so the tests
 * drive this without Electron.
 */
const { debugLog } = require('./debug-log');
const { restartBlockers, decideAfterCheck } = require('./update-policy');

const FIRST_CHECK_DELAY_MS = 5 * 60 * 1000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

const message = err => (err && err.message) || String(err);

/**
 * The settings every check runs under. allowDowngrade goes last on
 * purpose: assigning `channel` silently turns it on, and nothing here may
 * ever assign `channel`.
 */
function configureUpdater(updater, log = debugLog) {
    updater.logger = {
        info: m => log(`[updater] ${m}`),
        warn: m => log(`[updater] warn: ${m}`),
        error: m => log(`[updater] error: ${m}`),
        debug: () => {},
    };
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    // Only the full installer named in latest.yml; never a web-installer
    // package fetched from elsewhere.
    updater.disableWebInstaller = true;
    // electron-updater turns prerelease on for any build whose own version
    // has a prerelease tag (1.3.0-beta.1). Releases only, always.
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
}

/**
 * @param {object} deps
 * @param {object} deps.updater - electron-updater's autoUpdater (NsisUpdater)
 * @param {Function} deps.getRestartState - () => ({ queue, unconfirmedFiles, directUploads })
 * @param {Function} [deps.onChange] - the tray needs rebuilding
 * @param {Function} [deps.notify] - (body) => void, a desktop notification
 * @param {Function} [deps.log]
 * @param {object} [deps.timers] - { setTimeout, setInterval }
 */
function createUpdateController({ updater, getRestartState, onChange = () => {}, notify = () => {}, log = debugLog, timers }) {
    const clock = timers || { setTimeout, setInterval };
    let downloadedVersion = null;
    let notifiedVersion = null;
    let checking = false;

    const changed = () => {
        try { onChange(); } catch (err) { log(`[updater] Tray update failed: ${message(err)}`); }
    };
    const tell = body => {
        try { notify(body); } catch (err) { log(`[updater] Notification failed: ${message(err)}`); }
    };

    configureUpdater(updater, log);

    // AppUpdater logs its own errors through updater.logger. This listener
    // only guarantees that an 'error' emit can never throw.
    updater.on('error', () => {});

    updater.on('update-downloaded', info => {
        downloadedVersion = info && info.version ? String(info.version) : null;
        if (!downloadedVersion) return;
        // Re-armed here: a withdrawal may have switched it off for an earlier
        // download.
        updater.autoInstallOnAppQuit = true;
        log(`[updater] ${downloadedVersion} downloaded and verified; installs on quit or from the tray`);
        changed();
        if (notifiedVersion !== downloadedVersion) {
            notifiedVersion = downloadedVersion;
            tell(`Quework Desktop ${downloadedVersion} is ready. It installs when you quit, `
                + 'or choose "Restart to Update" in the tray menu.');
        }
    });

    /**
     * One check. Never rejects.
     * @returns {Promise<{ok: boolean, result?: object|null, error?: any, skipped?: boolean}>}
     */
    async function check(reason) {
        if (checking) return { ok: false, skipped: true };
        checking = true;
        changed();
        let outcome;
        try {
            const result = await updater.checkForUpdates();
            // The download runs on after the check resolves, and rejects on
            // its own — offline mid-download, a checksum mismatch, a full
            // disk. Handle it here or it is an unhandled rejection.
            if (result && result.downloadPromise && typeof result.downloadPromise.catch === 'function') {
                result.downloadPromise.catch(err => log(`[updater] Download failed, will retry at the next check: ${message(err)}`));
            }
            outcome = { ok: true, result: result || null };
        } catch (err) {
            log(`[updater] Check (${reason}) failed, will retry at the next check: ${message(err)}`);
            outcome = { ok: false, error: err };
        }
        checking = false;

        try {
            if (decideAfterCheck(downloadedVersion, outcome) === 'withdraw') {
                const offered = outcome.result.updateInfo.version;
                log(`[updater] ${downloadedVersion} is no longer offered (latest offered: ${offered}, `
                    + `available: ${outcome.result.isUpdateAvailable}); it will not be installed`);
                updater.autoInstallOnAppQuit = false;
                downloadedVersion = null;
            }
        } catch (err) {
            log(`[updater] Could not apply the check result: ${message(err)}`);
        }
        changed();
        return outcome;
    }

    function start({ firstLaunchOfVersion }) {
        if (firstLaunchOfVersion) {
            log('[updater] First launch of this version; no check before the first periodic one');
        } else {
            clock.setTimeout(() => check('launch'), FIRST_CHECK_DELAY_MS);
        }
        clock.setInterval(() => check('periodic'), CHECK_INTERVAL_MS);
    }

    /**
     * "Restart to Update". Installs only if nothing is uploading or waiting.
     * @returns {{ok: boolean, reasons?: string[]}}
     */
    function restartToUpdate() {
        if (!downloadedVersion) return { ok: false, reasons: ['no update is ready to install'] };
        let reasons;
        try {
            reasons = restartBlockers(getRestartState());
        } catch (err) {
            reasons = [`the app could not tell whether uploads are in progress (${message(err)})`];
        }
        if (reasons.length > 0) {
            log(`[updater] Restart to install ${downloadedVersion} refused: ${reasons.join('; ')}`);
            return { ok: false, reasons };
        }
        log(`[updater] Restarting to install ${downloadedVersion}`);
        try {
            // Silent install, then start the new version.
            updater.quitAndInstall(true, true);
        } catch (err) {
            log(`[updater] Could not start the installer: ${message(err)}`);
            return { ok: false, reasons: [`the installer could not be started (${message(err)})`] };
        }
        return { ok: true };
    }

    return {
        start,
        check,
        restartToUpdate,
        get downloadedVersion() { return downloadedVersion; },
        get checking() { return checking; },
    };
}

module.exports = { createUpdateController, configureUpdater, FIRST_CHECK_DELAY_MS, CHECK_INTERVAL_MS };
