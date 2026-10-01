# v1.2.0 upgrade verification

Merge gate for v1.2.0 (`fix/quework-rebrand-followups`, then
`fix/tls-verification`). The unit tests all passed while the legacy-host
migration was dead code, so they do not gate this release — a real upgrade over
a real v1.1.5 install does.

Run it on Windows, start to finish, in order. Step 0 describes the fixture; it
is **run** at step 1.2, after v1.1.5 is installed.

Section 6 is the gate for **tagging**: the automatic update, tested on the
release candidate from the `dry-run` workflow job, before anything is
published.

Every command below is PowerShell. Paste each block whole. No command prints
the token: anything that shows `taxone-settings.json` drops `_token` first.

## Why a manual test is the gate

v1.1.5 renamed `productName`, which is what Electron derives `userData` from,
which is what `electron-store` resolves its directory from — once, at
construction time. Nothing in the test suite touches that chain. Everything the
migration is supposed to repair lives on the far side of it.

---

## 0. Restore the fixture — mandatory, at step 1.2

**When:** after installing v1.1.5 (step 1.1) and before recording the baseline
(step 1.5). Installing v1.1.5 overwrites a restored fixture: its finish page
launches the app, which writes to `%APPDATA%\TaxOne Desktop`. So install first,
then restore. A fixture restored before the install is not the fixture any
more.

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

## 1. Baseline: install v1.1.5, then restore the fixture

1. Download `TaxOne-Desktop-Setup.exe` from the
   [v1.1.5 release](https://github.com/abr9t/taxone-desktop/releases/tag/v1.1.5)
   and install it. The finish page launches it: **quit it from the tray**. Do
   not sign in — the fixture carries the legacy sign-in.
2. **Run step 0 now.** Not earlier: the install in 1.1 is what would have
   overwritten it.
3. The fixture is the legacy install: signed in against `https://taxone.cpa`,
   watch folder `C:\Users\<you>\TaxoneWatch` (the default-folder path). Do not
   sign in again, which would replace the fixture's token. To test the
   explicit-choice path instead, open **Settings** and set a folder of your
   own. Note which you chose; step 3 compares against it.
4. **Make sure there is a v1.1.5-style Run value.** If the fixture's install
   has none, the autostart check in step 3 would only exercise the "autostart
   off" branch and never the repair. v1.1.5 writes the value unquoted, naming
   `TaxOne Desktop.exe`; create exactly that if it is missing:

```powershell
$run = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$key = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\fb2f6324-7194-5753-aa0e-d1c9da0ecd6e' -ErrorAction SilentlyContinue
$cur = (Get-ItemProperty $run).'com.taxone.desktop'
if ($cur) {
    "Run value already present, left as is: $cur"
} elseif (-not $key) {
    'STOP: uninstall key fb2f6324-... not found; v1.1.5 is not installed'
} elseif ($key.UninstallString -notmatch '^"?(.+?\.exe)"?') {
    "STOP: cannot parse UninstallString: $($key.UninstallString)"
} else {
    $exe = Join-Path (Split-Path $Matches[1] -Parent) 'TaxOne Desktop.exe'
    if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
        "STOP: no exe at $exe"
    } else {
        Set-ItemProperty -Path $run -Name 'com.taxone.desktop' -Value $exe
        "Run value created (unquoted, v1.1.5 style): $exe"
    }
}
```

5. Record the baseline:

```powershell
Get-Content "$env:APPDATA\TaxOne Desktop\taxone-settings.json" -Raw | ConvertFrom-Json | Select-Object -Property * -ExcludeProperty _token | Format-List
```

```powershell
# Install directory, located from the uninstall key rather than assumed.
$key = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\fb2f6324-7194-5753-aa0e-d1c9da0ecd6e' -ErrorAction SilentlyContinue
if (-not $key) {
    'STOP: uninstall key fb2f6324-... not found; v1.1.5 is not installed'
} else {
    "DisplayName: $($key.DisplayName)"
    if ($key.UninstallString -match '^"?(.+?\.exe)"?') {
        $dir = Split-Path $Matches[1] -Parent
        "install dir: $dir"
        Get-ChildItem -LiteralPath $dir -Filter *.exe | ForEach-Object { "  $($_.Name)" }
    } else {
        "STOP: cannot parse UninstallString: $($key.UninstallString)"
    }
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

Expected: `serverUrl` is `https://taxone.cpa` (and no `_token` line is
printed); `DisplayName` is `TaxOne Desktop 1.1.5`; the install directory is
listed with the exes in it; and `Run` and `protocol` both PASS, naming an
existing exe called `TaxOne Desktop.exe`. Which directory that is does not
matter and is not checked: an installer reuses whatever directory it finds, so
on a machine that has had any earlier install it may not be
`...\Programs\TaxOne Desktop`. After step 1.4 a `Run` NOTE should not happen;
if it does, step 1.4 did not take.

Record the Run value too. Step 3 checks it against this:

```powershell
Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" | Select-Object com.taxone.desktop
```

If it is blank, autostart is off on this install, and after the upgrade it
must still be absent.

6. Record the queue counts. **Write these two numbers down** — step 3
   compares against them. Do not create a pending file to test with: the
   fixture already carries a real queue, and a deliberately unconfirmed file
   adds nothing but a way to lose one.

```powershell
$q = Get-Content "$env:APPDATA\TaxOne Desktop\migration-queue.json" -Raw | ConvertFrom-Json
"files:   $($q.files.Length)"
"history: $($q.history.Length)"
```

7. **Quit the app from the tray** before upgrading, if it is running. Do not
   just close windows — the queue is flushed on `before-quit`.

---

## 2. Upgrade in place

Run the installer built from this branch's final commit over the top. Do not
uninstall first — an in-place upgrade is what is being tested.

Its absolute path, SHA256, size and the commit it was built from are in the
`fix/tls-verification` pull request description. **Verify you are running that
binary before you start** — a stale one from an earlier build (including the
`fix/quework-rebrand-followups` build this file used to name) invalidates
everything below:

```powershell
Get-FileHash "<path from the PR>" -Algorithm SHA256
```

