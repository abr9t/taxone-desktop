const path = require('path');
const { debugLog } = require('./debug-log');

// The registry value name Electron writes the autostart entry under. It is
// the AppUserModelId, which main.js also sets — the rebrand deliberately did
// not change it, which is the only reason the entry below is findable at all.
const AUTO_LAUNCH_ENTRY_NAME = 'com.taxone.desktop';

function samePath(a, b) {
    return path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();
}

// productName drives the executable name and the install directory, so the
// rebrand moves the exe — but the Run-key entry recording its absolute path
// does not move with it. The entry survives the upgrade pointing at an
// executable the installer has just removed, and the app silently stops
// starting at login.
//
// Re-assert it whenever the recorded path has drifted. Only when an entry
// already exists: someone who turned autostart off in Settings has none, and
// resurrecting it would be worse than a stale path.
//
// @param deps - injected by tests; defaults come from the Electron runtime.
// @returns {string} what it did, for tests and for the log
function reconcileAutoLaunch(deps = {}) {
    const app = deps.app || require('electron').app;
    const execPath = deps.execPath || process.execPath;
    const log = deps.log || debugLog;

    if (!app.isPackaged) return 'not-packaged';

    try {
        const settings = app.getLoginItemSettings();
        const entry = (settings.launchItems || []).find(item => item.name === AUTO_LAUNCH_ENTRY_NAME);
        if (!entry) return 'no-entry';

        if (samePath(entry.path, execPath)) return 'up-to-date';

        // enabled carries the startup-approved state: Task Manager and
        // Windows Settings can disable an entry without removing it, and
        // setLoginItemSettings defaults enabled to true. Writing the new path
        // without it would re-enable autostart for someone who turned it off
        // there — a rename must not overrule that.
        app.setLoginItemSettings({
            openAtLogin: true,
            path: execPath,
            enabled: entry.enabled,
        });
        log(`[autostart] Re-registered: ${entry.path} -> ${execPath}`
            + ` (enabled: ${entry.enabled})`);
        return 're-registered';
    } catch (err) {
        log(`[autostart] Reconcile failed: ${err.message}`);
        return 'failed';
    }
}

module.exports = { reconcileAutoLaunch, AUTO_LAUNCH_ENTRY_NAME };
