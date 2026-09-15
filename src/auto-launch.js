const { debugLog } = require('./debug-log');

// The registry value name Electron writes the autostart entry under. It is
// the AppUserModelId, which main.js also sets — the rebrand deliberately did
// not change it, which is the only reason the entry below is findable at all.
const AUTO_LAUNCH_ENTRY_NAME = 'com.taxone.desktop';

// productName drives the executable name, so the rebrand moves the exe — but
// the Run-key entry recording its absolute path does not move with it. The
// entry survives the upgrade pointing at an executable that no longer exists,
// and the app silently stops starting at login.
//
// So when an entry exists, re-assert it with the running executable on every
// packaged launch. Unconditionally: whether the stored path is stale cannot be
// read back. The Run value is written unquoted, and Electron parses an
// unquoted value up to the first space — for this app, launchItems[].path
// comes back as "...\Programs\TaxOne", which never equals process.execPath.
// A staleness check built on it re-registered on every launch anyway, while
// claiming to detect drift. Rewriting an identical value is harmless.
//
// For the same reason there is no success log: "did anything change?" is not
// answerable, and a line on every launch is noise that looks like a finding.
// Failures are still logged.
//
// The rules that do not depend on reading the path back:
// - Never create an entry. Turning autostart off in Settings removes the
//   value, and a rename must not resurrect it.
// - Never re-enable one. enabled carries the startup-approved state that
//   Task Manager and Windows Settings toggle without removing the value, and
//   setLoginItemSettings defaults it to true.
// - Never touch the registry from an unpackaged build.
//
// @param deps - injected by tests; defaults come from the Electron runtime.
// @returns {string} what it did, for tests
function reconcileAutoLaunch(deps = {}) {
    const app = deps.app || require('electron').app;
    const execPath = deps.execPath || process.execPath;
    const log = deps.log || debugLog;

    if (!app.isPackaged) return 'not-packaged';

    try {
        const settings = app.getLoginItemSettings();
        const entry = (settings.launchItems || []).find(item => item.name === AUTO_LAUNCH_ENTRY_NAME);
        if (!entry) return 'no-entry';

        app.setLoginItemSettings({
            openAtLogin: true,
            path: execPath,
            enabled: entry.enabled,
        });
        return 're-registered';
    } catch (err) {
        log(`[autostart] Reconcile failed: ${err.message}`);
        return 'failed';
    }
}

module.exports = { reconcileAutoLaunch, AUTO_LAUNCH_ENTRY_NAME };
