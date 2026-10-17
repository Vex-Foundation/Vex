# QA matrix

Manual verification grid for release-candidate sign-off. Vex runs its own
local runtime: a bundled Postgres 18 + pgvector and a bundled `llama-server`
for embeddings, started and supervised by the app. **Run every cell on a
machine with Docker uninstalled** (or at least not running), except the
"Upgrade from a Docker release" rows, which need the previous release's data.

Until the release that makes it the only runtime, select it with
`VEX_RUNTIME=native` in the app's environment.

Run each cell on a clean install (see [`LOCAL_RUNTIME.md`](./LOCAL_RUNTIME.md)
→ "Clean-slate reset") unless the row says otherwise.

Cells are scored:
- ✅ pass — feature behaves as specified, no console errors, no log warnings
  beyond the documented noise floor
- ⚠️ pass-with-notes — works, but flag observed friction
- ❌ fail — bug or regression; do not ship

The automated gates cover the happy path of the first block on every
platform before a release (the clean-machine gate: Docker removed, packaged
app, first run, quit, relaunch). The manual matrix exists for what they do
not: failure paths, the upgrade, Settings, and real hardware.

## Platforms

| ID | Platform | Notes |
|---|---|---|
| W11 | Windows 11 x64 | Primary release target |
| WA | Windows 11 arm64 | Primary; Postgres runs as x64 under emulation (llama.cpp is native arm64) |
| MAS | macOS 13+ Apple Silicon | Primary release target; macOS 13 is the floor |
| MIN | macOS 13+ Intel | Primary release target |
| U22 | Ubuntu 22.04 x64 | Primary release target; the glibc floor |
| U24 | Ubuntu 24.04 x64 | Primary release target |

## Feature matrix

| Feature | W11 | WA | MAS | MIN | U22 | U24 |
|---|---|---|---|---|---|---|
| **First run** | | | | | | |
| App boot → splash → System Check visible, with no Docker installed | | | | | | |
| System Check rows: Local runtime OK, Disk space, Memory, network, OS; no Docker row | | | | | | |
| System Check blocks Continue when free disk cannot fit the model + database; warns under 2 GiB | | | | | | |
| "Preparing local runtime": database ready, model downloads (bytes, speed, %), verifies, embeddings ready | | | | | | |
| Quit during the model download, relaunch: the download resumes, not restarts | | | | | | |
| Offline first run: model row fails with the offline copy; Try again succeeds once back online | | | | | | |
| Migrations: the full chain applied, progress streamed | | | | | | |
| **Wizard** | | | | | | |
| Wizard step `keystore` — master password + keystore set, `secrets.vault.json` created | | | | | | |
| Wizard step `wallets` — EVM + Solana wallets generated, addresses in `config.json` | | | | | | |
| Wizard step `apiKeys` — Jupiter / Tavily / Rettiwt entries persisted to vault | | | | | | |
| Wizard step `embedding` — bundled embeddings shown reachable (live port, not 27134) | | | | | | |
| Wizard step `agentCore` — agent-core tuning written to `.env` | | | | | | |
| Wizard step `provider` — OpenRouter API key set + AGENT_MODEL chosen | | | | | | |
| Wizard step `review` — finalize + telemetry consent toggle + setup-complete marker written | | | | | | |
| **Every launch** | | | | | | |
| Relaunch after setup: same database (no re-initialisation), no model download, straight to unlock | | | | | | |
| Unlock screen — correct password unlocks | | | | | | |
| Unlock screen — wrong password throttles after 5 attempts, retryAfterMs honoured | | | | | | |
| Session memory: a long session is summarised and embedded (no HTTP 500 in `main.log`) | | | | | | |
| Wallet private-key export (from app shell) — clipboard cleared after lease | | | | | | |
| Quit (menu, and closing the last window on Windows/Linux): app exits, no `postgres` or `llama-server` process left, `runtime/pg18/postmaster.pid` gone | | | | | | |
| App quit relocks vault, in-flight handlers torn down via globalCleanup | | | | | | |
| Kill the app (Task Manager / `kill -9`), relaunch: the orphaned servers are reaped and the runtime starts | | | | | | |
| Auto-update installs: the runtime is stopped before the installer runs, and the updated app starts it | | | | | | |
| **Settings → Local runtime** | | | | | | |
| Panel shows status, release, Postgres / pgvector / llama.cpp versions, database and model size | | | | | | |
| Restart runtime: progress returns to ready; a session written before is still readable after | | | | | | |
| Reset local data (type RESET): app relaunches into setup; wallets, vault, config and model kept | | | | | | |
| **Upgrade from a Docker release** (install the previous release, use it, then install this one) | | | | | | |
| Migration screen offered on first launch; Move my data: progress, then the runtime screen, then the app with every session and memory | | | | | | |
| Relaunch after the move: migration not offered again | | | | | | |
| Docker stopped when the new version first launches: the screen asks for Docker once; Try again works after starting it | | | | | | |
| Quit mid-move, relaunch: the move resumes and completes | | | | | | |
| Start fresh (type the phrase): an empty database; the old Docker data is kept | | | | | | |
| Settings → Remove old Docker data: removes only this install's volumes; row disappears | | | | | | |

