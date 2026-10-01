/**
 * Source tripwire: nothing that ships, or that configures what ships, may
 * relax certificate verification.
 *
 * No test framework — run with `node test/tls-tripwire.test.js`.
 *
 * Scanned: src/ and scripts/ (.js, .mjs, .cjs, and the <script> bodies of
 * .html), plus package.json and electron-builder.yml at the root.
 *
 * Each JS file is read twice, comments removed both times:
 *   code view   — string contents blanked, so log text cannot trip a rule;
 *   string view — strings kept, for things that only exist as strings
 *                 (event names, command-line switches, shell env prefixes).
 * Quoted keys ('rejectUnauthorized': …, env['NAME'] = …) are rewritten to
 * bare names first, so quoting a key does not hide it. Config files are
 * scanned as raw text.
 *
 * Flags:
 *   - NODE_TLS_REJECT_UNAUTHORIZED assigned or used as a key, in code or in a
 *     string (e.g. a "NODE_TLS_REJECT_UNAUTHORIZED=0 node …" shell prefix);
 *   - rejectUnauthorized set to anything but a literal `true` followed by
 *     `,`, `}` or end of line — so `true && !isDev`, `true ? false : true`,
 *     a variable or `false` are all flagged;
 *   - checkServerIdentity (overriding it disables the hostname check);
 *   - setCertificateVerifyProc, a 'certificate-error' handler, and the
 *     ignore-certificate-errors switch (the Chromium-side equivalents).
 * Allows reading the variable, `delete process.env.NODE_TLS_REJECT_UNAUTHORIZED`,
 * and main.js's log line naming it.
 *
 * Cannot catch — code review owns these:
 *   - names built at runtime: process.env[name] = '0', 'rejectUn' + 'authorized';
 *   - eval, new Function, or code loaded from outside the scanned files;
 *   - a regex literal containing a quote, which this light lexer reads as the
 *     start of a string (none exist in src/ today);
 *   - anything in node_modules, and an environment set outside the app — the
 *     startup delete and the pinned agent cover that at runtime.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Rewrite env['NAME'] to env.NAME and 'NAME': to NAME:, so quoting a key
// does not hide it from the rules below.
function unquoteKeys(source) {
    return source
        .replace(/\[\s*(['"`])([A-Za-z_$][\w$]*)\1\s*\]/g, '.$2')
        .replace(/(['"`])([A-Za-z_$][\w$]*)\1(\s*:)/g, '$2$3');
}

// Remove comments, keeping line structure. With keepStrings false, string
// contents are blanked too.
function lex(source, { keepStrings }) {
    const src = unquoteKeys(source);
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
                if (src[i] === '\\') {
                    if (keepStrings) out += src.slice(i, i + 2);
                    i += 2;
                    continue;
                }
                if (keepStrings || src[i] === '\n') out += src[i];
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

const NODE_TLS_ASSIGNED = {
    name: 'NODE_TLS_REJECT_UNAUTHORIZED assigned',
    re: /\bNODE_TLS_REJECT_UNAUTHORIZED\b['"]?\s*(?:=(?!=)|:)/,
};
const CODE_RULES = [
    NODE_TLS_ASSIGNED,
    { name: 'rejectUnauthorized not a plain true', re: /\brejectUnauthorized\b['"]?\s*(?:=(?!=)|:)(?!\s*true\s*(?:[,}]|$))/ },
    { name: 'checkServerIdentity overridden', re: /\bcheckServerIdentity\b/ },
    { name: 'setCertificateVerifyProc', re: /\bsetCertificateVerifyProc\b/ },
];
const STRING_RULES = [
    NODE_TLS_ASSIGNED,
    { name: "'certificate-error' handler", re: /['"`]certificate-error['"`]/ },
    { name: 'ignore-certificate-errors switch', re: /ignore-certificate-errors/ },
];
const CONFIG_RULES = [...CODE_RULES, ...STRING_RULES];

function applyRules(text, rules, hits) {
    text.split('\n').forEach((line, idx) => {
        for (const rule of rules) {
            if (rule.re.test(line) && !hits.some(h => h.line === idx + 1 && h.rule === rule.name)) {
                hits.push({ line: idx + 1, rule: rule.name });
            }
        }
    });
    return hits;
}

// kind: 'js' (JavaScript, or an HTML file's script bodies) or 'config' (raw).
function findRelaxations(source, kind = 'js') {
    if (kind === 'config') return applyRules(source, CONFIG_RULES, []);
    const hits = applyRules(lex(source, { keepStrings: false }), CODE_RULES, []);
    return applyRules(lex(source, { keepStrings: true }), STRING_RULES, hits);
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
    'const env = { "NODE_TLS_REJECT_UNAUTHORIZED": "0" };',
    "exec('NODE_TLS_REJECT_UNAUTHORIZED=0 node upload.js');",
    'new https.Agent({ rejectUnauthorized: false })',
    'new https.Agent({rejectUnauthorized:false})',
    "new https.Agent({ 'rejectUnauthorized': false })",
    'agent.options.rejectUnauthorized = false;',
    'axios.create({ httpsAgent: new https.Agent({ rejectUnauthorized: !app.isPackaged }) })',
    'tls.connect({ rejectUnauthorized: 0 })',
    'const opts = { rejectUnauthorized: isDev ? false : true };',
    'new https.Agent({ rejectUnauthorized: true && !isDev })',
    'new https.Agent({ rejectUnauthorized: true ? false : true })',
    'tls.connect({ host, checkServerIdentity: () => undefined })',
    "new https.Agent({ 'checkServerIdentity': () => undefined })",
    "app.on('certificate-error', (e, wc, url, err, cert, cb) => { e.preventDefault(); cb(true); });",
    "app.commandLine.appendSwitch('ignore-certificate-errors');",
    'session.defaultSession.setCertificateVerifyProc((req, cb) => cb(0));',
];
for (const sample of MUST_FLAG) {
    assert.ok(findRelaxations(sample).length > 0, `not flagged: ${sample}`);
}
ok(`flags ${MUST_FLAG.length} JavaScript ways of relaxing verification`);

const MUST_FLAG_CONFIG = [
    '{ "scripts": { "start": "cross-env NODE_TLS_REJECT_UNAUTHORIZED=0 electron ." } }',
    'extraMetadata:\n  env:\n    NODE_TLS_REJECT_UNAUTHORIZED: "0"',
    '{ "build": { "rejectUnauthorized": false } }',
    '{ "scripts": { "start": "electron . --ignore-certificate-errors" } }',
    // Why config is scanned raw: read as JS, the apostrophe opens a string
    // that swallows the line below it.
    "# don't ship this\nrejectUnauthorized: false",
];
for (const sample of MUST_FLAG_CONFIG) {
    assert.ok(findRelaxations(sample, 'config').length > 0, `not flagged (config): ${sample}`);
}
ok(`flags ${MUST_FLAG_CONFIG.length} package.json / electron-builder.yml variants`);

// ─── …and allows what main.js and uploader.js legitimately do ─────

const MUST_ALLOW = [
    'delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;',
    'const inheritedTlsOverride = process.env.NODE_TLS_REJECT_UNAUTHORIZED;',
    "if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {}",
    'debugLog(`[tls] Ignored NODE_TLS_REJECT_UNAUTHORIZED (value "${v}") inherited from the environment`);',
    "console.warn('rejectUnauthorized: false is never used here');",
    '// process.env.NODE_TLS_REJECT_UNAUTHORIZED = \'0\' used to live here',
    '/* rejectUnauthorized: false; app.on(\'certificate-error\') */',
    'new https.Agent({ keepAlive: true, rejectUnauthorized: true })',
    'const opts = { rejectUnauthorized: true, keepAlive: true };',
    'const opts = {\n    rejectUnauthorized: true\n};',
    'if (agent.options.rejectUnauthorized === false) throw new Error();',
];
for (const sample of MUST_ALLOW) {
    assert.deepStrictEqual(findRelaxations(sample), [], `wrongly flagged: ${sample}`);
}
ok(`allows ${MUST_ALLOW.length} legitimate mentions (delete, reads, log text, comments, plain true)`);

