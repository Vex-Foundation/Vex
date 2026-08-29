/**
 * Post-build gate for the Vex Studio pty-host bundle and the repository's
 * first NATIVE runtime dependencies (node-pty, @parcel/watcher).
 *
 * Why a gate at all: under pnpm 10 a dependency's install scripts run ONLY if
 * it is listed in `pnpm.onlyBuiltDependencies`. Drop node-pty from that list
 * and the install still succeeds - it just silently produces a package with no
 * usable binary, and the failure surfaces as a broken terminal at runtime on a
 * user's machine. Equally, the `asarUnpack` globs in electron-builder.yml are
 * plain strings: rename a directory upstream and they quietly match nothing.
 * Both are exactly the class of defect a green test suite cannot see, so they
 * are asserted against the real filesystem here.
 *
 * The architecture check reads each artifact's own ELF/Mach-O/PE header
 * through `inspectExecutable`, the same inspector the Go bridge uses. That
 * matters more than it looks: node-pty ships prebuilds for all six
 * platform-arch targets in one tarball, so this gate verifies the macOS and
 * Windows binaries we will ship FROM a Linux CI box, long before a mac build
 * exists to test.
 *
 * Consumed by scripts/check-build-artifacts.mjs, which owns the runner and the
 * exit code.
 */

import { existsSync, readFileSync, readdirSync, statSync, constants } from "node:fs";
import path from "node:path";

import {
  GO_ARCH_BY_ELECTRON_ARCH,
  GOOS_BY_ELECTRON_PLATFORM,
  inspectExecutable,
} from "./bridge-artifact.mjs";

/**
 * What each node-pty prebuild directory must contain.
 *
 * Windows carries no `pty.node` in 1.2.0-beta.15 - the ConPTY backend replaced
 * it - so the expectation is per-platform rather than one shared list. A
 * directory that exists but holds none of its required files is a failure, not
 * a skip.
 *
 * `spawn-helper` is the macOS-only executable node-pty forks to set up the
 * child's controlling terminal. It must keep its executable bit through
 * install, packaging and signing or every terminal spawn fails on macOS.
 */
const NODE_PTY_PREBUILD_CONTRACT = Object.freeze({
  linux: { binaries: ["pty.node"], executables: [] },
  darwin: { binaries: ["pty.node"], executables: ["spawn-helper"] },
  windows: { binaries: ["conpty.node", "conpty_console_list.node"], executables: [] },
});

/** Split a node-pty prebuild directory name (`darwin-arm64`) into a Go target. */
function goTargetForPrebuildDir(dirName) {
  const separator = dirName.lastIndexOf("-");
  if (separator === -1) return undefined;
  const goos = GOOS_BY_ELECTRON_PLATFORM[dirName.slice(0, separator)];
  const arch = GO_ARCH_BY_ELECTRON_ARCH[dirName.slice(separator + 1)];
  if (goos === undefined || arch === undefined) return undefined;
  return { goos, arch };
}

function assertExecutableBit(file, issues) {
  // Windows has no POSIX permission bits; asserting them there would fail for
  // a reason that has nothing to do with the artifact.
  if (process.platform === "win32") return;
  const mode = statSync(file).mode;
  if ((mode & constants.S_IXUSR) === 0) {
    issues.push(`${file}: not executable (mode ${(mode & 0o777).toString(8)})`);
  }
}

/**
 * node-pty: every shipped prebuild directory holds the right files, and each
 * binary's own header matches the architecture its directory name claims.
 */
