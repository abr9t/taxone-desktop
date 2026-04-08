# TaxOne Desktop — Architecture

Electron companion app for [TaxOne](https://taxone.cpa). Two core features:

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
| axios | ^1.7.0 | HTTP client for TaxOne API |
| keytar | ^7.9.0 | OS keychain for token storage (fallback: electron-store) |
| xlsx | ^0.18.5 | Excel export for queue data |
| form-data | (transitive) | Multipart uploads via axios |
| electron-builder | ^25.0.0 | Build & packaging (dev) |
| cross-env | ^7.0.3 | Cross-platform env vars (dev) |
| png2icons | ^2.0.1 | Icon conversion (dev) |

Node.js built-in `crypto.randomUUID()` for IDs (no `uuid` package — ESM incompatibility).

---

## TLS Configuration

`process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'` is set at the top of `src/main.js` (line 1) to disable TLS certificate verification. This allows connections to servers with self-signed or invalid certificates.

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
- **First-launch auto-start** — on first run, `app.setLoginItemSettings({ openAtLogin: true })` and `hasLaunched` flag set in `appStore`
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
- Server URL stored in `electron-store` (store name: `taxone-settings`), normalized (trailing slash stripped, `http://` forced to `https://` for non-localhost/non-`.test` URLs)
- Token verified on app start via `GET /api/desktop/clients?search=&limit=1`
  - `'ok'` → proceed with cached credentials, open File Upload window
  - `'auth_error'` (401/403) → show login
  - `'network_error'` → proceed anyway (offline-tolerant)
- Tokens don't expire unless revoked from TaxOne Firm Settings

### Login Methods

**1. Browser OAuth flow (primary):**
- User enters server URL → clicks "Sign in with Browser" → opens `{serverUrl}/desktop/authorize` in default browser via `shell.openExternal()`
- TaxOne web app authenticates user, then redirects to `taxone-desktop://auth?token=X&url=Y`
- Custom protocol registered via `app.setAsDefaultProtocolClient('taxone-desktop')` (with `process.execPath` arg in dev mode)
- `handleAuthUrl()` parses URL, saves token + server URL, configures uploader, starts watching, inits migration queue, opens File Upload window
- Sends `migration:auth-changed` event to File Upload window with `true`
- Shows "Successfully signed in" OS notification

**2. `taxone-desktop://connect` handler:**
- Web app can link to `taxone-desktop://connect?url=X` to pre-fill server URL via `auth.saveServerUrl()`
- If already signed in (token exists), opens File Upload window directly
- If not signed in, opens login window (with server URL pre-filled)

**3. Manual token paste (fallback):**
- Login window has expandable "Paste token manually" section (toggle animation with `max-height` transition)
- User enters server URL + token → `uploader.verifyTokenWith()` validates (10s timeout) → save to keychain + store
- On success: shows green checkmark success state, auto-closes window after 2s

**Login window auto-fills server URL** — on init, calls `window.taxone.getServerUrl()` and populates the input field

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

- chokidar monitors configurable watch path (default: `~/TaxoneWatch/`)
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
- **Server-side:** upload endpoint returns `{skipped: true}` if same filename exists in same client+folder → file marked `skipped` with error "Already exists in TaxOne"

**Oversized files:** files > 100MB auto-set to `skipped` status with error "File exceeds 100MB upload limit" at enqueue time

**Queue controls:**
- Start/Pause, auto-resume on app start
- Retry single file (`retryFile`), retry all failed (`retryAllFailed`)
- Skip file (`skipFile`)
- Clear queue (`clearQueue`), clear by status (`clearByStatus`)
- Batch completion counters (`_batchCompleted`, `_batchSkipped`, `_batchFailed`) — reset on each `start()` call, reported in the completion notification (per-run, not cumulative)

**Network reconnection:**
- 30s `setInterval` in main.js checks `uploader.verifyToken()`
- If online and failed files exist with idle queue → `retryAllFailed()`

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
| `settings:set-auto-launch` | invoke | Set `app.setLoginItemSettings({ openAtLogin })` |
| `settings:browse-folder` | invoke | Native folder picker dialog |
| `get-server-url` | invoke | Return stored server URL |
| `open-external` | invoke | Open URL in default browser via `shell.openExternal()` |

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
| `migration:get-clients` | invoke | Fetch all TaxOne clients (limit: 2000, `include_all: true`) |
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

## electron-store Schemas

### Default store (no name — `main.js`)

Used by `main.js` for app-level flags.

| Key | Type | Default | Purpose |
|-----|------|---------|---------|
| `hasLaunched` | boolean | `undefined` | Set on first launch after enabling auto-start |
| `hasClosedUploadWindow` | boolean | `undefined` | Set after first File Upload window close (tray notification shown once) |

### Settings store (`taxone-settings`)

Used by `auth.js` and `watcher.js`.

| Key | Type | Default | Purpose |
|-----|------|---------|---------|
| `serverUrl` | string | `''` | TaxOne server URL |
| `watchPath` | string | `~/TaxoneWatch/` | Watch folder path |
| `moveAfterUpload` | boolean | `true` | Move files to Uploaded/ subfolder |
| `_token` | string | `null` | API token (fallback when keytar unavailable) |

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
    folderPath: string,    // destination folder path in TaxOne
    filename: string,      // basename
    status: string,        // pending | uploading | completed | failed | skipped
    retries: number,       // 0–5
    error: string | null,
    documentId: number | null,  // TaxOne document ID after upload
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
    documentId: number,    // TaxOne document ID
    uploadedAt: string,    // ISO timestamp
}
```

---

## Tray Menu

`updateTrayMenu(status)` builds a dynamic context menu based on connection status:

| Item | Condition |
|------|-----------|
| TaxOne Desktop (disabled label) | Always |
| File Upload | Always — opens migration window |
| WATCH FOLDER (section header) | Always |
| Status label (emoji + text) | Always — disconnected/watching/uploading/error |
| Watch folder path | When watch path exists |
| Open Watch Folder | When watch path exists |
| N file(s) pending | When pending watch files > 0 |
| Settings... | Always |
| **Sign In** | When `status === 'disconnected'` |
| **Sign Out** | When `status !== 'disconnected'` — clears token, sends auth-changed, shows login |
| Quit TaxOne Desktop | Always |

Single-click on tray icon opens File Upload window. Right-click opens context menu.

---

## Build & Distribution

- **electron-builder** with NSIS installer for Windows
- Desktop + Start Menu shortcuts, custom installer icon
- `appId: com.taxone.desktop`
- Custom protocol `taxone-desktop://` registered in `electron-builder.yml` under `protocols`
- Icon: `assets/icon.ico` (installer + NSIS), `assets/icon.png` (app window)
- Files included: `src/**/*`, `assets/**/*`, `node_modules/**/*`, `package.json`
- Output: `dist/`
- NSIS: non-oneClick (shows install wizard), no directory change allowed

