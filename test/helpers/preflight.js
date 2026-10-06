/**
 * What the suites load from node_modules, checked before any of them runs,
 * so a checkout without `npm ci` fails with one clear line instead of a
 * MODULE_NOT_FOUND stack halfway through the run. Not a suite itself.
 */
const REQUIRED = {
    'electron-updater': 'test/updater.test.js (the real NsisUpdater)',
    'js-yaml': 'test/release-config.test.js (reads the build and workflow YAML)',
    axios: 'src/uploader.js (the API client under test)',
    'form-data': 'src/uploader.js (multipart uploads)',
};

function missingDependencies(resolve = require.resolve) {
    return Object.keys(REQUIRED).filter(name => {
        try {
            resolve(name);
            return false;
        } catch {
            return true;
        }
    });
}

function preflightMessage(missing) {
    return `Missing from node_modules: ${missing.join(', ')}. Run \`npm ci\` first.\n`
        + missing.map(name => `  ${name} is needed by ${REQUIRED[name]}`).join('\n');
}

module.exports = { missingDependencies, preflightMessage, REQUIRED };
