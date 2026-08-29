/**
 * ONE loadable candidate per native module: the paths and policy behind it.
 *
 * THE PROBLEM. Both native dependencies can be satisfied by more than one
 * artifact on disk, and each has its own search order. Whichever the loader
 * finds first is the one that runs, so if the payload carries two, the reviewed
 * unpack + signing contract covers an artifact that never loads. Measured
 * loader orders (read from the installed packages, not from convention):
 *
 *   node-pty 1.2.0-beta.15, `lib/utils.js` `loadNativeModule()`:
 *       build/Release  ->  build/Debug  ->  prebuilds/<platform>-<arch>
 *     each tried relative to `..` then `.`. build/Release WINS over the
 *     prebuilds. `pnpm install` leaves no build/ directory, but any
 *     @electron/rebuild pass (electron-builder runs one by default, and one
 *     had already run in this checkout: build/Release/pty.node with a
 *     `.forge-meta` sibling) creates one, and from then on the prebuilds are
 *     dead weight.
 *
 *   @parcel/watcher 2.6.0, `index.js`:
 *       require('@parcel/watcher-<platform>-<arch>[-glibc|-musl]')
 *         ->  ./build/Release/watcher.node  ->  ./build/Debug/watcher.node
 *     the per-platform OPTIONAL PACKAGE wins; the parent's own source build is
 *     only a fallback.
 *
 *   bufferutil 4.1.0 and utf-8-validate 6.0.6, `index.js` (identical file in
 *   both): `require('node-gyp-build')(__dirname)`, falling back to
 *   `require('./fallback')` - the pure-JS implementation - when that throws.
 *   node-gyp-build 4.8.4 `node-gyp-build.js` `load.resolve()`, read from the
 *   installed package:
 *       build/Release/*.node  ->  build/Debug/*.node
 *         ->  prebuilds/<platform>-<arch>/<best tag match>
 *         ->  the same prebuilds/ tree beside process.execPath
 *     (the first two are skipped only when PREBUILDS_ONLY is set, which nothing
 *     in Vex sets). Same shape as node-pty: build/Release WINS over prebuilds.
 *     MEASURED under this repo's Electron 42 (ABI 146), ELECTRON_RUN_AS_NODE,
 *     via `load.resolve()` on the installed packages:
 *       with build/ present: bufferutil -> build/Release/bufferutil.node,
 *                            utf-8-validate -> build/Release/validation.node
 *       with build/ absent:  bufferutil -> prebuilds/linux-x64/bufferutil.node,
 *                            utf-8-validate -> prebuilds/linux-x64/utf-8-validate.node
 *                            and both LOADED, exporting their native functions.
 *
 *     N-API evidence, not convention: both packages build with
 *     `prebuildify --napi` (their own `prebuild` script), and the shipped
 *     linux-x64 prebuilds import 6 and 5 `napi_*` symbols respectively and ZERO
 *     `v8::`/`node::` symbols (`nm -D --undefined-only`). Node-API is ABI
 *     stable, which is why an Electron 42 process loads a prebuild published
 *     for Node 8.11.2 without a rebuild - the second half of the measurement
 *     above is that proof end to end.
 *
 * THE DECISION, per module, and why:
 *
 *   node-pty      SELECTED: prebuilds/<platform>-<arch>/ (the published N-API
 *                 artifacts, one directory per target in a single tarball).
 *                 EXCLUDED: build/**. The prebuilds are Node-API, which is ABI
 *                 stable across Node and Electron - `pnpm probe:node-pty`
 *                 measures that claim - so a rebuild buys nothing and costs
 *                 the review: a rebuilt build/Release/spawn-helper on macOS is
 *                 not in the `mac.binaries` signing list and the hardened
 *                 runtime would refuse to exec it. Excluding build/** is what
 *                 forces the loader past its own first choice onto the
 *                 reviewed path. `npmRebuild: false` in both electron-builder
 *                 profiles stops the rebuild from being produced at all; the
 *                 exclusion is the belt to that suspenders, because a build/
 *                 left over from a developer's earlier run would otherwise be
 *                 copied straight into the payload.
 *
 *   @parcel/watcher  SELECTED: @parcel/watcher-<platform>-<arch>[-libc]/watcher.node,
 *                 which is already the loader's FIRST choice, so this
 *                 exclusion removes only a fallback that could never win.
 *                 EXCLUDED: @parcel/watcher/build/**. Keeping it would ship a
 *                 second unreviewed binary that only ever runs when the
 *                 selected one is missing - and "silently degraded to an
 *                 unreviewed artifact" is the outcome this contract exists to
 *                 forbid. When the selected package is absent for a packaged
 *                 arch the build must FAIL, which is what the payload gate in
 *                 check-packaged-payload.mjs does.
 *
 *   bufferutil,   SELECTED: prebuilds/<platform>-<arch>/<name>.node.
 *   utf-8-validate  EXCLUDED: build/**. The loader order is node-pty's, so the
 *                 exclusion is what forces the loader off a leftover local
 *                 build onto the reviewed artifact; without it the payload
 *                 ships (and would load) a binary compiled on whoever's machine
 *                 last ran a rebuild. Both are OPTIONAL `ws` accelerators
 *                 pulled in by @solana/web3.js and viem, and both fall back to
 *                 `./fallback.js`, a pure-JS implementation, when no native
 *                 artifact resolves.
 *
 *                 ABSENCE IS A DEGRADE, NOT A FAILURE, and this is the one way
 *                 they differ from @parcel/watcher in the gate. The published
 *                 prebuilds cover darwin-x64, darwin-arm64, linux-x64,
 *                 win32-x64 and win32-ia32 - so a linux-arm64 or win32-arm64
 *                 package legitimately carries no native accelerator and runs
 *                 the JS fallback, slower but correct. @parcel/watcher has no
 *                 fallback at all once its build/ is excluded, so ITS absence
 *                 must fail. The gate therefore asserts these two as
 *                 present-and-unpacked-and-arch-correct WHEN PRESENT, and
 *                 reports a named degrade when a target has none.
 *
 *                 No `mac.binaries` entry: unlike node-pty's `spawn-helper`
 *                 these are `.node` files with the extension, which
 *                 @electron/osx-sign's nested-binary walker does sign.
 *
 * Consumers: electron-builder.yml and electron-builder.release.yml carry these
 * strings; scripts/check-native-artifacts.mjs asserts the configs still match
 * these constants (so the three files cannot drift apart), and
 * scripts/check-packaged-payload.mjs asserts the real `--dir` output.
 */

