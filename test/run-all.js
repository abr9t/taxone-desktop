/**
 * Runs every *.test.js in this directory, each in its own process.
 *
 * Separate processes on purpose: the suites stub electron-store and friends
 * through Module._load and require the module under test at load time, so
 * sharing one process would hand the second suite the first one's stubs and
 * its already-cached modules.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { missingDependencies, preflightMessage } = require('./helpers/preflight');

// The suites need the installed dependencies (`npm ci`), electron-updater
// and js-yaml among them. Say so before running anything.
const missing = missingDependencies();
if (missing.length > 0) {
    console.error(preflightMessage(missing));
    process.exit(1);
}

const files = fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js')).sort();
let failed = 0;

for (const file of files) {
    console.log(`
── ${file} ${'─'.repeat(Math.max(0, 60 - file.length))}`);
    const result = spawnSync(process.execPath, [path.join(__dirname, file)], { stdio: 'inherit' });
    if (result.status !== 0) failed++;
}

console.log(`
${files.length - failed}/${files.length} suites passed`);
process.exit(failed === 0 ? 0 : 1);
