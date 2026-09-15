# v1.2.0 upgrade verification

Merge gate for `fix/quework-rebrand-followups`. The unit tests all passed while
the legacy-host migration was dead code, so they do not gate this release — a
real upgrade over a real v1.1.5 install does.

Run it on Windows, start to finish, in order.

## Why a manual test is the gate

v1.1.5 renamed `productName`, which is what Electron derives `userData` from,
which is what `electron-store` resolves its directory from — once, at
construction time. Nothing in the test suite touches that chain. Everything the
migration is supposed to repair lives on the far side of it.

---

## 0. Restore the fixture — mandatory

`%APPDATA%\TaxOne Desktop` on the dev machine is **no longer** a legacy
install. The previous upgrade test migrated it: `serverUrl` is now
`https://caputa.quework.app`, `_hostMigratedV1` is set, and `debug.log` holds
lines from earlier builds. A test run against it proves nothing, so restoring
from the backup is mandatory, not a fallback.

The backup at `%USERPROFILE%\Desktop\taxone-fixture-backup` is the pristine
v1.1.5 fixture: `serverUrl=https://taxone.cpa`,
`watchPath=C:\Users\<you>\TaxoneWatch`, a real token, a ~20 MB
`migration-queue.json`, no migration guard flags, and **no `debug.log`**.

A correct fixture has no `debug.log`. v1.1.5 never writes one: its `debugLog()`
was defined but never called. Any `debug.log` in the fixture came from a newer
build, and would let the log checks in step 3 pass on lines that build wrote,
so the restore deletes it.

Quit the app from the tray first, then:

```powershell
$ud  = "$env:APPDATA\TaxOne Desktop"
$bak = "$env:USERPROFILE\Desktop\taxone-fixture-backup"
if (-not (Test-Path -LiteralPath "$bak\taxone-settings.json")) { throw "STOP: no fixture backup at $bak" }
if (Get-Process 'Quework Desktop', 'TaxOne Desktop' -ErrorAction SilentlyContinue) { throw 'STOP: quit the app from the tray first' }
if (Test-Path -LiteralPath $ud) { Remove-Item -LiteralPath $ud -Recurse -Force }
Copy-Item -LiteralPath $bak -Destination $ud -Recurse
Remove-Item -LiteralPath "$ud\debug.log" -Force -ErrorAction SilentlyContinue
$s = Get-Content "$ud\taxone-settings.json" -Raw | ConvertFrom-Json
"serverUrl:         $($s.serverUrl)"
"_hostMigratedV1:   $($s._hostMigratedV1)"
"debug.log present: $(Test-Path -LiteralPath "$ud\debug.log")"
```

Expected: `serverUrl` is `https://taxone.cpa`, `_hostMigratedV1` is empty, and
`debug.log present` is `False`. Anything else: stop.

**Do not launch a dev build (`npm start`) before the test.** It runs the same
migrations, sets `_hostMigratedV1`, writes `debug.log`, and turns step 3 into a
no-op that proves nothing. Run this step again if that happens.

---

## 1. Baseline: install v1.1.5

