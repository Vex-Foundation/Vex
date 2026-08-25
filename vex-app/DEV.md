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

## Notes

- Mission context and design law live in `/chronos-update.md` (repo root,
  local git-ignored doc).
- Both flags may be combined; they own opposite corners (tour bottom-left,
  preview bottom-right) and never overlap.
