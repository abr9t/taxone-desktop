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
