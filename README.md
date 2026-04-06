# TaxOne Desktop Companion

Watch folder file uploader for TaxOne. Monitors a local folder and uploads files to TaxOne with client matching.

## Setup

```bash
npm install
npm start          # run in dev mode
npm run build:win  # build Windows installer
```

## How It Works

1. **Login** — paste your server URL and API token (generated in Firm Settings → Integrations → Desktop App)
2. **Configure watch folder** — default is `~/TaxoneWatch/`
3. **Drop files in** — the app auto-detects new files and prompts you to confirm the upload

### Folder Structure Convention

```
TaxoneWatch/
├── SMITH, JOHN/          ← matched to client by name
│   ├── 2024/             ← creates "2024" folder in TaxOne
│   │   └── 1040.pdf      ← uploaded file
│   └── W2.pdf            ← uploaded to client root
└── receipt.pdf           ← you pick the client manually
```

## Architecture

- **Electron** — system tray app, stays running in background
- **chokidar** — watches folder for new files (ignores temp files, partial downloads)
- **axios** — uploads to TaxOne API via Sanctum token auth
- **keytar** — stores API token in OS keychain (falls back to electron-store)

## Laravel API Endpoints

Two endpoints behind `auth:sanctum` + `ability:desktop`:

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/desktop/clients` | Search clients for picker |
| POST | `/desktop/upload` | Upload file with folder path |

## Phase 2 (future): TWAIN Scanning
## Phase 3 (future): Virtual Printer