The hash must equal the one in the PR. The version resource reads Quework
Desktop 1.2.0, Quework LLC.

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

- [ ] After upgrading, check `%APPDATA%\Quework Desktop`. A missing folder is
      only evidence if the upgraded app actually ran, because an app that never
      launched writes nothing anywhere. So PASS also requires a new
      `[migration]` line in the pinned folder's `debug.log` since the step 2
      baseline:

```powershell
$wrong = "$env:APPDATA\Quework Desktop"
$bf    = "$env:TEMP\quework-upgrade-log-baseline.json"
$log   = "$env:APPDATA\TaxOne Desktop\debug.log"
$leaks = @('taxone-settings.json', 'migration-queue.json', 'debug.log') | Where-Object { Test-Path -LiteralPath (Join-Path $wrong $_) }
if (-not (Test-Path -LiteralPath $bf)) {
    'FAIL: no baseline file. Run the step 2 block before the installer.'
} else {
    $before   = (Get-Content -LiteralPath $bf -Raw | ConvertFrom-Json).migration
    $launched = @(if (Test-Path -LiteralPath $log) { Select-String -LiteralPath $log -Pattern '[migration] Re-pointed persisted host' -SimpleMatch }).Count - $before
    if ($leaks) {
        "FAIL: $($leaks -join ', ') in $wrong. The pin was bypassed. Stop the test and report."
    } elseif ($launched -lt 1) {
        'FAIL: no new [migration] line, so there is no evidence the upgraded app launched; a missing folder proves nothing'
    } else {
        "PASS: none of the three files in $wrong, and the upgraded app launched ($launched new [migration] line)"
    }
}
```

      **FAIL** on leaked files means the pin was bypassed. If `debug.log`
      exists in `$wrong`, a `[auth] userData resolved to` line in it confirms
      this. **Stop the test and report.** Electron-internal folders there
      (e.g. `Crashpad`) are expected and not checked.
- [ ] The settings file shows `serverUrl` = `https://caputa.quework.app` and
      `_hostMigratedV1` = true:

```powershell
Get-Content "$env:APPDATA\TaxOne Desktop\taxone-settings.json" -Raw | ConvertFrom-Json | Select-Object -Property * -ExcludeProperty _token | Format-List
```

- [ ] The app came up **signed in**. No login window, no re-pair.
- [ ] Settings shows the same watch folder as step 1.3.
      If you used the default, `watchPath` is now persisted as
      `C:\Users\<you>\TaxoneWatch` with `_watchPathMigratedV1` = true.
      `~\QueworkWatch` was not created and is not being watched.