// ─── The repository is clean ──────────────────────────────────────

const ROOT = path.join(__dirname, '..');
const SCANNED_EXT = /\.(js|mjs|cjs|html)$/;
function sourceFiles(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) return sourceFiles(p);
        return SCANNED_EXT.test(e.name) ? [p] : [];
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
    const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    if (/\.(json|ya?ml)$/.test(file)) return findRelaxations(text, 'config');
    return findRelaxations(file.endsWith('.html') ? scriptOnly(text) : text);
}

{
    // No .mjs/.cjs exists yet; the first one must not slip past.
    for (const name of ['a.js', 'b.mjs', 'c.cjs', 'd.html']) assert.ok(SCANNED_EXT.test(name), `not scanned: ${name}`);
    ok('.js, .mjs, .cjs and .html are all scanned');
}

{
    const html = "<p>Your firm's URL</p>\n<script>\nnew https.Agent({ rejectUnauthorized: false })\n</script>\n<p>it's</p>";
    assert.deepStrictEqual(findRelaxations(scriptOnly(html)).map(h => h.line), [3]);
    ok('HTML: script bodies are scanned, an apostrophe in prose does not hide them');
}

{
    // The two lines main.js really has must stay allowed — checked against
    // the file, not only against samples.
    const main = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8').split(/\r?\n/);
    const real = main.filter(l => l.includes('delete process.env.NODE_TLS_REJECT_UNAUTHORIZED')
        || (l.includes('debugLog(') && l.includes('NODE_TLS_REJECT_UNAUTHORIZED')));
    assert.strictEqual(real.length, 2, 'main.js should have the startup delete and its log line');
    for (const line of real) assert.deepStrictEqual(findRelaxations(line), [], `wrongly flagged: ${line.trim()}`);
    ok("main.js's startup delete and log line are allowed");
}

const scanned = [
    ...['src', 'scripts'].flatMap(d => sourceFiles(path.join(ROOT, d))),
    path.join(ROOT, 'package.json'),
    path.join(ROOT, 'electron-builder.yml'),
];
for (const must of [path.join('src', 'main.js'), 'package.json', 'electron-builder.yml']) {
    assert.ok(scanned.some(f => f.endsWith(must)), `scan must include ${must}`);
}
const found = scanned.flatMap(f => scanFile(f)
    .map(h => `${path.relative(ROOT, f)}:${h.line} ${h.rule}`));
assert.deepStrictEqual(found, [], `certificate verification relaxed in:\n  ${found.join('\n  ')}`);
ok(`no relaxation in ${scanned.length} files (src/, scripts/, package.json, electron-builder.yml)`);

console.log('');
console.log(`${passed} passed`);
