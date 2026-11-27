/**
 * The deep-link schemes the app answers (src/protocol.js), and that the
 * installer registers the same ones (electron-builder.yml).
 *
 * No test framework — run with `node test/protocol.test.js`.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const protocol = require('../src/protocol');

let passed = 0;
function ok(name) {
    console.log(`  ok  ${name}`);
    passed++;
}

assert.deepStrictEqual([...protocol.PROTOCOL_SCHEMES], ['quework-desktop', 'taxone-desktop']);
assert.ok(Object.isFrozen(protocol.PROTOCOL_SCHEMES));
ok('schemes: quework-desktop first, taxone-desktop kept as the alias');

for (const url of [
    'quework-desktop://auth?token=a&url=b',
    'taxone-desktop://connect?url=b',
    'QUEWORK-DESKTOP://connect',
    'Taxone-Desktop://auth',
]) {
    assert.strictEqual(protocol.isProtocolUrl(url), true, url);
}
ok('isProtocolUrl accepts both schemes, in any letter case');

for (const value of [
    'quework://auth', 'quework-desktop:auth', 'quework-desktop:/auth', 'https://caputa.quework.app',
    'xquework-desktop://auth', ' quework-desktop://auth', 'C:\\Program Files\\Quework Desktop.exe',
    '', null, undefined, 42, {},
]) {
    assert.strictEqual(protocol.isProtocolUrl(value), false, String(value));
}
ok('isProtocolUrl rejects other schemes, near misses and non-strings');

assert.strictEqual(
    protocol.findProtocolUrl(['Quework Desktop.exe', '--allow-file-access', 'taxone-desktop://connect?url=x', 'quework-desktop://auth']),
    'taxone-desktop://connect?url=x');
assert.strictEqual(protocol.findProtocolUrl(['Quework Desktop.exe', '--flag']), undefined);
assert.strictEqual(protocol.findProtocolUrl(undefined), undefined);
ok('findProtocolUrl returns the first deep link in a command line, or undefined');

// electron-builder's `protocols` key is read by the macOS, Linux and AppX
// targets only; the NSIS (Windows) installer ignores it, and on Windows
// main.js registers the schemes at launch. This keeps the list in step for
// the other targets, so a future mac/Linux build cannot drift from the app.
const builder = yaml.load(fs.readFileSync(path.join(__dirname, '..', 'electron-builder.yml'), 'utf8'));
const installed = (builder.protocols || []).flatMap(p => p.schemes || []);
assert.deepStrictEqual(installed, [...protocol.PROTOCOL_SCHEMES]);
ok('electron-builder.yml protocols (macOS/Linux targets) list exactly the schemes src/protocol.js handles');

console.log(`\n${passed} passed`);
