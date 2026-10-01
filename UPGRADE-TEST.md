# v1.2.0 upgrade verification

Merge gate for v1.2.0 (`fix/quework-rebrand-followups`, then
`fix/tls-verification`). The unit tests all passed while the legacy-host
migration was dead code, so they do not gate this release — a real upgrade over
a real v1.1.5 install does.

Run it on Windows, start to finish, in order. Step 0 describes the fixture; it
is **run** at step 1.2, after v1.1.5 is installed.

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
