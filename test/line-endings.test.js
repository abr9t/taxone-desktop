/**
 * Line endings: the repository stores LF, and .gitattributes keeps the
 * types tests and builds read as text on LF in every working tree, so a
 * Windows checkout with core.autocrlf=true tests and packages the bytes
 * that were committed.
 *
 * No test framework — run with `node test/line-endings.test.js`.
 * Walks the directories instead of asking git, so it also runs on a
 * `git archive` export (which has no .git).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EOL_LF = ['js', 'yml', 'md', 'json', 'html'];
const RULES = ['* text=auto', ...EOL_LF.map(ext => `*.${ext} text eol=lf`)];
// Not the project's files: installed or generated, or private to one machine.
const SKIP = new Set(['node_modules', 'dist', '.git', '.idea', '.claude']);

let passed = 0;
function ok(name) {
    console.log(`  ok  ${name}`);
    passed++;
}

function attributeProblems(text) {
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    const missing = RULES.filter(r => !lines.includes(r));
    const extra = lines.filter(l => !RULES.includes(l));
    return [...missing.map(r => `missing: ${r}`), ...extra.map(l => `unexpected: ${l}`)];
}

function crlfFiles(dir) {
    const found = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (SKIP.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            found.push(...crlfFiles(full));
        } else if (EOL_LF.includes(path.extname(entry.name).slice(1)) && fs.readFileSync(full).includes('\r')) {
            found.push(path.relative(ROOT, full));
        }
    }
    return found;
}

{
    const problems = attributeProblems(fs.readFileSync(path.join(ROOT, '.gitattributes'), 'utf8'));
    assert.deepStrictEqual(problems, [], problems.join('; '));
    // The check has to be able to fail.
    assert.ok(attributeProblems(RULES.filter(r => r !== '*.yml text eol=lf').join('\n')).includes('missing: *.yml text eol=lf'));
    assert.ok(attributeProblems(`${RULES.join('\n')}\n*.js -text`).includes('unexpected: *.js -text'));
    ok(`.gitattributes: ${RULES.join(', ')}`);
}

{
    const crlf = crlfFiles(ROOT);
    assert.deepStrictEqual(crlf, [], `CR in: ${crlf.join(', ')}`);
    ok(`no .${EOL_LF.join('/.')} file in this checkout has a CR in it`);
}

console.log('');
console.log(`${passed} passed`);
