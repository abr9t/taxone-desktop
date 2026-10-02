# Quework Desktop — Architecture

Electron companion app for [Quework](https://taxone.cpa). Two core features:

1. **Watch Folder** — monitors a local directory and prompts per-file upload to a matched client
2. **File Upload Tool** — bulk import with drag-and-drop, client matching, persistent queue, throttled uploads

CommonJS throughout (no ESM — `electron-store` v8 requirement).

---

## Stack & Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| electron | ^33.0.0 | App shell |
| electron-store | ^8.2.0 | Persistent key-value storage (NOT v10+ which is ESM-only) |
| chokidar | ^4.0.0 | File system watcher |
| axios | ^1.7.0 | HTTP client for Quework API |
| keytar | ^7.9.0 | OS keychain for token storage (fallback: electron-store) |
| xlsx | ^0.18.5 | Excel export for queue data |
| electron-updater | 6.8.9 (exact) | Background updates from GitHub Releases — see [Releases and auto-update](#releases-and-auto-update) |
| form-data | (transitive) | Multipart uploads via axios |
| electron-builder | ^25.0.0 | Build & packaging (dev) |
| cross-env | ^7.0.3 | Unused since `npm run dev` moved to `scripts/dev.js`; removal tracked in `BACKLOG.md` |
| png2icons | ^2.0.1 | Icon conversion (dev) |

Node.js built-in `crypto.randomUUID()` for IDs (no `uuid` package — ESM incompatibility).

---

## TLS

Certificate verification is always on, in every build. Nothing in the app
turns it off, and `test/tls-tripwire.test.js` fails the suite if anything
under `src/` or `scripts/` does.

Until v1.2.0, `src/main.js` began with `process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'`
(added in `3afd711` so the app could reach Herd's `https://*.test` sites). That
disabled verification for every Node HTTPS call: the bearer token and every
uploaded client document. Anyone on the network path could impersonate
`caputa.quework.app`. Releases are unsigned, so certificate checking is the
only thing that vouches for the server, and later for an update.

**Which stack does what.** Every API call (sign-in check, client search,
folders, uploads, both upload paths) is axios in the main process on Node's
`https`. Node trusts its own bundled CA list and **not** the Windows
certificate store. The renderers make no network requests. `shell.openExternal`
hands the browser sign-in to the user's default browser, which uses the
Windows store.

**Updates are the exception.** electron-updater does not use Node's `https`.
It fetches `latest.yml`, the blockmaps and the installer through Electron's
`net` module (Chromium's network stack) on its own `electron-updater` session
partition, so it trusts the **Windows certificate store** and follows the
system proxy, like the browser. Neither `NODE_TLS_REJECT_UNAUTHORIZED` nor
`NODE_EXTRA_CA_CERTS` has any effect on it. Probed on Electron 33.4.11
against a local HTTPS server with the TEST-ONLY fixtures: the updater's own
HTTP executor and a full `checkForUpdates()` failed with
`net::ERR_CERT_AUTHORITY_INVALID` with no variable, with
`NODE_TLS_REJECT_UNAUTHORIZED=0` and with `NODE_EXTRA_CA_CERTS` pointing at
the test CA; no request reached the server and Node's `https` was never
called, while a Node `https` control in the same process obeyed both
variables. A network that re-signs TLS with a CA pushed to the Windows store
therefore works for updates even where the API fails. Nothing in `src/`
touches the Chromium side's verification (the tripwire below flags
`setCertificateVerifyProc`, `'certificate-error'` and
`ignore-certificate-errors`).

**One place builds a client.** `uploader.createApiClient(serverUrl, token)`:
- runs the host through `validateServerUrl()` on every build and throws
  `HostRejectedError` (`code: 'E_HOST_REJECTED'`) before anything is sent;
- pins `httpsAgent: new https.Agent({ keepAlive: true, rejectUnauthorized: true })`.
  The explicit option wins over a `NODE_TLS_REJECT_UNAUTHORIZED=0` inherited
  from the user's environment;
- renames certificate failures (see below).

`getClient`, `configure` and `verifyTokenWith` all go through it.
`main.js` also deletes an inherited `NODE_TLS_REJECT_UNAUTHORIZED` at startup
and records it in `debug.log`, to cover anything that ever bypasses the
factory. A released build that sees `NODE_EXTRA_CA_CERTS` records that too.

**Development servers.** Herd installs its CA in the Windows store only, so
the browser trusts `https://taxone.test` and the app's Node client does not.
`npm run dev` runs `scripts/dev.js`, which launches Electron with
`NODE_EXTRA_CA_CERTS` pointing at Herd's CA
(`%USERPROFILE%\.config\herd\config\valet\CA\LaravelValetCASelfSigned.crt`),
or keeps one you already set. That adds a trust anchor; chain and hostname
checks stay on. Two constraints:
- Node reads `NODE_EXTRA_CA_CERTS` once at process start (verified on Electron
  33.4.11), which is why it is set by the launcher and not in `main.js`.
- `scripts/` is outside electron-builder's `files:`, so the launcher can never
  be packaged (`test/dev-launcher.test.js`).

Plain `npm start` / `electron .` gets no extra CA: `https://*.test` then fails
certificate verification. `http://` dev hosts are unaffected.

**Certificate failures are named.** A network that re-signs TLS (corporate
inspection, some firewalls and antivirus) pushes its CA to the Windows store,
which Node does not read, so every request fails with a certificate error.
The factory's response interceptor rewrites `err.message` for Node's
certificate codes to *"Quework Desktop could not verify the security
certificate of {host} ({code}), so nothing was sent. If your office network
inspects encrypted traffic, ask your IT team to exempt {host}."* It keeps
`err.code` and logs `[tls] Certificate verification failed`. As a result:
- sign-in shows that message instead of "Invalid token";
- startup gets `verifyToken() === 'tls_error'`, keeps the token, sets the tray
  to its error state and shows one notification;
- queue rows and the confirm window show the message. The wording avoids
  "SSL" and "timeout", so `_isRetryableError()` does not retry what a retry
  cannot fix.

Routing requests through Electron's `net` (Windows store, system proxy) is
tracked in `BACKLOG.md`.

**Tests.**
- `test/tls-verification.test.js` uses the TEST-ONLY fixtures in
  `test/fixtures/tls/`. It checks that a packaged build refuses a dev host
  before connecting, that an untrusted CA is rejected with no request sent,
  and that an inherited `NODE_TLS_REJECT_UNAUTHORIZED=0` does not win (with a
  default-agent control that proves the variable was live). It also checks
  that `NODE_EXTRA_CA_CERTS` makes the CA trusted while a hostname mismatch is
  still rejected, and covers the certificate-failure messages.
- `test/tls-tripwire.test.js` checks for relaxations in `src/` and `scripts/`
  (`.js`, `.mjs`, `.cjs`, HTML `<script>` bodies), `package.json` and
  `electron-builder.yml`. It flags:
  - any assignment of `NODE_TLS_REJECT_UNAUTHORIZED`, including as a quoted
    key or a shell prefix in a string;
  - `rejectUnauthorized` other than a literal `true` followed by `,`, `}` or end
    of line;
  - `checkServerIdentity`, `setCertificateVerifyProc`, a `'certificate-error'`
    handler and the `ignore-certificate-errors` switch.

  **The tripwire is a tripwire, not a boundary.** It catches the line that
  shipped and its obvious variants. It does not prove verification is on, and
  it is easy to get past on purpose, by any of these:
  - a value continued on the next line;
  - code inside a template `${…}`;
  - `Reflect.set` / `Object.defineProperty` with a string key;
  - `??=` / `||=`;
  - unicode-escaped identifiers;
  - runtime-built names;
  - `eval`.

  Its header lists these. **The control is the factory pin:**
  `createApiClient()` builds every client with `rejectUnauthorized: true`, which
  wins over the environment, and `test/tls-verification.test.js` proves that
  against a real TLS server. Code review owns everything the tripwire cannot
  see.

---

## App Architecture

```
┌──────────────────────────────────────────────────────────┐
│                     Main Process                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────────┐   │
│  │ auth.js  │  │watcher.js│  │   migration.js       │   │
│  │ (keytar/ │  │(chokidar)│  │  (MigrationQueue)    │   │
│  │  store)  │  │          │  │  in-memory + store    │   │
│  └──────────┘  └──────────┘  └──────────────────────┘   │
│  ┌──────────┐  ┌──────────────────────────────────────┐  │
│  │uploader. │  │ migration-ipc.js                     │  │
│  │  js      │  │ (IPC handler registration)           │  │
│  │ (axios)  │  │                                      │  │
│  └──────────┘  └──────────────────────────────────────┘  │
│                      ipcMain                             │
└──────────────────┬───────────────────────────────────────┘
                   │ contextBridge (contextIsolation: true)
┌──────────────────┴───────────────────────────────────────┐
│               Renderer Processes (display-only)          │
│  login.html  settings.html  confirm-upload.html          │
│  migration.html                                          │
└──────────────────────────────────────────────────────────┘
```

- **Single-instance lock** — `app.requestSingleInstanceLock()`, second instance either handles `taxone-desktop://` auth URL or opens File Upload window
- **System tray app** — no dock icon on macOS (`app.dock.hide()`), single-click tray opens File Upload window
- **Main process owns all state** — queues, watchers, uploads
- **Renderer processes are display-only** — communicate via IPC only
- **`nodeIntegration: false`, `contextIsolation: true`** — separate preloads per window type
- **App user model ID** — `com.taxone.desktop` (`app.setAppUserModelId`)
- **First-launch auto-start** — on first run, `app.setLoginItemSettings({ openAtLogin: true, path: process.execPath })` and `hasLaunched` flag set in `appStore`. On every packaged launch, `reconcileAutoLaunch()` (`src/auto-launch.js`) re-registers the existing Run-key entry against the running executable, unconditionally — see [Autostart reconciliation](#autostart-reconciliation)
- **App opens File Upload window on start** — `showMigrationTool()` called after successful auth verification
- **Tray close notification** — first time the File Upload window is closed, a notification says the app is still running in the tray (`hasClosedUploadWindow` flag)

### Windows

| Window | HTML | Preload | Size | Resizable |
|--------|------|---------|------|-----------|
| Login | `login.html` | `preload.js` | 420x520 | No |
| Settings | `settings.html` | `preload.js` | 520x720 (minHeight: 600) | Yes |
| Confirm Upload | `confirm-upload.html` | `preload.js` | 540x580 | No |
| File Upload | `migration.html` | `preload-migration.js` | 900x700 (min 700x400, max height 900) | Yes |

Login, Settings, Confirm Upload expose `window.taxone` namespace.
File Upload exposes `window.electronAPI.migration` namespace.

---

## Authentication

**`src/auth.js`**

- Sanctum personal access token with `desktop` ability scope
- Token storage: OS keychain via keytar (`TaxOneDesktop` / `api-token`), falls back to `electron-store` `_token` key
- Token always saved to both keychain and electron-store (store as fallback)
- Server URL stored in `electron-store` (store name: `taxone-settings`). Every write goes through `auth.validateServerUrl()` — an allowlist, not a normalizer — see [Server URL validation](#server-url-validation). `saveServerUrl()` throws rather than storing a host that fails it
- Token verified on app start via `GET /api/desktop/clients?search=&limit=1`
  - `'ok'` → proceed with cached credentials, open File Upload window
  - `'auth_error'` (401/403) → show login
  - `'network_error'` → proceed anyway (offline-tolerant)
- Tokens don't expire unless revoked from Quework Firm Settings

### Login Methods

**1. Browser OAuth flow (primary):**
- User enters server URL → clicks "Sign in with Browser" → `auth:open-browser-sign-in` validates the URL, then opens `{canonicalUrl}/desktop/authorize` in the default browser via `shell.openExternal()`. The renderer never passes a full URL to be opened
- Quework web app authenticates user, then redirects to `taxone-desktop://auth?token=X&url=Y`
- Custom protocol registered via `app.setAsDefaultProtocolClient('taxone-desktop')` (with `process.execPath` arg in dev mode)
- `handleAuthUrl()` parses URL, saves token + server URL, configures uploader, starts watching, inits migration queue, opens File Upload window
- Sends `migration:auth-changed` event to File Upload window with `true`
- Shows "Successfully signed in" OS notification

**2. `taxone-desktop://connect` handler:**
- Web app can link to `taxone-desktop://connect?url=X` to pre-fill server URL. The URL goes through `applyServerUrlFromLink()` in `main.js`: validated, then — if the install is already paired with a different host — confirmed by a dialog before it is stored
- If already signed in (token exists), opens File Upload window directly
- If not signed in, opens login window (with server URL pre-filled)

**3. Manual token paste (fallback):**
- Login window has expandable "Paste token manually" section (toggle animation with `max-height` transition)
- User enters server URL + token → `uploader.verifyTokenWith()` validates (10s timeout) → save to keychain + store. It returns `{ ok, error }`; `error` carries the certificate message when the failure was a certificate, and the window shows it instead of "Invalid token"
- On success: shows green checkmark success state, auto-closes window after 2s

**Login window auto-fills server URL** — on init, calls `window.taxone.getServerUrl()` and populates the input field

**Startup notice** — on init it also calls `window.taxone.getStartupNotice()` (`auth:get-startup-notice`). When startup rejected the stored host, this returns a message naming the host and saying the user was signed out, shown in the window's error area. The next successful sign-in clears it. See [Persisted host, checked on read](#persisted-host-checked-on-read)

### Auth State Propagation

- Sign in/sign out from any source (browser OAuth, manual token, tray menu, settings) sends `migration:auth-changed` event to File Upload window
- File Upload window updates UI: connection status in header, drop zone enabled/disabled, lock icon when not authenticated, queue controls gated
- Tray menu conditionally shows "Sign In" (when disconnected) or "Sign Out" (when connected)

### Sign Out Flow

1. Stop watcher
2. Clear token from keychain and electron-store
3. Update tray menu to disconnected state
4. Send `migration:auth-changed` with `false` to File Upload window
5. Show login window

---

## Watch Folder

**`src/watcher.js`**

- chokidar monitors configurable watch path (default for new installs: `~/QueworkWatch/`; installs upgraded from v1.1.5 keep `~/TaxoneWatch/` — see [Legacy watch folder migration](#legacy-watch-folder-migration))
- `ignoreInitial: true`, `awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 200 }`, `depth: 5`
- Ignores: hidden files (regex), `.tmp`, `.crdownload`, `~` suffix
- `parseFileInfo()` also skips files in `Uploaded/` and `Cancelled/` subfolders (at any depth, case-insensitive, backslash-safe)
- Allowed extensions: `.pdf`, `.jpg`, `.jpeg`, `.png`, `.heic`, `.tiff`, `.gif`, `.webp`, `.xlsx`, `.xls`, `.csv`, `.doc`, `.docx`, `.txt`, `.zip`, `.msg`, `.eml`
- `parseFileInfo()` extracts `clientHint` (first subfolder) and `folderHint` (remaining path)
- New files trigger `enqueueFile()` in main.js → opens confirm-upload window

### Confirm Upload Flow

- File queue managed in main process (`pendingFiles[]` array, not persisted)
- One file at a time — confirm window shows current file, "Skip" or "Upload"
- File rename (editable filename stem, extension preserved), client search (debounced 250ms), navigable folder browser
- New folder creation (server creates on upload via `folder_path`)
- Client hint from folder name pre-fills client search, exact match auto-selects
- After upload: optional move-to-`Uploaded/` subfolder (handles name collisions with `(n)` suffix)
- Cancel: moves file to `Cancelled/` subfolder (same collision handling)
- OS `Notification` on successful upload

---

## File Upload Tool

**`src/migration.js`** (MigrationQueue class) + **`src/migration-ipc.js`** (IPC handlers) + **`src/renderer/migration.html`** (UI)

Three-tab interface: **Import**, **Queue**, **History**.

### Header

- Shows "File Upload" title
- Connection status subtitle: "Connected to {serverUrl}" or "Not connected" — updated via `updateAuthUI()` on init and `migration:auth-changed` events

### Import Tab

**Drop zone:**
- Full-window drop target (dragenter counter pattern) with overlay ("Drop files here") + compact bar + Browse button
- Accepts folders (each = one client row) and loose files
- `webkitGetAsEntry()` to distinguish files from folders
- `webUtils.getPathForFile()` to get absolute paths from dropped files
- Disabled state with lock icon and "Sign in to upload files" button when not authenticated
- Auth guard: drop handler and folder browse check `isAuthed` before proceeding

**Folder scanning (`scanClientFolder` / `_walkDir`):**
- Recursive directory walk, skips hidden directories
- Junk file filter: `.DS_Store`, `Thumbs.db`, `desktop.ini`, `.sync`, `~$` prefix, `.` prefix, `.tmp`, `.crdownload`, `.partial`
- Flags oversized files (`size > MAX_FILE_SIZE` = 100MB)

**Loose file support:**
- Individual files dropped create a separate import row per drop
- Row name: single filename or `filename (+N files)` for multiple
- Pre-fills last used client (`lastClient` store key) if still valid
- Folder picker available to choose destination folder

**Client matching (`matchClients`):**
1. **Exact** — case-insensitive, non-alphanumeric stripped (`normalizeForMatch`)
2. **Fuzzy** — Levenshtein distance, threshold = `max(3, ceil(name.length * 0.3))`, top 3 candidates. Single candidate with distance <= 2 auto-suggested.
3. **Unmatched** — no candidates within threshold

**Searchable client dropdown:**
- Substring filter on `allClients` array (fetched once from API, limit 2000, `include_all: true`), max 10 results
- Keyboard navigation (ArrowUp/Down, Enter, Escape)
- `has-selection` / `has-value` CSS states
- On selection: sets `matchType: 'manual'`, auto-checks row, enables folder picker
- Clear button reverts to unmatched, disables folder picker
- Last selected client saved via `migration:set-last-client`

**Folder picker modal (loose files only):**
- Navigable folder tree via `clients:folders` IPC
- Breadcrumb navigation, back button, "Use root folder" option
- Selected path stored as `folderPath` / `folderId` on import row
- Non-loose rows show "Preserved" — folder structure from source directory is kept

**Import table:**
- Checkboxes per row, "Check All" / "Uncheck Unmatched" / "Clear Queued" / "Clear Unchecked" / "Clear All"
- Per-row remove button (x)
- Additive staging — rows persist across drops, duplicate folder names skipped
- Queued rows grayed out (`match-row-queued`) with "queued" label instead of checkbox
- Import rows persisted to `electron-store` (`importRows` key) via `migration:set-import-rows`
- Restored on window open via `migration:get-import-rows`
- Clickable folder/file names open in system Explorer via `migration:open-path`
- Oversized file count shown per row
- Enqueue summary: "N files from M clients will be queued (K skipped)"

### Queue Tab

**Persistent queue (`MigrationQueue` class):**
- `electron-store` (store name: `migration-queue`) with in-memory arrays (`_files`, `_history`)
- Debounced disk writes every 2s (`_scheduleSave`, `_scheduleHistorySave`) for 30k+ file performance
- `flushSave()` called on `before-quit` event

**Crash recovery:**
- On construct: `_recoverCrashedUploads()` resets any `uploading` files back to `pending`
- `autoResume()` called after init — starts queue if pending/uploading files exist

**Upload concurrency & throttling:**
- `concurrency: 1` — single upload at a time to prevent server overload
- 500ms delay before each upload (`setTimeout` in `_uploadFile`) as additional throttle
- Managed via `activeUploads` counter

**Auto-start queue on enqueue:**
- `enqueue()` calls `this.start()` at the end — no manual Start button needed to begin processing

**Retry logic:**
- Up to `maxRetries: 5` with exponential backoff: `2^retries * 1000`ms (2s, 4s, 8s, 16s, 32s)
- Retryable errors (`_isRetryableError`): `ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, `ENOTFOUND`, 5xx responses, `timeout`/`SSL`/`ECONNRESET`/`socket hang up` in message
- Non-retryable: 4xx errors, file not found, other client errors

**File statuses:** `pending` → `uploading` → `completed` | `failed` | `skipped`

**Deduplication:**
- **Local:** `enqueue()` checks `absolutePath` against existing `_files` entries
- **Server-side:** upload endpoint returns `{skipped: true}` if same filename exists in same client+folder → file marked `skipped` with error "Already exists in Quework"

**Oversized files:** files > 100MB auto-set to `skipped` status with error "File exceeds 100MB upload limit" at enqueue time

**Queue controls:**
- Start/Pause, auto-resume on app start
- Retry single file (`retryFile`), retry all failed (`retryAllFailed`)
- Skip file (`skipFile`)
- Clear queue (`clearQueue`), clear by status (`clearByStatus`)
- Batch completion counters (`_batchCompleted`, `_batchSkipped`, `_batchFailed`) — reset on each `start()` call, reported in the completion notification (per-run, not cumulative)

**Network reconnection:**
- 30s `setInterval` in main.js runs `retryFailedIfOnline()` (`src/reconnect.js`), which checks `uploader.verifyToken()`
- If online (`'ok'`) and failed files exist with idle queue → `retryAllFailed()`. Any other answer — including `'host_rejected'` and `'tls_error'` — retries nothing
- Never rejects: a throw inside the tick (a rejected host, a broken store) is logged and the tick ends
- Registered only by `initMigrationQueue()`, which does not run after a startup that rejected the stored host

**Export to Excel:**
- "Export" button on Queue tab toolbar exports current filtered file list to `.xlsx`
- Uses `xlsx` package via `migration:export-queue` IPC handler
- Shows save dialog (default: `taxone-queue-export.xlsx`), writes file, opens in system app
- Columns: Filename, Client, Folder, Size, Status, Error, Path

**Queue status dot indicator:**
- Colored dot on Queue tab label: green (running), amber (paused), gray (idle)
- CSS classes: `queue-dot-running`, `queue-dot-paused`, `queue-dot-idle`

**Queue UI:**
- Filter pills: All, Pending, Uploading, Failed, Completed, Skipped
- Search by filename (substring)
- Per-filter clear button ("Clear Completed", "Clear Failed", etc.)
- Progress bar, stat counts, percentage, total size (uploaded / total)
- Virtualizes at 200 rows with "Show all" button
- In-place file row updates via `migration:file-update` IPC event
- Retry flash animation on retry (`retryFlash` CSS animation)
- File rows show: filename, client name, folder path, size, status badge, actions (Retry/Skip)
- Error messages shown below failed rows, skip reasons below skipped rows
- OS `Notification` on queue completion with completed/skipped/failed counts (batch counters)

### History Tab

- Completed uploads log (capped at 5,000 entries in `_history` array)
- Shows filename, client name, timestamp
- In-memory with debounced disk writes (2s)
- UI shows first 500 entries with truncation notice

---

## API Surface (Laravel)

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/desktop/clients` | Search/list clients (`?search=`, `?limit=`, `?include_all=`) |
| `GET` | `/api/desktop/clients/{id}/folders` | Folder tree (`?parent_id=`), returns `{folders, breadcrumb, parent_id}` |
| `POST` | `/api/desktop/upload` | Upload file (multipart: `file`, `client_id`, `folder_path`, `filename`) |

- All routes behind `auth:sanctum` + `ability:desktop`
- Upload endpoint: 100MB max, `folder_path` resolved via `firstOrCreate`
- Duplicate detection: returns `{skipped: true, document_id}` if same filename exists in same client+folder
- CSRF excluded (api.php routes)
- Cloudflare WAF bypass for `/api/desktop/*` POST
- Axios timeout: 300,000ms (5 min) for uploads, 10,000ms for token verification (`verifyTokenWith`)

### Web Auth Endpoint

| Path | Purpose |
|------|---------|
| `GET` | `/desktop/authorize` | Browser sign-in page, redirects to `taxone-desktop://auth?token=X&url=Y` after auth |

---

## IPC Channels

### Auth & Settings (registered in `main.js`)

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `auth:login` | invoke | Verify token with server, save to keychain + store, start watching, init queue, send auth-changed |
| `auth:sign-out` | invoke | Stop watcher, clear token, update tray, notify migration window, show login |
| `settings:get` | invoke | Return `{serverUrl, watchPath, moveAfterUpload, hasToken}` |
| `settings:save` | invoke | Save watchPath + moveAfterUpload, restart watcher |
| `settings:show-login` | invoke | Open login window from settings |
| `settings:get-auto-launch` | invoke | Return `app.getLoginItemSettings().openAtLogin` |
| `settings:set-auto-launch` | invoke | Set `app.setLoginItemSettings({ openAtLogin, path: process.execPath })` |
| `settings:browse-folder` | invoke | Native folder picker dialog |
| `get-server-url` | invoke | Return stored server URL |
| `auth:get-startup-notice` | invoke | Return why startup opened the sign-in window (e.g. a rejected stored host), or `null`. Cleared by the next successful sign-in |
| `auth:open-browser-sign-in` | invoke | Validate a server URL, then open `{canonicalUrl}/desktop/authorize` in the default browser. Returns `{success, error}` |

### Clients & Upload (registered in `main.js`)

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `clients:search` | invoke | Search clients via API |
| `clients:folders` | invoke | Fetch folder tree for a client (`clientId`, optional `parentId`) |
| `upload:file` | invoke | Upload file, move-to-Uploaded if enabled, send notification |
| `upload:cancel` | invoke | Move file to `Cancelled/` subfolder, dequeue |
| `queue:next` | invoke | Dequeue current file, show next or close window |
| `queue:state` | invoke | Return `{total, current}` for pending files |

### File Upload Tool (registered in `migration-ipc.js`)

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `migration:is-authenticated` | invoke | Check if token exists |
| `migration:scan-folders` | invoke | Scan directory trees, return `{clientFolders}` |
| `migration:scan-files` | invoke | Scan loose file paths, return `{name, path, files}` with oversized flags |
| `migration:get-clients` | invoke | Fetch all Quework clients (limit: 2000, `include_all: true`) |
| `migration:match-clients` | invoke | Match scanned folders against clients |
| `migration:enqueue` | invoke | Add files to upload queue (auto-starts), return stats |
| `migration:start` | invoke | Start queue processing, return stats |
| `migration:pause` | invoke | Pause queue processing, return stats |
| `migration:retry-file` | invoke | Retry a single failed file, return stats |
| `migration:retry-all-failed` | invoke | Retry all failed files, return stats |
| `migration:skip-file` | invoke | Skip a file, return stats |
| `migration:clear-queue` | invoke | Clear entire queue, return stats |
| `migration:clear-by-status` | invoke | Clear files with a specific status, return stats |
| `migration:get-stats` | invoke | Return queue statistics |
| `migration:get-files` | invoke | Return all files in queue |
| `migration:get-history` | invoke | Return upload history |
| `migration:get-import-rows` | invoke | Return persisted import tab staging rows |
| `migration:set-import-rows` | invoke | Save import tab staging rows |
| `migration:get-last-client` | invoke | Return last used client for loose files |
| `migration:set-last-client` | invoke | Save last used client |
| `migration:select-folder` | invoke | Native folder picker dialog |
| `migration:open-path` | invoke | Open file/folder in system file manager |
| `migration:export-queue` | invoke | Export files to Excel (.xlsx), show save dialog, open file |
| `migration:flush-save` | invoke | Force immediate disk write |

### Push Events (main → renderer)

| Channel | Target | Purpose |
|---------|--------|---------|
| `queue-updated` | confirm-upload | `{total, current}` — current file + queue count |
| `migration:progress` | migration | Queue stats (total, completed, failed, pending, uploading, skipped, percent, queueStatus) |
| `migration:file-update` | migration | Single file status change (for in-place row update) |
| `migration:auth-changed` | migration | `boolean` — auth state changed (sign in/out), updates UI lock state and connection status |

---

## Identifiers vs. Branding

The v1.1.5 → v1.2.0 rebrand renamed the *display* name from TaxOne to Quework.
Three strings look like branding and are not: they are identifiers that other
things resolve against. Renaming any of them breaks something silently, with no
build error and no failing test.

### The userData pin

`main.js` pins `userData` before any `require()` that can construct a store:

```js
const USER_DATA_DIR = 'TaxOne Desktop';
app.setPath('userData', path.join(app.getPath('appData'), USER_DATA_DIR));
```

**`"TaxOne Desktop"` here is an identifier, not branding. Do not change it to
match the display name.** It is the directory every existing install keeps its
`serverUrl`, watch folder, token fallback and upload queue in.

Electron derives `userData` from `productName`, and electron-store resolves its
directory once, at construction time, from `app.getPath('userData')`. Every store
in this app — `auth.js`, `watcher.js`, `migration.js`, the `appStore` in
`main.js` — is constructed at module load, which is why the pin has to sit above
the requires rather than next to `app.setName()`.

Without it, renaming `productName` points the app at a fresh, empty
`%APPDATA%\Quework Desktop`: the legacy-host migration finds nothing to migrate
and every user lands on the login screen with their queue gone. The failure is
silent, so `auth.js` carries a tripwire that compares the resolved directory
against the expected one — it throws in an unpackaged build and writes to
`debug.log` via `debugError` in a packaged one.

### The installer filename

`electron-builder.yml` sets `artifactName: "TaxOne-Desktop-Setup.${ext}"`.

The web app links straight at that filename: `routes/web.php:540` in
`abr9t/taxone` points the download button at
`releases/latest/download/TaxOne-Desktop-Setup.exe`. Renaming the artifact 404s
that button the moment a release is tagged. If it ever has to change, both repos
ship in the same release.

### The AppUserModelId

`com.taxone.desktop`, set by `app.setAppUserModelId()` and also used as `appId`.
Two things resolve against it:

- The **uninstall registry key** is a UUIDv5 of `appId`
  (`fb2f6324-7194-5753-aa0e-d1c9da0ecd6e`). Unchanged, so NSIS upgrades in place
  rather than leaving a second Apps & Features entry beside the old one.
- The **Run-key value name** for autostart defaults to it — see below.

### Autostart reconciliation

`src/auto-launch.js`. `productName` drives the executable name, so the rebrand
renames the exe. On a machine upgraded from v1.1.5 it goes from
`%LOCALAPPDATA%\Programs\TaxOne Desktop\TaxOne Desktop.exe` to
`%LOCALAPPDATA%\Programs\TaxOne Desktop\Quework Desktop.exe`: same directory, new
file name, and the old exe is removed (see [Build & Distribution](#build--distribution)).
The Run-key entry records the absolute exe path and does not follow the rename.
The app enables autostart only once, behind `hasLaunched`, so without
reconciliation the entry would keep naming `TaxOne Desktop.exe` and the app
would silently stop starting at login.

`reconcileAutoLaunch()` runs on every packaged launch and, when an entry exists,
re-registers it **unconditionally** with `path: process.execPath`. It does not
try to detect a stale path, because it cannot: the Run value is written
unquoted, and Electron parses an unquoted value only up to the first space. For
this app `launchItems[].path` comes back as `...\Programs\TaxOne`, which never
equals the real executable path. An earlier version compared the two, and a live
upgrade test showed it re-registering on every launch anyway. Rewriting an
identical value is harmless.

What it will not do, none of which depends on reading the path back:

- **Create an entry.** Turning autostart off in Settings removes the value, and
  a launch must not resurrect it.
- **Re-enable one.** It passes `entry.enabled` through, so an entry disabled in
  Task Manager stays disabled; `setLoginItemSettings` defaults `enabled` to
  `true`.
- **Touch the registry from an unpackaged build.**

It logs only on failure (`[autostart] Reconcile failed: ...`). There is no
success line: whether anything changed cannot be determined from a truncated
path, and a line on every launch reads like a finding. Quoting the Run value so
the path can be read back is tracked in `BACKLOG.md`.

### Debug log location

`src/debug-log.js` writes to `{userData}\debug.log`, resolved lazily on first
write. Not next to `__dirname`: in a packaged build that is inside `app.asar`,
where `appendFileSync` throws. Writes are wrapped in try/catch — logging must
never be the thing that breaks startup, and the callers are on the upgrade path
inside the `whenReady` handler, where a throw would take the tray, the watcher
and the upload queue with it.

`debugLog` writes to the file and stdout; `debugError` writes to the file and
stderr.

### Server URL validation

`auth.validateServerUrl()` is the single gate every `serverUrl` passes. On
write: all three writers (the `connect` handler, the `auth` handler and
`auth:login`). On read: once at startup (`enforcePersistedServerUrl`, below)
and every time an API client is built (`uploader.createApiClient`, see
[TLS](#tls)).

`taxone-desktop://` is a protocol anyone can put behind a link, the repo is
public, and the stored host is where the app sends its bearer token on the next
launch: startup verifies the token against it unprompted from `whenReady`. An
unvalidated `url=` parameter is therefore a one-click token exfiltration
primitive.

The rule is an allowlist:

| Input | Result |
|-------|--------|
| `https://<single-label>.quework.app` | accepted, canonicalized to the origin |
| `https://taxone.cpa`, `https://www.taxone.cpa` | mapped to `https://caputa.quework.app` (same rule as the migration) |
| `localhost` / `*.test` | accepted **only** when `!app.isPackaged`; port preserved |
| anything with userinfo (`https://host@evil.com`) | rejected |
| anything with an explicit port on a Quework host | rejected — canonicalization would drop it silently |
| any other host, scheme, or multi-label subdomain | rejected |

`auth:login` validates **before** `verifyTokenWith()`, because that call sends
the token to the host. The `auth` handler persists the host before the token, so
a token arriving with a rejected host is never written. A link that would move an
already-configured install to a different server raises a confirmation dialog
first — a valid Quework URL is still some other firm's.

### Persisted host, checked on read

Validating writes is not enough on its own. An install upgraded from v1.1.5 can
be carrying a host written before the gate existed (an unvalidated
`taxone-desktop://connect` link was enough to set one), and it would keep
sending its token there after the upgrade.

At startup, after the legacy host and watch-folder migrations and before
anything authenticated, `main.js` calls `resolveStartup()` (`src/startup.js`).
That runs `auth.enforcePersistedServerUrl()`:

| Stored `serverUrl` | Result |
|--------------------|--------|
| empty | nothing to do |
| valid | kept; the canonical form is persisted if the stored string differed (so a `taxone.cpa` that survived the migration guard maps to `caputa.quework.app`). That write has its own try/catch: if it fails it is logged and startup continues with the canonical URL. A valid host never leads to `clearToken()` |
| rejected | `serverUrl` deleted **and** `clearToken()` called, which clears the keychain entry and the electron-store `_token` fallback (the token may already have been sent to that host); logged via `debugLog` |

On a rejected host, `resolveStartup()` returns `{ action: 'login', notice }` and
`main.js` opens only the sign-in window, which shows the notice. Until a sign-in
stores a valid host again:
- `uploader.configure` is not called, so there is no API client;
- `initMigrationQueue` is not called, so there is no `MigrationQueue`, no
  `autoResume` and no 30s reconnect loop;
- the watcher is not started **at launch**. It can still be started from
  Settings > Save, because `startWatching()` is not gated on a valid host
  (tracked in `BACKLOG.md`). That sends nothing: a watched file can only reach
  `upload:file`, and with no host or token stored, upload and search refuse
  with `E_NOT_AUTHENTICATED` ("Not authenticated. Please sign in.").

The IPC handlers registered at load (search, folders, upload) still answer, but
`getClient()` finds no host or token and sends nothing.

A failed token check is not a rejection. `tls_error` and `network_error` resume
with the host and both copies of the token kept; only `auth_error` (401/403)
and `host_rejected` open the sign-in window.

**Stop is not delete.** Only a `validateServerUrl()` rejection removes the host
and the token. If the check itself throws (a settings file locked for a moment,
or corrupt), startup **stops**: nothing is sent, nothing is removed, and the
sign-in window says the settings could not be read and nothing was removed. The
next launch reads the file again. A throw later in the startup decision (for
example `getToken()`'s store read) is caught around the `resolveStartup()` call
in `whenReady` and handled the same way, with the error in the notice. It never
leaves the app with a tray and no window. In the other direction, a rejected host whose
removal partly fails (one delete throws) is still a rejection: every removal is
attempted, the failure is logged as "Removal incomplete", and the user sees the
rejection notice.

**A keychain that will not let go.** `clearToken()` works in this order:
1. Delete the `_token` fallback first: it is the plain-text copy, and the one
   the app can always reach. This happens before the keychain is touched, so a
   hung Credential Manager cannot leave it behind. A try/finally means the
   keychain is still attempted if this delete throws.
2. Delete the keychain entry.
3. If that throws, log it and revoke the entry: in memory for this run, and as
   `_keychainTokenRevoked` in the store. The store write has its own try/catch
   and log.

While the entry is revoked, `getToken()` ignores the keychain and reads only
the `_token` fallback, which step 1 deleted. A later `taxone-desktop://connect`
link therefore finds the user signed out. `saveToken()` lifts the revocation
only once a new token is in the keychain; if that write fails too, the new token
is read from the fallback, never the revoked one.

Residual: if the keychain delete **and** the flag write both fail, the
revocation holds only until the app restarts. After that the old keychain entry
is readable again. The log records it ("Could not persist the keychain
revocation"). The host was removed in the same pass, so nothing is sent until a
sign-in stores a valid host.

**Firms outside `*.quework.app`.** The allowlist accepts only a single-label
`https://<firm>.quework.app` host (plus the `taxone.cpa` mapping). A firm on any
other host — a custom domain, a nested subdomain, a port — is treated as
rejected on upgrade: signed out, with its host and token removed. It **cannot
sign in again** until a release widens the allowlist, because every sign-in path
goes through the same `validateServerUrl()`. Today that is one firm
(`caputa.quework.app`), so nobody is affected. Widening the allowlist or
supporting custom domains is tracked in `BACKLOG.md`, and has to land before a
firm on another host is onboarded.

Tests:
- `test/enforce-persisted-host.test.js` covers the table above, the token
  stores, and `resolveStartup`.
- `test/startup-gating.test.js` loads the real `main.js` against a fake
  Electron and checks that nothing above starts or sends after a rejected
  host, with a valid-host launch as the control. It also covers Settings > Save
  starting the watcher while upload and search still send nothing, and a
  connect link after a failed keychain delete.

---

## electron-store Schemas

### Default store (no name — `main.js`)

Used by `main.js` for app-level flags.

| Key | Type | Default | Purpose |
|-----|------|---------|---------|
| `hasLaunched` | boolean | `undefined` | Set on first launch after enabling auto-start |
| `hasClosedUploadWindow` | boolean | `undefined` | Set after first File Upload window close (tray notification shown once) |
| `lastLaunchedVersion` | string | `undefined` | Version of the previous packaged launch. Differs (or is missing) on the first launch of a version — that session does not check for updates before the 6-hour tick |

### Settings store (`taxone-settings`)

Used by `auth.js` and `watcher.js`.

| Key | Type | Default | Purpose |
|-----|------|---------|---------|
| `serverUrl` | string | `''` | Quework server URL |
| `watchPath` | string | `~/QueworkWatch/` | Watch folder path. Not written on first run — `getWatchPath()` falls back to the default instead of persisting it |
| `moveAfterUpload` | boolean | `true` | Move files to Uploaded/ subfolder |
| `_token` | string | `null` | API token (fallback when keytar unavailable) |
| `_keychainTokenRevoked` | boolean | `undefined` | Set when `clearToken()` could not delete the keychain entry: `getToken()` then ignores the keychain. Removed by a `saveToken()` whose keychain write succeeds |
| `_hostMigratedV1` | boolean | `undefined` | Guard flag: legacy-host migration has run once |
| `_watchPathMigratedV1` | boolean | `undefined` | Guard flag: legacy watch folder migration has run once |

**Legacy-host migration** — `auth.migrateLegacyHost()` runs once at startup (`main.js`, `app.whenReady`, before `serverUrl` is read), wrapped in its own try/catch so a store failure costs the migration and not the tray. electron-store lives in `userData` and survives installer updates — but only because `userData` is pinned; see [The userData pin](#the-userdata-pin), without which this migration finds an empty store and silently does nothing. This step rewrites an exact-hostname match on `taxone.cpa` / `www.taxone.cpa` to `https://caputa.quework.app`, then sets `_hostMigratedV1` so it never runs again. Deliberately single-firm and exact-match — it must be retired before multi-tenant subdomains land, not generalized. The stored host is then validated on read — see [Persisted host, checked on read](#persisted-host-checked-on-read).

**Legacy watch folder migration** — `watcher.migrateLegacyWatchPath()` runs once at startup, immediately after the host migration and before `createTray()`. `watchPath` is never written on first run, so an install whose owner never opened Settings has no stored value for the `userData` pin to preserve — renaming the default from `~/TaxoneWatch` to `~/QueworkWatch` would silently move it. When `watchPath` is unset **and** `~/TaxoneWatch` exists on disk, the legacy path is persisted; a fresh install has no such folder and keeps `~/QueworkWatch`. Sets `_watchPathMigratedV1`.

### Migration queue store (`migration-queue`)

Used by `MigrationQueue` class.

| Key | Type | Default | Purpose |
|-----|------|---------|---------|
| `files` | array | `[]` | Queue entries (id, absolutePath, clientId, status, etc.) |
| `status` | string | `'idle'` | Queue status: `idle`, `running`, `paused` |
| `history` | array | `[]` | Completed upload records (capped at 5,000) |
| `importRows` | array | `[]` | Persistent import tab staging rows |
| `lastClient` | object | `null` | Last client selected for loose file uploads |

### Queue file entry schema

```js
{
    id: string,           // crypto.randomUUID()
    absolutePath: string,  // full local path
    relativePath: string,  // path relative to client folder
    size: number,          // bytes
    clientId: number,
    clientName: string,
    folderName: string,    // source folder name
    folderPath: string,    // destination folder path in Quework
    filename: string,      // basename
    status: string,        // pending | uploading | completed | failed | skipped
    retries: number,       // 0–5
    error: string | null,
    documentId: number | null,  // Quework document ID after upload
    uploadedAt: string | null,  // ISO timestamp
}
```

### History entry schema

```js
{
    id: string,            // same as queue file id
    filename: string,
    clientName: string,
    clientId: number,
    documentId: number,    // Quework document ID
    uploadedAt: string,    // ISO timestamp
}
```

---

## Tray Menu

`updateTrayMenu(status)` builds a dynamic context menu based on connection status:

| Item | Condition |
|------|-----------|
| Quework Desktop (disabled label) | Always |
| File Upload | Always — opens migration window |
| WATCH FOLDER (section header) | Always |
| Status label (emoji + text) | Always — disconnected/watching/uploading/error |
| Watch folder path | When watch path exists |
| Open Watch Folder | When watch path exists |
| N file(s) pending | When pending watch files > 0 |
| Settings... | Always |
| **Restart to Update (x.y.z)** | An update is downloaded and still offered — installs silently and relaunches, unless something is uploading or waiting (then a dialog says what) |
| Check for Updates | Packaged builds — checks now and reports the result in a notification (greyed out as *Checking for Updates...* while a check runs) |
| **Sign In** | When `status === 'disconnected'` |
| **Sign Out** | When `status !== 'disconnected'` — clears token, sends auth-changed, shows login |
| Quit Quework Desktop | Always |

Single-click on tray icon opens File Upload window. Right-click opens context menu.

---

## Build & Distribution

- **electron-builder** with NSIS installer for Windows
- Desktop + Start Menu shortcuts, custom installer icon
- `appId: com.taxone.desktop` — unchanged by the rebrand; see [The AppUserModelId](#the-appusermodelid)
- `artifactName: TaxOne-Desktop-Setup.${ext}` — an identifier, coupled to `routes/web.php:540` in `abr9t/taxone`; see [The installer filename](#the-installer-filename)
- `productName: Quework Desktop` — drives the executable name (`Quework Desktop.exe`), but **not** `userData`; see [The userData pin](#the-userdata-pin). **The install directory is not renamed on upgrade.** Installing v1.2.0 over v1.1.5 reuses the existing directory: the exe lands at `%LOCALAPPDATA%\Programs\TaxOne Desktop\Quework Desktop.exe`, the old directory name is kept, and no `TaxOne Desktop.exe` remains in it (observed on a live upgrade). A fresh install is expected to use `%LOCALAPPDATA%\Programs\Quework Desktop` (electron-builder's default for `productName`; not verified). **The directory name is therefore not a reliable indicator of version** — check the exe name or its version resource instead.
- Custom protocol `taxone-desktop://` registered in `electron-builder.yml` under `protocols`
- Icon: `assets/icon.ico` (installer + NSIS), `assets/icon.png` (app window)
- Files included: `src/**/*`, `assets/**/*`, `node_modules/**/*`, `package.json`
- Output: `dist/`
- NSIS: non-oneClick (shows install wizard), no directory change allowed

### GitHub Actions Release

`.github/workflows/release.yml` — see [Release pipeline](#release-pipeline).

### Scripts

| Script | Command |
|--------|---------|
| `start` | `electron .` |
| `dev` | `node scripts/dev.js` — launches Electron with `NODE_ENV=development` and Herd's CA in `NODE_EXTRA_CA_CERTS`; see [TLS](#tls) |
| `test` | `node test/run-all.js` |
| `build` | `electron-builder --win --publish never` |
| `build:dir` | `electron-builder --win --dir --publish never` |
| `build:win` | `electron-builder --win --publish never` |

Every local build passes `--publish never`; only CI publishes (see [Release pipeline](#release-pipeline)).

---

## Releases and auto-update

### Release pipeline

`.github/workflows/release.yml` has two jobs, and a run starts only one of them.

| Job | Trigger | Permissions | What it does |
|-----|---------|-------------|--------------|
| `publish` | a pushed `v*` tag | `contents: write` | `npm ci`, `npm test`, then `electron-builder --win --publish always`: builds and uploads `TaxOne-Desktop-Setup.exe`, `TaxOne-Desktop-Setup.exe.blockmap` and `latest.yml` to a **draft** release |
| `dry-run` | Run workflow (`workflow_dispatch`), any branch | `contents: read` | `npm ci`, `npm test`, `npm run build` (`--publish never`), and uploads the same three files as a workflow artifact kept 7 days. Creates no release |

- **electron-builder is the only uploader.** It writes `latest.yml`, so the sha512 in it and the installer beside it come from one build. Releases up to v1.1.5 were built by electron-builder (which, with no `publish:` block, found the repo from `.git/config` and uploaded to its own draft) and then `softprops/action-gh-release`, which found that draft, uploaded the exe again and published it. v1.1.2 shows both: `TaxOne-Desktop-Setup-1.1.2.exe` from electron-builder and `TaxOne.Desktop.Setup.1.1.2.exe` from softprops, in one release. The second uploader is gone, and the `publish:` block in `electron-builder.yml` names the repo explicitly.
- **A draft reaches nobody.** electron-updater (via `github.com/abr9t/taxone-desktop/releases/latest`) and the web download link (`releases/latest/download/TaxOne-Desktop-Setup.exe`) only see published releases. Publishing the draft by hand is the moment every installed app starts downloading it.
- **Release candidates come from the dry run.** Run the workflow on the branch, download the artifact, and test that installer (UPGRADE-TEST.md) before tagging. The tag build is a fresh build of the same commit, not the same bytes; its `latest.yml` matches its own installer.
- **Least privilege.** Top-level `permissions: {}`; only the `publish` job can write, and only its publish step is given the token. Actions are pinned by commit SHA. `actions/checkout` runs with `persist-credentials: false`, so nothing that runs during `npm ci` finds a token in `.git/config`.
- **A local build never publishes.** Every `npm run build*` script passes `--publish never` (electron-builder otherwise publishes on its own when it sees a CI tag, and always from an npm script named `release`).
- `test/release-config.test.js` checks all of the above, and that each check can fail.

### What the app does

`src/updater.js`, started by `startUpdates()` in `main.js` right after the tray
and **before** the stored-host check: `resolveStartup()` returns early to the
sign-in window for a rejected host, and a signed-out install is exactly the one
a fixed release may be for. Updates go to GitHub and send no token. Unpackaged
builds (`npm start`, `npm run dev`) do not start it. `startUpdates()` itself
only records `lastLaunchedVersion`; electron-updater (about 100 ms to load and
construct) is required on the next turn of the event loop (`setImmediate`), so
it never delays the host check. `startup-gating.test.js` checks the order:
tray, `startUpdates()`, the host check, then the electron-updater load.

- **Configuration** (`configureUpdater`): `autoDownload: true`,
  `autoInstallOnAppQuit: true`, `disableWebInstaller: true`,
  `allowPrerelease: false`, `allowDowngrade: false`. `channel` is **never**
  assigned: electron-updater's `channel` setter silently sets
  `allowDowngrade = true`. `allowPrerelease` is set explicitly because
  electron-updater turns it on for any build whose own version has a
  prerelease tag (`1.3.0-beta.1`). `test/updater.test.js` pins all of this on
  the real `NsisUpdater`.
- **When it checks:** 5 minutes after launch, then every 6 hours, plus *Check
  for Updates* in the tray. On the **first launch of a version** (a fresh
  install, or the first run after any upgrade — `lastLaunchedVersion` differs
  or is missing) there is no 5-minute check, so first sign-in and the first
  look at a new version are not interrupted. The manual item still works.
- **Download:** silent, in the background, to
  `%LOCALAPPDATA%\taxone-desktop-updater` (from `updaterCacheDirName` in
  `app-update.yml`, not `userData`). Differential via the blockmaps when the
  previous release's blockmap is still published, otherwise the full ~85 MB
  installer. When it completes: one notification per version, and *Restart to
  Update (x.y.z)* appears in the tray.
- **Install:** never on the app's own initiative.
  - **On quit** (tray *Quit*): silent install, the app is not relaunched. Not
    gated — quitting is the user's call and an install relaunches nothing.
    Windows shutdown or logoff does **not** install: Electron does not emit
    `quit` then, and the installer is started from `quit`.
  - ***Restart to Update***: `quitAndInstall(true, true)` — silent, then the new
    version starts — only if `restartBlockers()` (`src/update-policy.js`)
    finds nothing in flight: a file uploading, the queue's throttle/back-off
    slot, **any pending file, paused included** (`autoResume()` ignores a saved
    pause, so a restart would un-pause it), an unconfirmed watch-folder file
    (in memory only — a restart drops it) or a confirm-window upload. A queue
    that cannot be read blocks. Otherwise a dialog names what is in flight
    and the update stays ready. The queue's `running` status is deliberately
    not a rule. `MigrationQueue` loads its persisted status at construction
    (`migration.js:94`), and a quit or crash mid-run leaves `running` saved.
    On the next launch `autoResume()` calls `start()`, which returns early
    because the status already says running (`migration.js:341`), so
    `_processNext()` never runs, nothing uploads and the status never clears.
    Gating on it would refuse every restart on that install. (If pending files
    are left in that stuck queue, the pending rule refuses anyway — see
    `BACKLOG.md`.)
- **Never throws, never rejects unhandled.** Every check resolves; the
  download promise, which rejects on its own, is caught; an `'error'` emit
  cannot throw; tray, notification and installer failures are logged. If
  electron-updater cannot even load, `startUpdates()` logs `[updater] Not
  started` and everything else starts as normal (`startup-gating.test.js`).
- **Logging:** electron-updater's own logger and the controller both write to
  `debug.log` with an `[updater]` prefix.

### What is verified, and who can ship an update

Builds are unsigned. electron-updater checks a signature only when
`app-update.yml` has a `publisherName`, which electron-builder writes only for
signed builds, so **no signature is checked**. What does hold:

1. TLS (Chromium, Windows store) to `github.com/abr9t/taxone-desktop/releases/latest`
   — the web endpoint, not the API, which excludes drafts and prereleases —
   and the `.atom` feed, then `releases/download/<tag>/latest.yml`.
2. The installer, fetched from GitHub's release-asset host, must match the
   **sha512 in `latest.yml`**; a mismatch fails with `ERR_CHECKSUM_MISMATCH`
   and the file is discarded. A differential download is hashed as a whole
   at the end; a cached download is re-hashed before reuse.
3. `semver`: only a higher version than the running one (no downgrade).
4. The installer then runs **silently, as the user**. It carries no
   Mark-of-the-Web, so SmartScreen does not prompt.

So the sha512 protects against a corrupt or truncated download, **not**
against a malicious release: whoever can publish one writes both files. That
is anyone with the `abr9t` account or write access to the repo, any token with
`contents: write` (including a workflow change merged to master followed by a
tag push), or **any compromised dependency that runs during `npm ci` or the
build in CI**, which can alter the installer before `latest.yml` is hashed.
The draft step means a person has to publish. A network attacker is stopped
by TLS, unless they have a root in the Windows store, in which case they
already control the machine.

### Failure modes

| What happens | Result |
|--------------|--------|
| Offline, DNS failure, 429, 5xx | Check logged, nothing changes, retried at the next tick |
| Certificate failure | Same — and a downloaded update is **not** withdrawn |
| `latest.yml` missing from the release | `ERR_UPDATER_CHANNEL_FILE_NOT_FOUND`, logged, nothing offered |
| Corrupt or truncated download | `ERR_CHECKSUM_MISMATCH`, file discarded, offered nothing, downloaded again next check |
| Interrupted download | Written to a `temp-*` file and only renamed after the hash passes |
| Older version published as latest | Not offered (no downgrade) |
| Prerelease published | Not offered: `/releases/latest` skips prereleases, and `allowPrerelease` is off |
| Disk full | Write error logged, temp file removed |

### Kill switch

| Need | How | Effect |
|------|-----|--------|
| Pause, keep the release and the web download | Edit `latest.yml` on the release to add `stagingPercentage: 0` (delete the asset, upload the edited one) | Apps that have not downloaded it stop being offered it; apps that have downloaded it **withdraw it** at their next successful check |
| Withdraw | Mark the release as a **prerelease**, or delete it | `/releases/latest` falls back to the previous release, which is older, so nothing is offered and downloaded copies are withdrawn at the next successful check. **The web download link (`releases/latest/download/TaxOne-Desktop-Setup.exe`) then serves the previous release's installer too** |
| Already installed | Publish a higher version with the fix | Rollback is not possible by design (no downgrade) |

- **Withdrawal of a downloaded update.** Only a *successful* check that no
  longer offers the downloaded version sets `autoInstallOnAppQuit = false` and
  removes *Restart to Update* (`decideAfterCheck()` in `update-policy.js`).
  Offline, 429, a TLS failure or a missing `latest.yml` never withdraw: an
  error says nothing about the release. Without this, a withdrawn build still
  installs at the next quit. Tested in both directions.
- **Immutable releases must stay off.** With GitHub's *Immutable releases*
  setting, assets of a published release cannot be changed, so the
  `stagingPercentage: 0` pause is impossible and only the prerelease/delete
  route is left. All releases to date report `immutable: false`.

### Install path and userData

An update runs the same NSIS installer with `--updated /S`:
- `INSTDIR` comes from `HKCU\Software\fb2f6324-7194-5753-aa0e-d1c9da0ecd6e\InstallLocation`,
  so the existing directory is reused, and the uninstall key is the same
  (both derive from the unchanged `appId`). The installer is per-user and asks
  for no elevation.
- The previous version's uninstaller runs with `/KEEP_APP_DATA --updated`,
  and `deleteAppDataOnUninstall` is not set, so `%APPDATA%\TaxOne Desktop`
  is never deleted. The userData pin and the one-time migrations run as on
  any launch.
- electron-updater writes one file into `%APPDATA%\TaxOne Desktop`:
  `.updaterId`, a random id for staged rollouts. It changes nothing else there.

### Code signing — deferred

Signing would make electron-builder write `publisherName`, and electron-updater
would then refuse an installer not signed by that publisher. That stops a
GitHub account or release compromise **only if** the signing key is out of
reach (HSM, Azure Trusted Signing). It does not stop a compromised CI that
holds the signing credentials, and it does not cover the first signed
release (installed by an app whose `app-update.yml` has no `publisherName`).
For one firm and a handful of installs it is deferred; see `BACKLOG.md`.

### Tests

- `test/update-policy.test.js` — each restart blocker alone; withdrawal in both
  directions.
- `test/updater.test.js` — the controller on a fake updater and clock; the
  configuration on the real `NsisUpdater`.
- `test/startup-gating.test.js` — the real `main.js`: updates start on every
  launch path, a failing updater costs nothing else, and *Restart to Update*
  refuses for the real queue, unconfirmed files and confirm-window uploads.
- `test/release-config.test.js` — the pipeline.
- End to end, on Windows, against the dry-run release candidate:
  UPGRADE-TEST.md section 6.

---

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| electron-store v8 not v10 | v10+ is ESM-only, incompatible with Electron's CommonJS require |
| `crypto.randomUUID()` over uuid package | uuid v9+ is ESM-only |
| Queue in main process, not renderer | Survives window close, single source of truth |
| In-memory files with debounced 2s writes | 30k+ file performance — avoids JSON.stringify on every status change |
| Folder path as string, not ID | Server resolves via `firstOrCreate` — client doesn't need to pre-create |
| Server-side dedup over client-side | Server is source of truth for existing files |
| Separate preloads per window type | Minimal API surface per window via contextBridge |
| Levenshtein for fuzzy matching | Simple, no external NLP dependency, good enough for client names |
| 5 retries with exponential backoff | Handles flaky networks and transient server errors |
| 30s network polling for auto-reconnect | Retries failed files automatically when connection is restored |
| `webUtils.getPathForFile()` | Electron's API for getting absolute paths from drag-and-drop files |
| Browser OAuth as primary login | Avoids users having to find and copy API tokens manually |
| `taxone-desktop://connect` protocol | Allows web app to deep-link into desktop app for onboarding |
| Offline-tolerant startup | `network_error` or `tls_error` on token verify doesn't force re-login — cached credentials used; `tls_error` also shows a notification and the tray error state |
| Stored host validated at startup | Rejected host and both token copies cleared before anything authenticated; nothing starts until a valid sign-in |
| Two separate file upload mechanisms | Watch folder for day-to-day (per-file), File Upload tool for bulk imports |
| 200-row virtualization in Queue tab | Prevents DOM thrashing with 30k+ files |
| Import rows persisted to store | Survives window close/reopen during long import sessions |
| Three separate electron-store instances | Separates concerns: app flags, user settings, queue state |
| Concurrency: 1 with 500ms throttle | Prevents server overload during bulk uploads |
| Auto-start queue on enqueue | Eliminates extra manual step — `enqueue()` calls `start()` automatically |
| Batch counters reset per start | Completion notification shows per-run results, not cumulative totals |
| Certificate verification never relaxed | The token and client documents ride on it, and unsigned builds have nothing else vouching for the server |
| One client factory (`createApiClient`) | Host validation and `rejectUnauthorized: true` in one place no caller can skip |
| Dev CA via `NODE_EXTRA_CA_CERTS`, not `rejectUnauthorized: false` | Adds a trust anchor in dev without turning any check off; the launcher lives outside the packaged files |
| Server URL allowlist in `validateServerUrl` | https on a single-label `*.quework.app` host only; the stored host is where the bearer token is sent, and `taxone-desktop://` is a protocol anyone can link to. A firm on any other host is signed out on upgrade and cannot sign in until the allowlist is widened (see [Persisted host, checked on read](#persisted-host-checked-on-read)) |
| Auth-changed event propagation | Single source of truth for auth state across all windows |
| Updates download silently, never restart on their own | A tray app may be uploading a client's files at any moment; install on quit, or from the tray when `restartBlockers()` finds nothing in flight |
| Updates start before the host check | A signed-out install (rejected host, no sign-in yet) is exactly the one a fixed release may be for; updates go to GitHub and carry no token |
| Draft releases, published by hand | The publish click is the one moment every install starts downloading; a candidate is tested from the dry-run artifact first |
| Only a successful check withdraws a downloaded update | Offline, 429 or a broken feed says nothing about the release; the kill switch must not depend on the network being up, nor fire when it is down |

---

## File Structure

```
taxone-desktop/
├── .github/
│   └── workflows/
│       └── release.yml           # GitHub Actions: tag → draft release; Run workflow → 7-day release-candidate artifact
├── assets/
│   ├── icon.ico                  # Windows installer icon (NSIS)
│   ├── icon.png                  # App window icon (256x256)
│   ├── icon.svg                  # App icon source
│   └── tray-icon.png             # System tray icon
├── src/
│   ├── main.js                   # App entry — inherited-TLS-override guard, userData pin, lifecycle, tray, windows, IPC handlers, queue init, protocol handler
│   ├── auth.js                   # Token storage (keytar + electron-store fallback), server URL allowlist, legacy-host migration, persisted-host check, userData tripwire
│   ├── startup.js                # resolveStartup — login-or-resume decision, stored host checked before the first request
│   ├── reconnect.js              # One never-rejecting tick of the 30s reconnect loop
│   ├── updater.js                # electron-updater wiring: configuration, check schedule, withdrawal, Restart to Update
│   ├── update-policy.js          # Pure decisions: restart blockers, first launch of a version, keep/withdraw after a check
│   ├── auto-launch.js            # Run-key reconciliation after the executable rename
│   ├── debug-log.js              # Shared {userData}debug.log writer (debugLog / debugError)
│   ├── watcher.js                # chokidar watch folder, file parsing, move-to-Uploaded/Cancelled
│   ├── uploader.js               # createApiClient (host validation, pinned TLS verification, certificate-error naming) — search, folders, upload, token verification
│   ├── migration.js              # MigrationQueue class — persistent queue engine, client matching, scanning, throttling
│   ├── migration-ipc.js          # IPC handler registration for file upload tool, Excel export
│   ├── preload.js                # contextBridge for login/settings/confirm windows (window.taxone)
│   ├── preload-migration.js      # contextBridge for file upload window (window.electronAPI.migration)
│   └── renderer/
│       ├── login.html            # Browser OAuth + manual token paste, server URL auto-fill
│       ├── settings.html         # Watch folder config, connection status, auto-launch toggle, sign in/out
│       ├── confirm-upload.html   # Per-file upload: rename, client search, folder browser, cancel
│       └── migration.html        # File upload tool: import/queue/history tabs, auth guards, Excel export, drop overlay
├── scripts/
│   └── dev.js                    # `npm run dev` launcher — adds Herd's CA via NODE_EXTRA_CA_CERTS; never packaged
├── test/
│   ├── run-all.js                # Runs every *.test.js, one process each (the suites stub Module._load)
│   ├── auto-launch.test.js       # Run-key reconciliation, including the Task-Manager-disabled case
│   ├── dev-launcher.test.js      # Dev CA resolution; scripts/ stays outside the packaged files
│   ├── enforce-persisted-host.test.js # Stored host checked on read; both token stores cleared; resolveStartup
│   ├── migrate-legacy-host.test.js   # taxone.cpa -> caputa.quework.app, guard, idempotence
│   ├── migrate-watch-path.test.js    # ~/TaxoneWatch pinning vs. fresh installs
│   ├── reconnect.test.js         # The 30s tick never rejects and never retries for a rejected host
│   ├── release-config.test.js    # Publish config, --publish never locally, release.yml permissions/pins/dry run
│   ├── startup-gating.test.js    # Real main.js on a fake Electron: a rejected host starts nothing but updates; tray update items
│   ├── tls-tripwire.test.js      # Nothing in src/, scripts/, package.json or electron-builder.yml relaxes certificate verification
│   ├── tls-verification.test.js  # Local HTTPS server: rejection, env override, dev CA, hostname check, error naming
│   ├── update-policy.test.js     # Each restart blocker alone; withdrawal in both directions
│   ├── updater.test.js           # Controller on a fake updater; configuration pinned on the real NsisUpdater
│   ├── userdata-tripwire.test.js     # Tripwire throws unpackaged, records packaged
│   ├── validate-server-url.test.js   # Server URL allowlist and its counterfactuals
│   ├── helpers/                  # Module._load stubs and the TLS child-process client (not suites)
│   └── fixtures/tls/             # TEST-ONLY CA and leaf certificates (100-year validity) — see its README
├── .gitleaksignore               # Fingerprints of the TEST-ONLY fixture keys
├── electron-builder.yml          # Build config — NSIS, protocol registration, icons, artifactName, publish (GitHub draft)
├── package.json                  # Dependencies & scripts
├── UPGRADE-TEST.md               # Manual upgrade checklist — the merge gate for v1.2.0
└── ARCHITECTURE.md               # This file
```
