# Electron dependency audit, 2026-09-09

Context: on 2026-09-09 a new js-yaml advisory (GHSA-2883-xcg3-v3hh) turned the
production dependency audit red on every open branch through the
`electron-updater > js-yaml` path. PR #180 moved the existing
`electron-updater>js-yaml` override pin from 4.3.1 to 4.3.2 and cleared it.
The owner then asked for a review of every Electron-related dependency in
`vex-app/package.json`: what upstream changed, and whether to bump.

Three research passes read the upstream release records (GitHub releases,
package changelogs, the Electron breaking-changes document, the advisory
database, npm dist-tags) against our own call sites and build configuration.
Repository facts were re-verified on a main-based worktree; every file:line
below refers to `vex-app/`.

Decision (owner, 2026-09-09): before the next release only the bumps that are
easy and cannot interfere with release testing land. Everything else is
recorded here with the dates that make it urgent.

## Summary

| Package | Pinned | Available | Decision | Reason |
| --- | --- | --- | --- | --- |
| `electron` | `42.0.0` | 42.11.3 (42 line), 43.6.0, 44.3.0 | after the release: 42.11.3 | 17 CVE backports, zero breaking changes, no native rebuild; deferred only to keep the binary under manual test stable |
| `electron-builder` | `~26.8.1` | 26.16.1 (`v26` tag; npm `latest` is 26.15.3) | after the release: 26.16.1 with a three-platform dry run | fixes the AppImage CVE-2026-54672 we currently ship; changes the release pipeline |
| `electron-updater` | `~6.8.9` | 6.8.9 | current | the shipped `builder-util-runtime` is already 9.7.0 |
| `@sentry/electron` | `~7.16.0` | 7.18.0 | now | no effect on our configuration, verified below |
| `electron-log` | `~5.4.3` | 5.4.4 | now | exports map only |
| `@electron/fuses` | `~2.1.1` | 2.1.3 | now (lockfile refresh inside the range) | no option change |
| `node-pty` | `1.2.0-beta.15` | same (`beta` tag) | current | the exact version VS Code pins |

Reference: the VS Code checkout in `agents-colab/vscode` (2026-08-18) pins
`electron` 42.8.1 and `node-pty` `^1.2.0-beta.15`. A production desktop
product under real load has not moved to Electron 43 or 44.

## Electron

Support policy: the latest three stable majors are supported, eight-week
cadence. Electron 42 loses support when 45 ships on 2026-10-20.

| Target | Chromium / Node | Released / end of support | Breaking changes that touch us | Native rebuild |
| --- | --- | --- | --- | --- |
| 42.11.3 | 148 / 24.19.0 | 2026-09-08 / 2026-10-20 | none | no |
| 43.6.0 | 150 / 24.17.0 | 2026-06-30 / 2027-01-05 | one behaviour change (dialog default directory) | no |
| 44.3.0 | 152 / 24.18.1 | 2026-08-25 / 2027-03-02 | clipboard API became asynchronous | no, needs the packaged probe |

### 42.0.0 to 42.11.3, the patch line

Security: 42.4.1 carries CVE-2026-9115 and CVE-2026-9116; 42.11.1 carries
CVE-2026-15764 through CVE-2026-15778 (15 CVEs). Node moved from 24.15.0 to
24.19.0, which is newer than the Node base of 43 or 44.

Fixes that land on code we run:

- ASAR integrity with an updater: a browser-process crash in
  `ValidateIntegrityOrDie` and a spurious preload `ENOENT` when `app.asar` is
  replaced on disk while the app runs (42.6.2). We flip
  `EnableEmbeddedAsarIntegrityValidation` and `OnlyLoadAppFromAsar` in
  `build/afterPack.mjs:392-393` and ship `electron-updater`.
- utilityProcess: crashes at exit on Windows 11 24H2 and later (42.10.0),
  faster `utilityProcess.fork()`. We fork the pty host in
  `src/main/studio/pty-host-starter.ts:551`.
- safeStorage: `isAsyncEncryptionAvailable()` answered false right after
  `ready`, and the async encrypt and decrypt calls could crash before
  initialization (42.4.1). Consumer: `src/main/compose/electron-secret-adapter.ts`.
- contextBridge: renderer crash on arrays with throwing getters, main and
  utility crashes on option objects with throwing accessors (42.11.2).
- Permission handlers received the top-level origin and a null `webContents`
  for `hid` and `usb` from subframes. We deny everything in
  `src/main/permissions.ts`, so we were already fail-closed.
- `protocol.handle` session selection and cross-origin `no-cors` responses,
  sandbox inheritance for windows opened from sandboxed frames, a Windows
  process that would not exit after `app.quit()` with a pending Open With
  dialog, BrowserWindow creation leak, a crash showing a file dialog on a
  closing window, a Linux D-Bus disconnect crash.