import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

/** `asarUnpack` globs. The selected candidates, and nothing else. */
export const SELECTED_ASAR_UNPACK_GLOBS = Object.freeze([
  "node_modules/node-pty/prebuilds/**",
  // `watcher-*` with the hyphen: the per-platform packages only. The parent
  // `@parcel/watcher` is pure JS once its build/ is excluded and belongs
  // inside the asar like any other JS dependency.
  "node_modules/@parcel/watcher-*/**",
  // electron-builder auto-unpacks `.node` files even without a glob, so these
  // two were already outside the asar - by an undeclared default rather than by
  // the reviewed contract. Naming them makes the payload gate's
  // present-and-unpacked assertion follow from configuration.
  "node_modules/bufferutil/prebuilds/**",
  "node_modules/utf-8-validate/prebuilds/**",
]);

/**
 * `files` exclusions that keep the non-selected candidates out of the payload.
 *
 * Written as `**\/<pkg>/build/**` rather than `node_modules/<pkg>/build/**`
 * because pnpm's store puts the real directory under
 * `node_modules/.pnpm/<pkg>@<version>/node_modules/<pkg>/`, and app-builder-lib
 * copies node_modules through a SEPARATE matcher that takes only the negated
 * patterns from `files` (fileMatcher.js `getNodeModuleFileMatcher`, verified in
 * app-builder-lib 26.8.1). A prefix-anchored pattern would miss the store path.
 */
export const EXCLUDED_CANDIDATE_FILE_PATTERNS = Object.freeze([
  '"!**/node-pty/build/**"',
  '"!**/@parcel/watcher/build/**"',
  '"!**/bufferutil/build/**"',
  '"!**/utf-8-validate/build/**"',
]);

/**
 * Payload path fragments that must NOT appear anywhere in a packaged app -
 * neither in app.asar's file list nor in the unpacked tree. Matched against
 * POSIX-normalised relative paths.
 */
export const FORBIDDEN_PAYLOAD_FRAGMENTS = Object.freeze([
  "node-pty/build/",
  "@parcel/watcher/build/",
  "bufferutil/build/",
  "utf-8-validate/build/",
]);

/**
 * Native modules that reach the payload WITHOUT a candidate decision yet.
 *
 * EMPTY, and that is the contract's healthy state, not dead code: it is the
 * escape hatch the stray-`.node` scan in check-packaged-payload.mjs consults,
 * and the only way a newly arrived native dependency can reach a package
 * without failing the build. An entry here means "seen, visible, still owed a
 * decision": the gate prints it by name every run instead of passing silently.
 * Giving the module a decision above is what empties it again - which is what
 * happened to `bufferutil` and `utf-8-validate` (see their row in the header).
 */
export const UNDECIDED_NATIVE_MODULES = Object.freeze([]);

