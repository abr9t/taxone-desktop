/**
 * Source tripwire: nothing in src/ or scripts/ may relax certificate
 * verification.
 *
 * No test framework — run with `node test/tls-tripwire.test.js`.
 *
 * Flags, in code (comments and string contents are ignored):
 *   - any assignment to NODE_TLS_REJECT_UNAUTHORIZED, including
 *     process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = … and an object key
 *     { NODE_TLS_REJECT_UNAUTHORIZED: … } such as a spawn env;
 *   - rejectUnauthorized set to anything but the literal `true` — false, 0,
 *     a variable, `!isDev` — so it cannot be made conditional either.
 * Allows reading the variable, `delete process.env.NODE_TLS_REJECT_UNAUTHORIZED`,
 * and mentioning it in a log message.
 *
 * Not caught: a name built at runtime (process.env[name] = '0'). Code review
 * owns that; this catches the line that shipped and its obvious variants.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Blank comments and string contents, keeping line structure. A string used
// as a computed key (env['NAME']) is first rewritten to .NAME so it is seen.
function codeOnly(source) {
    const src = source.replace(/\[\s*(['"`])([A-Za-z_$][\w$]*)\1\s*\]/g, '.$2');
    let out = '';
    let i = 0;
    while (i < src.length) {
        const c = src[i];
        const next = src[i + 1];
        if (c === '/' && next === '/') {
            while (i < src.length && src[i] !== '\n') i++;
        } else if (c === '/' && next === '*') {
            i += 2;
            while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
                if (src[i] === '\n') out += '\n';
                i++;
            }
            i += 2;
        } else if (c === '"' || c === "'" || c === '`') {
            out += c;
            i++;
            while (i < src.length && src[i] !== c) {
                if (src[i] === '\\') i++;
                else if (src[i] === '\n') out += '\n';
                i++;
            }
            out += c;
            i++;
        } else {
            out += c;
            i++;
        }
    }
    return out;
}

const RULES = [
    { name: 'NODE_TLS_REJECT_UNAUTHORIZED assigned', re: /\bNODE_TLS_REJECT_UNAUTHORIZED\b\s*(?:=(?!=)|:)/ },
    { name: 'rejectUnauthorized not literally true', re: /\brejectUnauthorized\b\s*(?:=(?!=)|:)(?!\s*true\b)/ },
];

function findRelaxations(source) {
    const hits = [];
    codeOnly(source).split('\n').forEach((line, idx) => {
        for (const rule of RULES) {
            if (rule.re.test(line)) hits.push({ line: idx + 1, rule: rule.name });
        }
    });
    return hits;
}

let passed = 0;
function ok(name) {
    console.log(`  ok  ${name}`);
    passed++;
}

// ─── The scanner flags what it must ───────────────────────────────

const MUST_FLAG = [
    "process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';",
    'process.env.NODE_TLS_REJECT_UNAUTHORIZED=0',
    "process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';",
    'process.env["NODE_TLS_REJECT_UNAUTHORIZED"]=\'0\'',
    "spawn(exe, [], { env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0' } });",
    "Object.assign(process.env, { NODE_TLS_REJECT_UNAUTHORIZED: '0' });",
    'new https.Agent({ rejectUnauthorized: false })',
    'new https.Agent({rejectUnauthorized:false})',
    'agent.options.rejectUnauthorized = false;',
    'axios.create({ httpsAgent: new https.Agent({ rejectUnauthorized: !app.isPackaged }) })',
    'tls.connect({ rejectUnauthorized: 0 })',
    'const opts = { rejectUnauthorized: isDev ? false : true };',
];
for (const sample of MUST_FLAG) {
    assert.ok(findRelaxations(sample).length > 0, `not flagged: ${sample}`);
}
ok(`flags ${MUST_FLAG.length} ways of relaxing verification`);

// ─── …and allows what main.js and uploader.js legitimately do ─────

const MUST_ALLOW = [
    'delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;',
    'const inheritedTlsOverride = process.env.NODE_TLS_REJECT_UNAUTHORIZED;',
    "if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {}",
    'debugLog(`[tls] Ignored NODE_TLS_REJECT_UNAUTHORIZED (value "${v}") inherited from the environment`);',
    "debugLog('[tls] NODE_TLS_REJECT_UNAUTHORIZED=0 was set: ignored');",
    "console.warn('rejectUnauthorized: false is never used here');",
    '// process.env.NODE_TLS_REJECT_UNAUTHORIZED = \'0\' used to live here',
    '/* rejectUnauthorized: false */',
    'new https.Agent({ keepAlive: true, rejectUnauthorized: true })',
    'if (agent.options.rejectUnauthorized === false) throw new Error();',
];
for (const sample of MUST_ALLOW) {
    assert.deepStrictEqual(findRelaxations(sample), [], `wrongly flagged: ${sample}`);
}
ok(`allows ${MUST_ALLOW.length} legitimate mentions (delete, reads, log text, comments, true)`);

// ─── The repository is clean ──────────────────────────────────────

const ROOT = path.join(__dirname, '..');
function sourceFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) return sourceFiles(p);
        return /\.(js|html)$/.test(e.name) ? [p] : [];
    });
}

// In an HTML file only <script> bodies are code — and prose such as "your
// firm's URL" would otherwise open a string that swallows the script after it.
// Everything else becomes blank lines so reported line numbers still match.
function scriptOnly(html) {
    const parts = html.split(/(<script\b[^>]*>[\s\S]*?<\/script>)/i);
    return parts.map(p => (/^<script\b/i.test(p)
        ? p.replace(/^<script\b[^>]*>/i, m => m.replace(/[^\n]/g, ' ')).replace(/<\/script>$/i, '')
        : p.replace(/[^\n]/g, ''))).join('');
}

function scanFile(file) {
    const text = fs.readFileSync(file, 'utf8');
    return findRelaxations(file.endsWith('.html') ? scriptOnly(text) : text);
}

{
    const html = "<p>Your firm's URL</p>\n<script>\nnew https.Agent({ rejectUnauthorized: false })\n</script>\n<p>it's</p>";
    assert.deepStrictEqual(findRelaxations(scriptOnly(html)).map(h => h.line), [3]);
    ok('HTML: script bodies are scanned, an apostrophe in prose does not hide them');
}

const scanned = ['src', 'scripts'].flatMap(d => sourceFiles(path.join(ROOT, d)));
assert.ok(scanned.some(f => f.endsWith(path.join('src', 'main.js'))), 'scan must include src/main.js');
const found = scanned.flatMap(f => scanFile(f)
    .map(h => `${path.relative(ROOT, f)}:${h.line} ${h.rule}`));
assert.deepStrictEqual(found, [], `certificate verification relaxed in:\n  ${found.join('\n  ')}`);
ok(`no relaxation in ${scanned.length} files under src/ and scripts/`);

console.log('');
console.log(`${passed} passed`);