No native rebuild: `NODE_MODULE_VERSION` is fixed for the lifetime of an
Electron major, and node-pty is consumed as shipped prebuilds
(`scripts/check-native-artifacts.mjs`).

### 43

Breaking changes in 43 that reach us: dialog methods default `defaultPath` to
Downloads, and we never set it (`src/main/ipc/images.ts`,
`src/main/ipc/shell-backdrop.ts`), so both pickers change their starting
directory. `showHiddenFiles` on Linux was removed; we do not use it. 43 is
supported only until 2027-01-05 and its breaking set is a strict subset of the
44 work, so it is not a landing spot.

### 44, the one real migration

The clipboard module was rearchitected onto the W3C Clipboard API (RFC 0019):
`readText()`, `writeText()`, `read()`, `write()` and `has()` return Promises.
That lands on the wallet export lease, `src/main/ipc/wallet-export-clipboard-lease.ts`
(`clipboard.writeText(secret)` at line 111, `clipboard.readText()` at 63,
`clipboard.clear()` at 65). The lease reads the clipboard, compares a SHA-256
against the secret it wrote, and clears only content it still owns. Making all
three calls asynchronous opens a time-of-check to time-of-use window across two
awaits inside a secret-handling path. This is a lifecycle redesign with its own
plan, approval and tests, not a mechanical `await` insertion.

Also in 44: `clipboard` removed from the renderer (never exposed by us), 32-bit
targets removed (we build x64 and arm64 only), `net.request` rejects a frame
`Sec-Fetch-Dest` without `Sec-Fetch-Mode: navigate` (none of our `net.fetch`
sites send it), macOS 12 dropped. `webUtils.getPathForFile`, used by
`src/preload/shell/files.ts` and `src/preload/terminal-clipboard-files.ts`,
is unchanged since its introduction in Electron 32.

node-pty 1.2.0-beta.15 publishes no Electron compatibility claim. It builds
against `node-addon-api`, so prebuilds are ABI-stable across majors, but that
is inferred, not measured: `pnpm run probe:node-pty:packaged` is the gate
before accepting 43 or 44.

### Recommendation and schedule

1. First change after the release: `electron` 42.11.3. One version string,
   verified by CI and the packaged payload gates.
2. Before 2026-10-20: an Electron 44 arc that redesigns the clipboard lease
   around promise-based calls with the ownership-hash race named in the plan,
   then runs the packaged node-pty probe on 44.

## electron-builder

### The finding that matters: AppImage CVE-2026-54672

GHSA-7g7r-gx96-252g, CVSS 7.8, `app-builder-lib` below 26.15.0. The generated
`AppRun` exported `LD_LIBRARY_PATH="${APPDIR}/usr/lib:${LD_LIBRARY_PATH}"`;
with the variable unset this leaves a trailing colon, an empty path component
the dynamic linker resolves to the current working directory. The same applies
to `PATH`, `XDG_DATA_DIRS` and `GSETTINGS_SCHEMA_DIR`. We build AppImage
(`electron-builder.release.yml`, linux targets), so every AppImage published
from 26.8.1 carries it. There is no backport below 26.15.0. Do not publish
another AppImage before the bump.

The second advisory, GHSA-p2f4-r6v6-j797 / CVE-2026-54673 in
`builder-util-runtime` below 9.7.0 (credential leak on cross-origin
redirects), does not affect the shipped app: `electron-updater` 6.8.9 already
resolves `builder-util-runtime` 9.7.0 in `pnpm-lock.yaml`. Only the build-time
copy under `app-builder-lib` 26.8.1 is still 9.5.1.

### Why 26.16.1 and not 26.15.3

npm `latest` points at 26.15.3 because master moved to the 27 alphas; the
maintained 26 line continues on `release/v26` under the `v26` dist-tag, at
26.16.1 as of 2026-09-07. Its release notes exist only in the GitHub release
bodies. The pin must name the version (`~26.16.1`); neither `~26.8.1` nor
`latest` reaches it.

Versions 26.15.0 through 26.15.5 carry two regressions on our own targets:
the 7-Zip toolset switch in 26.15.0 dropped `.framework` symlinks from the
macOS zip and broke Squirrel.Mac update validation until 26.15.2, and NSIS
failed to extract the main exe and native binaries on x64 and arm64 until
26.15.6. 26.16.1 also fixes macOS signing with `CSC_LINK` on newer runners
(`security set-key-partition-list` received the wrong keychain password),
which is the shape of our release job.

