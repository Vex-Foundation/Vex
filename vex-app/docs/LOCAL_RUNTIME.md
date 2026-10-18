# Local runtime

Reference for contributors and QA running vex-app on their own machine.
Production release flow (signing, notarization, auto-updater) is intentionally
out of scope — see the release hardening track when it lands.

## Supported platforms

| OS | Versions | Notes |
|---|---|---|
| Windows | 10 + 11, x64 | Primary target |
| macOS | 13+ on Apple Silicon and Intel | Primary target |
| Linux (Ubuntu / Debian-based) | 22.04 + 24.04 | Primary target |
| WSL2 on Windows | — | **Dev environment only.** See WSL2 gotcha below. |

Other Linux distros may work but are not part of the QA matrix.

## Per-OS config paths

vex-app stores all user state in one directory rooted at the platform's
standard user-config location.

| OS | `CONFIG_DIR` |
|---|---|
| Linux | `$XDG_CONFIG_HOME/vex` (default `~/.config/vex`) |
| macOS | `~/Library/Application Support/vex` |
| Windows | `%APPDATA%/vex` (default `C:\Users\<user>\AppData\Roaming\vex`) |

Within `CONFIG_DIR`:

```
CONFIG_DIR/
  .env                              shared tracked env keys
  secrets.vault.json                encrypted API/provider credentials (scrypt + AES-256-GCM)
  .install-id                       per-install uuid (named the previous release's Docker project)
  .setup-complete                   wizard completion flag
  keystore.json                     EVM keystore (encrypted)
  solana-keystore.json              Solana keystore (encrypted)
  config.json                       wallet addresses + chain config (plaintext, no secrets)
  compose/                          only on installs that ran a Docker-based release
                                    (its rendered stack, read once by the data move)
  local-infra/secrets/pg_password   Postgres password (generated per install)
  runtime/                          bundled runtime: pg18/ cluster, models/, runtime-state.json
                                    (Windows: %LOCALAPPDATA%\vex\runtime instead)
  .electron-state/                  Electron-only (window state, session cache, log files)
```

Files OUTSIDE `.electron-state/` are shared runtime state for the desktop app.
Files INSIDE `.electron-state/` are Electron-private (Chromium cache, electron-log).

## WSL2 gotcha — Windows host

