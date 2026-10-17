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
| `win32-x64` | Windows x64: Git Bash in an MSVC x64 developer environment (Postgres: cl; llama: clang) | Windows 10 1903+ / 11 |
| `win32-arm64` | Postgres: the `win32-x64` tree. llama: cross-built on Windows x64 with clang for `arm64-pc-windows-msvc` | Windows 11 arm64 (`ggml-cpu` at `armv8.2-a+dotprod`: Snapdragon 850 / 7c / 8cx and later) |

PostgreSQL 18 cannot be built with MSVC for ARM64 (upstream support arrives in
PG 19), so the `win32-arm64` runtime is the x64 Postgres tree, run under
Windows' x64 emulation, plus a native arm64 `llama-server`.

## Build

```sh
native-runtime/postgres/build.sh darwin-arm64
native-runtime/llama/build.sh darwin-arm64
native-runtime/linux/build-in-container.sh postgres   # linux-x64
native-runtime/linux/build-in-container.sh llama      # linux-x64

# Windows, from Git Bash inside an MSVC developer environment (vcvarsall x64;
# amd64_arm64 for the arm64 llama), with Strawberry Perl, Python and clang on
# PATH (all on GitHub's windows-2025 image; flex/bison and zlib are pinned):
native-runtime/postgres/build.sh win32-x64
native-runtime/llama/build.sh win32-x64
native-runtime/llama/build.sh win32-arm64
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
- **Windows** trees keep that layout with `.exe`/`.dll` names. Postgres has
  `libpq.dll` in `bin/` (a DLL is found in the directory of the process's
  executable) and its modules in `lib/postgresql/`; llama is flat
  (`llama-server.exe`, `llama.dll`, `ggml*.dll`, `ggml-cpu-*.dll`, ...).
  - Everything links the dynamic CRT (`/MD`, so Postgres and its modules share
    one) and the trees carry the MSVC runtime app-locally (`vcruntime140*.dll`,
    and `msvcp140.dll` for llama), copied from the redistributable of the
    Visual Studio that built them: a clean Windows has no VC++ redistributable.
    The UCRT (`api-ms-win-crt-*`) is part of Windows 10+.
  - zlib is the pinned source, linked statically (pg_dump/pg_restore/server).
  - Every `.exe` embeds `lib/utf8.manifest` (process code page UTF-8, Windows
    10 1903+). Without it both programs see paths in the legacy ANSI code page:
    initdb fails on a non-ASCII install path (it `COPY`s
    `share/postgresql/sql_features.txt` by path inside UTF-8 SQL), Postgres
    reports a non-ASCII `data_directory` as U+FFFD, and `llama-server` cannot
    open a non-ASCII model path (ggml decodes its argv as UTF-8). A per-user
    install lives under the user's profile, so this is the common case for
    any user name outside ASCII.

## Gates

Every build ends with `lib/verify-tree.sh <tree> <target>`. It checks that:
- every binary has the target's arch,
- the macOS `minos` is <= 13.0 and Linux needs no glibc symbol above 2.35,
- rpaths and install names are relative,
- nothing links outside the OS baseline.

Windows trees are checked by `lib/pe.mjs` (Node only): every PE has the
target's machine type (x64 for both Postgres trees), every DLL it imports is a
Windows system DLL, an `api-ms-win-*` API set or a file in the tree (so a
missing MSVC runtime is caught), and nothing we built carries a PDB path. The
build scripts also refuse a tree containing the checkout's path in any of its
Windows spellings (MSVC's `__FILE__` is trimmed with `/d1trimfile`, clang's
with `-ffile-prefix-map`).

Then:

```sh
# Postgres: relocation, initdb, SCRAM, pgvector HNSW, dump/restore, stop, crash recovery
node native-runtime/postgres/smoke.mjs native-runtime/out/<target>/postgres

# llama-server: --port 0, API key, 768-dim alias contract, budget, footprint, SIGTERM
node native-runtime/llama/smoke.mjs <target> native-runtime/out/<target>/llama \
  native-runtime/.work/models/embeddinggemma-300M-Q8_0.gguf

# On Windows the same two smokes run on the host. The trees, the data dir and
# the model sit under a path with spaces and non-ASCII characters both inside
# and outside the ANSI code page ("vex ünïcode δοκιμή test"); Postgres is
# driven through pg_ctl, including the check that an elevated postgres.exe
# refuses to start; llama-server is stopped with TerminateProcess.

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
- **Windows, Postgres:**
  - `postgres.exe` refuses to run with administrative rights ("Execution of
    PostgreSQL by a user with administrative permissions is not permitted"),
    and an elevated Vex is a real case (CI runners are elevated). Start with
    `pg_ctl start -w -t 60 -D <data> -l <file> -o "-p <port>"`, stop with
    `pg_ctl stop -D <data> -m fast -w` (`-m immediate` as the fallback);
    pg_ctl and initdb drop the rights through a restricted token. Only the port
    goes in `-o`; settings stay in `postgresql.conf`. `postgres -C <name> -D
    <data>` works elevated only with `-C` first.
  - The postmaster is not Vex's child: watch the PID on line 1 of
    `postmaster.pid`.
  - `pg_ctl start -w` returning 0 does not prove the server is up: on Windows
    it accepts any "ready" `postmaster.pid` started within 2 s of itself
    (`pg_ctl.c` cannot know the postmaster's PID), so after a crash a stale
    file passes before the new postmaster replaces it. Ready means line 8 is
    `ready` AND line 1 names a live process.
  - pg_ctl creates the server with handle inheritance on
    (`CreateProcessAsUser(..., TRUE, ...)`), so the server holds whatever
    stdout/stderr pg_ctl had: give pg_ctl a file, not a pipe that the caller
    waits to see closed (the smoke does).
  - Bind errors (port taken) appear in `log/` only, as on the other platforms.
- **Windows, llama-server:** the smoke's minimal environment is `SystemRoot`,
  `LLAMA_API_KEY` and `LLAMA_CACHE`; its output lines end in CRLF. cpp-httplib
  closes idle keep-alive connections after 5 s, so a client must retry a
  request that hits a socket closed while idle.
- **Windows, Node:** `fs.cpSync` (Node 22) copies nothing, without an error,
  into a destination whose path has non-ASCII characters; staging code must
  copy file by file.
