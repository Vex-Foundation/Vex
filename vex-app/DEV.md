# Dev flags — Vex desktop app

## Build prerequisites

- Node + pnpm (versions per root `package.json` engines).
- Go, EXACT pinned version `go1.27.0` (owner decision 2026-08-24): required
  to build the Vex Studio MCP bridge (`bridge/` at the repo root), which
  every packaging job builds BEFORE electron-builder. The build wrapper
  runs with `GOTOOLCHAIN=local` and rejects any other `go version`; do not
  invoke raw `go build` in packaging paths. Local install used on the dev
  machine: official tarball under `~/.local/go` (add `~/.local/go/bin` to
  PATH in build scripts only).
- **On Windows: Git for Windows**, for its Git Bash. `bridge/build.sh` is a
  bash script and Windows has no bash of its own.

### Windows: the build finds Git Bash itself, and never uses WSL's

`where bash` on any Windows machine with WSL enabled answers
`C:\Windows\System32\bash.exe` first. That is the WSL launcher, not a shell:
it hands `bridge/build.sh` to a Linux distribution that cannot resolve the
Windows paths it is given and does not have the pinned Go toolchain this build
just verified. It was the real cause of a bridge build that failed on the
owner's machine (2026-09-04) while Git for Windows sat, unused, at
`C:\Program Files\Git\bin\bash.exe`.

So `vex-app/scripts/build-host-bridges.mjs` does not look `bash` up on PATH.
`resolveBuildShell` (in `vex-app/scripts/bridge-freshness.mjs`) resolves it,
in this order, and refuses a candidate under `System32` or `SysWOW64` at every
step:

1. `VEX_GIT_BASH`, when set. An override that names a missing file, or WSL's
   bash, REFUSES the build; it never falls through to a guess.
2. `git --exec-path` and its parent directories, up to five levels, each
   probed for `bin\bash.exe` and `usr\bin\bash.exe`. The Git that cloned this
   repository names the Git Bash beside it.
3. `%ProgramFiles%\Git` and `%LocalAppData%\Programs\Git`, the system-wide and
   per-user Git for Windows install roots, probed the same way.

When none of them exists, the build stops with a message naming every path it
probed, so the fix is installing Git for Windows or setting `VEX_GIT_BASH` -
not debugging an installer that "writes no files". `pnpm --dir vex-app doctor`
prints the shell it resolved and its source before it says anything about the
bridge. On macOS and Linux, PATH `bash` is correct and is what is used.

### `bridge/` builds TWO binaries, and not for the same targets

The artifact table has one owner, `vex-app/scripts/bridge-artifact.mjs`
(`BRIDGE_ARTIFACTS`); `bridge/build.sh` mirrors it in bash because bash cannot
import it, and a drift test parses both and fails when they disagree. Everything
else in the chain - the build wrapper's caller, the freshness manifest, the
staging preflight, the afterPack re-inspection, doctor - reads the table.

| artifact | Go package | targets | packaged as |
| --- | --- | --- | --- |
| `vex-mcp` | `./cmd/vex-mcp` | all six triples | `resources/bridge/vex-mcp[.exe]` |
| `vex-pipe-front` | `./cmd/vex-pipe-front` | `windows-amd64`, `windows-arm64` | `resources/bridge/vex-pipe-front.exe` |

Consequences a developer will actually meet:

- `bridge/build.sh <goos> <goarch>` CLEARS `bridge/dist/<goos>-<goarch>/`
  before it writes, so an artifact that stops being built for a triple, or one
  left behind by an older checkout, does not linger beside the current outputs.
  Every consumer (freshness, staging, doctor, the dev-mode resolver) addresses
  the artifacts by name from the table; nothing reads that directory whole.
- On Linux and macOS, `pnpm build:bridge:dev` still produces exactly one
  binary. `vex-pipe-front` is Windows-only by design, and
  `locateStudioPipeFront()` answers `unsupported_platform` (not an error) on
  every other platform.
- `bridge/dist/<triple>/build-manifest.json` is format v2: it carries a
  per-artifact digest map (`artifacts: { name -> { sha256, bytes } }`) instead
  of the old single `artifactDigest`. Any manifest written before this change
  reads as STALE and is rewritten by the next build - the manifest version is an
  input to the freshness stamp, so an old record can never read as fresh.