If you start vex-app from a WSL2 shell on a Windows host, the app launches as
a **Windows-native Electron process** (because the `electron` binary on
`$PATH` is the Windows binary in your project's `node_modules`).

That means:
- The app sees `process.platform === "win32"`, not `"linux"`.
- It reads + writes its config at `C:\Users\<user>\AppData\Roaming\vex\`
  (i.e. `%APPDATA%/vex`), **not** `~/.config/vex` inside WSL2.
- From WSL2 you can reach that directory at `/mnt/c/Users/<user>/AppData/Roaming/vex/`.

For a coherent dev environment, override the config root with
`VEX_CONFIG_DIR=<absolute path>` when launching the desktop app; it must be a
non-empty absolute path.

## Clean-slate reset

> **⚠️ Destructive.** `CONFIG_DIR` holds your signing keys — `keystore.json`
> (EVM) and `solana-keystore.json` (Solana) — plus the `backups/` directory
> (`src/config/paths.ts:43-51`). Deleting `CONFIG_DIR` deletes all of them
> with no recovery path. **Before step 3**, export/copy your keystores and
> backups outside `CONFIG_DIR` — see step 3 below for the exact command.

If a setup gets stuck mid-flow (e.g. corrupt vault, half-applied wizard,
a local database that will not start), reset. To empty only the database
(sessions, messages, memory, history; wallets, vault, settings and the model
are kept), use Settings -> Local runtime -> Reset local data instead; the
steps below remove the whole install:

### 1. Stop the running app

Close the desktop app. On Windows, verify no `vex.exe` lingers in Task Manager.
Quitting also stops the bundled runtime; verify no `postgres` or
`llama-server` process from the app is left (Task Manager on Windows,
`pgrep -fl 'postgres|llama-server'` on macOS / Linux).

### 2. Tear down the Docker stack (installs that ran a Docker release)

Skip this step if the install never ran a Docker-based release of Vex.

Run `docker compose down` from the per-install compose directory so the
generated `docker-compose.yml` is auto-discovered. Pass `--volumes` to drop
the per-install Postgres data volume and embeddings cache:

```bash
# Replace <uuid> with the value of .install-id inside your CONFIG_DIR.
cd "$CONFIG_DIR/compose"
docker compose -p vex-<uuid> down --remove-orphans --volumes
```

If `$CONFIG_DIR/compose` is already gone (e.g. you deleted the config
directory before stopping the stack), fall back to the label-based path
which does NOT need a compose file:

```bash
# Stops running containers without deleting volumes.
docker ps --filter label=com.docker.compose.project=vex-<uuid> --format '{{.ID}}' \
  | xargs -r docker stop
# Drop volumes manually if needed:
docker volume ls --filter label=com.docker.compose.project=vex-<uuid> --format '{{.Name}}' \
  | xargs -r docker volume rm
```

If you don't know the install-id, list all Vex-labelled projects:

```bash
docker ps -a --filter label=com.docker.compose.project --format '{{.Names}}\t{{.Labels}}' | grep vex-
```

### 3. Delete the config directory

> **⚠️ Destructive — irreversible key loss.** This step permanently deletes
> `keystore.json`, `solana-keystore.json`, and the `backups/` directory along
> with the rest of `CONFIG_DIR`. There is no undo. Complete step 3a below
> before running the delete command in step 3b.

#### 3a. Export keystores and backups first

Copy the entire config directory (or make an encrypted archive of it) to a
location outside `CONFIG_DIR` — e.g. an external drive or password manager
attachment — so `keystore.json`, `solana-keystore.json`, and `backups/` all
survive the reset:

```bash
# macOS / Linux — replace <dest> with a path outside CONFIG_DIR.
cp -r "$CONFIG_DIR" <dest>/vex-config-backup-$(date +%Y%m%d)
```

```powershell
# Windows (PowerShell) — replace <dest> with a path outside CONFIG_DIR.
Copy-Item -Recurse -Force "$env:APPDATA\vex" "<dest>\vex-config-backup"
```

Note: the keystores and `secrets.vault.json` are encrypted at rest — copying
them does not remove the need for your master password. Keep the password
itself somewhere separate from the copied files; an unusable password makes
the backup unusable too.

**Verify the copy before continuing to 3b.** Confirm the destination exists
and contains `keystore.json`, `solana-keystore.json`, and `backups/` — a
partial or failed copy here means step 3b's delete is unrecoverable:

```bash
# macOS / Linux
ls "<dest>/vex-config-backup-<date>/keystore.json" \
   "<dest>/vex-config-backup-<date>/solana-keystore.json" \
   "<dest>/vex-config-backup-<date>/backups"
```

```powershell
# Windows (PowerShell)
Test-Path "<dest>\vex-config-backup\keystore.json"
Test-Path "<dest>\vex-config-backup\solana-keystore.json"
Test-Path "<dest>\vex-config-backup\backups"
```

Do not proceed to 3b until all checks above succeed.

#### 3b. Delete the directory

| OS | Command |
|---|---|
| Linux | `rm -rf ~/.config/vex` |
| macOS | `rm -rf "$HOME/Library/Application Support/vex"` |
| Windows (PowerShell) | `Remove-Item -Recurse -Force "$env:APPDATA\vex"` |
| WSL2 reaching Windows AppData | `rm -rf /mnt/c/Users/<user>/AppData/Roaming/vex` |

The bundled runtime's directory (database cluster, embeddings model,
`runtime-state.json`) is `CONFIG_DIR/runtime` on macOS and Linux, so the
commands above remove it. **On Windows it is machine-local and must be removed
separately**, or the next launch reuses the old database:

```powershell
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\vex\runtime"
```

### 4. Verify Docker volumes are gone (installs that ran a Docker release)

Per-install volumes are named after the project label and disappear with
`docker compose down --volumes`. If you didn't pass `--volumes` above (the
default in step 2 is also without it — volumes are preserved by design),
manually:

```bash
docker volume ls --filter label=com.docker.compose.project=vex-<uuid>
docker volume rm <each-listed-volume>
```

### 5. Restart the app

A fresh `CONFIG_DIR` is created on next launch and the wizard flow restarts
from System Check.

## Embeddings for the integration suite

`pnpm test:integration` and the eval lanes (`pnpm test:eval*`) need a live
embeddings endpoint in `EMBEDDING_BASE_URL`; no CI lane runs them, and the
required Studio lane (`pnpm test:studio-postgres`) needs none. The app's own
embeddings server picks its port and an API key on every launch, so it cannot
be borrowed: start the bundled `llama-server` yourself, with the flags the app
uses (`src/main/runtime/native/llama-supervisor.ts`) on a fixed port and
without a key.

```bash
# From the repository root. The tree comes from `pnpm dev:assets` (or
# `node scripts/fetch-native-runtime.mjs --current` in vex-app/); the model,
# sha256-verified, from native-runtime/llama/fetch-model.sh.
bash native-runtime/llama/fetch-model.sh
MODEL="$PWD/native-runtime/.work/models/embeddinggemma-300M-Q8_0.gguf"
mkdir -p /tmp/vex-llama-cache
# cwd = the binary's directory: ggml loads its CPU backends from there.
cd vex-app/resources/native-runtime/<platform>-<arch>/llama
LLAMA_CACHE=/tmp/vex-llama-cache ./llama-server --model "$MODEL" --embeddings \
  --alias ai/embeddinggemma:300M-Q8_0 --host 127.0.0.1 --port 27999 \
  --device none -ngl 0 -np 1 -c 2048 -b 2048 -ub 2048 --no-webui --offline
```

Then, in another shell at the repository root:

```bash
export EMBEDDING_BASE_URL=http://127.0.0.1:27999/v1
export EMBEDDING_MODEL=ai/embeddinggemma:300M-Q8_0 EMBEDDING_DIM=768 EMBEDDING_PROVIDER=local
make e2e-smoke            # expects "OK: dim=768"
VEX_TEST_PG=native pnpm test:integration   # Postgres on the bundled binaries too
```

Any other OpenAI-compatible `/v1` endpoint serving that model works as well;
set `EMBEDDING_API_KEY` when it wants a bearer key. Without
`EMBEDDING_BASE_URL` the suite stops at setup and says how to start one.

## Diagnostic commands

Bundled runtime (`RUNTIME_DIR` is `CONFIG_DIR/runtime`, or
`%LOCALAPPDATA%\vex\runtime` on Windows):

```bash
# Is the cluster up? Line 8 of postmaster.pid reads "ready" once it accepts connections.
cat "$RUNTIME_DIR/pg18/postmaster.pid"

# Postgres's own log (the logging collector writes here, not to the app log)
ls -t "$RUNTIME_DIR/pg18/log" | head -1

# Recorded cluster identity, last port, migration state and provider
cat "$RUNTIME_DIR/runtime-state.json"

# View electron-log output
#   Linux:        ~/.config/vex/.electron-state/logs/main.log
#   macOS:        ~/Library/Application Support/vex/.electron-state/logs/main.log
#   Windows:      %APPDATA%\vex\.electron-state\logs\main.log
```

The previous release's Docker stack (installs that ran a Docker release,
until their data has been moved and the old data removed):

```bash
# Is the Vex compose project running?
docker ps --filter label=com.docker.compose.project=vex-<uuid>

# Tail Postgres logs from the stack
docker compose -p vex-<uuid> logs -f postgres

# Tail embeddings-runtime logs
docker compose -p vex-<uuid> logs -f embeddings-runtime

# Probe Postgres TCP locally (replace <pg-port> with the value from compose)
nc -zv 127.0.0.1 <pg-port>
```
