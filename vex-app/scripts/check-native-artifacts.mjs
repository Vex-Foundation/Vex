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
import {
  EXCLUDED_CANDIDATE_FILE_PATTERNS,
  MAC_SIGNED_NATIVE_BINARIES,
  parcelWatcherPackageName,
  REBUILD_DISABLED_LINE,
  SELECTED_ASAR_UNPACK_GLOBS,
  WS_ACCELERATOR_MODULES,
} from "./native-payload-contract.mjs";

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
 * is why the asarUnpack glob targets `@parcel/watcher-*`.
 *
 * SEVERAL of them are installed, not just the host's:
 * `pnpm.supportedArchitectures` deliberately materialises every arch the
 * release matrix packages, because the macOS job builds x64 and arm64 from one
 * install (see the header of native-payload-contract.mjs). Each package is
 * therefore held to the target its OWN NAME declares - a darwin-arm64 package
 * carrying an x86_64 binary is the defect this catches - while the HOST's
 * package must additionally be present, since that is the one this machine
 * loads.
 *
 * MEASURED LOADER ORDER (@parcel/watcher 2.6.0 `index.js`, read from the
 * installed package):
 *
 *     require('@parcel/watcher-<platform>-<arch>[-glibc|-musl]')
 *       ->  ./build/Release/watcher.node
 *       ->  ./build/Debug/watcher.node
 *
 * The optional platform package WINS, so it is the SELECTED shipping
 * candidate; the parent's own source build is excluded from the payload by
 * `files` (see scripts/native-payload-contract.mjs). Note this is the OPPOSITE
 * order to node-pty, which tries `build/Release` FIRST - which is why node-pty
 * needs its build/ excluded to reach the reviewed prebuilds at all, while
 * @parcel/watcher's exclusion only removes a fallback that could never win.
 *
 * The parent build, when a developer's tree still has one, is held to the same
 * architecture contract here: it never reaches a package, but a wrong-arch
 * binary in node_modules means the local install is not what it claims.
 */
/**
 * The Go target a `watcher-<platform>-<arch>[-libc]` package name declares.
 *
 * Name-derived on purpose: the package's own name is the only statement of
 * what it is FOR, so comparing it against the binary's header is what catches
 * a mislabelled or corrupted download. `undefined` in either field means the
 * name names a target this repository has no mapping for.
 */
