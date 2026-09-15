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

## 0. Back up the fixture first

`%APPDATA%\TaxOne Desktop` on the dev machine is already a pristine legacy
install: `serverUrl=https://taxone.cpa`, `watchPath=C:\Users\<you>\TaxoneWatch`,
a real token, and a ~20 MB `migration-queue.json`.

```
xcopy "%APPDATA%\TaxOne Desktop" "%USERPROFILE%\Desktop\taxone-userdata-backup" /E /I /H
```

**Do not launch a dev build (`npm start`) before the test.** It runs the same
migrations, sets `_hostMigratedV1`, and turns step 5 into a no-op that proves
nothing. Restore from the backup if that happens.

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
reg query "HKCU\Software\Classes\taxone-desktop\shell\open\command" /ve
dir "%LOCALAPPDATA%\Programs\TaxOne Desktop"
```

Expected: `serverUrl` is `https://taxone.cpa`; the Run entry and the protocol
command both point at `...\TaxOne Desktop\TaxOne Desktop.exe`.

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
- [ ] `%APPDATA%\TaxOne Desktop\debug.log` exists and contains the
      `[migration] Re-pointed persisted host` line. Its absence means the
      migration did not run — that is a failure, not a logging nit.

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

# 2. Exactly one *Desktop* entry, and it is Quework Desktop 1.2.0.
$m = @(Get-ChildItem $un | ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.DisplayName -like '*Desktop*' })
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

      All three must PASS. For check 2, read the listed matches before calling
      it a failure: `*Desktop*` also matches unrelated apps such as GitHub
      Desktop. The failure that matters is any `TaxOne` or `Quework` entry
      other than the `fb2f6324-...` key.

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
      failure. `debug.log` is append-only and survives upgrades, so it may
      already hold lines from an earlier build: count them **before** launching
      the upgraded app, and compare after.

```powershell
$log = "$env:APPDATA\TaxOne Desktop\debug.log"
$before = @(Select-String -Path $log -Pattern '[autostart]' -SimpleMatch -ErrorAction SilentlyContinue).Count
# launch the upgraded app, then:
$lines = @(Select-String -Path $log -Pattern '[autostart]' -SimpleMatch -ErrorAction SilentlyContinue)
if ($lines.Count -eq $before) { 'PASS' } else { 'FAIL'; $lines | Select-Object -Skip $before | ForEach-Object { $_.Line } }
```

      No new lines: PASS. Any new line: FAIL. Report it verbatim.

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

Restore `%APPDATA%\TaxOne Desktop` from the step-0 backup before re-running —
the migration guards are one-shot and a half-migrated store is not a valid
fixture.