1. Download `TaxOne-Desktop-Setup.exe` from the
   [v1.1.5 release](https://github.com/abr9t/taxone-desktop/releases/tag/v1.1.5)
   and install it.
2. Sign in against **`https://taxone.cpa`** (not the new host — the point is to
   create a legacy install).
3. Open **Settings** and set a watch folder. Use `C:\Users\<you>\TaxoneWatch`
   for the default-folder path, or a folder of your own to test the
   explicit-choice path. Note which you chose.
4. Record the baseline:

```
type "%APPDATA%\TaxOne Desktop\taxone-settings.json"
```

```powershell
# Install directory, located from the uninstall key rather than assumed.
$key = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\fb2f6324-7194-5753-aa0e-d1c9da0ecd6e' -ErrorAction SilentlyContinue
if (-not $key) { 'STOP: uninstall key fb2f6324-... not found; v1.1.5 is not installed' }
else {
    "DisplayName: $($key.DisplayName)"
    if ($key.UninstallString -match '^"?(.+?\.exe)"?') {
        $dir = Split-Path $Matches[1] -Parent
        "install dir: $dir"
        Get-ChildItem -LiteralPath $dir -Filter *.exe | ForEach-Object { "  $($_.Name)" }
    } else { "STOP: cannot parse UninstallString: $($key.UninstallString)" }
}

# Run entry and protocol command: each must name an existing TaxOne Desktop.exe.
$check = {
    param($label, $value)
    if (-not $value) { "${label}: NOTE: no value"; return }
    if ($value -notmatch '^"?(.+?\.exe)"?') { "${label}: FAIL: cannot parse: $value"; return }
    $exe = $Matches[1]
    $problems = @()
    if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { $problems += 'exe does not exist' }
    if ((Split-Path $exe -Leaf) -ne 'TaxOne Desktop.exe')  { $problems += 'exe is not TaxOne Desktop.exe' }
    if ($problems) { "${label}: FAIL: $($problems -join ', ') -> $exe" } else { "${label}: PASS -> $exe" }
}
& $check 'Run'      (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run').'com.taxone.desktop'
& $check 'protocol' (Get-ItemProperty 'HKCU:\Software\Classes\taxone-desktop\shell\open\command').'(default)'
```

Expected: `serverUrl` is `https://taxone.cpa`; `DisplayName` is
`TaxOne Desktop 1.1.5`; the install directory is listed with the exes in it;
and `Run` and `protocol` both PASS, naming an existing exe called
`TaxOne Desktop.exe`. Which directory that is does not matter and is not
checked: an installer reuses whatever directory it finds, so on a machine that
has had any earlier install it may not be `...\Programs\TaxOne Desktop`. A `Run`
NOTE means autostart is off; the next step covers that case.

Record the Run value too. Step 3 checks it against this:

```powershell
Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" | Select-Object com.taxone.desktop
```

If it is blank, autostart is off on this install, and after the upgrade it
must still be absent.

5. Record the queue counts. **Write these two numbers down** — step 3
   compares against them. Do not create a pending file to test with: the
   fixture already carries a real queue, and a deliberately unconfirmed file
   adds nothing but a way to lose one.

```powershell
$q = Get-Content "$env:APPDATA\TaxOne Desktop\migration-queue.json" -Raw | ConvertFrom-Json
"files:   $($q.files.Length)"
"history: $($q.history.Length)"
```

6. **Quit the app from the tray** before upgrading. Do not just close windows —
   the queue is flushed on `before-quit`.

---

## 2. Upgrade in place

Run the installer built from this branch over the top. Do not uninstall
first — an in-place upgrade is what is being tested.

```
C:\Users\aburszczyk\Projects\taxone-desktop\.claude\worktrees\phase-2-report-contradictions-e70c2f\dist\TaxOne-Desktop-Setup.exe
```

Verify you are running the right binary before you start — a stale one from
an earlier build invalidates everything below:

```powershell
Get-FileHash "<path above>" -Algorithm SHA256
```

| | |
|---|---|
| SHA256 | `7452DEF7EBBDEC808D1F3EFA6C5B60A18C53C2A2C48AF6690FE2E02F019A45B9` |
| Size | 84,637,702 bytes |
| Version resource | Quework Desktop 1.2.0, Quework LLC |
| Built from | `5176536`. The last commit that changes anything the installer packs is `f29d890` |

Unsigned, so SmartScreen will warn on launch. That is unchanged from v1.1.5
and not a finding.

**Before you run it, record the log baseline.** The installer's finish page
launches the app by default (electron-builder's `runAfterFinish`), so the
first launch — and the migration it performs — happens the moment you click
Finish. This cannot wait until after installing. Step 3 reads the file this
writes; the counts are not kept in the shell, so the two halves cannot be
pasted together and pass by construction.

```powershell
$log = "$env:APPDATA\TaxOne Desktop\debug.log"
$bf  = "$env:TEMP\quework-upgrade-log-baseline.json"
Remove-Item -LiteralPath $bf -Force -ErrorAction SilentlyContinue
if (Test-Path -LiteralPath $log) {
    'STOP: debug.log already exists, so the fixture is not clean. Run step 0 again. No baseline written.'
} else {
    # debug.log does not exist, so neither line can have been written yet.
    $baseline = [ordered]@{
        autostart = 0
        migration = 0
        recorded  = (Get-Date).ToString('o')
    }
    $baseline | ConvertTo-Json | Set-Content -LiteralPath $bf
    "baseline written to $bf"
    $baseline
}
```

Expected: `baseline written`, with both counts `0`. Then run the installer.

---

## 3. Checks

### Config survived — the whole point of the release

- [ ] After upgrading, check `%APPDATA%\Quework Desktop`.
      - **PASS:** it doesn't exist, or it contains only Electron-internal
        folders (e.g. `Crashpad`) and none of: `taxone-settings.json`,
        `migration-queue.json`, `debug.log`.
      - **FAIL:** any of those three files exists. The pin was bypassed. If
        `debug.log` exists, a `[auth] userData resolved to` line in it
        confirms this. **Stop the test and report.**
- [ ] `type "%APPDATA%\TaxOne Desktop\taxone-settings.json"` shows
      `serverUrl` = `https://caputa.quework.app` and `_hostMigratedV1` = true.
- [ ] The app came up **signed in**. No login window, no re-pair.
- [ ] Settings shows the same watch folder as step 1.3.
      If you used the default, `watchPath` is now persisted as
      `C:\Users\<you>\TaxoneWatch` with `_watchPathMigratedV1` = true.
      `~\QueworkWatch` was not created and is not being watched.
- [ ] The queue counts match the two numbers from step 1.5 — same command,
      same `files` and `history` lengths. Then open the **File Upload** window
      and confirm the **Queue** and **History** tabs show those same counts, so
      the store on disk and what the app renders agree.
- [ ] `debug.log` gained **exactly one** `[migration] Re-pointed persisted host`
      line since the step 2 baseline. `debug.log` is append-only and survives
      upgrades, so a line being present proves nothing on its own; only a new
      one does. Exactly one, because the migration is guarded and must not
      repeat on later launches. (The settings-file check above proves the
      migration's result; this proves this build performed it, once.)

```powershell
$bf = "$env:TEMP\quework-upgrade-log-baseline.json"
if (-not (Test-Path -LiteralPath $bf)) { 'FAIL: no baseline file. Run the step 2 block before the installer.' }
else {
    $before = (Get-Content -LiteralPath $bf -Raw | ConvertFrom-Json).migration
    $log    = "$env:APPDATA\TaxOne Desktop\debug.log"
    $lines  = @(if (Test-Path -LiteralPath $log) { Select-String -LiteralPath $log -Pattern '[migration] Re-pointed persisted host' -SimpleMatch })
    $new    = $lines.Count - $before
    if ($new -eq 1) { 'PASS' } else { "FAIL: $new new line(s), expected exactly 1" }
    $lines | Select-Object -Skip $before | ForEach-Object { $_.Line }
}
```

### Upgraded in place, not alongside

- [ ] **One uninstall entry, same key, no old exe.** Do **not** judge this by
      the install directory's name: an upgrade reuses the existing directory,
      so over v1.1.5 it is still called `TaxOne Desktop`, and its name proves
      nothing either way. Check these three instead:

```powershell
$un  = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
$key = Get-ItemProperty "$un\fb2f6324-7194-5753-aa0e-d1c9da0ecd6e" -ErrorAction SilentlyContinue

# 1. The uninstall key is unchanged.
if ($key) { "1 PASS: key present, DisplayName = $($key.DisplayName)" } else { '1 FAIL: key fb2f6324-... is missing' }

# 2. Exactly one TaxOne/Quework entry, and it is Quework Desktop 1.2.0.
$m = @(Get-ChildItem $un | ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.DisplayName -match 'TaxOne|Quework' })
$m | ForEach-Object { "   $($_.PSChildName)  $($_.DisplayName)" }
if ($m.Count -eq 1 -and $m[0].DisplayName -eq 'Quework Desktop 1.2.0') { '2 PASS' } else { "2 FAIL: $($m.Count) match(es), listed above" }

# 3. No TaxOne Desktop.exe in the install directory, located from the
#    uninstall key rather than assumed.
if ($key.UninstallString -match '^"?(.+?\.exe)"?') {
    $dir = Split-Path $Matches[1] -Parent
    "   install dir: $dir"
    if (Test-Path -LiteralPath (Join-Path $dir 'TaxOne Desktop.exe')) { '3 FAIL: TaxOne Desktop.exe is still there' } else { '3 PASS' }
} else { "3 FAIL: cannot parse UninstallString: $($key.UninstallString)" }
```

      All three must PASS. Check 2 filters on `TaxOne|Quework`, so an
      unrelated app with "Desktop" in its name (GitHub Desktop, Docker
      Desktop) cannot make the printed verdict wrong.

      (Both installers derive `fb2f6324-7194-5753-aa0e-d1c9da0ecd6e` as a
      UUIDv5 of the unchanged `appId: com.taxone.desktop`. That is why the
      upgrade lands in place.)
- [ ] Desktop and Start Menu each have exactly one shortcut, `Quework Desktop`,
      and it launches. No orphaned `TaxOne Desktop` shortcut.

### Registry follows the renamed executable

- [ ] **The protocol command names the same exe as the Run value.** The
      expected path is not written down here on purpose: it is whatever
      directory the install actually uses. Launch the upgraded app once, then:

```powershell
$cmd = (Get-ItemProperty 'HKCU:\Software\Classes\taxone-desktop\shell\open\command').'(default)'
$run = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run').'com.taxone.desktop'
"command: $cmd"
"run:     $run"
if ($cmd -notmatch '^"?(.+?\.exe)"?') { 'FAIL: cannot parse the command' } else {
    $exe = $Matches[1]
    $ok  = $true
    if (-not (Test-Path -LiteralPath $exe -PathType Leaf))      { 'FAIL: the command exe does not exist'; $ok = $false }
    if ((Split-Path $exe -Leaf) -ne 'Quework Desktop.exe')      { 'FAIL: the command exe is not Quework Desktop.exe'; $ok = $false }
    if (-not $run)                                              { 'NOTE: no Run value (autostart off), so there is nothing to compare against' }
    elseif ($exe -ne $run.Trim('"'))                            { 'FAIL: the command exe differs from the Run value'; $ok = $false }
    if ($ok) { 'PASS' }
}
```

      **PASS:** the command's exe exists, is named `Quework Desktop.exe`, and
      is the same path as the Run value. Quotes are stripped from both before
      comparing. If autostart is off there is no Run value; the first two
      conditions must still hold.
- [ ] **The Run value points at an exe that exists.** Launch the upgraded app
      once, then:

```powershell
$run = (Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run").'com.taxone.desktop'
"value: $run"
if (-not $run) { 'FAIL: the value is gone' }
elseif (Test-Path -LiteralPath $run.Trim('"') -PathType Leaf) { 'PASS' }
else { 'FAIL: no exe at that path' }
```

      **PASS:** the value exists and `Test-Path` finds the exe it names.
      **FAIL:** the value disappeared, or it names a path with no exe behind it.
      Exception: if the step 1.4 baseline had no value, autostart was off, and
      the value must still be absent. "The value is gone" is then a pass.
      `.Trim('"')` only removes surrounding quotes, in case a later build
      quotes the value; today it is written unquoted.

- [ ] `debug.log` gains **no** `[autostart]` line from this build. A successful
      re-registration is not logged, so any new `[autostart]` line is a
      failure. Compared against the count recorded in step 2, before the
      installer ran. "No new line" only means something if the upgraded app
      actually launched in between, so PASS also requires the new
      `[migration]` line from the check above as proof of that launch.

```powershell
$bf = "$env:TEMP\quework-upgrade-log-baseline.json"
if (-not (Test-Path -LiteralPath $bf)) { 'FAIL: no baseline file. Run the step 2 block before the installer.' }
else {
    $base   = Get-Content -LiteralPath $bf -Raw | ConvertFrom-Json
    $log    = "$env:APPDATA\TaxOne Desktop\debug.log"
    $lines  = @(if (Test-Path -LiteralPath $log) { Select-String -LiteralPath $log -Pattern '[autostart]' -SimpleMatch })
    $launch = @(if (Test-Path -LiteralPath $log) { Select-String -LiteralPath $log -Pattern '[migration] Re-pointed persisted host' -SimpleMatch }).Count - $base.migration
    if ($launch -lt 1)                     { 'FAIL: no new [migration] line, so there is no evidence the upgraded app launched; an empty result proves nothing' }
    elseif ($lines.Count -eq $base.autostart) { 'PASS' }
    else { 'FAIL'; $lines | Select-Object -Skip $base.autostart | ForEach-Object { $_.Line } }
}
```

- [ ] **Disabled stays disabled.** In Task Manager → Startup apps, disable the
      app's entry (value name `com.taxone.desktop`; it may be listed as
      Quework Desktop). Relaunch the app, then confirm the entry is still
      **Disabled**. The app re-registers the entry on every launch; one that
      does not carry the enabled state through turns autostart back on.
      Re-enable it afterwards if you want autostart back.

### Function

- [ ] **Protocol handoff.** With the app running, sign in from the browser at
      `https://caputa.quework.app/desktop/authorize`. It should hand back to the
      app without a "change server" dialog (same host).
      *Note: the handoff only works while the app is already running — a
      cold-start protocol launch is not handled. Pre-existing, unrelated to this
      branch.*
- [ ] **Rejected link.** Paste into Run (Win+R):
      `taxone-desktop://connect?url=https://evil.example`
      → "This link was ignored", `serverUrl` unchanged in the settings file.
- [ ] **Host-change confirmation.** Paste:
      `taxone-desktop://connect?url=https://otherfirm.quework.app`
      → a "Change Quework server?" dialog. **Cancel it.** `serverUrl` unchanged.
- [ ] **End-to-end upload.** Drop a PDF into the watch folder, confirm it in the
      window, and verify it lands in the client's documents on
      `caputa.quework.app`.
- [ ] **Autostart.** Reboot (or sign out and back in). The app starts.

---

## 4. If it fails

Run step 0 again before re-running, then step 2's baseline block again. The
migration guards are one-shot, a half-migrated store is not a valid fixture,
and the restore deletes the `debug.log` that the step 3 log checks count
against.