### GitHub Actions Release

`.github/workflows/release.yml` — triggered on `v*` tags:
1. Runs on `windows-latest`
2. Node.js 20, `npm ci`, `npm run build`
3. `softprops/action-gh-release@v2` uploads `dist/*.exe` to GitHub Releases

### Scripts

| Script | Command |
|--------|---------|
| `start` | `electron .` |
| `dev` | `cross-env NODE_ENV=development electron .` |
| `build` | `electron-builder --win` |
| `build:dir` | `electron-builder --win --dir` |
| `build:win` | `electron-builder --win` |

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
| Offline-tolerant startup | `network_error` on token verify doesn't force re-login — cached credentials used |
| Two separate file upload mechanisms | Watch folder for day-to-day (per-file), File Upload tool for bulk imports |
| 200-row virtualization in Queue tab | Prevents DOM thrashing with 30k+ files |
| Import rows persisted to store | Survives window close/reopen during long import sessions |
| Three separate electron-store instances | Separates concerns: app flags, user settings, queue state |
| Concurrency: 1 with 500ms throttle | Prevents server overload during bulk uploads |
| Auto-start queue on enqueue | Eliminates extra manual step — `enqueue()` calls `start()` automatically |
| Batch counters reset per start | Completion notification shows per-run results, not cumulative totals |
| `NODE_TLS_REJECT_UNAUTHORIZED = '0'` | Allows connections to servers with self-signed certificates |
| HTTPS enforcement in `saveServerUrl` | Forces `https://` for non-localhost/non-`.test` URLs |
| Auth-changed event propagation | Single source of truth for auth state across all windows |

---

## File Structure

```
taxone-desktop/
├── .github/
│   └── workflows/
│       └── release.yml           # GitHub Actions: build on tag push, publish to GitHub Releases
├── assets/
│   ├── icon.ico                  # Windows installer icon (NSIS)
│   ├── icon.png                  # App window icon (256x256)
│   ├── icon.svg                  # App icon source
│   └── tray-icon.png             # System tray icon
├── src/
│   ├── main.js                   # App entry — lifecycle, tray, windows, IPC handlers, queue init, protocol handler, TLS config
│   ├── auth.js                   # Token storage (keytar + electron-store fallback), server URL, HTTPS enforcement
│   ├── watcher.js                # chokidar watch folder, file parsing, move-to-Uploaded/Cancelled
│   ├── uploader.js               # Axios API client — search, folders, upload, token verification
│   ├── migration.js              # MigrationQueue class — persistent queue engine, client matching, scanning, throttling
│   ├── migration-ipc.js          # IPC handler registration for file upload tool, Excel export
│   ├── preload.js                # contextBridge for login/settings/confirm windows (window.taxone)
│   ├── preload-migration.js      # contextBridge for file upload window (window.electronAPI.migration)
│   └── renderer/
│       ├── login.html            # Browser OAuth + manual token paste, server URL auto-fill
│       ├── settings.html         # Watch folder config, connection status, auto-launch toggle, sign in/out
│       ├── confirm-upload.html   # Per-file upload: rename, client search, folder browser, cancel
│       └── migration.html        # File upload tool: import/queue/history tabs, auth guards, Excel export, drop overlay
├── electron-builder.yml          # Build config — NSIS, protocol registration, icons
├── package.json                  # Dependencies & scripts
└── ARCHITECTURE.md               # This file
```