/**
 * The OPTIONAL `ws` accelerators, and the prebuild file each publishes.
 *
 * Optional in the load-bearing sense: `ws` uses them when they resolve and
 * falls back to its own JS path when they do not, so a target with no published
 * prebuild degrades rather than breaks. The payload gate holds every artifact
 * that IS present to the same present-unpacked-arch-correct contract as the
 * others; see the header for why absence is tolerated here and nowhere else.
 */
export const WS_ACCELERATOR_MODULES = Object.freeze([
  Object.freeze({ packageName: "bufferutil", binary: "bufferutil.node" }),
  Object.freeze({ packageName: "utf-8-validate", binary: "utf-8-validate.node" }),
]);

/**
 * A ws accelerator's selected directory for one target, relative to
 * `node_modules`. The tuple directory is node-gyp-build's
 * `prebuilds/<platform>-<arch>`, matched against `process.platform`/`arch`
 * spelling - the same vocabulary electron-builder's target names use.
 */
export function wsAcceleratorPrebuildDir(packageName, platform, arch) {
  return path.posix.join(packageName, "prebuilds", `${platform}-${arch}`);
}

/** electron-builder must not rebuild native deps: the prebuilds are the ship. */
export const REBUILD_DISABLED_KEY = "npmRebuild";
export const REBUILD_DISABLED_LINE = "npmRebuild: false";

/**
 * The macOS binaries that need their own signature, relative to the .app
 * bundle root. Derived from the SELECTED node-pty path so the signing list and
 * the unpack glob can never point at different artifacts.
 *
 * `spawn-helper` is a Mach-O executable with no file extension, which
 * @electron/osx-sign's nested-binary walker does not pick up on its own (it
 * does sign `.node` files). Both arches are listed because node-pty ships both
 * prebuilds and electron-builder packages x64 and arm64 in one invocation.
 */
export const MAC_SIGNED_NATIVE_BINARIES = Object.freeze(
  ["darwin-x64", "darwin-arm64"].map(
    (target) =>
      `Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/${target}/spawn-helper`
  )
);

/** node-pty's selected directory for one target, relative to `node_modules`. */
export function nodePtyPrebuildDir(platform, arch) {
  return path.posix.join("node-pty", "prebuilds", `${platform}-${arch}`);
}

/**
 * @parcel/watcher's selected package name for one target.
 *
 * The libc suffix exists on Linux only, and the loader picks it with
 * `detect-libc` at runtime; a packaged Linux app therefore needs the package
 * matching the libc it will run against. Vex ships glibc builds.
 */
export function parcelWatcherPackageName(platform, arch, libc = "glibc") {
  return platform === "linux"
    ? `@parcel/watcher-${platform}-${arch}-${libc}`
    : `@parcel/watcher-${platform}-${arch}`;
}

/**
 * electron-builder's `--dir` output directory names, mapped to the target each
 * was packaged FOR. The arch matters: it is what a header check compares
 * against, and a macOS invocation emits x64 and arm64 side by side.
 */
export const PAYLOAD_DIR_TARGETS = Object.freeze({
  "linux-unpacked": { platform: "linux", arch: "x64" },
  "linux-arm64-unpacked": { platform: "linux", arch: "arm64" },
  "win-unpacked": { platform: "win32", arch: "x64" },
  "win-arm64-unpacked": { platform: "win32", arch: "arm64" },
  mac: { platform: "darwin", arch: "x64" },
  "mac-arm64": { platform: "darwin", arch: "arm64" },
});

/**
 * One packaged app: its target, a display label, and its `resources` directory
 * (which holds `app.asar` and `app.asar.unpacked`). `undefined` when the
 * directory is not a recognised electron-builder `--dir` output.
 *
 * Shared by the payload gate and the packaged-layout probe so both look at the
 * same tree by the same rules.
 */
export function resolvePayload(dir) {
  const target = PAYLOAD_DIR_TARGETS[path.basename(dir)];
  if (target === undefined || !existsSync(dir)) return undefined;
  if (target.platform === "darwin") {
    const apps = readdirSync(dir, { withFileTypes: true }).filter(
      (entry) => entry.isDirectory() && entry.name.endsWith(".app")
    );
    if (apps.length !== 1) return undefined;
    return {
      target,
      label: path.join(path.basename(dir), apps[0].name),
      resources: path.join(dir, apps[0].name, "Contents", "Resources"),
    };
  }
  return { target, label: path.basename(dir), resources: path.join(dir, "resources") };
}

/** Every packaged app under `<appRoot>/dist-electron`, in stable label order. */
export function discoverPayloads(appRoot) {
  const outDir = path.join(appRoot, "dist-electron");
  if (!existsSync(outDir)) return [];
  return readdirSync(outDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolvePayload(path.join(outDir, entry.name)))
    .filter((payload) => payload !== undefined)
    .sort((a, b) => a.label.localeCompare(b.label));
}