Other changes on our configuration keys, 26.8.2 to 26.16.1: exe regeneration
when the ASAR header changes so integrity validation matches (26.8.2), Azure
Trusted Signing preflight removed (26.9.1), `signAndEditExecutable` split
with a new `signExecutable` flag (26.11.0), deterministic file ordering in
`latest*.yml` (26.12.0), blockmap and icon generation rewritten in TypeScript
(26.14.0), `app-builder-bin` removed (26.15.0) and `7zip-bin` removed
(26.16.0). The comment in `electron-builder.release.yml:227` about
app-builder-lib 26.8.1 defaults for the Azure timestamp keys goes stale; the
keys are pinned explicitly, so behaviour does not change.

### What the bump changes for CI

7-Zip, makensis, appimage, fpm and the icon tools are no longer npm packages.
They are downloaded toolsets with pinned checksums, so all three release jobs
acquire a build-time network dependency and a cold-cache failure mode.
The node-module collector was rewritten repeatedly between 26.9 and 26.16;
our negated `files` globs and `asarUnpack` list are exactly what it decides.

### Release dry run checklist

1. Linux: unpack the AppImage and confirm `AppRun` uses the
   `${VAR:+:${VAR}}` form for `LD_LIBRARY_PATH`, `PATH`, `XDG_DATA_DIRS`
   and `GSETTINGS_SCHEMA_DIR`, with no trailing colon. This is the acceptance
   test for the CVE.
2. macOS: `codesign -vvv --deep --strict` and `spctl -a -vv` on both
   architectures, notarization staples, and `unzip -l` of the zip artifact
   showing the `Electron Framework.framework` symlinks survived. Confirm the
   `CSC_LINK` job no longer fails on `set-key-partition-list`.
3. Windows: install the NSIS output on a clean x64 machine and confirm the
   main exe, the node-pty prebuilds, `spawn-helper`, `vex-mcp.exe` and
   `vex-pipe-front.exe` are extracted; rerun the Authenticode and timestamp
   gate and the bridge path gate in `.github/workflows/release.yml`.
4. ASAR integrity: the fuses set by `build/afterPack.mjs` still validate;
   `disableAsarIntegrity` stays unset.
5. Updater metadata: diff `latest.yml`, `latest-mac.yml` and
   `latest-linux.yml` and the blockmaps against the current release.
6. Payload: `pnpm run check:package` and `scripts/check-native-artifacts.mjs`
   stay green after the collector changes.
7. CI: the toolset downloads succeed on all three runners, or the cache is
   seeded.

v27 is in alpha (27.0.0-alpha.8) with a `migrate-schema` command; its
breaking changes rename `azureSignOptions` into a unified `win.sign`, change
the `asar` option shape and require native ESM with Node 22.12 or later. Not
a candidate.

## @sentry/electron and electron-log

`@sentry/electron` 7.16.0 to 7.18.0: 7.17.0 pins the Sentry JavaScript SDK
10.70.0, 7.18.0 pins 10.73.0. The one breaking change in 7.18.0, the
`electronBreadcrumbs`, `electronNet` and `childProcess` integrations no longer
emitting logs by default, has no effect on us: `src/main/telemetry/sentry-lifecycle.ts`
sets `defaultIntegrations: false` and enables only dedupe and linked errors,
with `sendDefaultPii: false` and `skipOpenTelemetrySetup: true`. The advisory
database lists nothing against `@sentry/electron`. Verification after the
bump: the app type check and the `before-send` and `sentry-lifecycle` suites,
because `before-send.ts` imports the SDK's `Event` and `Breadcrumb` types.

`electron-log` 5.4.3 to 5.4.4: an `exports` map in package.json and a CI-only
test fix. Our `electron-log/main.js` import stays valid; the file transport,
rotation and hooks are unchanged.

`@electron/fuses` 2.1.2 replaced `extract-zip` with an internal fork; 2.1.3
fixes `.app` bundle path detection on macOS. `FuseV1Options` is unchanged.

## Sources

- https://github.com/electron/electron/releases
- https://www.electronjs.org/docs/latest/breaking-changes
- https://www.electronjs.org/docs/latest/tutorial/electron-timelines
- https://github.com/electron/rfcs/blob/main/text/0019-clipboard-rearchitecture.md
- https://github.com/electron/fuses/releases
- https://github.com/electron-userland/electron-builder/releases
- https://github.com/advisories/GHSA-7g7r-gx96-252g
- https://github.com/advisories/GHSA-p2f4-r6v6-j797
- https://github.com/advisories/GHSA-2883-xcg3-v3hh
- https://github.com/getsentry/sentry-electron/blob/master/CHANGELOG.md
- https://github.com/megahertz/electron-log/releases