**NAMED OMISSION: the `windows-arm64` pipe front is built, stamped and
verified, but NOT SHIPPED.** `electron-builder.release.yml` sets
`win.target.arch: [x64]` ("x64 only for the first Windows release; arm64
later"), so the release job packages only `windows-amd64` and the arm64 front
never leaves the build machine. It is still built by `bridge/build.sh` with no
arguments, staged by the CI matrix and held to the same gates, so that adding
`arm64` to the release profile later is a one-line change against artifacts
that have been green all along rather than a first attempt on release day. The
internal `electron-builder.yml` profile does package `win arm64`, so the arm64
front IS exercised end to end by `pnpm --dir vex-app make`.

Two build-time Vite flags for design/QA work on the renderer. Both are baked in
at build time (`import.meta.env`), so release builds — made without them — do
not contain the code paths at all. Neither flag touches the main process, IPC,
or any security gate: they only change renderer VIEW routing / swap in local
mock data. Screens still fetch real state; the vault still needs the real
password to actually unlock.

## How to run

Simplest (cross-platform, persistent): uncomment the flag in
`vex-app/.env.local` (gitignored — Vite loads it automatically; both lines
ship commented out, so a plain `pnpm dev` boots the app normally) and run:

```
# vex-app/.env.local — uncomment to enable
VITE_VEX_SETUP_TOUR=1
VITE_VEX_UPDATER_PREVIEW=1
```

```powershell
pnpm vex:dev          # from repo root (any shell)
```

One-off, per shell (the `VAR=1 cmd` prefix is bash-only):

```bash
# bash / zsh / WSL
VITE_VEX_SETUP_TOUR=1 VITE_VEX_UPDATER_PREVIEW=1 pnpm vex:dev
```

```powershell
# Windows PowerShell
$env:VITE_VEX_SETUP_TOUR="1"; $env:VITE_VEX_UPDATER_PREVIEW="1"; pnpm vex:dev
```

```bat
:: Windows cmd.exe
set VITE_VEX_SETUP_TOUR=1 && set VITE_VEX_UPDATER_PREVIEW=1 && pnpm vex:dev
```

Turning a flag off: delete/comment its line in `.env.local` (or
`Remove-Item Env:VITE_VEX_SETUP_TOUR` in PowerShell) and RESTART the dev
process — the flags are read at build time, not live.

## `VITE_VEX_SETUP_TOUR=1` — setup screen tour

What: a small mono navigator docks bottom-left with one key per pre-shell view
(systemCheck · dockerBootstrap · composeBootstrap · migrations · wizard ·
unlock · appShell) plus **Reload boot**, which replays the whole Chronos Gate
cold open (cobalt plate → sigil → curtain).

How it works: the buttons drive `uiStore.setCurrentView` directly (dismissing
the boot gate overlay first, idempotent). `WizardShell` additionally pins
itself to its persisted step instead of auto-routing away, so a machine with a
COMPLETED setup can still view every wizard step — without the flag that
routing is untouched. Code: `src/renderer/features/setup/SetupTour.tsx` + the
`setupTour` guard in `src/renderer/features/wizard/WizardShell.tsx`.

Use it to view every setup screen regardless of what is actually configured
(no vault, no API keys — doesn't matter; each screen renders its real state
for this machine).

## `VITE_VEX_UPDATER_PREVIEW=1` — update toast preview

What: replaces the live update layer with a local previewer. A mono picker
docks bottom-right (left of the toast slot) with every toast state:
`available`, `available·critical`, `downloading`, `downloaded`,
`blocked·download`, `blocked·install`, `error`. Picking one renders the real
`UpdateToast` component in the bottom-right corner with a schema-valid mock
status.

How it works: `UpdateLayer` short-circuits to `UpdaterPreview`, which feeds
`UpdateToast` local `UpdateStatus` mocks — zero IPC, no updater feed needed.
Toast buttons walk realistic transitions locally ("Update now" → downloading,
"Cancel" → available, "Restart & install" → downloaded, "Try again" re-enters
the blocked step). Code: `src/renderer/features/updates/UpdaterPreview.tsx`.

Use it to design/review the updater element without publishing a release.

## Accepted transitive-dependency warnings

Two warnings show up on a clean install / boot and are DELIBERATELY not fixed.
Measured 2026-09-01; this section is their one home, so please update it here
rather than re-deriving the chain in a new doc.

### `[INEFFECTIVE_DYNAMIC_IMPORT] ... approval-runtime.ts` (build:main)

Accepted as cosmetic (coordinator decision 2026-09-01, measured). The warning
is only about chunk co-location: the module's static importers (`reject.ts`,
`resume.ts`, `engine/index.ts`) live entirely inside the lazy island main only
ever reaches by dynamic import, so `pg` is provably NOT in main's startup
graph - the eagerness the warning hints at cannot occur. Every fix path was
closed by measurement: making the five dynamic sites static would pull `pg`
into main's startup graph (forbidden by the test-enforced direct-module
discipline in `run-tool-boundary.test.ts`), leaf-only imports cannot cover the
three orchestrator functions `approval-runtime.ts` itself owns, and relocating
those would restructure the approval decision path for a cosmetic warning.

