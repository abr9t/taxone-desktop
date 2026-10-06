# Quework Desktop Companion

Watch folder file uploader for Quework. Monitors a local folder and uploads files to Quework with client matching.

## Setup

```bash
npm ci             # install exactly the locked dependencies; the tests need them
npm test           # all suites (electron-updater and js-yaml come from node_modules)
npm start          # run in dev mode
npm run build:win  # build Windows installer (local only: --publish never)
```

Releases are built by CI from a `v*` tag into a draft GitHub release, and
installed apps update themselves from published releases — see
ARCHITECTURE.md, "Releases and auto-update", and UPGRADE-TEST.md section 6
before tagging.

## How It Works

1. **Login** — paste your server URL and API token (generated in Firm Settings → Integrations → Desktop App)
2. **Configure watch folder** — default is `~/QueworkWatch/`
3. **Drop files in** — the app auto-detects new files and prompts you to confirm the upload

### Folder Structure Convention

```
QueworkWatch/
├── SMITH, JOHN/          ← matched to client by name
│   ├── 2024/             ← creates "2024" folder in Quework
│   │   └── 1040.pdf      ← uploaded file
│   └── W2.pdf            ← uploaded to client root
└── receipt.pdf           ← you pick the client manually
```

## Architecture

- **Electron** — system tray app, stays running in background
- **chokidar** — watches folder for new files (ignores temp files, partial downloads)
- **axios** — uploads to Quework API via Sanctum token auth
- **keytar** — stores API token in OS keychain (falls back to electron-store)
- **electron-updater** — background updates from GitHub Releases; installs on quit or from the tray

## Laravel API Endpoints

Two endpoints behind `auth:sanctum` + `ability:desktop`:

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/desktop/clients` | Search clients for picker |
| POST | `/desktop/upload` | Upload file with folder path |

## Phase 2 (future): TWAIN Scanning
## Phase 3 (future): Virtual Printer
