/**
 * Standalone test for test/helpers/preflight.js, the dependency check
 * run-all.js makes before any suite.
 *
 * No test framework — run with `node test/preflight.test.js`.
 */
const assert = require('assert');
const { missingDependencies, preflightMessage, REQUIRED } = require('./helpers/preflight');

let passed = 0;
function ok(name) {
    console.log(`  ok  ${name}`);
    passed++;
}

{
    assert.deepStrictEqual(missingDependencies(), [], 'this checkout has its dependencies installed');
    assert.ok('electron-updater' in REQUIRED && 'js-yaml' in REQUIRED);
    ok('with node_modules installed nothing is missing, and electron-updater and js-yaml are on the list');
}

{
    const absent = new Set(['electron-updater', 'js-yaml']);
    const resolve = name => {
        if (absent.has(name)) throw Object.assign(new Error(`Cannot find module '${name}'`), { code: 'MODULE_NOT_FOUND' });
        return `/fake/${name}`;
    };
    const missing = missingDependencies(resolve);
    assert.deepStrictEqual(missing, ['electron-updater', 'js-yaml']);
    const message = preflightMessage(missing);
    assert.match(message, /Run `npm ci` first/);
    assert.match(message, /electron-updater is needed by test\/updater\.test\.js/);
    assert.match(message, /js-yaml is needed by test\/release-config\.test\.js/);
    ok('a missing electron-updater or js-yaml is named, with the file that needs it and "Run `npm ci` first"');
}

console.log('');
console.log(`${passed} passed`);