### `bigint: Failed to load bindings, pure JS will be used (try npm run rebuild?)`

- **Chain** (`pnpm why bigint-buffer`, repo root):
  `bigint-buffer@1.1.5 <- @solana/buffer-layout-utils@0.2.0 <- @solana/spl-token@0.4.14 <- @vex/vex`.
  It is a production dependency of the Solana token path, not a dev tool.
- **Why the warning fires**: the package's `install` script is
  `node-gyp rebuild || echo "Couldn't build bindings..."`. pnpm@10 does not run
  dependency lifecycle scripts unless the package is listed in
  `pnpm.onlyBuiltDependencies`; `bigint-buffer` is not, so no `build/` dir is
  produced and `require('bindings')('bigint_buffer')` throws at load. The
  package then `console.warn`s once and takes its pure-JS branch.
- **Disposition: the JS fallback is KEPT ON PURPOSE, and building the native
  addon would be a REGRESSION.** `pnpm audit --prod` reports
  [GHSA-3gc7-fjrx-p6mg](https://github.com/advisories/GHSA-3gc7-fjrx-p6mg)
  (high, "Buffer Overflow via `toBigIntLE()`") against `bigint-buffer <=1.1.5`
  with **`Patched versions: <0.0.0`** - the package is unmaintained and no fix
  will ever ship. The overflow is in the native N-API C code
  (`src/bigint-buffer.c`); `dist/node.js` only reaches it when `converter` is
  defined. With no bindings built, every entry point takes the
  `Buffer`/`BigInt` JS branch and the vulnerable C code is never loaded.
  Adding `bigint-buffer` to `onlyBuiltDependencies` would compile and activate
  it, and would additionally require an Electron-ABI rebuild per packaged
  target and arch.
- **Perf caveat**: the JS branch round-trips through a hex string
  (`Buffer.reverse()` + `toString('hex')` + `BigInt()`) instead of a direct
  word copy, so each u64 conversion is materially slower than native. This is
  confined to SPL token amount encode/decode - a handful of calls per balance
  read or transfer, not a hot loop - so the cost is not measurable in app
  behavior. Revisit only if a Solana path ever converts amounts in bulk.
- **Removal condition**: drops out when `@solana/spl-token` stops depending on
  `@solana/buffer-layout-utils`, or when that package drops `bigint-buffer`.
  Do not attempt a standalone upgrade: there is no patched version to upgrade
  to.

### `punycode` deprecation noise

- **Chain** (`pnpm --dir vex-app why punycode`): `punycode@2.3.1`, reached only
  through **devDependencies** - `tr46 <- whatwg-url <- data-urls <- jsdom`
  (and `vitest`), plus `uri-js <- ajv@6 <- @develar/schema-utils <-
  app-builder-lib <- electron-builder`.
- **Disposition: documentation only.** Both roots are test/build tooling, so
  nothing here reaches the packaged runtime. The chain is entirely inside
  `jsdom`/`vitest` and `electron-builder`; there is no one-line fix we own,
  and forcing a resolution would override the tooling's own pins for zero
  runtime benefit.
- **Removal condition**: clears itself when `electron-builder` moves off
  `ajv@6` and jsdom's `tr46` drops the userland `punycode` shim. No tracking
  action needed on our side.

## Notes

- Mission context and design law live in `/chronos-update.md` (repo root,
  local git-ignored doc).
- Both flags may be combined; they own opposite corners (tour bottom-left,
  preview bottom-right) and never overlap.
