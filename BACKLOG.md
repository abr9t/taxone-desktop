# Backlog

- Autostart: writes an unquoted Run value. Consider quoting it so Electron can
  parse the path back (needs care: changing the value's format on installed
  machines).
- Watch folder ignores files that land while the app is closed (chokidar
  ignoreInitial: true) and unconfirmed files are lost at quit (pendingFiles is
  in-memory). Staff may believe files uploaded when they did not.
- Migration queue: autoResume ignores a persisted paused status; history rewrites
  a 5,000-entry file on every update (a leftover .tmp from April suggests atomic
  writes have failed before). Consider capping/archiving history.
- keytar fell back to the electron-store _token on at least one machine, so the
  bearer token is in plaintext in taxone-settings.json. ARCHITECTURE.md claims
  tokens are never plaintext on disk. Find out why the fallback fired.
- Desktop consent screen lists "Scan documents" and "Print files" permissions for
  Phase 2/3 features that do not exist yet.
- App icons (assets/) still show the TaxOne "T".
- Repo hygiene: .claude/settings.local.json and .idea/* are tracked. Untrack them
  (git rm --cached) and add them to .gitignore; until then every commit has to
  stage explicit paths to keep local edits out.
- Settings: the Start-with-Windows checkbox reads openAtLogin, so it shows
  checked when the entry is disabled in Task Manager (StartupApproved byte 3).
  Reflect the enabled state, or say it is disabled elsewhere.
- preload.js defines searchClients twice in the window.taxone bridge (identical,
  so harmless, but the second silently wins).
- uploader.js requires form-data, which package.json does not declare; it only
  arrives as a transitive dependency of axios. Declare it.
- Route API requests through Electron's net module (Chromium stack: Windows
  certificate store and system proxy), so firms whose network re-signs TLS work
  without IT exempting the host. Until then such networks get the "could not
  verify the security certificate" message. A later Electron on Node >= 23.8
  could alternatively use --use-system-ca.
- cross-env is an unused devDependency since npm run dev moved to
  scripts/dev.js. Remove it (lockfile change).
