/**
 * Release pipeline config: where builds go, and that only a tag can send
 * them anywhere.
 *
 * No test framework — run with `node test/release-config.test.js`.
 *
 * Reads electron-builder.yml, package.json and .github/workflows/release.yml
 * with js-yaml — the parser electron-builder itself reads its config with
 * (a dependency of electron-builder, so present wherever the build is).
 *
 * Each rule is a function that returns a list of problems. It runs once
 * against the real files, which must have none, and again against a copy
 * with one thing broken, which must be caught — so every rule is shown to be
 * able to fail.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

const builder = yaml.load(read('electron-builder.yml'));
const pkg = JSON.parse(read('package.json'));
const workflow = yaml.load(read('.github/workflows/release.yml'));

const clone = o => JSON.parse(JSON.stringify(o));
let passed = 0;
function ok(name) {
    console.log(`  ok  ${name}`);
    passed++;
}

function expectClean(rule, input, name) {
    assert.deepStrictEqual(rule(input), [], `${name}: ${rule(input).join('; ')}`);
}
function expectCaught(rule, input, why) {
    assert.ok(rule(input).length > 0, `the rule did not catch: ${why}`);
}

// ─── electron-builder.yml ─────────────────────────────────────────

// What electron-updater reads from the packaged app-update.yml. A token here
// would ship inside every installer; `private: true` is what makes
// electron-builder write one.
function publishConfigProblems(config) {
    const problems = [];
    const pub = Array.isArray(config.publish) ? config.publish : [config.publish];
    if (pub.length !== 1 || !pub[0]) return ['electron-builder.yml needs exactly one publish entry'];
    const p = pub[0];
    if (p.provider !== 'github') problems.push(`provider is ${p.provider}, not github`);
    if (p.owner !== 'abr9t') problems.push(`owner is ${p.owner}`);
    if (p.repo !== 'taxone-desktop') problems.push(`repo is ${p.repo}`);
    if (p.releaseType !== 'draft') problems.push(`releaseType is ${p.releaseType}, not draft`);
    if ('token' in p) problems.push('a token is configured, and would ship in app-update.yml');
    if (p.private) problems.push('private: true makes electron-builder embed a token');
    if ('channel' in p) problems.push('a channel is configured (it also enables downgrades in the updater)');
    return problems;
}

{
    expectClean(publishConfigProblems, builder, 'electron-builder.yml publish');
    for (const [why, mutate] of [
        ['publish block removed', c => { delete c.publish; }],
        ['token added', c => { c.publish.token = 'ghp_x'; }],
        ['private: true', c => { c.publish.private = true; }],
        ['releaseType release', c => { c.publish.releaseType = 'release'; }],
        ['another repo', c => { c.publish.repo = 'taxone-desktop-fork'; }],
        ['channel set', c => { c.publish.channel = 'beta'; }],
    ]) {
        const c = clone(builder);
        mutate(c);
        expectCaught(publishConfigProblems, c, why);
    }
    ok('publish: github abr9t/taxone-desktop, draft, no token, no private, no channel');
}

{
    // The web app's download button points at this exact name, and so does
    // latest.yml.
    assert.strictEqual(builder.nsis.artifactName, 'TaxOne-Desktop-Setup.${ext}');
    ok('the installer is still TaxOne-Desktop-Setup.exe');
}

// ─── package.json ─────────────────────────────────────────────────

// A local build must never publish. electron-builder publishes on its own
// when it sees a CI tag, and always when run from an npm script named
// "release", unless --publish never says otherwise.
function localScriptProblems(p) {
    const problems = [];
    if ('release' in p.scripts) problems.push('a "release" script makes electron-builder publish always');
    for (const [name, cmd] of Object.entries(p.scripts)) {
        if (!/electron-builder/.test(cmd)) continue;
        const policies = [...cmd.matchAll(/(?:--publish|-p)[=\s]+(\S+)/g)].map(m => m[1]);
        if (policies.length !== 1 || policies[0] !== 'never') {
            problems.push(`npm run ${name} does not pass exactly --publish never: ${cmd}`);
        }
    }
    return problems;
}

{
    expectClean(localScriptProblems, pkg, 'package.json scripts');
    const builds = Object.keys(pkg.scripts).filter(n => /electron-builder/.test(pkg.scripts[n]));
    assert.ok(builds.includes('build'), 'npm run build should be an electron-builder script');
    for (const [why, mutate] of [
        ['--publish never dropped', p => { p.scripts.build = 'electron-builder --win'; }],
        ['--publish always', p => { p.scripts['build:win'] = 'electron-builder --win --publish always'; }],
        ['-p onTag', p => { p.scripts['build:dir'] = 'electron-builder --win --dir -p onTag'; }],
        ['a release script', p => { p.scripts.release = 'node -e 0'; }],
    ]) {
        const p = clone(pkg);
        mutate(p);
        expectCaught(localScriptProblems, p, why);
    }
    ok(`every local electron-builder script is --publish never (${builds.join(', ')})`);
}

// ─── .github/workflows/release.yml ────────────────────────────────

// The exact line release.yml runs: the pushed tag must be v + package.json's
// version, so a release cannot be published under a number the app does not
// report.
const TAG_CHECK = 'test "$GITHUB_REF_NAME" = "v$(node -p "require(\'./package.json\').version")"';

// A secret or the job token, written into a workflow.
const SECRET = /\$\{\{\s*(secrets\.|github\.token\b)/;

// `on:` may be a string, a list or a map; these are the event names.
function triggers(on) {
    if (typeof on === 'string') return [on];
    if (Array.isArray(on)) return on;
    return Object.keys(on || {});
}

const allSteps = wf => Object.entries(wf.jobs).flatMap(([job, j]) => (j.steps || []).map(s => ({ job, ...s })));

function workflowProblems(wf) {
    const problems = [];
    // Only a tag push or a person may start this workflow. pull_request_target
    // in particular runs with write access on code from a fork.
    const extra = triggers(wf.on).filter(t => t !== 'push' && t !== 'workflow_dispatch');
    if (extra.length > 0) problems.push(`triggers other than push and workflow_dispatch: ${extra.join(', ')}`);
    const on = (wf.on && typeof wf.on === 'object' && !Array.isArray(wf.on)) ? wf.on : {};
    if (!on.push || JSON.stringify(on.push.tags) !== '["v*"]') problems.push('publishing is not triggered by v* tags');
    if (!('workflow_dispatch' in on)) problems.push('no workflow_dispatch dry run');
    if (JSON.stringify(wf.permissions) !== '{}') problems.push('top-level permissions are not {}');

    const jobs = wf.jobs || {};
    const writers = Object.entries(jobs).filter(([, j]) => /write/.test(JSON.stringify(j.permissions || {})));
    if (writers.length !== 1 || writers[0][0] !== 'publish') {
        problems.push(`jobs with write access: ${writers.map(([n]) => n).join(', ') || 'none'} (only publish may)`);
    }

    const publish = jobs.publish || {};
    if (JSON.stringify(publish.permissions) !== '{"contents":"write"}') problems.push('publish job permissions are not exactly contents: write');
    if (!/github\.event_name == 'push'/.test(publish.if || '') || !/github\.ref_type == 'tag'/.test(publish.if || '')) {
        problems.push('publish job does not require a pushed tag');
    }

    const publishSteps = publish.steps || [];
    const tagCheck = publishSteps.findIndex(s => s.run === TAG_CHECK);
    const build = publishSteps.findIndex(s => /electron-builder/.test(s.run || ''));
    if (tagCheck === -1) {
        problems.push('the publish job does not check the tag against package.json');
    } else {
        // Exactly these keys: an `if:`, `continue-on-error:` or an `env:`
        // that sets GITHUB_REF_NAME would each leave the step present and
        // disarmed.
        const keys = Object.keys(publishSteps[tagCheck]).sort();
        if (JSON.stringify(keys) !== '["name","run","shell"]') {
            problems.push(`the tag check step has keys ${keys.join(', ')}; it may only have name, run and shell`);
        }
        if (publishSteps[tagCheck].shell !== 'bash') problems.push('the tag check does not run in bash (the runner default is pwsh)');
        if (build === -1 || tagCheck > build) problems.push('the tag check does not run before the build');
    }

    for (const [where, env] of [['workflow', wf.env], ['publish job', publish.env]]) {
        if (env && Object.prototype.hasOwnProperty.call(env, 'GITHUB_REF_NAME')) problems.push(`${where} env sets GITHUB_REF_NAME, which the tag check reads`);
    }

    const steps = allSteps(wf);
    const publishing = steps.filter(s => /--publish\s+(always|onTag|onTagOrDraft)|-p\s+always/.test(s.run || ''));
    if (publishing.length !== 1 || publishing[0].job !== 'publish') problems.push('exactly one step, in the publish job, may publish');
    else if (!/github\.ref_type == 'tag'/.test(publishing[0].if || '')) problems.push('the publish step does not check ref_type == tag itself');

    // Secrets reach exactly one step. Workflow- or job-level env would hand
    // them to every step under it, npm ci included.
    if (SECRET.test(JSON.stringify(wf.env || {}))) problems.push('workflow-level env hands out a secret');
    for (const [name, j] of Object.entries(jobs)) {
        if (SECRET.test(JSON.stringify(j.env || {}))) problems.push(`job-level env of ${name} hands out a secret`);
    }
    const tokenSteps = steps.filter(s => SECRET.test(JSON.stringify(s.env || {}) + JSON.stringify(s.with || {})));
    if (tokenSteps.some(s => s !== publishing[0])) problems.push('a step other than the publish step is handed a secret');

    for (const s of steps.filter(x => x.uses)) {
        if (!/@[0-9a-f]{40}$/.test(s.uses)) problems.push(`${s.uses} is not pinned to a commit SHA`);
        if (/softprops\/action-gh-release/.test(s.uses)) problems.push('softprops/action-gh-release is back: electron-builder is the only uploader');
        if (/actions\/checkout/.test(s.uses) && !(s.with && s.with['persist-credentials'] === false)) {
            problems.push(`checkout in ${s.job} persists its token into .git/config`);
        }
    }

    const dry = jobs['dry-run'] || {};
    if (!/github\.event_name == 'workflow_dispatch'/.test(dry.if || '')) problems.push('dry-run job is not limited to workflow_dispatch');
    if (JSON.stringify(dry.permissions) !== '{"contents":"read"}') problems.push('dry-run job permissions are not exactly contents: read');
    const drySteps = steps.filter(s => s.job === 'dry-run');
    if (!drySteps.some(s => s.run === 'npm run build')) problems.push('dry-run does not build with npm run build (--publish never)');
    const upload = drySteps.find(s => /actions\/upload-artifact/.test(s.uses || ''));
    if (!upload) {
        problems.push('dry-run uploads no artifact');
    } else {
        const paths = String(upload.with.path).split(/\r?\n/).map(l => l.trim()).filter(Boolean).sort();
        const want = ['dist/TaxOne-Desktop-Setup.exe', 'dist/TaxOne-Desktop-Setup.exe.blockmap', 'dist/latest.yml'];
        if (JSON.stringify(paths) !== JSON.stringify(want)) problems.push(`dry-run artifact holds ${paths.join(', ')}`);
        if (upload.with['retention-days'] !== 7) problems.push('dry-run artifact retention is not 7 days');
        if (upload.with['if-no-files-found'] !== 'error') problems.push('a missing latest.yml or blockmap would not fail the dry run');
    }
    for (const job of ['publish', 'dry-run']) {
        if (!steps.some(s => s.job === job && s.run === 'npm test')) problems.push(`${job} does not run npm test`);
    }
    return problems;
}

{
    expectClean(workflowProblems, workflow, 'release.yml');
    const step = (wf, job, re) => wf.jobs[job].steps.find(s => re.test(s.uses || s.run || ''));
    for (const [why, mutate] of [
        ['write permission at the top level', wf => { wf.permissions = { contents: 'write' }; }],
        ['dry-run given write access', wf => { wf.jobs['dry-run'].permissions = { contents: 'write' }; }],
        ['publish job also runs on dispatch', wf => { wf.jobs.publish.if = "github.ref_type == 'tag'"; }],
        ['publish step without its own tag check', wf => { delete step(wf, 'publish', /electron-builder/).if; }],
        ['dry-run publishes', wf => { step(wf, 'dry-run', /npm run build/).run = 'npx electron-builder --win --publish always'; }],
        ['dry-run handed the token', wf => { step(wf, 'dry-run', /npm run build/).env = { GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}' }; }],
        ['an action on a moving tag', wf => { step(wf, 'publish', /setup-node/).uses = 'actions/setup-node@v4'; }],
        ['softprops added back', wf => { wf.jobs.publish.steps.push({ uses: 'softprops/action-gh-release@' + 'a'.repeat(40) }); }],
        ['checkout persists credentials', wf => { delete step(wf, 'dry-run', /checkout/).with; }],
        ['latest.yml left out of the artifact', wf => {
            const u = step(wf, 'dry-run', /upload-artifact/);
            u.with.path = 'dist/TaxOne-Desktop-Setup.exe\ndist/TaxOne-Desktop-Setup.exe.blockmap';
        }],
        ['artifact kept 90 days', wf => { step(wf, 'dry-run', /upload-artifact/).with['retention-days'] = 90; }],
        ['no dispatch trigger', wf => { delete wf.on.workflow_dispatch; }],
        ['a pull_request_target trigger', wf => { wf.on.pull_request_target = { types: ['opened'] }; }],
        ['a pull_request trigger in list form', wf => { wf.on = ['push', 'pull_request']; }],
        ['a schedule trigger', wf => { wf.on.schedule = [{ cron: '0 0 * * *' }]; }],
        ['GH_TOKEN in dry-run job env', wf => { wf.jobs['dry-run'].env = { GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}' }; }],
        ['GH_TOKEN in publish job env', wf => { wf.jobs.publish.env = { GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}' }; }],
        ['GH_TOKEN in workflow env', wf => { wf.env = { GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}' }; }],
        ['github.token in a dry-run step', wf => { step(wf, 'dry-run', /npm run build/).env = { T: '${{ github.token }}' }; }],
        ['tests skipped before publishing', wf => { wf.jobs.publish.steps = wf.jobs.publish.steps.filter(s => s.run !== 'npm test'); }],
        ['no tag/version check', wf => { wf.jobs.publish.steps = wf.jobs.publish.steps.filter(s => s.run !== TAG_CHECK); }],
        ['the tag check after the build', wf => {
            const steps = wf.jobs.publish.steps;
            const check = steps.splice(steps.findIndex(s => s.run === TAG_CHECK), 1)[0];
            steps.push(check);
        }],
        ['the tag check in pwsh', wf => { delete step(wf, 'publish', /GITHUB_REF_NAME/).shell; }],
        ['a weakened tag check', wf => { step(wf, 'publish', /GITHUB_REF_NAME/).run = 'test -n "$GITHUB_REF_NAME"'; }],
    ]) {
        const wf = clone(workflow);
        mutate(wf);
        expectCaught(workflowProblems, wf, why);
    }
    ok('release.yml: only a pushed tag publishes, as a draft, from one step in the one job with write access');
    ok('release.yml: the dry run builds the three files into a 7-day artifact, with read-only access and no token');
    ok('release.yml: every action is SHA-pinned, checkout keeps no token, tests run before any build');
    ok('release.yml: the publish job checks the tag is v + package.json version, in bash, before the build');

    // The same check against edited copies of the release.yml text, the way
    // someone would disarm it by hand.
    const source = read('.github/workflows/release.yml');
    const anchor = '        shell: bash\n';
    assert.strictEqual(source.split(anchor).length, 2, 'the tag check step is the only "shell: bash" line');
    for (const [why, extra] of [
        ['if: false on the tag check', '        if: false\n'],
        ['continue-on-error: true on the tag check', '        continue-on-error: true\n'],
        ['a step env that pins GITHUB_REF_NAME', '        env:\n          GITHUB_REF_NAME: v1.2.0\n'],
    ]) {
        expectCaught(workflowProblems, yaml.load(source.replace(anchor, anchor + extra)), why);
    }
    for (const [why, mutate] of [
        ['GITHUB_REF_NAME in publish job env', wf => { wf.jobs.publish.env = { GITHUB_REF_NAME: 'v1.2.0' }; }],
        ['GITHUB_REF_NAME in workflow env', wf => { wf.env = { GITHUB_REF_NAME: 'v1.2.0' }; }],
    ]) {
        const wf = clone(workflow);
        mutate(wf);
        expectCaught(workflowProblems, wf, why);
    }
    ok('release.yml: the tag check cannot be disarmed (no if, continue-on-error or env on it; no GITHUB_REF_NAME above it)');
    ok('release.yml: triggered only by push and workflow_dispatch; no secret in workflow- or job-level env');
}

console.log('');
console.log(`${passed} passed`);