function checkNodePtyPrebuilds(root) {
  const prebuilds = path.join(root, "node_modules", "node-pty", "prebuilds");
  if (!existsSync(prebuilds)) {
    throw new Error(
      `missing ${prebuilds}\n`
        + "    node-pty's install script did not run. Under pnpm 10 that means it is "
        + "absent from `pnpm.onlyBuiltDependencies` in vex-app/package.json."
    );
  }

  const dirs = readdirSync(prebuilds, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  if (dirs.length === 0) {
    throw new Error(`${prebuilds} contains no platform directories`);
  }

  const issues = [];
  let hostDirSeen = false;
  const hostDir = `${process.platform}-${process.arch}`;

  for (const dirName of dirs) {
    const target = goTargetForPrebuildDir(dirName);
    if (target === undefined) {
      // An unrecognised target is reported, never skipped: it means node-pty
      // changed its layout and the asarUnpack/signing paths need review.
      issues.push(`${dirName}: not a platform-arch pair Vex maps (see bridge-artifact.mjs)`);
      continue;
    }
    if (dirName === hostDir) hostDirSeen = true;

    const contract = NODE_PTY_PREBUILD_CONTRACT[target.goos];
    for (const fileName of [...contract.binaries, ...contract.executables]) {
      const file = path.join(prebuilds, dirName, fileName);
      if (!existsSync(file)) {
        issues.push(`${dirName}/${fileName}: missing`);
        continue;
      }
      try {
        const found = inspectExecutable(file);
        if (found.goos !== target.goos || found.arch !== target.arch) {
          issues.push(
            `${dirName}/${fileName}: header says ${found.goos}/${found.arch}, directory claims ${target.goos}/${target.arch}`
          );
        }
      } catch (error) {
        issues.push(`${dirName}/${fileName}: ${error.message}`);
      }
      if (contract.executables.includes(fileName)) {
        assertExecutableBit(file, issues);
      }
    }
  }

  if (!hostDirSeen) {
    issues.push(`no prebuild for this host (${hostDir}); node-pty cannot load here`);
  }
  if (issues.length > 0) {
    throw new Error(`node-pty prebuild issues:\n    ${issues.join("\n    ")}`);
  }
}

/**
 * @parcel/watcher: the native binary arrives through a per-platform OPTIONAL
 * package (`@parcel/watcher-linux-x64-glibc`), not the parent package, which
 * is why the asarUnpack glob targets `@parcel/watcher-*`. Only the host's
 * package is installed, so only the host's is asserted.
 */
function checkParcelWatcher(root) {
  const scopeDir = path.join(root, "node_modules", "@parcel");
  if (!existsSync(scopeDir)) {
    throw new Error(`missing ${scopeDir}; @parcel/watcher is not installed`);
  }

  const platformPackages = readdirSync(scopeDir, { withFileTypes: true })
    .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && entry.name.startsWith("watcher-"))
    .map((entry) => entry.name)
    .sort();

  if (platformPackages.length === 0) {
    throw new Error(
      `no @parcel/watcher-<platform> package under ${scopeDir}\n`
        + "    Without one, @parcel/watcher falls back to a source build; if that also "
        + "did not run, file watching has no native backend at runtime."
    );
  }

  const issues = [];
  const expectedArch = GO_ARCH_BY_ELECTRON_ARCH[process.arch];
  const expectedGoos = GOOS_BY_ELECTRON_PLATFORM[process.platform];

  // The parent package's own source build, when the install script produced
  // one. @parcel/watcher prefers it over the optional platform package, so it
  // is held to the same architecture contract.
  const sourceBuild = path.join(scopeDir, "watcher", "build", "Release", "watcher.node");
  const candidates = platformPackages.map((pkg) => ({
    label: `@parcel/${pkg}/watcher.node`,
    file: path.join(scopeDir, pkg, "watcher.node"),
    required: true,
  }));
  if (existsSync(sourceBuild)) {
    candidates.push({
      label: "@parcel/watcher/build/Release/watcher.node",
      file: sourceBuild,
      required: false,
    });
  }

  for (const { label, file: binary, required } of candidates) {
    if (!existsSync(binary)) {
      if (required) issues.push(`${label}: missing`);
      continue;
    }
    try {
      const found = inspectExecutable(binary);
      if (found.goos !== expectedGoos || found.arch !== expectedArch) {
        issues.push(
          `${label}: header says ${found.goos}/${found.arch}, host is ${expectedGoos}/${expectedArch}`
        );
      }
    } catch (error) {
      issues.push(`${label}: ${error.message}`);
    }
  }

  if (issues.length > 0) {
    throw new Error(`@parcel/watcher issues:\n    ${issues.join("\n    ")}`);
  }
}

