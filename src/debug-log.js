const fs = require('fs');
const path = require('path');

// Shared by main.js and auth.js. Lives in userData rather than next to
// __dirname: in a packaged build __dirname is inside app.asar, where
// appendFileSync throws.
//
// The path is resolved on first write, not at module load, so requiring this
// never depends on app being ready — or on the userData pin in main.js having
// run yet, which matters because auth.js logs the failure of that very pin.
let logPath = null;

function write(consoleFn, args) {
    const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
    try {
        if (logPath === null) {
            logPath = path.join(require('electron').app.getPath('userData'), 'debug.log');
        }
        fs.appendFileSync(logPath, line);
    } catch {
        // Logging must never be the thing that breaks startup.
    }
    consoleFn(...args);
}

function debugLog(...args) {
    write(console.log, args);
}

// Same file, stderr instead of stdout. For conditions that are wrong but not
// worth taking the app down over.
function debugError(...args) {
    write(console.error, args);
}

module.exports = { debugLog, debugError };
