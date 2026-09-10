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
4. Drop a file in the watch folder and leave it **unconfirmed**, so something
   is sitting in the queue.
5. Record the baseline:

```
type "%APPDATA%\TaxOne Desktop\taxone-settings.json"
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v com.taxone.desktop
reg query "HKCU\Software\Classes\taxone-desktop\shell\open\command" /ve
dir "%LOCALAPPDATA%\Programs\TaxOne Desktop"
```

Expected: `serverUrl` is `https://taxone.cpa`; the Run entry and the protocol
command both point at `...\TaxOne Desktop\TaxOne Desktop.exe`.

6. **Quit the app from the tray** before upgrading. Do not just close windows —
   the queue is flushed on `before-quit`.

---

## 2. Upgrade in place

Run `dist\TaxOne-Desktop-Setup.exe` from this branch over the top. Do not
uninstall first — an in-place upgrade is what is being tested.

---

## 3. Checks

### Config survived — the whole point of the release

- [ ] `%APPDATA%\Quework Desktop` **does not exist**.
- [ ] `type "%APPDATA%\TaxOne Desktop\taxone-settings.json"` shows
      `serverUrl` = `https://caputa.quework.app` and `_hostMigratedV1` = true.
- [ ] The app came up **signed in**. No login window, no re-pair.
- [ ] Settings shows the same watch folder as step 1.3.
      If you used the default, `watchPath` is now persisted as
      `C:\Users\<you>\TaxoneWatch` with `_watchPathMigratedV1` = true.
      `~\QueworkWatch` was not created and is not being watched.
- [ ] The pending file from step 1.4 is still in the queue.
- [ ] `%APPDATA%\TaxOne Desktop\debug.log` exists and contains the
      `[migration] Re-pointed persisted host` line. Its absence means the
      migration did not run — that is a failure, not a logging nit.

### Upgraded in place, not alongside

- [ ] **Apps & Features** lists exactly one entry: `Quework Desktop 1.2.0`.
      No `TaxOne Desktop 1.1.5` beside it.
      (Both installers derive the same uninstall key
      `fb2f6324-7194-5753-aa0e-d1c9da0ecd6e` from the unchanged
      `appId: com.taxone.desktop` — verified, but confirm it really happened.)
- [ ] `%LOCALAPPDATA%\Programs\TaxOne Desktop` is **gone**, and
      `%LOCALAPPDATA%\Programs\Quework Desktop\Quework Desktop.exe` exists.
- [ ] Desktop and Start Menu each have exactly one shortcut, `Quework Desktop`,
      and it launches. No orphaned `TaxOne Desktop` shortcut.

### Registry follows the renamed executable

- [ ] `reg query "HKCU\Software\Classes\taxone-desktop\shell\open\command" /ve`
      → `...\Quework Desktop\Quework Desktop.exe" "%1"`.
- [ ] `reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v com.taxone.desktop`
      → `...\Quework Desktop\Quework Desktop.exe`.

      This one is the fragile check. The value name stays `com.taxone.desktop`
      (it is the AppUserModelId, unchanged); only the path moves. It is repaired
      by `reconcileAutoLaunch()` **on launch**, so run the app once before
      checking. If the path is still `TaxOne Desktop`, the `launchItems` lookup
      did not find the entry — report it rather than editing the registry.

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