function watcherPackageTarget(packageName) {
  const [, platform, arch] = packageName.split("-");
  return { goos: GOOS_BY_ELECTRON_PLATFORM[platform], arch: GO_ARCH_BY_ELECTRON_ARCH[arch] };
}

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
  const hostGoos = GOOS_BY_ELECTRON_PLATFORM[process.platform];
  const hostArch = GO_ARCH_BY_ELECTRON_ARCH[process.arch];

  const hostPackage = parcelWatcherPackageName(process.platform, process.arch).replace("@parcel/", "");
  if (!platformPackages.includes(hostPackage)) {
    issues.push(
      `@parcel/${hostPackage} is not installed; this host has no native watcher backend `
        + `(installed: ${platformPackages.join(", ")})`
    );
  }

  const sourceBuild = path.join(scopeDir, "watcher", "build", "Release", "watcher.node");
  // Each platform package declares its target in its own name; the parent's
  // source build, when a developer's tree still has one, was compiled here.
  const candidates = platformPackages.map((pkg) => ({
    label: `@parcel/${pkg}/watcher.node`,
    file: path.join(scopeDir, pkg, "watcher.node"),
    expected: watcherPackageTarget(pkg),
    required: true,
  }));
  if (existsSync(sourceBuild)) {
    candidates.push({
      label: "@parcel/watcher/build/Release/watcher.node",
      file: sourceBuild,
      expected: { goos: hostGoos, arch: hostArch },
      required: false,
    });
  }

  for (const { label, file: binary, expected, required } of candidates) {
    if (!existsSync(binary)) {
      if (required) issues.push(`${label}: missing`);
      continue;
    }
    if (expected.goos === undefined || expected.arch === undefined) {
      issues.push(
        `${label}: package name declares a platform/arch this repository has never reviewed; `
          + "add it to bridge-artifact.mjs's target maps or narrow pnpm.supportedArchitectures"
      );
      continue;
    }
    try {
      const found = inspectExecutable(binary);
      if (found.goos !== expected.goos || found.arch !== expected.arch) {
        issues.push(
          `${label}: header says ${found.goos}/${found.arch}, the package name declares `
            + `${expected.goos}/${expected.arch}`
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
 * wrong place.
 *
 * TWO assertions, because either alone is vacuous. The absence scan (node-pty's
 * loader is not in the bundle) passes trivially when nothing imports it at all,
 * which is exactly what B1 looked like before src/pty-host/index.ts took a real
 * import. The PRESENCE assertion is the one with teeth: a bare
 * `from "node-pty"` in the emitted ESM is what proves
 * `rolldownOptions.external` still holds, and it goes red both when the import
 * is dropped from the source and when `external` is removed from
 * vite.pty-host.config.ts (rolldown then inlines the module and the specifier
 * disappears).
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
  // node-pty's loader is unmistakable if it were inlined: `loadNativeModule`
  // builds its search path from the "build/Debug" + "prebuilds/" pair. The
  // CONJUNCTION matters. Scanning for either literal alone flagged this bundle
  // for a source COMMENT that merely names the packaging hazard (measured
  // 2026-08-29) - a gate that fails on prose about itself teaches people to
  // stop writing the prose.
  if (source.includes("build/Debug") && source.includes("prebuilds/")) {
    throw new Error(
      `${bundle} appears to INLINE node-pty (found its loader's build/Debug + prebuilds/ search path).\n`
        + "    node-pty must stay in `rolldownOptions.external` in vite.pty-host.config.ts."
    );
  }

  // A bare specifier, not a relative path: `from "node-pty"` / `require("node-pty")`.
  // Anything relative would mean the module was emitted into dist/pty-host/.
  const externalReference =
    /(?:^|[\s;{,])(?:import\s[^;]*?from\s*|import\s*|require\s*\(\s*)["']node-pty["']/m;
  if (!externalReference.test(source)) {
    throw new Error(
      `${bundle} carries NO external reference to "node-pty".\n`
        + "    Either src/pty-host/index.ts dropped its import, or node-pty left\n"
        + "    `rolldownOptions.external` in vite.pty-host.config.ts and was inlined.\n"
        + "    Without this reference the externalization contract is untested."
    );
  }
}

/**
 * Both electron-builder profiles still state the single-candidate policy, and
 * they state the SAME one.
 *
 * Every string compared here comes from scripts/native-payload-contract.mjs, so
 * the unpack globs, the payload exclusions and the macOS signing list have one
 * source of truth instead of three files that happen to agree today. A
 * mismatched signing path is the failure that motivates it: `mac.binaries` and
 * `asarUnpack` pointing at different directories produces a package whose
 * spawn-helper is unpacked but unsigned, and nothing before this gate would
 * say so.
 *
 * This is a CONFIG assertion. What the packaged bytes actually contain is
 * asserted separately by scripts/check-packaged-payload.mjs against a real
 * `--dir` tree; a glob that matches nothing is not an error to
 * electron-builder, so config agreement alone proves nothing about a package.
 */
function checkPackagingPolicyConfig(root) {
  const profiles = ["electron-builder.yml", "electron-builder.release.yml"];
  const probes = [
    {
      glob: SELECTED_ASAR_UNPACK_GLOBS[0],
      probe: path.join(root, "node_modules", "node-pty", "prebuilds"),
    },
    {
      // The glob is a wildcard over the per-platform packages; this probe only
      // proves the scope exists, and checkParcelWatcher verifies the concrete
      // package for this host.
      glob: SELECTED_ASAR_UNPACK_GLOBS[1],
      probe: path.join(root, "node_modules", "@parcel"),
    },
    ...WS_ACCELERATOR_MODULES.map(({ packageName }) => ({
      glob: `node_modules/${packageName}/prebuilds/**`,
      probe: path.join(root, "node_modules", packageName, "prebuilds"),
    })),
  ];

  const issues = [];
  for (const profile of profiles) {
    const file = path.join(root, profile);
    if (!existsSync(file)) {
      issues.push(`${profile}: missing`);
      continue;
    }
    const config = readFileSync(file, "utf8");
    for (const glob of SELECTED_ASAR_UNPACK_GLOBS) {
      if (!config.includes(glob)) {
        issues.push(`${profile}: asarUnpack is missing \`${glob}\``);
      }
    }
    for (const pattern of EXCLUDED_CANDIDATE_FILE_PATTERNS) {
      if (!config.includes(pattern)) {
        issues.push(
          `${profile}: \`files\` is missing ${pattern}, so a non-selected native `
            + "candidate can enter the payload"
        );
      }
    }
    if (!config.includes(REBUILD_DISABLED_LINE)) {
      issues.push(
        `${profile}: missing \`${REBUILD_DISABLED_LINE}\`; electron-builder rebuilds `
          + "native deps by DEFAULT, which plants a build/Release that outranks the "
          + "reviewed node-pty prebuilds"
      );
    }
    for (const binary of MAC_SIGNED_NATIVE_BINARIES) {
      if (!config.includes(binary)) {
        issues.push(`${profile}: \`mac.binaries\` is missing \`${binary}\` (would ship unsigned)`);
      }
    }
    if (!config.includes("dist/pty-host/**")) {
      issues.push(`${profile}: \`files\` is missing \`dist/pty-host/**\``);
    }
  }
  for (const { glob, probe } of probes) {
    if (!existsSync(probe)) {
      issues.push(`asarUnpack \`${glob}\` matches nothing: ${probe} does not exist`);
    }
  }

  if (issues.length > 0) {
    throw new Error(`packaging policy issues:\n    ${issues.join("\n    ")}`);
  }
}

/**
 * Checks in the shape `check-build-artifacts.mjs` runs: `{ label, run(root) }`,
 * where `run` throws with a diagnostic on violation.
 */
export const nativeArtifactChecks = [
  {
    label: "pty-host bundle - exists and keeps node-pty external",
    run: checkPtyHostBundle,
  },
  {
    label: "node-pty prebuilds - present, right architecture, spawn-helper executable",
    run: checkNodePtyPrebuilds,
  },
  {
    label: "@parcel/watcher - native backend installed for this host",
    run: checkParcelWatcher,
  },
  {
    label:
      "electron-builder - one native candidate per module: rebuild off, "
      + "non-selected candidates excluded, selected ones unpacked and mac-signed",
    run: checkPackagingPolicyConfig,
  },
];