- [ ] The queue counts match the two numbers from step 1.6 — same command,
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
if (-not (Test-Path -LiteralPath $bf)) {
    'FAIL: no baseline file. Run the step 2 block before the installer.'
} else {
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
} else {
    "3 FAIL: cannot parse UninstallString: $($key.UninstallString)"
}
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
if ($cmd -notmatch '^"?(.+?\.exe)"?') {
    'FAIL: cannot parse the command'
} else {
    $exe = $Matches[1]
    $ok  = $true
    if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { 'FAIL: the command exe does not exist'; $ok = $false }
    if ((Split-Path $exe -Leaf) -ne 'Quework Desktop.exe') { 'FAIL: the command exe is not Quework Desktop.exe'; $ok = $false }
    if (-not $run) {
        'NOTE: no Run value (autostart off), so there is nothing to compare against'
    } elseif ($exe -ne $run.Trim('"')) {
        'FAIL: the command exe differs from the Run value'; $ok = $false
    }
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
if (-not $run) {
    'FAIL: the value is gone'
} elseif (Test-Path -LiteralPath $run.Trim('"') -PathType Leaf) {
    'PASS'
} else {
    'FAIL: no exe at that path'
}
```

      **PASS:** the value exists and `Test-Path` finds the exe it names.
      **FAIL:** the value disappeared, or it names a path with no exe behind it.
      Exception: if the step 1.5 baseline had no value, autostart was off, and
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
if (-not (Test-Path -LiteralPath $bf)) {
    'FAIL: no baseline file. Run the step 2 block before the installer.'
} else {
    $base   = Get-Content -LiteralPath $bf -Raw | ConvertFrom-Json
    $log    = "$env:APPDATA\TaxOne Desktop\debug.log"
    $lines  = @(if (Test-Path -LiteralPath $log) { Select-String -LiteralPath $log -Pattern '[autostart]' -SimpleMatch })
    $launch = @(if (Test-Path -LiteralPath $log) { Select-String -LiteralPath $log -Pattern '[migration] Re-pointed persisted host' -SimpleMatch }).Count - $base.migration
    if ($launch -lt 1) {
        'FAIL: no new [migration] line, so there is no evidence the upgraded app launched; an empty result proves nothing'
    } elseif ($lines.Count -eq $base.autostart) {
        'PASS'
    } else {
        'FAIL'; $lines | Select-Object -Skip $base.autostart | ForEach-Object { $_.Line }
    }
}
```

- [ ] **Disabled stays disabled.** The app re-registers the entry on every
      launch; one that does not carry the enabled state through turns
      autostart back on.

      Task Manager hides Run entries whose exe does not exist, so first reset
      the Run value to the real current exe path, unquoted (the way the app
      writes it). Without this, a stale value from an earlier run leaves
      nothing in Task Manager to disable:

```powershell
$run = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$cmd = (Get-ItemProperty 'HKCU:\Software\Classes\taxone-desktop\shell\open\command').'(default)'
if ($cmd -notmatch '^"?(.+?\.exe)"?') {
    'STOP: cannot parse the protocol command'
} elseif (-not (Test-Path -LiteralPath $Matches[1] -PathType Leaf)) {
    "STOP: no exe at $($Matches[1])"
} else {
    $exe = $Matches[1]
    Set-ItemProperty -Path $run -Name 'com.taxone.desktop' -Value $exe
    "Run value reset to: $exe"
}
```

      Then, in Task Manager → Startup apps, **disable** the entry (value name
      `com.taxone.desktop`; it may be listed as Quework Desktop) and record the
      StartupApproved byte. The first byte is `2` when enabled and `3` when
      disabled:

```powershell
$sa = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run' -ErrorAction SilentlyContinue).'com.taxone.desktop'
$bf = "$env:TEMP\quework-startupapproved-before.txt"
Remove-Item -LiteralPath $bf -Force -ErrorAction SilentlyContinue
if (-not $sa) {
    'STOP: no StartupApproved value; disable the entry in Task Manager first'
} elseif ($sa[0] -ne 3) {
    "STOP: byte is $($sa[0]), not 3 (disabled); disable the entry in Task Manager first"
} else {
    # Plain text, not JSON: pwsh 7's ConvertFrom-Json turns an ISO string into
    # a DateTime, which then round-trips through the current culture and loses
    # its sub-second part. 'o' with the invariant culture keeps full precision
    # and the UTC offset.
    $at = (Get-Date).ToString('o', [System.Globalization.CultureInfo]::InvariantCulture)
    Set-Content -LiteralPath $bf -Value @([int]$sa[0], $at)
    "before: $($sa[0]) (disabled) at $at, recorded to $bf"
}
```

      Quit the app from the tray, launch it again, then record the byte after.
      The check requires the running app to have started **after** the
      "before" record, so it cannot pass without a relaunch:

```powershell
$sa = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run' -ErrorAction SilentlyContinue).'com.taxone.desktop'
$bf = "$env:TEMP\quework-startupapproved-before.txt"
$procs = @(Get-Process 'Quework Desktop' -ErrorAction SilentlyContinue)
if (-not (Test-Path -LiteralPath $bf)) {
    'FAIL: no "before" record. Run the previous block first.'
} elseif (-not $procs) {
    'FAIL: Quework Desktop is not running. Launch it, then run this again.'
} elseif (-not $sa) {
    'FAIL: the StartupApproved value is gone'
} else {
    $rec     = @(Get-Content -LiteralPath $bf)
    $byte    = [int]$rec[0]
    $at      = [datetime]::ParseExact($rec[1], 'o', [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind)
    $started = ($procs | Sort-Object StartTime | Select-Object -First 1).StartTime
    "before: $byte at $($at.ToString('o'))"
    "after:  $($sa[0]); app started $($started.ToString('o'))"
    if ($started.ToUniversalTime() -le $at.ToUniversalTime()) {
        'FAIL: the app has not been relaunched since the "before" record'
    } elseif ($byte -eq 3 -and $sa[0] -eq 3) {
        'PASS: relaunched and still disabled'
    } else {
        'FAIL: the relaunch changed the enabled state'
    }
}
```

      Task Manager must also still show the entry **Disabled**. Re-enable it
      afterwards if you want autostart back.

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
      `caputa.quework.app`. This is also the check that the released build
      reaches `https://caputa.quework.app` with certificate verification on.
- [ ] **Autostart.** Reboot (or sign out and back in). The app starts.

---

## 4. Stored host is validated on read

Run this last: it signs the install out. It checks that a host stored before
validation existed (what an unvalidated `taxone-desktop://connect` link could
leave behind on v1.1.5) is cleared together with the token on the first launch.

1. Quit the app from the tray, then run **step 0** to restore the fixture.
2. Point the restored fixture at `https://evil.example`. The file is written
   back **without a BOM**: electron-store discards a settings file it cannot
   parse, which would also make the host disappear and pass this check for the
   wrong reason.

```powershell
$f = "$env:APPDATA\TaxOne Desktop\taxone-settings.json"
$s = Get-Content -LiteralPath $f -Raw | ConvertFrom-Json
$s.serverUrl = 'https://evil.example'
[System.IO.File]::WriteAllText($f, ($s | ConvertTo-Json -Depth 10), (New-Object System.Text.UTF8Encoding $false))
$s = Get-Content -LiteralPath $f -Raw | ConvertFrom-Json
$kb = "$env:TEMP\quework-keychain-before.txt"
$keychain = @(cmdkey /list | Select-String 'TaxOneDesktop')
Set-Content -LiteralPath $kb -Value $keychain.Count
"serverUrl:         $($s.serverUrl)"
"_token present:    $([bool]$s._token)"
"keychain entries:  $($keychain.Count) (recorded to $kb)"
$keychain | ForEach-Object { "  $($_.Line.Trim())" }
```

      Expected: `serverUrl` is `https://evil.example`, `_token present` is
      `True`, and one `TaxOneDesktop/api-token` keychain entry (keytar writes
      the token there as well as to `_token`). `cmdkey` prints target names
      only, never the secret. The count is recorded so the check after launch
      compares against it.
3. Launch Quework Desktop from the Start Menu.
4. Check:

- [ ] Only the **sign-in window** opens (no File Upload window), and its error
      area says the saved server address was not accepted, names
      `evil.example`, and says you were signed out.
- [ ] The host and **both** copies of the token are gone:

```powershell
$f   = "$env:APPDATA\TaxOne Desktop\taxone-settings.json"
$kb  = "$env:TEMP\quework-keychain-before.txt"
$log = "$env:APPDATA\TaxOne Desktop\debug.log"
$s = $null
if (Test-Path -LiteralPath $f) {
    try { $s = Get-Content -LiteralPath $f -Raw | ConvertFrom-Json -ErrorAction Stop } catch { $s = $null }
}
$after = @(cmdkey /list | Select-String 'TaxOneDesktop').Count
if (-not (Test-Path -LiteralPath $f)) {
    # The app clears two keys, it does not delete the file. A missing file means
    # something else happened (electron-store discards a file it cannot parse),
    # so "no host, no token" would be true for the wrong reason.
    'FAIL: taxone-settings.json is missing, so its absence of a host and token proves nothing'
} elseif ($null -eq $s) {
    'FAIL: taxone-settings.json could not be read or parsed'
} elseif (-not (Test-Path -LiteralPath $kb)) {
    'FAIL: no keychain count recorded before launch. Run the block in step 4.2 first.'
} else {
    $hasHost  = [bool]$s.serverUrl
    $hasToken = [bool]$s._token
    "serverUrl present: $hasHost"
    "_token present:    $hasToken"
    $before = [int](Get-Content -LiteralPath $kb -Raw).Trim()
    "keychain entries:  before $before, after $after"
    $deleteFailed = (Test-Path -LiteralPath $log) -and (Select-String -LiteralPath $log -Pattern '[auth] Could not delete the keychain token' -SimpleMatch -Quiet)
    if ($hasHost -or $hasToken) {
        'FAIL: the host or the _token fallback survived'
    } elseif ($before -lt 1) {
        'INCONCLUSIVE: there was no keychain entry before launch, so the keychain half proves nothing. Host and _token are gone.'
    } elseif ($after -eq 0) {
        'PASS: host, _token and the keychain entry are gone'
    } elseif ($deleteFailed) {
        'FAIL: the keychain delete failed (logged). The token is revoked, not removed. Report it.'
    } else {
        'FAIL: the keychain entry survived and no delete failure was logged'
    }
}
```

- [ ] `debug.log` names what happened: exactly one rejection line, naming
      `evil.example`.

```powershell
$log = "$env:APPDATA\TaxOne Desktop\debug.log"
$lines = @(if (Test-Path -LiteralPath $log) {
    Select-String -LiteralPath $log -Pattern '[startup] Stored server URL rejected' -SimpleMatch | Where-Object { $_.Line -match 'evil\.example' }
})
$lines | ForEach-Object { $_.Line }
if ($lines.Count -eq 1) { 'PASS' } else { "FAIL: $($lines.Count) rejection line(s) naming evil.example, expected exactly 1" }
```
- [ ] Sign in again with `https://caputa.quework.app`. The error area clears
      and the app works as before.

---

## 5. If it fails

Run step 0 again before re-running, then step 2's baseline block again. The
migration guards are one-shot, a half-migrated store is not a valid fixture,
and the restore deletes the `debug.log` that the step 3 log checks count
against.

---

## 6. Automatic update — the release candidate, before tagging

The gate for tagging v1.2.0 with the updater in it. It tests the **release
candidate** — the installer the `dry-run` job built from the final commit —
by updating it to a throwaway **1.2.1 built from the same commit**, served
from this machine. Nothing is published and nothing is tagged. Tag only after
every check here passes.

What it proves: the download is checked against `latest.yml`; *Restart to
Update* refuses while a file is pending; a successful check that stops
offering the version withdraws it; the silent install stays per-user, lands
in the same directory under the same uninstall key, and relaunches; the
app's stored data survives; the first launch of the new version runs no
early check. What it does not prove: the GitHub and TLS leg (`github.com`,
Windows certificate store) — that is 6.12, after the real release is
published.

Run every block in **one** PowerShell window, in order (the local update
server runs in a second one). If that window is closed, run 6.0 again. Each
check prints PASS or FAIL; any FAIL stops the release. No block prints the
token.

### 6.0 Session helpers

```powershell
$root = "$env:TEMP\quework-update-test"
$ud   = "$env:APPDATA\TaxOne Desktop"
$log  = "$ud\debug.log"
$guid = 'fb2f6324-7194-5753-aa0e-d1c9da0ecd6e'
$un   = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$guid"
$inst = "HKCU:\Software\$guid"

function Get-Sha512Base64([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    try {
        [Convert]::ToBase64String([Security.Cryptography.SHA512]::Create().ComputeHash($stream))
    } finally {
        $stream.Dispose()
    }
}

# A release folder: latest.yml names $Version and matches the installer
# beside it, the installer's version resource says $Version, and the
# blockmap is there.
function Test-ReleaseFolder([string]$Dir, [string]$Version) {
    $yml  = Get-Content -LiteralPath "$Dir\latest.yml"
    $ver  = ($yml | Select-String -Pattern '^version:\s*(\S+)').Matches[0].Groups[1].Value
    $want = ($yml | Select-String -Pattern '^sha512:\s*(\S+)').Matches[0].Groups[1].Value
    $have = Get-Sha512Base64 "$Dir\TaxOne-Desktop-Setup.exe"
    $res  = (Get-Item -LiteralPath "$Dir\TaxOne-Desktop-Setup.exe").VersionInfo.FileVersion
    if ($ver -eq $Version) { "version  PASS: latest.yml says $ver" } else { "version  FAIL: latest.yml says $ver, expected $Version" }
    if ($want -eq $have) { 'sha512   PASS: latest.yml matches the installer' } else { "sha512   FAIL: latest.yml $want, installer $have" }
    if ($res -eq $Version) { "resource PASS: installer FileVersion $res" } else { "resource FAIL: installer FileVersion $res, expected $Version" }
    if (Test-Path -LiteralPath "$Dir\TaxOne-Desktop-Setup.exe.blockmap") { 'blockmap PASS' } else { 'blockmap FAIL: missing' }
}

# Lines debug.log gained since $Mark (a line count taken earlier).
function Get-NewLogLines([int]$Mark) {
    @(Get-Content -LiteralPath $log -ErrorAction SilentlyContinue | Select-Object -Skip $Mark)
}
function Get-LogMark {
    @(Get-Content -LiteralPath $log -ErrorAction SilentlyContinue).Count
}

# Every electron-store file in userData except migration-queue.json, key by
# key. Values are held as JSON strings and never printed: _token is compared,
# not shown.
function Get-StoreSnapshot {
    $snap = @{}
    Get-ChildItem -LiteralPath $ud -Filter *.json -File | Where-Object { $_.Name -ne 'migration-queue.json' } | ForEach-Object {
        $props = @{}
        $obj = Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json
        foreach ($p in $obj.PSObject.Properties) { $props[$p.Name] = ConvertTo-Json -InputObject $p.Value -Compress -Depth 20 }
        $snap[$_.Name] = $props
    }
    $snap
}

function Get-RunningVersion {
    $p = Get-Process 'Quework Desktop' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($p) { (Get-Item -LiteralPath $p.Path).VersionInfo.FileVersion } else { 'not running' }
}
```

### 6.1 Get the release candidate

1. On GitHub: **Actions → Build and Release → Run workflow**, on the branch
   being released, at its final commit. When the `dry-run` job is green,
   download the artifact `release-candidate-<commit sha>` to `Downloads`.
2. Paste the full commit SHA from the artifact's name, then:

```powershell
$sha = 'PASTE-THE-40-CHARACTER-COMMIT-SHA'
$zip = "$env:USERPROFILE\Downloads\release-candidate-$sha.zip"
$rc  = "$root\v1.2.0"
if ($sha -notmatch '^[0-9a-f]{40}$') { throw 'STOP: paste the full commit SHA' }
if (-not (Test-Path -LiteralPath $zip)) { throw "STOP: no artifact at $zip" }
if (Get-Process 'Quework Desktop' -ErrorAction SilentlyContinue) { throw 'STOP: quit the app from the tray first' }
if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
New-Item -ItemType Directory -Path $rc | Out-Null
Expand-Archive -LiteralPath $zip -DestinationPath $rc
Get-ChildItem -LiteralPath $rc | ForEach-Object { "  $($_.Name)  $($_.Length)" }
Test-ReleaseFolder $rc '1.2.0'
```

Expected: exactly `latest.yml`, `TaxOne-Desktop-Setup.exe` and
`TaxOne-Desktop-Setup.exe.blockmap`, and four PASS lines.

### 6.2 Build the throwaway 1.2.1 from the same commit

Same commit, only the version changed, in a clean export — never in your
working copy. Set `$repo` to your clone first.

```powershell
$repo = "$env:USERPROFILE\PhpstormProjects\taxone-desktop"
$src  = "$root\build-1.2.1"
$upd  = "$root\v1.2.1"
git -C $repo fetch origin
if ((git -C $repo cat-file -t $sha) -ne 'commit') { throw "STOP: $sha is not a commit in $repo" }
git -C $repo archive --format=zip -o "$root\src.zip" $sha
Expand-Archive -LiteralPath "$root\src.zip" -DestinationPath $src
Push-Location -LiteralPath $src
try {
    npm version 1.2.1 --no-git-tag-version
    if ($LASTEXITCODE -ne 0) { throw 'STOP: npm version failed' }
    npm ci
    if ($LASTEXITCODE -ne 0) { throw 'STOP: npm ci failed' }
    npm run build
    if ($LASTEXITCODE -ne 0) { throw 'STOP: npm run build failed' }
} finally {
    Pop-Location
}
New-Item -ItemType Directory -Path $upd | Out-Null
Copy-Item -LiteralPath "$src\dist\TaxOne-Desktop-Setup.exe", "$src\dist\TaxOne-Desktop-Setup.exe.blockmap", "$src\dist\latest.yml" -Destination $upd
Copy-Item -LiteralPath "$upd\latest.yml" -Destination "$root\latest.yml.good"
Test-ReleaseFolder $upd '1.2.1'
```

Expected: four PASS lines. (`npm run build` is `--publish never`: this
build cannot publish anything.)

### 6.3 Start the local update server — second PowerShell window

A 30-line static server on `127.0.0.1:8765`, serving `$root` the way GitHub
lays out a release (`v1.2.0\…`, `v1.2.1\…`). It prints every request.

```powershell
@'
const http = require('http');
const fs = require('fs');
const path = require('path');
const root = path.resolve(process.argv[2]);
http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.join(root, path.normalize(rel));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        console.log(`404 ${req.method} ${rel}`);
        res.writeHead(404);
        return res.end();
    }
    const size = fs.statSync(file).size;
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    if (range) {
        const start = Number(range[1]);
        const end = range[2] ? Number(range[2]) : size - 1;
        console.log(`206 ${req.method} ${rel} ${start}-${end}`);
        res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' });
        return fs.createReadStream(file, { start, end }).pipe(res);
    }
    console.log(`200 ${req.method} ${rel}`);
    res.writeHead(200, { 'Content-Length': size, 'Accept-Ranges': 'bytes' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
}).listen(8765, '127.0.0.1', () => console.log(`serving ${root} on http://127.0.0.1:8765/`));
'@ | Set-Content -LiteralPath "$env:TEMP\quework-update-server.js" -Encoding ASCII
node "$env:TEMP\quework-update-server.js" "$env:TEMP\quework-update-test"
```

Expected: `serving …\quework-update-test on http://127.0.0.1:8765/`. Leave it
running until 6.11.

### 6.4 Install the release candidate and point it at the local server

1. Run `$rc\TaxOne-Desktop-Setup.exe` (Explorer, or `& "$rc\TaxOne-Desktop-Setup.exe"`).
   SmartScreen warns — the build is unsigned; *More info → Run anyway*. Let
   the finish page launch the app, then **quit it from the tray**.
2. The install is per-user and its updater started quietly:

```powershell
$k = Get-ItemProperty -LiteralPath $un -ErrorAction SilentlyContinue
$dir = (Get-ItemProperty -LiteralPath $inst -ErrorAction SilentlyContinue).InstallLocation
if ($k.DisplayName -eq 'Quework Desktop 1.2.0') { 'PASS: HKCU uninstall entry is Quework Desktop 1.2.0' } else { "FAIL: HKCU uninstall entry is '$($k.DisplayName)'" }
if ($dir -and $dir.StartsWith("$env:LOCALAPPDATA\", [StringComparison]::OrdinalIgnoreCase)) { "PASS: InstallLocation is per-user: $dir" } else { "FAIL: InstallLocation is '$dir'" }
$v = (Get-Item -LiteralPath (Join-Path $dir 'Quework Desktop.exe')).VersionInfo.FileVersion
if ($v -eq '1.2.0') { 'PASS: installed exe is 1.2.0' } else { "FAIL: installed exe is $v" }
$cfg = Get-Content -LiteralPath "$ud\config.json" -Raw | ConvertFrom-Json
if ($cfg.lastLaunchedVersion -eq '1.2.0') { 'PASS: lastLaunchedVersion 1.2.0' } else { "FAIL: lastLaunchedVersion is '$($cfg.lastLaunchedVersion)'" }
$lines = @(Get-Content -LiteralPath $log)
$started = @($lines | Where-Object { $_ -match '\[updater\] Started for 1\.2\.0' })
$first   = @($lines | Where-Object { $_ -match '\[updater\] First launch of this version' })
if ($started.Count -ge 1 -and $first.Count -ge 1) { 'PASS: updater started; first launch, no early check' } else { "FAIL: $($started.Count) 'Started for 1.2.0', $($first.Count) 'First launch' line(s)" }
$yml = Join-Path $dir 'resources\app-update.yml'
$y = Get-Content -LiteralPath $yml -Raw
if ($y -match 'provider:\s*github' -and $y -match 'owner:\s*abr9t' -and $y -match 'repo:\s*taxone-desktop' -and $y -notmatch 'token') { 'PASS: app-update.yml is github abr9t/taxone-desktop, no token' } else { "FAIL: app-update.yml:`n$y" }
```

3. Point the installed app at the local server. The update replaces this
   file, so the change undoes itself in 6.8:

```powershell
if (Get-Process 'Quework Desktop' -ErrorAction SilentlyContinue) { throw 'STOP: quit the app from the tray first' }
Copy-Item -LiteralPath $yml -Destination "$root\app-update.yml.rc"
@'
provider: generic
url: http://127.0.0.1:8765/v1.2.1/
useMultipleRangeRequest: false
updaterCacheDirName: taxone-desktop-updater
'@ | Set-Content -LiteralPath $yml -Encoding ASCII
Get-Content -LiteralPath $yml
```

### 6.5 A wrong sha512 offers nothing

```powershell
$wrong = ('A' * 86) + '=='
Get-Content -LiteralPath "$root\latest.yml.good" | ForEach-Object { $_ -replace '^(\s*sha512:\s*)\S+$', "`${1}$wrong" } | Set-Content -LiteralPath "$upd\latest.yml" -Encoding ASCII
Select-String -LiteralPath "$upd\latest.yml" -Pattern 'sha512' | ForEach-Object { $_.Line }
$mark = Get-LogMark
```

Start Quework Desktop from the Start menu. Tray → **Check for Updates**. The
server window shows `latest.yml` and the installer being fetched. Wait until
it is quiet (a minute is plenty), then:

```powershell
$new = Get-NewLogLines $mark
$mismatch = @($new | Where-Object { $_ -match 'sha512 checksum mismatch' })
$ready    = @($new | Where-Object { $_ -match '\[updater\] 1\.2\.1 downloaded and verified' })
if ($mismatch.Count -ge 1 -and $ready.Count -eq 0) { 'PASS: the installer was rejected on its sha512 and nothing was offered' } else { "FAIL: $($mismatch.Count) mismatch line(s), $($ready.Count) 'downloaded and verified' line(s)" }
```

- [ ] The tray menu has **no** *Restart to Update* item.

### 6.6 A pending queue file makes the restart refuse

The queue only holds a file *pending* while it cannot upload it, so this
step runs **offline**, with one throwaway file added to the queue for client
id `0` (no such client — if it ever reached the server it would be refused,
not filed). The real `migration-queue.json` is backed up first and restored
in 6.11.

1. **Quit the app from the tray.** Restore the good `latest.yml` and add the
   test file:

```powershell
if (Get-Process 'Quework Desktop' -ErrorAction SilentlyContinue) { throw 'STOP: quit the app from the tray first' }
if (-not (Test-Path -LiteralPath "$ud\migration-queue.json")) { throw 'STOP: no migration-queue.json; sign in and open File Upload once first' }
Copy-Item -LiteralPath "$root\latest.yml.good" -Destination "$upd\latest.yml" -Force
Test-ReleaseFolder $upd '1.2.1'
Copy-Item -LiteralPath "$ud\migration-queue.json" -Destination "$root\migration-queue.json.bak"
$testFile = "$root\pending-test\update-test.txt"
New-Item -ItemType Directory -Path (Split-Path $testFile -Parent) -Force | Out-Null
Set-Content -LiteralPath $testFile -Value 'Quework Desktop update test. Safe to delete.' -Encoding ASCII
$q = Get-Content -LiteralPath "$ud\migration-queue.json" -Raw | ConvertFrom-Json
$entry = [pscustomobject]@{
    id = 'update-test-0001'; absolutePath = $testFile; relativePath = 'update-test.txt'
    size = (Get-Item -LiteralPath $testFile).Length; clientId = 0; clientName = 'UPDATE TEST'
    folderName = 'pending-test'; folderPath = ''; filename = 'update-test.txt'
    status = 'pending'; retries = 0; error = $null; documentId = $null; uploadedAt = $null
}
$q.files = @(@($q.files) | Where-Object { $null -ne $_ }) + $entry
$q.status = 'paused'
# No BOM: electron-store refuses a JSON file that starts with one.
[IO.File]::WriteAllText("$ud\migration-queue.json", ($q | ConvertTo-Json -Depth 20 -Compress), (New-Object Text.UTF8Encoding $false))
"files in queue: $(@($q.files).Count)"
```

2. **Go offline** (airplane mode, or disconnect the network). The local
   server still answers. Confirm:

```powershell
$online = $true
try {
    $null = Invoke-WebRequest -Uri 'https://caputa.quework.app' -UseBasicParsing -TimeoutSec 10
} catch {
    $online = [bool]$_.Exception.Response
}
if ($online) { 'STOP: caputa.quework.app answered; this machine is still online' } else { 'PASS: offline' }
```

3. Start Quework Desktop. It resumes the queue (it ignores a saved pause) and
   the test file starts failing to upload and retrying.
4. In **File Upload → Queue**, click **⏸ Pause**. If the file already shows
   *failed* (its retries run out after about a minute), click **↻ Retry
   Failed**, then **⏸ Pause**. Then:

```powershell
$q = Get-Content -LiteralPath "$ud\migration-queue.json" -Raw | ConvertFrom-Json
$t = @($q.files | Where-Object { $_.id -eq 'update-test-0001' })
"queue status: $($q.status)"
"test file:    $($t.status) — $($t.error)"
if ($q.status -eq 'paused' -and $t.Count -eq 1 -and $t[0].status -eq 'pending') { 'PASS: the test file is pending in a paused queue' } else { 'STOP: not pending in a paused queue; repeat step 4' }
$mark = Get-LogMark
```

5. Tray → **Check for Updates**. Wait for the notification *Quework Desktop
   1.2.1 is ready*. Tray → **Restart to Update (1.2.1)**. A dialog says the
   app will not restart while files are uploading or waiting, and names
   *1 file(s) waiting in the upload queue*. Click OK, then:

```powershell
$new = Get-NewLogLines $mark
$ready   = @($new | Where-Object { $_ -match '\[updater\] 1\.2\.1 downloaded and verified' })
$refused = @($new | Where-Object { $_ -match 'Restart to install 1\.2\.1 refused: .*1 file\(s\) waiting in the upload queue' })
if ($ready.Count -ge 1) { 'PASS: 1.2.1 downloaded and passed its sha512' } else { 'FAIL: no "1.2.1 downloaded and verified" line' }
if ($refused.Count -eq 1) { 'PASS: the restart was refused, naming the pending file' } else { "FAIL: $($refused.Count) refusal line(s)" }
$running = Get-RunningVersion
if ($running -eq '1.2.0') { 'PASS: still running 1.2.0' } else { "FAIL: running version is $running" }
```

6. In **File Upload → Queue**, click **Skip** on the test file. **Go back
   online.**

### 6.7 A withdrawn update is not installed

`stagingPercentage: 0` is the pause switch in ARCHITECTURE.md's kill-switch
table. A successful check that no longer offers 1.2.1 must take it back.

```powershell
@(Get-Content -LiteralPath "$root\latest.yml.good") + 'stagingPercentage: 0' | Set-Content -LiteralPath "$upd\latest.yml" -Encoding ASCII
$mark = Get-LogMark
```

Tray → **Check for Updates** (notification: *1.2.0 is up to date*). Then:

```powershell
$new = Get-NewLogLines $mark
$withdrawn = @($new | Where-Object { $_ -match '\[updater\] 1\.2\.1 is no longer offered' })
if ($withdrawn.Count -eq 1) { 'PASS: 1.2.1 withdrawn after a successful check' } else { "FAIL: $($withdrawn.Count) withdrawal line(s)" }
```

- [ ] The tray menu no longer has *Restart to Update*.

Offer it again:

```powershell
Copy-Item -LiteralPath "$root\latest.yml.good" -Destination "$upd\latest.yml" -Force
$mark = Get-LogMark
```

Tray → **Check for Updates** (notification: *1.2.1 is ready*), then:

```powershell
$new = Get-NewLogLines $mark
if (@($new | Where-Object { $_ -match '\[updater\] 1\.2\.1 downloaded and verified' }).Count -ge 1) { 'PASS: offered again' } else { 'FAIL: not offered again' }
```

- [ ] *Restart to Update (1.2.1)* is back in the tray menu.

### 6.8 Restart to Update: silent, per-user, in place

Make sure no confirm window is open and nothing is uploading. Record the
state just before:

```powershell
$before = @{
    InstallLocation = (Get-ItemProperty -LiteralPath $inst).InstallLocation
    TopLevel        = @(Get-ChildItem -LiteralPath $ud -Force | ForEach-Object { $_.Name })
    Stores          = Get-StoreSnapshot
}
"InstallLocation: $($before.InstallLocation)"
"top-level entries in userData: $($before.TopLevel.Count)"
$mark = Get-LogMark
```

Tray → **Restart to Update (1.2.1)**.

- [ ] **No UAC prompt** appeared. The app closed and came back by itself
      within about a minute, with no installer window.

```powershell
$guidHklm = @(
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$guid",
    "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\$guid",
    "HKLM:\Software\$guid",
    "HKLM:\Software\WOW6432Node\$guid"
) | Where-Object { Test-Path -LiteralPath $_ }
if ($guidHklm) { "FAIL: per-machine keys exist: $($guidHklm -join ', ')" } else { 'PASS: nothing under HKLM' }

$k = Get-ItemProperty -LiteralPath $un -ErrorAction SilentlyContinue
if ($k.DisplayName -eq 'Quework Desktop 1.2.1' -and $k.DisplayVersion -eq '1.2.1') { 'PASS: HKCU uninstall entry is Quework Desktop 1.2.1' } else { "FAIL: HKCU uninstall entry is '$($k.DisplayName)' / '$($k.DisplayVersion)'" }
$all = @(Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' | ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.DisplayName -match 'TaxOne|Quework' })
if ($all.Count -eq 1) { 'PASS: exactly one TaxOne/Quework entry' } else { "FAIL: $($all.Count) TaxOne/Quework entries" }

$dir = (Get-ItemProperty -LiteralPath $inst).InstallLocation
if ($dir -eq $before.InstallLocation) { "PASS: InstallLocation unchanged: $dir" } else { "FAIL: InstallLocation was $($before.InstallLocation), now $dir" }
$v = (Get-Item -LiteralPath (Join-Path $dir 'Quework Desktop.exe')).VersionInfo.FileVersion
if ($v -eq '1.2.1') { 'PASS: installed exe is 1.2.1' } else { "FAIL: installed exe is $v" }
$running = Get-RunningVersion
if ($running -eq '1.2.1') { 'PASS: 1.2.1 is running (relaunched)' } else { "FAIL: running version is $running" }
$y = Get-Content -LiteralPath (Join-Path $dir 'resources\app-update.yml') -Raw
if ($y -match 'provider:\s*github') { 'PASS: app-update.yml replaced by the update (github again)' } else { "FAIL: app-update.yml:`n$y" }

$new = Get-NewLogLines $mark
if (@($new | Where-Object { $_ -match '\[updater\] Restarting to install 1\.2\.1' }).Count -eq 1) { 'PASS: restart logged' } else { 'FAIL: no "Restarting to install 1.2.1" line' }
if (@($new | Where-Object { $_ -match '\[updater\] Started for 1\.2\.1' }).Count -eq 1) { 'PASS: 1.2.1 started its updater' } else { 'FAIL: no "Started for 1.2.1" line' }
```

### 6.9 The app's data survived

Compared: every electron-store file in `%APPDATA%\TaxOne Desktop`, key by
key (`taxone-settings.json`, `config.json`, …), and that nothing at the top
level of the folder disappeared. Not compared: `.updaterId` (written by the
updater), `migration-queue.json` (the test edited it) and `debug.log` (it
grows), and Chromium's own state (`Local State`, `Preferences`, caches),
which Electron rewrites on every launch, update or not. `config.json`'s
`lastLaunchedVersion` must change, to `1.2.1` — proof that the new version
ran against this folder.

```powershell
$after = Get-StoreSnapshot
$fail = 0
foreach ($file in $before.Stores.Keys) {
    if (-not $after.ContainsKey($file)) { "FAIL: $file is gone"; $fail++; continue }
    $keys = @($before.Stores[$file].Keys) + @($after[$file].Keys) | Sort-Object -Unique
    foreach ($key in $keys) {
        if ($file -eq 'config.json' -and $key -eq 'lastLaunchedVersion') { continue }
        if ($before.Stores[$file][$key] -cne $after[$file][$key]) { "FAIL: $file key '$key' changed"; $fail++ }
    }
}
foreach ($file in $after.Keys) { if (-not $before.Stores.ContainsKey($file)) { "note: new store file $file" } }
if ($fail -eq 0) { "PASS: $($before.Stores.Count) store file(s) kept every key and value" } else { "FAIL: $fail difference(s) above" }

$now = @(Get-ChildItem -LiteralPath $ud -Force | ForEach-Object { $_.Name })
$gone = @($before.TopLevel | Where-Object { $now -notcontains $_ })
if ($gone.Count -eq 0) { 'PASS: nothing at the top of userData disappeared' } else { "FAIL: gone: $($gone -join ', ')" }

$cfg = Get-Content -LiteralPath "$ud\config.json" -Raw | ConvertFrom-Json
if ($cfg.lastLaunchedVersion -eq '1.2.1') { 'PASS: lastLaunchedVersion 1.2.1' } else { "FAIL: lastLaunchedVersion is '$($cfg.lastLaunchedVersion)'" }
if (Test-Path -LiteralPath "$ud\.updaterId") { 'note: .updaterId present (expected)' }
```

### 6.10 The first launch of 1.2.1 is not disturbed

Leave 1.2.1 running, untouched, for **6 minutes** (the early check comes 5
minutes after a launch that is not a first launch). Then:

```powershell
$lines = @(Get-Content -LiteralPath $log)
$at = -1
for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -match '\[updater\] Started for 1\.2\.1') { $at = $i } }
if ($at -lt 0) { 'FAIL: no "Started for 1.2.1" line' } else {
    $since = @($lines | Select-Object -Skip $at)
    if (@($since | Where-Object { $_ -match '\[updater\] First launch of this version' }).Count -ge 1) { 'PASS: 1.2.1 knows it is a first launch' } else { 'FAIL: no "First launch of this version" line' }
    $checks = @($since | Where-Object { $_ -match 'Checking for update' })
    if ($checks.Count -eq 0) { 'PASS: no update check since 1.2.1 started' } else { "FAIL: $($checks.Count) check(s) since 1.2.1 started" }
}
```

- [ ] No update notification appeared.

### 6.11 Put the machine back

The installed app is now a 1.2.1 that will never exist on GitHub: it would
refuse the real 1.2.0 (no downgrade) and wait for 1.2.2. Put the release
candidate back, and the real queue:

1. **Quit the app from the tray.** Stop the server (Ctrl+C in its window).

```powershell
if (Get-Process 'Quework Desktop' -ErrorAction SilentlyContinue) { throw 'STOP: quit the app from the tray first' }
Copy-Item -LiteralPath "$root\migration-queue.json.bak" -Destination "$ud\migration-queue.json" -Force
Remove-Item -LiteralPath "$root\pending-test" -Recurse -Force
Remove-Item -LiteralPath "$env:LOCALAPPDATA\taxone-desktop-updater" -Recurse -Force -ErrorAction SilentlyContinue
& "$rc\TaxOne-Desktop-Setup.exe"
```

2. Click through the installer (it installs 1.2.0 over 1.2.1 in the same
   directory) and let it launch, then:

```powershell
$dir = (Get-ItemProperty -LiteralPath $inst).InstallLocation
$v = (Get-Item -LiteralPath (Join-Path $dir 'Quework Desktop.exe')).VersionInfo.FileVersion
if ($v -eq '1.2.0') { 'PASS: back on 1.2.0' } else { "FAIL: installed exe is $v" }
$y = Get-Content -LiteralPath (Join-Path $dir 'resources\app-update.yml') -Raw
if ($y -match 'provider:\s*github') { 'PASS: app-update.yml points at GitHub' } else { "FAIL: app-update.yml:`n$y" }
$q = Get-Content -LiteralPath "$ud\migration-queue.json" -Raw | ConvertFrom-Json
if (@($q.files | Where-Object { $_.id -eq 'update-test-0001' }).Count -eq 0) { 'PASS: the test file is out of the queue' } else { 'FAIL: the test file is still queued' }
```

If every check in 6.1–6.11 passed, the release candidate can be tagged.

### 6.12 After the real release is published (not a gate)

On a machine running the published 1.2.0: tray → **Check for Updates**.
The notification says *Quework Desktop 1.2.0 is up to date*, and:

```powershell
$hit = @(Get-Content -LiteralPath $log | Where-Object { $_ -match '\[updater\] Update for version 1\.2\.0 is not available \(latest version: 1\.2\.0' })
if ($hit.Count -ge 1) { 'PASS: the GitHub leg works (TLS, /releases/latest, latest.yml)' } else { 'FAIL: no answer from GitHub; look for "[updater]" lines in debug.log' }
```

That is the first proof of the GitHub leg. The first real update (1.2.0 →
1.2.1) is the second: watch `debug.log` for `[updater]` lines on the first
machine that gets it.
