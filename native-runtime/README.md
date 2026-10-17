# native-runtime

Build recipes and gates for the two helper programs Vex is moving out of
Docker and into the app bundle:

- **Postgres 18.6 + pgvector 0.8.7**, the data store.
- **llama.cpp `llama-server` b9115**, the embeddings engine (EmbeddingGemma
  300M), built from the same tag as today's `server-b9115` image so stored
  vectors stay valid.

Everything is built from pinned sources (`sources.env`: tarball sha256, git tag
+ commit, build-tool versions, platform floors) into relocatable trees that
`lib/verify-tree.sh` must accept. Nothing here is wired into the app yet; the
trees are what the packaging step will stage into `Resources/postgres` and
`Resources/llama`.

## Targets

| Target | Built on | Floor |
|---|---|---|
| `darwin-arm64` | macOS arm64 | macOS 13.0 |
| `darwin-x64` | macOS arm64 (cross: Postgres via a meson cross file, llama via `CMAKE_OSX_ARCHITECTURES`) | macOS 13.0 |
| `linux-x64` | `linux/build-in-container.sh` in the pinned `manylinux_2_28` image | glibc <= 2.35 (built against 2.28) |

Windows (x64, arm64) is not built here yet.

## Build

```sh
native-runtime/postgres/build.sh darwin-arm64
native-runtime/llama/build.sh darwin-arm64
native-runtime/linux/build-in-container.sh postgres   # linux-x64
native-runtime/linux/build-in-container.sh llama      # linux-x64
```

Output: `native-runtime/out/<target>/{postgres,llama}/`. Source checkouts, tool
venvs and build trees live in `native-runtime/.work/`. Both are gitignored.

- **Postgres** (`bin/ lib/ share/`) finds `lib/postgresql` and
  `share/postgresql` relative to `bin/`, so keep the layout. Its compiled-in
  prefix (`/vex-unrelocated`) never exists.
- **llama** is flat. `llama-server` loads `libggml-cpu*.so` from its own
  directory, falling back to the current directory, so spawn it with `cwd` set
  to that directory. x64 trees carry all CPU variants and the best one is
  picked at runtime.

## Gates

Every build ends with `lib/verify-tree.sh <tree> <target>`. It checks that:
- every binary has the target's arch,
- the macOS `minos` is <= 13.0 and Linux needs no glibc symbol above 2.35,
- rpaths and install names are relative,
- nothing links outside the OS baseline.

Then:

```sh
# Postgres: relocation, initdb, SCRAM, pgvector HNSW, dump/restore, stop, crash recovery
node native-runtime/postgres/smoke.mjs native-runtime/out/<target>/postgres

# llama-server: --port 0, API key, 768-dim alias contract, budget, footprint, SIGTERM
node native-runtime/llama/smoke.mjs <target> native-runtime/out/<target>/llama \
  native-runtime/.work/models/embeddinggemma-300M-Q8_0.gguf

# Embedding parity vs the pinned server-b9115 image (min cosine >= 0.999,
# mean top-10 retrieval overlap >= 0.95 over 841 production-shaped inputs)
native-runtime/parity/run.sh <target>

# The app's Postgres suites on the bundled binaries instead of a container
VEX_TEST_PG=native pnpm test:studio-postgres

# Commit latency, checkpoint and fast-stop cost per wal_sync_method
node native-runtime/postgres/bench-durability.mjs native-runtime/out/<target>/postgres
```

The model for the llama gates must be the pinned GGUF
(`vex-app/src/main/onboarding/embedding-defaults.ts`: name, size, sha256) at
`native-runtime/.work/models/`.

On Linux the smoke and parity runs execute the server inside `ubuntu:22.04`
(`linux/amd64`), the oldest supported distro. On Apple Silicon that means
emulation, so the Linux timings say nothing about native speed.

## Runtime requirements the gates found

These must be honoured by whatever spawns the binaries:

- **`llama-server`:**
  - Pass `LLAMA_CACHE`: on macOS, b9115 segfaults at startup when neither it
    nor `HOME` is set.
  - Spawn with a minimal environment: it reads every `LLAMA_ARG_*` variable,
    and `AIP_*` can move its port.
  - With `--port 0`, the bound port is logged only after the model has
    loaded, as `main: server is listening on http://127.0.0.1:<port>`. That
    line doubles as the ready signal.
- **Postgres:**
  - With `logging_collector = on`, stderr carries only the redirect notice;
    the ready line and bind errors (such as a taken port) go to `log/`.
  - Detect readiness from `postmaster.pid` (line 8 is `ready`, line 1 is the
    spawned PID), not from stderr.
- **SIGKILL:** never SIGKILL the postmaster except as a last resort. On macOS
  that leaks its SysV semaphores and segment until the same data directory is
  started again.
