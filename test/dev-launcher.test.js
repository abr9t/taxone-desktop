/**
 * Standalone smoke test for scripts/dev.js, the `npm run dev` launcher.
 *
 * No test framework — run with `node test/dev-launcher.test.js`.
 * Covers which extra CA it picks, and that the launcher can never be packaged:
 * it is the one place a dev-only trust anchor is added, so it has to stay out
 * of app.asar.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { resolveExtraCaCerts, herdCaPath } = require('../scripts/dev');

const HOME = 'C:/Users/dev';
const HERD = herdCaPath(HOME);
let passed = 0;

function ok(name) {
    console.log(`  ok  ${name}`);
    passed++;
}

// ─── CA resolution ────────────────────────────────────────────────

{
    const ca = resolveExtraCaCerts({ env: {}, home: HOME, exists: p => p === HERD });
    assert.deepStrictEqual(ca, { path: HERD, source: 'herd' });
    ok('uses the Herd CA when it is installed');
}

{
    const ca = resolveExtraCaCerts({
        env: { NODE_EXTRA_CA_CERTS: 'D:/corp/bundle.pem' }, home: HOME, exists: p => p === HERD,
    });
    assert.deepStrictEqual(ca, { path: 'D:/corp/bundle.pem', source: 'environment' });
    ok('a NODE_EXTRA_CA_CERTS already in the environment wins over Herd');
}

{
    const ca = resolveExtraCaCerts({ env: {}, home: HOME, exists: () => false });
    assert.strictEqual(ca, null);
    ok('no Herd and no env var resolves to nothing, rather than a missing file');
}

{
    assert.ok(HERD.replace(/\\/g, '/').endsWith('/.config/herd/config/valet/CA/LaravelValetCASelfSigned.crt'),
        `unexpected Herd CA path: ${HERD}`);
    ok('the Herd CA path is the one Herd for Windows writes');
}

// ─── Never packaged ───────────────────────────────────────────────
//
// electron-builder packages what `files:` lists. Read the list straight out of
// electron-builder.yml (a flat list of globs — no YAML parser needed) and make
// sure no entry can reach scripts/. A missing list would mean "package
// everything", so that fails too.

function packagedGlobs() {
    const yml = fs.readFileSync(path.join(__dirname, '..', 'electron-builder.yml'), 'utf8').split(/\r?\n/);
    const start = yml.findIndex(l => /^files:\s*$/.test(l));
    assert.notStrictEqual(start, -1, 'electron-builder.yml must have an explicit files: list');
    const globs = [];
    for (const line of yml.slice(start + 1)) {
        const m = line.match(/^\s+-\s+["']?([^"'\s#]+)["']?/);
        if (!m) break;
        globs.push(m[1]);
    }
    assert.ok(globs.length > 0, 'files: list is empty');
    return globs;
}

function couldInclude(glob, file) {
    if (glob.startsWith('!')) return false;
    const first = glob.split('/')[0];
    return first === file.split('/')[0] || first.includes('*');
}

{
    const globs = packagedGlobs();
    const leaks = globs.filter(g => couldInclude(g, 'scripts/dev.js'));
    assert.deepStrictEqual(leaks, [], `these files: entries could package scripts/dev.js: ${leaks.join(', ')}`);
    ok(`scripts/dev.js is outside every packaged glob (${globs.join(', ')})`);
}

{
    // The check above has to be able to fail.
    assert.ok(couldInclude('scripts/**/*', 'scripts/dev.js'));
    assert.ok(couldInclude('**/*', 'scripts/dev.js'));
    assert.ok(!couldInclude('src/**/*', 'scripts/dev.js'));
    ok('the packaging check flags scripts/** and **/* and passes src/**');
}

{
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    assert.strictEqual(pkg.scripts.dev, 'node scripts/dev.js', 'npm run dev must go through the launcher');
    ok('npm run dev goes through the launcher');
}

console.log('');
console.log(`${passed} passed`);
