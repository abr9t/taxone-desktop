# TaxOne Desktop — Architecture

Electron companion app for [TaxOne](https://taxone.cpa). Two core features:

1. **Watch Folder** — monitors a local directory and prompts per-file upload to a matched client
2. **File Upload Tool** — bulk import with drag-and-drop, client matching, persistent queue, concurrent uploads

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
| form-data | (transitive) | Multipart uploads via axios |
| electron-builder | ^25.0.0 | Build & packaging (dev) |
| cross-env | ^7.0.3 | Cross-platform env vars (dev) |

Node.js built-in `crypto.randomUUID()` for IDs (no `uuid` package — ESM incompatibility).

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

- **Single-instance lock** — `app.requestSingleInstanceLock()`, second instance focuses settings
- **System tray app** — no dock icon on macOS (`app.dock.hide()`)
- **Main process owns all state** — queues, watchers, uploads
- **Renderer processes are display-only** — communicate via IPC only
- **`nodeIntegration: false`, `contextIsolation: true`** — separate preloads per window type

### Windows

| Window | HTML | Preload | Size | Resizable |
|--------|------|---------|------|-----------|
| Login | `login.html` | `preload.js` | 420×520 | No |
| Settings | `settings.html` | `preload.js` | 520×640 | Yes |
| Confirm Upload | `confirm-upload.html` | `preload.js` | 540×580 | No |
| File Upload | `migration.html` | `preload-migration.js` | 900×680 (min 700×500) | Yes |

Login, Settings, Confirm Upload expose `window.taxone` namespace.
File Upload exposes `window.electronAPI.migration` namespace.

---

## Authentication

**`src/auth.js`**

- Sanctum personal access token with `desktop` ability scope
- Token storage: OS keychain via keytar (`TaxOneDesktop` / `api-token`), falls back to `electron-store` `_token` key
- Server URL stored in `electron-store` (store name: `taxone-settings`), normalized (trailing slash stripped)
- Token verified on app start via `GET /api/desktop/clients?search=&limit=1`
- Login window: server URL + token paste → `uploader.verifyTokenWith()` → save to keychain + store
- Tokens don't expire unless revoked from TaxOne Firm Settings

---

## Watch Folder

**`src/watcher.js`**

- chokidar monitors configurable watch path (default: `~/TaxoneWatch/`)
- `ignoreInitial: true`, `awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 200 }`, `depth: 5`
- Ignores: hidden files, `.tmp`, `.crdownload`, `~` suffix, `Uploaded/` subfolders
- Allowed extensions: `.pdf`, `.jpg`, `.jpeg`, `.png`, `.heic`, `.tiff`, `.gif`, `.webp`, `.xlsx`, `.xls`, `.csv`, `.doc`, `.docx`, `.txt`, `.zip`, `.msg`, `.eml`
- `parseFileInfo()` extracts `clientHint` (first subfolder) and `folderHint` (remaining path)
- New files trigger `enqueueFile()` in main.js → opens confirm-upload window

### Confirm Upload Flow

- File queue managed in main process (`pendingFiles[]` array, not persisted)
- One file at a time — confirm window shows current file, "Skip" or "Upload"
- File rename, client search (debounced 250ms), navigable folder browser
- New folder creation (server creates on upload via `folder_path`)
- Optional move-to-`Uploaded/` subfolder after success (handles name collisions with `(n)` suffix)
- OS `Notification` on successful upload

---

## File Upload Tool

**`src/migration.js`** (MigrationQueue class) + **`src/migration-ipc.js`** (IPC handlers) + **`src/renderer/migration.html`** (UI)

Three-tab interface: **Import**, **Queue**, **History**.

### Import Tab

**Drop zone:**
- Full-window drop target (dragenter counter pattern) + compact bar + Browse button
- Accepts folders (each = one client row) and loose files
- `webkitGetAsEntry()` to distinguish files from folders
- `webUtils.getPathForFile()` to get absolute paths from dropped files

**Folder scanning (`scanClientFolder` / `_walkDir`):**
- Recursive directory walk, skips hidden directories
- Junk file filter: `.DS_Store`, `Thumbs.db`, `desktop.ini`, `.sync`, `~$` prefix, `.` prefix, `.tmp`, `.crdownload`, `.partial`
- Flags oversized files (`size > MAX_FILE_SIZE` = 100MB)

**Client matching (`matchClients`):**
1. **Exact** — case-insensitive, non-alphanumeric stripped (`normalizeForMatch`)
2. **Fuzzy** — Levenshtein distance, threshold = `max(3, ceil(name.length * 0.3))`, top 3 candidates
3. **Unmatched** — no candidates within threshold

**Searchable client dropdown:**
- Substring filter on `allClients` array, max 10 results
- Keyboard navigation (ArrowUp/Down, Enter, Escape)
- `has-selection` / `has-value` CSS states
- On selection: sets `matchType: 'manual'`, auto-checks row

**Folder picker modal (loose files only):**
- Navigable folder tree via `clients:folders` IPC
- Breadcrumb navigation, back button, "Use root folder" option
- Selected path stored as `folderPath` on import row

**Import table:**
- Checkboxes per row, "Check All" / "Uncheck Unmatched" / "Clear Queued" / "Clear All"
- Additive staging — rows persist across drops, duplicate folder names skipped
- Queued rows grayed out (`match-row-queued`)
- Import rows persisted to `electron-store` (`importRows` key) via `migration:set-import-rows`
- Last used client remembered for loose file drops (`lastClient` key)

### Queue Tab

**Persistent queue (`MigrationQueue` class):**
- `electron-store` (store name: `migration-queue`) with in-memory arrays (`_files`, `_history`)
- Debounced disk writes every 2s (`_scheduleSave`, `_scheduleHistorySave`) for 30k+ file performance
- `flushSave()` called on `before-quit` event

**Crash recovery:**
- On construct: `_recoverCrashedUploads()` resets any `uploading` files back to `pending`
- `autoResume()` called after init — starts queue if pending/uploading files exist

**Concurrent uploads:**
- `concurrency: 3` (configurable), managed via `activeUploads` counter
- `_processNext()` fills slots up to concurrency limit

**Retry logic:**
- Up to `maxRetries: 5` with exponential backoff: `2^retries * 1000`ms (2s, 4s, 8s, 16s, 32s)
- Retryable errors (`_isRetryableError`): `ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, `ENOTFOUND`, 5xx responses, `timeout`/`SSL`/`ECONNRESET`/`socket hang up` in message

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

**Network reconnection:**
- 30s `setInterval` in main.js checks `uploader.verifyToken()`
- If online and failed files exist with idle queue → `retryAllFailed()`

**Queue UI:**
- Filter pills: All, Pending, Uploading, Failed, Completed, Skipped
- Search by filename (substring)
- Per-filter clear button ("Clear Completed", "Clear Failed", etc.)
- Progress bar, stat counts, percentage, total size (uploaded / total)
- Virtualizes at 200 rows with "Show all" button
- In-place file row updates via `migration:file-update` IPC event
- OS `Notification` on queue completion

### History Tab

- Completed uploads log (capped at 5,000 entries in `_history` array)
- Shows filename, client name, timestamp
- In-memory with debounced disk writes (2s)
- UI shows first 500 entries

---

## API Surface (Laravel)

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/desktop/clients` | Search/list clients (`?search=`, `?limit=`) |
| `GET` | `/api/desktop/clients/{id}/folders` | Folder tree (`?parent_id=`) |
| `POST` | `/api/desktop/upload` | Upload file (multipart: `file`, `client_id`, `folder_path`, `filename`) |

- All routes behind `auth:sanctum` + `ability:desktop`
- Upload endpoint: 100MB max, `folder_path` resolved via `firstOrCreate`
- Duplicate detection: returns `{skipped: true}` if same filename exists in same client+folder
- CSRF excluded (api.php routes)
- Cloudflare WAF bypass for `/api/desktop/*` POST
- Axios timeout: 300,000ms (5 min) for uploads, 10,000ms for token verification

---

## File Structure

```
taxone-desktop/
├── assets/
│   ├── icon.png              # App icon (256×256)
│   ├── icon.svg              # App icon source
│   └── tray-icon.png         # System tray icon
├── src/
│   ├── main.js               # App entry — lifecycle, tray, windows, IPC handlers, queue init
│   ├── auth.js               # Token storage (keytar + electron-store fallback), server URL
│   ├── watcher.js            # chokidar watch folder, file parsing, move-to-Uploaded
│   ├── uploader.js           # Axios API client — search, folders, upload
│   ├── migration.js          # MigrationQueue class — persistent queue engine
│   ├── migration-ipc.js      # IPC handler registration for file upload tool
│   ├── preload.js            # contextBridge for login/settings/confirm windows (window.taxone)
│   ├── preload-migration.js  # contextBridge for file upload window (window.electronAPI.migration)
│   └── renderer/
│       ├── login.html        # Server URL + token paste
│       ├── settings.html     # Watch folder config, connection status
│       ├── confirm-upload.html  # Per-file upload: rename, client search, folder browser
│       └── migration.html    # File upload tool: import/queue/history tabs
├── electron-builder.yml      # Build config
├── package.json              # Dependencies & scripts
└── README.md
```

---

## IPC Channels

### Auth & Settings (registered in `main.js`)

| Channel | Handler | Purpose |
|---------|---------|---------|
| `auth:login` | `main.js` | Verify token, save to keychain, start watching |
| `settings:get` | `main.js` | Return serverUrl, watchPath, moveAfterUpload, hasToken |
| `settings:save` | `main.js` | Save watchPath + moveAfterUpload, restart watcher |
| `settings:browse-folder` | `main.js` | Native folder picker dialog |

### Clients & Upload (registered in `main.js`)

| Channel | Handler | Purpose |
|---------|---------|---------|
| `clients:search` | `main.js` | Search clients via API |
| `clients:folders` | `main.js` | Fetch folder tree for a client |
| `upload:file` | `main.js` | Upload file, move-to-Uploaded, send notification |
| `queue:next` | `main.js` | Dequeue current file, show next or close window |
| `queue:state` | `main.js` | Return pending count + current file |

### File Upload Tool (registered in `migration-ipc.js`)

| Channel | Handler | Purpose |
|---------|---------|---------|
| `migration:scan-folders` | `migration-ipc.js` | Scan directory trees, return client folders + files |
| `migration:scan-files` | `migration-ipc.js` | Scan loose file paths, return file info |
| `migration:get-clients` | `migration-ipc.js` | Fetch all TaxOne clients (limit: 9999) |
| `migration:match-clients` | `migration-ipc.js` | Match scanned folders against clients |
| `migration:enqueue` | `migration-ipc.js` | Add files to upload queue |
| `migration:start` | `migration-ipc.js` | Start queue processing |
| `migration:pause` | `migration-ipc.js` | Pause queue processing |
| `migration:retry-file` | `migration-ipc.js` | Retry a single failed file |
| `migration:retry-all-failed` | `migration-ipc.js` | Retry all failed files |
| `migration:skip-file` | `migration-ipc.js` | Skip a file |
| `migration:clear-queue` | `migration-ipc.js` | Clear entire queue |
| `migration:clear-by-status` | `migration-ipc.js` | Clear files with a specific status |
| `migration:get-stats` | `migration-ipc.js` | Return queue statistics |
| `migration:get-files` | `migration-ipc.js` | Return all files in queue |
| `migration:get-history` | `migration-ipc.js` | Return upload history |
| `migration:get-import-rows` | `migration-ipc.js` | Return persisted import tab staging rows |
| `migration:set-import-rows` | `migration-ipc.js` | Save import tab staging rows |
| `migration:get-last-client` | `migration-ipc.js` | Return last used client for loose files |
| `migration:set-last-client` | `migration-ipc.js` | Save last used client |
| `migration:select-folder` | `migration-ipc.js` | Native folder picker dialog |
| `migration:flush-save` | `migration-ipc.js` | Force immediate disk write |

### Push Events (main → renderer)

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `queue-updated` | main → confirm-upload | Current file + queue count |
| `migration:progress` | main → migration | Queue stats (total, completed, failed, percent, etc.) |
| `migration:file-update` | main → migration | Single file status change (for in-place row update) |

---

## electron-store Schemas

### Default store (`taxone-settings`)

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

---

## Build & Distribution

- **electron-builder** with NSIS installer for Windows
- Desktop + Start Menu shortcuts, custom installer icon
- `appId: com.taxone.desktop`
- Icon: `assets/icon.ico` (installer), `assets/icon.png` (app window)
- Files included: `src/**/*`, `assets/**/*`, `package.json`
- Output: `dist/`
- Download: `https://taxone.cpa/download/taxone-desktop-setup.exe`
- Auto-update via `electron-updater` planned (not yet implemented)

### Scripts

| Script | Command |
|--------|---------|
| `start` | `electron .` |
| `dev` | `cross-env NODE_ENV=development electron .` |
| `build` | `electron-builder` |
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
