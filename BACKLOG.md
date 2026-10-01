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
- Server allowlist: only single-label https://<firm>.quework.app is accepted.
  A firm on a custom domain or any other host is signed out on upgrade (host
  and token removed) and cannot sign in until a release widens the allowlist.
  Widen it, or support per-firm custom domains, before onboarding such a firm.
- Gate startWatching() on a valid stored host. After startup rejects the host,
  Settings > Save still starts the watcher. It sends nothing today (upload and
  search refuse with E_NOT_AUTHENTICATED), but files get enqueued into a
  confirm window that cannot upload them.
- test/dev-launcher.test.js couldInclude() only looks at a glob's first path
  segment, so a brace glob such as {src,scripts}/**/* in electron-builder.yml
  files: would package scripts/dev.js without failing the test. Expand braces,
  or match with a real glob library.
- The startup `delete process.env.NODE_TLS_REJECT_UNAUTHORIZED` in main.js has
  no test of its own; the pinned agent covers the API client either way. Add
  one that loads main.js with the variable set and checks it is gone and
  logged.
- scripts/dev.js sets NODE_ENV=development, which nothing in the app reads.
  Drop it, or use it.
- Code signing (deferred, see ARCHITECTURE.md "Code signing — deferred").
  Unsigned updates are trusted on GitHub account security and the release
  pipeline alone. Revisit when installs grow past a handful of firms or a
  second maintainer gets write access: Azure Trusted Signing (key not
  exportable) or an OV certificate on a hardware token; electron-builder then
  writes publisherName and electron-updater refuses installers from anyone
  else. Plan the first signed release: it is installed by apps whose
  app-update.yml has no publisherName yet.
- An install that is never quit never installs an update: Windows shutdown
  does not emit quit, and nothing restarts on its own. If installs lag,
  consider installing a downloaded update at the next launch, before the
  queue resumes.
- The tag build is a fresh build of the tested commit, not the tested bytes.
  Consider promoting the dry-run artifact (or comparing its sha512 with the
  tag build's latest.yml) so the installer that ships is the one tested.
- npm audit --omit=dev reports five pre-existing advisories this branch does
  not touch: axios (direct), form-data and follow-redirects (via axios),
  fast-uri (via electron-store) and xlsx (direct, no fix upstream). Update
  axios, and replace or contain xlsx (it only writes the queue export).
