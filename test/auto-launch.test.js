/**
 * Standalone smoke test for reconcileAutoLaunch().
 *
 * No test framework — run with `node test/auto-launch.test.js`.
 * The Electron app object is injected rather than stubbed through
 * Module._load, which is why this logic lives in src/auto-launch.js instead
 * of inside main.js: requiring main.js would build windows and register IPC.
 */
const assert = require('assert');
const { reconcileAutoLaunch, AUTO_LAUNCH_ENTRY_NAME } = require('../src/auto-launch');

const NEW_EXE = 'C:\\Users\\x\\AppData\\Local\\Programs\\Quework Desktop\\Quework Desktop.exe';
const OLD_EXE = 'C:\\Users\\x\\AppData\\Local\\Programs\\TaxOne Desktop\\TaxOne Desktop.exe';

let passed = 0;

// Builds an app stub and records what reconcileAutoLaunch writes back.
function makeApp({ isPackaged = true, launchItems = [], throws = false } = {}) {
    const writes = [];
    return {
        writes,
        logs: [],
        isPackaged,
        getLoginItemSettings() {
            if (throws) throw new Error('registry unavailable');
            return { openAtLogin: launchItems.length > 0, launchItems };
        },
        setLoginItemSettings(settings) { writes.push(settings); },
    };
}

function run(app, opts = {}) {
    const logs = [];
    const outcome = reconcileAutoLaunch({
        app,
        execPath: opts.execPath || NEW_EXE,
        log: (...args) => logs.push(args.join(' ')),
    });
    app.logs = logs;
    return outcome;
}

function entry(overrides) {
    return { name: AUTO_LAUNCH_ENTRY_NAME, path: OLD_EXE, args: [], scope: 'user', enabled: true, ...overrides };
}

// ─── The Task Manager case: the point of this suite ───────────────
{
    const app = makeApp({ launchItems: [entry({ enabled: false })] });
    const outcome = run(app);

    assert.strictEqual(outcome, 're-registered', 'a drifted path is re-registered');
    assert.strictEqual(app.writes.length, 1, 'exactly one write');
    assert.strictEqual(app.writes[0].enabled, false,
        'an entry disabled in Task Manager must come back disabled — omitting enabled '
        + 'lets setLoginItemSettings default it to true and silently re-enable autostart');
    assert.strictEqual(app.writes[0].path, NEW_EXE, 'the path is the one that moved');
    assert.strictEqual(app.writes[0].openAtLogin, true);
    console.log('  ok  a Task-Manager-disabled entry stays disabled across the rename');
    passed++;
}

{
    const app = makeApp({ launchItems: [entry({ enabled: true })] });
    run(app);
    assert.strictEqual(app.writes[0].enabled, true, 'an enabled entry stays enabled');
    console.log('  ok  an enabled entry stays enabled across the rename');
    passed++;
}

// ─── The unquoted Run value, as seen on a live upgrade ────────────
{
    // The Run value is written unquoted, so Electron reads it back only up to
    // the first space. This is the exact path launchItems returned on the
    // machine where the bug was confirmed. Launch twice, as that test did.
    const TRUNCATED = 'C:\\Users\\aburszczyk\\AppData\\Local\\Programs\\TaxOne';
    const app = makeApp({ launchItems: [entry({ path: TRUNCATED, enabled: false })] });

    const logs = [];
    for (let launch = 0; launch < 2; launch++) {
        assert.strictEqual(run(app), 're-registered', `launch ${launch + 1}: re-registers`);
        logs.push(...app.logs);
    }

    for (const write of app.writes) {
        assert.strictEqual(write.path, NEW_EXE, 'written with process.execPath, not the truncated path');
        assert.strictEqual(write.enabled, false, 'a disabled entry stays disabled');
        assert.strictEqual(write.openAtLogin, true);
    }
    assert.strictEqual(logs.length, 0,
        'no log line on either launch — a per-launch "Re-registered" line is the bug');
    console.log('  ok  a truncated unquoted path re-registers, stays disabled, and logs nothing');
    passed++;
}

// ─── Everything else it must not do ───────────────────────────────
{
    // No staleness check: a path that already matches is rewritten too. The
    // stored path cannot be read back reliably (see the truncation case below),
    // so the write is unconditional and has to be idempotent.
    const app = makeApp({ launchItems: [entry({ path: NEW_EXE })] });
    assert.strictEqual(run(app), 're-registered');
    assert.strictEqual(app.writes.length, 1, 'a matching path is still written');
    assert.deepStrictEqual(app.writes[0], { openAtLogin: true, path: NEW_EXE, enabled: true },
        'and written with exactly the same settings, so repeating it changes nothing');
    console.log('  ok  an entry that already matches is rewritten identically');
    passed++;
}

{
    // Autostart turned off in Settings removes the registry value entirely.
    const app = makeApp({ launchItems: [] });
    assert.strictEqual(run(app), 'no-entry');
    assert.strictEqual(app.writes.length, 0, 'autostart that was turned off is not resurrected');
    console.log('  ok  a missing entry is not resurrected');
    passed++;
}

{
    // Another app's Run entry is not ours to touch.
    const app = makeApp({ launchItems: [entry({ name: 'SomeOtherApp' })] });
    assert.strictEqual(run(app), 'no-entry');
    assert.strictEqual(app.writes.length, 0, 'only our own entry is considered');
    console.log('  ok  another app\'s Run entry is ignored');
    passed++;
}

{
    const app = makeApp({ isPackaged: false, launchItems: [entry()] });
    assert.strictEqual(run(app), 'not-packaged');
    assert.strictEqual(app.writes.length, 0, 'dev runs never touch the registry');
    console.log('  ok  an unpackaged build does not touch the registry');
    passed++;
}

{
    const app = makeApp({ throws: true });
    assert.strictEqual(run(app), 'failed', 'a registry error is contained, not thrown');
    assert.ok(app.logs.some(l => l.includes('Reconcile failed')), 'the failure is logged');
    console.log('  ok  a registry failure is logged and contained');
    passed++;
}

console.log('');
console.log(`${passed} passed`);