/**
 * The pty-host bundle exists and kept node-pty EXTERNAL.
 *
 * Inlining node-pty's loader would break it silently: the loader resolves
 * `prebuilds/<platform>-<arch>/pty.node` relative to its own file location
 * inside node_modules, so a copy living in dist/pty-host/ would look in the
 * wrong place. The import statement surviving in the emitted ESM is the
 * evidence that `rolldownOptions.external` still holds.
 */
function checkPtyHostBundle(root) {
  const bundle = path.join(root, "dist", "pty-host", "index.js");
  if (!existsSync(bundle)) {
    throw new Error(
      `missing ${bundle}\n    Run \`pnpm run build:pty-host\` (part of \`pnpm run build\`).`
    );
  }
  const source = readFileSync(bundle, "utf8");

  // node-pty's own source is unmistakable if it were inlined: the loader
  // builds the prebuilds path from these literals.
  if (source.includes("prebuilds/") || source.includes("spawn-helper")) {
    throw new Error(
      `${bundle} appears to INLINE node-pty (found its prebuilds/spawn-helper literals).\n`
        + "    node-pty must stay in `rolldownOptions.external` in vite.pty-host.config.ts."
    );
  }
}

/**
 * The `asarUnpack` globs in the electron-builder profiles still match real
 * directories.
 *
 * A glob that matches nothing is not an error to electron-builder - it just
 * packs the native module INSIDE app.asar, where it cannot be dlopen'd. This
 * compares the configured prefixes against the installed tree so an upstream
 * layout change fails here instead of in a shipped build.
 */
function checkAsarUnpackCoverage(root) {
  const profiles = ["electron-builder.yml", "electron-builder.release.yml"];
  const required = [
    {
      glob: "node_modules/node-pty/prebuilds/**",
      probe: path.join(root, "node_modules", "node-pty", "prebuilds"),
    },
    {
      // `watcher*`, not `watcher-*`: @parcel/watcher loads
      // `build/Release/watcher.node` from the PARENT package when a source
      // build produced one, and falls back to the per-platform optional
      // package. Both were present in a real `--dir` package, and only the
      // wildcard covers both. electron-builder also auto-unpacks stray `.node`
      // files, but that is implicit behavior - this glob is the contract.
      glob: "node_modules/@parcel/watcher*/**",
      probe: path.join(root, "node_modules", "@parcel"),
      // The glob is a wildcard; the probe above only proves the scope exists,
      // so the concrete packages are verified by checkParcelWatcher.
    },
  ];

  const issues = [];
  for (const profile of profiles) {
    const file = path.join(root, profile);
    if (!existsSync(file)) {
      issues.push(`${profile}: missing`);
      continue;
    }
    const config = readFileSync(file, "utf8");
    for (const { glob } of required) {
      if (!config.includes(glob)) {
        issues.push(`${profile}: asarUnpack is missing \`${glob}\``);
      }
    }
    if (!config.includes("dist/pty-host/**")) {
      issues.push(`${profile}: \`files\` is missing \`dist/pty-host/**\``);
    }
  }
  for (const { glob, probe } of required) {
    if (!existsSync(probe)) {
      issues.push(`asarUnpack \`${glob}\` matches nothing: ${probe} does not exist`);
    }
  }

  if (issues.length > 0) {
    throw new Error(`asarUnpack coverage issues:\n    ${issues.join("\n    ")}`);
  }
}

/**
 * Checks in the shape `check-build-artifacts.mjs` runs: `{ label, run(root) }`,
 * where `run` throws with a diagnostic on violation.
 */
export const nativeArtifactChecks = [
  {
    label: "pty-host bundle — exists and keeps node-pty external",
    run: checkPtyHostBundle,
  },
  {
    label: "node-pty prebuilds — present, right architecture, spawn-helper executable",
    run: checkNodePtyPrebuilds,
  },
  {
    label: "@parcel/watcher — native backend installed for this host",
    run: checkParcelWatcher,
  },
  {
    label: "electron-builder — pty-host packaged and native modules asarUnpack'd",
    run: checkAsarUnpackCoverage,
  },
];