Wizard step IDs match `vex-app/src/shared/schemas/wizard.ts` (canonical
order after the M12 mode/wake removal: `keystore → wallets → apiKeys →
embedding → agentCore → provider → review`). The `keystore` step
historically owned just the keystore but now also creates the master
password + vault — the ID stayed for backwards compat. Telemetry
consent is a checkbox inside the `review` step; there is no separate
Settings UI as of this writing.

## Where to look

| What | Where |
|---|---|
| App log | `CONFIG_DIR/.electron-state/logs/main.log` (Settings → Local runtime → Open logs) |
| Runtime directory | `CONFIG_DIR/runtime/`; on Windows `%LOCALAPPDATA%\vex\runtime\` |
| Database cluster | `runtime/pg18/`; Postgres's own log in `runtime/pg18/log/` |
| Embeddings model | `runtime/models/embeddinggemma-300M-Q8_0.gguf` (333.6 MB) |
| Runtime and migration state | `runtime/runtime-state.json` |

To exercise the disk and memory rows without filling a disk, a development
build accepts `VEX_DEV_SYSTEM_CHECK` (JSON byte counts; ignored by packaged
builds).

## Per-OS known gotchas

### Windows 11 (x64 and arm64)
- `%APPDATA%` path uses backslashes; copy/paste from this doc may need
  escaping in a shell.
- The runtime lives under `%LOCALAPPDATA%` (machine-local), not `%APPDATA%`
  (roaming), so a roaming profile does not carry the database.
- arm64: the database starts a little slower than on x64 because Postgres
  runs under x64 emulation; the embeddings server is native.
- Upgrade rows only: Docker Desktop must be installed and runnable once to
  move the old data.

### macOS (Apple Silicon + Intel)
- Release builds are signed and notarized. A locally built, unsigned app
  needs `xattr -d com.apple.quarantine` before Gatekeeper will open it.
- Keychain integration is NOT used; secrets live in the vault file.

### Ubuntu 22.04 + 24.04
- `electron.shell.openExternal` calls into `xdg-open` from `xdg-utils`.
  A standard Ubuntu desktop install ships this; **minimal / headless
  containers may not**, in which case `sudo apt-get install -y xdg-utils`.
- The embeddings model (333.6 MB) is downloaded from Hugging Face on the
  first run; on slow networks this is the longest step of setup.

## Reporting

Open one GitHub issue per failing cell with:
- Cell coordinates (feature + platform)
- App version + commit SHA (visible in the dev diagnostics panel,
  or from `dist/main/index.js` build metadata)
- Repro steps starting from a clean install
- Relevant log slices: `main.log` and, for database problems, the newest file
  in `runtime/pg18/log/` (redact any secrets / wallet addresses before
  pasting)
