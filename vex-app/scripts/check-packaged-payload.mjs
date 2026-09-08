#!/usr/bin/env node
/**
 * The PACKAGED PAYLOAD gate: what electron-builder actually produced, not what
 * the config says it should have.
 *
 * Every other native check in this repository reads node_modules or greps a
 * YAML file. Neither can see the failure that matters: a glob that matches
 * nothing is not an error to electron-builder, a `files` exclusion that misses
 * pnpm's store layout silently ships the file anyway, and Electron's smart-ASAR
 * fallback can make a mispackaged native module keep working on the developer's
 * platform while failing on a signed macOS build. So this runs over the real
 * `--dir` tree and asserts three things per packaged app:
 *
 *   1. the SELECTED native candidates are present, UNPACKED (outside app.asar,
 *      where they can be dlopen'd), architecture-correct for the arch that app
 *      was packaged for, and still executable where that matters;
 *   2. the EXCLUDED candidates are ABSENT - from the asar's file list and from
 *      the unpacked tree alike. This is the assertion that makes
 *      "one loadable candidate per module" a fact rather than an intention:
 *      node-pty searches build/Release BEFORE prebuilds/, so a build/ surviving
 *      into the payload silently demotes the reviewed, signed artifact;
 *   3. nothing outside the reviewed paths carries a stray `.node`;
 *   4. (CLI only, POST-SIGNING) the Lighter signer helpers are present and, in
 *      an app that is itself signed, carry a valid platform signature - the
 *      failure `build/afterPack.mjs` cannot see, because it runs before
 *      codesign.
 *
 * One nuance in (1): a module that is OPTIONAL with a working fallback
 * (bufferutil, utf-8-validate - see native-payload-contract.mjs) may be absent
 * for a target its upstream publishes no prebuild for. That is reported as a
 * named DEGRADE rather than a failure. Anything actually shipped is still held
 * to the full present-unpacked-arch-correct contract.
 *
 * The architecture check reads each binary's own ELF/Mach-O/PE header through
 * `inspectExecutable`, so a macOS x64 bundle that quietly received arm64
 * artifacts fails here rather than on a user's machine.
 *
 * TWO ENTRY POINTS, one body. `checkPayload(appOutDir, platform, arch)` is the
 * importable core: build/afterPack.mjs calls it per packaged app with the
 * target electron-builder actually packaged for, which is what puts this
 * contract on the PRODUCTION path - the release workflow packages and uploads
 * in one `--publish always` invocation and never gets to run a separate CLI
 * gate, so a violation caught only by the CLI would already be on GitHub.
 *
 * Run the CLI: `pnpm --dir vex-app check:package` after `electron-builder --dir`
 * (wired into the `package` script). Give it `--payload <dir>` to point at one
 * specific packaged app; with no argument it checks every packaged app it finds
 * under dist-electron/ and FAILS if there are none - a gate that silently
 * skips is not a gate.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync, constants } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import asar from "@electron/asar";

import {
  GO_ARCH_BY_ELECTRON_ARCH,
  GOOS_BY_ELECTRON_PLATFORM,
  inspectExecutable,
} from "./bridge-artifact.mjs";
import {
  discoverPayloads,
  FORBIDDEN_PAYLOAD_FRAGMENTS,
  nodePtyPrebuildDir,
  parcelWatcherPackageName,
  PAYLOAD_DIR_TARGETS,
  resolvePayload,
  resolvePayloadForTarget,
  UNDECIDED_NATIVE_MODULES,
  WS_ACCELERATOR_MODULES,
  wsAcceleratorPrebuildDir,
} from "./native-payload-contract.mjs";
import {
  lighterSignerBinaryName,
  lighterSignerTargetsForPlatform,
  PACKAGED_LIGHTER_SIGNER_SUBPATH,
} from "./lighter-signer-artifact.mjs";

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

/** Every path inside app.asar, POSIX-normalised and relative to the archive root. */
function asarEntries(archive) {
  return asar.listPackage(archive, { isPack: false }).map((entry) => entry.replace(/^[/\\]/, "").split(path.sep).join("/"));
}

/** Every file under a directory, relative and POSIX-normalised. */
function walkFiles(dir, base = dir, found = []) {
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, base, found);
    else found.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return found;
}

/**
 * One native artifact: it exists at the reviewed path, and its own header
 * agrees with the arch this app was packaged for.
 */
function assertArtifact(file, label, target, issues, { executable = false } = {}) {
  if (!existsSync(file)) {
    issues.push(`${label}: MISSING from the payload at ${file}`);
    return;
  }
  const expectedGoos = GOOS_BY_ELECTRON_PLATFORM[target.platform];
  const expectedArch = GO_ARCH_BY_ELECTRON_ARCH[target.arch];
  try {
    const found = inspectExecutable(file);
    if (found.goos !== expectedGoos || found.arch !== expectedArch) {
      issues.push(
        `${label}: header says ${found.goos}/${found.arch}, this app was packaged for ${expectedGoos}/${expectedArch}`
      );
    }
  } catch (error) {
    issues.push(`${label}: ${error.message}`);
  }
  // Windows has no POSIX permission bits, and a payload built ON Windows would
  // fail this for a reason unrelated to the artifact.
  if (executable && process.platform !== "win32") {
    const mode = statSync(file).mode;
    if ((mode & constants.S_IXUSR) === 0) {
      issues.push(`${label}: lost its executable bit in packaging (mode ${(mode & 0o777).toString(8)})`);
    }
  }
}

function inspectPayload(payload) {
  const { target, resources } = payload;
  const issues = [];
  /** Tolerated, NAMED losses of an optional capability. Never silent. */
  const degraded = [];

  const archive = path.join(resources, "app.asar");
  const unpacked = path.join(resources, "app.asar.unpacked");
  if (!existsSync(archive)) {
    issues.push(`no app.asar at ${archive}`);
    return { issues, undecided: [], degraded };
  }
  if (!existsSync(unpacked)) {
    issues.push(
      `no app.asar.unpacked at ${unpacked}; every native module is inside the `
        + "archive, where it cannot be dlopen'd"
    );
    return { issues, undecided: [], degraded };
  }

  const unpackedModules = path.join(unpacked, "node_modules");

  // 1a. node-pty: the SELECTED prebuild for this target, unpacked.
  const prebuildDir = path.join(unpackedModules, ...nodePtyPrebuildDir(target.platform, target.arch).split("/"));
  if (target.platform === "win32") {
    // node-pty 1.2.0-beta.15 ships ConPTY on Windows: no pty.node there.
    for (const name of ["conpty.node", "conpty_console_list.node"]) {
      assertArtifact(path.join(prebuildDir, name), `node-pty ${name}`, target, issues);
    }
  } else {
    assertArtifact(path.join(prebuildDir, "pty.node"), "node-pty pty.node", target, issues);
  }
  if (target.platform === "darwin") {
    // The executable node-pty forks to set up the child's controlling
    // terminal. It must keep its exec bit through packaging, and it is the
    // artifact `mac.binaries` signs - a different path here than in the
    // signing list would ship it unsigned into a hardened runtime.
    assertArtifact(path.join(prebuildDir, "spawn-helper"), "node-pty spawn-helper", target, issues, {
      executable: true,
    });
  }

  // 1b. @parcel/watcher: the SELECTED per-platform package, unpacked. Its
  // absence is fatal by design - the parent's source build is excluded from the
  // payload, so there is deliberately nothing left to degrade to. On macOS this
  // is what turns "pnpm installed only the host arch's optional package" into a
  // red build instead of an app that silently cannot watch files.
  const watcherPackage = parcelWatcherPackageName(target.platform, target.arch);
  assertArtifact(
    path.join(unpackedModules, ...watcherPackage.split("/"), "watcher.node"),
    `${watcherPackage}/watcher.node`,
    target,
    issues
  );

  // 1c. bufferutil / utf-8-validate: the SELECTED prebuild for this target,
  // unpacked - WHEN the module made it into the payload at all. These are `ws`
  // accelerators with a pure-JS fallback, and their prebuilds cover only
  // darwin-x64/arm64, linux-x64 and win32-x64/ia32, so a linux-arm64 or
  // win32-arm64 package legitimately has none and runs the fallback. That is a
  // named DEGRADE, printed every run, not a failure - the opposite of
  // @parcel/watcher above, which has nothing to degrade to. What is NOT
  // tolerated is a present-but-wrong artifact: anything that IS shipped is held
  // to the same arch contract as every other selected candidate.
  for (const { packageName, binary } of WS_ACCELERATOR_MODULES) {
    const moduleRoot = path.join(unpackedModules, packageName);
    const file = path.join(
      unpackedModules,
      ...wsAcceleratorPrebuildDir(packageName, target.platform, target.arch).split("/"),
      binary
    );
    if (!existsSync(moduleRoot)) {
      degraded.push(`${packageName}: not in this payload at all; ws uses its pure-JS path`);
      continue;
    }
    if (!existsSync(file)) {
      degraded.push(
        `${packageName}: no prebuild published for ${target.platform}-${target.arch}; `
          + "ws uses its pure-JS path"
      );
      continue;
    }
    assertArtifact(file, `${packageName} ${binary}`, target, issues);
  }

  // 2. The EXCLUDED candidates are absent from BOTH halves of the payload.
  const archiveEntries = asarEntries(archive);
  const unpackedEntries = walkFiles(unpacked);
  for (const [where, entries] of [
    ["app.asar", archiveEntries],
    ["app.asar.unpacked", unpackedEntries],
  ]) {
    for (const fragment of FORBIDDEN_PAYLOAD_FRAGMENTS) {
      const hits = entries.filter((entry) => entry.includes(fragment));
      if (hits.length > 0) {
        issues.push(
          `${where}: ${hits.length} path(s) under a NON-selected native candidate \`${fragment}\` `
            + `(e.g. ${hits[0]}).\n      node-pty and node-gyp-build both search build/Release BEFORE `
            + "prebuilds/, so this artifact would load INSTEAD of the reviewed, unpacked, signed one. Check "
            + "`npmRebuild: false` and the `files` exclusions in the electron-builder profile."
        );
      }
    }
  }

  // 3. No stray native binary outside the reviewed directories. Catches a new
  // native dependency arriving without a packaging decision. Modules already
  // named in UNDECIDED_NATIVE_MODULES are warned about rather than failed - see
  // that constant for why, and for the direction of travel.
  const reviewedPrefixes = [
    "node_modules/node-pty/prebuilds/",
    "node_modules/@parcel/watcher-",
    ...WS_ACCELERATOR_MODULES.map(({ packageName }) => `node_modules/${packageName}/prebuilds/`),
  ];
  const unreviewed = unpackedEntries.filter(
    (entry) => entry.endsWith(".node") && !reviewedPrefixes.some((prefix) => entry.startsWith(prefix))
  );
  const strays = unreviewed.filter(
    (entry) => !UNDECIDED_NATIVE_MODULES.some((prefix) => entry.startsWith(prefix))
  );
  const undecided = unreviewed.filter((entry) => !strays.includes(entry));
  if (strays.length > 0) {
    issues.push(
      `app.asar.unpacked carries unreviewed native binaries: ${strays.join(", ")}.\n`
        + "      Give each one a candidate decision in scripts/native-payload-contract.mjs "
        + "(and a mac signing entry if it is a bare executable)."
    );
  }

  return { issues, undecided, degraded };
}


// ── Post-signing: the Lighter signer helper's own signature ─────────────────

/**
 * Is this file signed, and does its signature verify?
 *
 * Returns `{ verified, detail }`. `verified: false` with a detail is a real
 * answer from the platform tool; a tool that is missing throws, because a gate
 * that silently degrades to "fine" when it cannot look is worse than no gate.
 *
 * Exported because it is the ONE answer in this repository to "does this file
 * carry a valid platform signature": `build/afterPack.mjs` asks the same
 * question about the Windows helper, which electron-builder signs while COPYING
 * it into resources, before afterPack runs. A second implementation there is
 * how one gate would accept what the other rejects.
 *
 * It is also the seam the tests fake: a Linux runner has neither `codesign` nor
 * `Get-AuthenticodeSignature`, and no test may hold a signing identity.
 */
export function inspectPlatformSignature(file, platform) {
  if (platform === "darwin") {
    const result = spawnSync("codesign", ["--verify", "--strict", "--verbose=2", file], {
      encoding: "utf8",
    });
    if (result.error !== undefined) {
      throw new Error(`codesign could not be run: ${result.error.message}`);
    }
    const detail = `${result.stderr ?? ""}${result.stdout ?? ""}`.trim();
    return { verified: result.status === 0, detail };
  }
  // Authenticode. `Get-AuthenticodeSignature` answers `NotSigned`,
  // `HashMismatch`, `UnknownError` or `Valid`; only `Valid` is a signature that
  // both exists and verifies against the file's current bytes.
  const literal = file.replace(/'/g, "''");
  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", `(Get-AuthenticodeSignature -LiteralPath '${literal}').Status`],
    { encoding: "utf8" }
  );
  if (result.error !== undefined) {
    throw new Error(`powershell Get-AuthenticodeSignature could not be run: ${result.error.message}`);
  }
  const detail = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return { verified: detail.split(/\r?\n/)[0]?.trim() === "Valid", detail };
}

/**
 * THE POST-SIGNING GATE for the Lighter signer helper.
 *
 * `build/afterPack.mjs` proves the helper's PROVENANCE while it still can (see
 * that file for the per-platform order: on macOS and Linux the packaged bytes
 * are still the unsigned build output; on Windows they are already Authenticode
 * signed). It cannot prove the thing that
 * actually breaks in production: on macOS a nested Mach-O executable that
 * @electron/osx-sign never signed is refused by the hardened runtime and
 * rejected by notarization, and the helper is exactly such an executable (no
 * file extension, so the default nested-binary walker skips it - which is why
 * `mac.binaries` names it explicitly in both profiles). The equivalent on
 * Windows is a helper missing the Authenticode signature the installer carries.
 *
 * The rule is RELATIVE to the app itself, deliberately: if the packaged app is
 * signed, an unsigned helper beside it is a failure; if the app is unsigned (an
 * ordinary local `--dir` build with no identity), there is no signature to
 * expect and that is REPORTED as a note rather than silently skipped. Linux
 * packages carry no platform signature at all, which is also a note.
 *
 * BOTH signing platforms are asserted here, by the same three sentences: macOS
 * through `codesign --verify --strict`, Windows through
 * `Get-AuthenticodeSignature`. The release workflow runs this step after
 * electron-builder has signed, on the macOS job and on the Windows job alike.
 *
 * `inspectSignature` and `host` are the test seam and nothing else:
 * `inspectSignature` is the platform signature tool (defaulting to the real
 * one) and `host` is the platform this process runs on, so a Linux test can
 * drive the Windows branch without a signing identity or a Windows runner.
 *
 * Returns `{ issues, notes }`.
 */
export function verifyPackagedLighterSignerSignature(
  payload,
  { inspectSignature = inspectPlatformSignature, host = process.platform } = {}
) {
  const { target, resources } = payload;
  const issues = [];
  const notes = [];
  const signerDir = path.join(resources, PACKAGED_LIGHTER_SIGNER_SUBPATH);
  const helpers = lighterSignerTargetsForPlatform(target.platform).map((entry) =>
    path.join(signerDir, lighterSignerBinaryName(entry))
  );

  for (const helper of helpers) {
    if (!existsSync(helper)) {
      issues.push(`Lighter signer helper MISSING from the payload at ${helper}`);
    }
  }
  if (issues.length > 0) return { issues, notes };

  if (target.platform === "linux") {
    notes.push("Linux packages carry no platform code signature; the helper is verified by digest only");
    return { issues, notes };
  }
  if (target.platform !== host) {
    notes.push(
      `the ${target.platform} helper signatures cannot be verified from a ${host} host; `
        + `this evidence comes from the ${target.platform} CI job and the owner's signed build`
    );
    return { issues, notes };
  }

  const appBinary = target.platform === "darwin"
    ? path.dirname(path.dirname(resources))
    : findWindowsAppExecutable(path.dirname(resources));
  if (appBinary === undefined) {
    notes.push("no packaged application executable found beside the resources directory; signatures not compared");
    return { issues, notes };
  }

  let app;
  try {
    app = inspectSignature(appBinary, target.platform);
  } catch (error) {
    issues.push(`the signing tool for ${target.platform} is unavailable: ${error.message}`);
    return { issues, notes };
  }
  if (!app.verified) {
    notes.push(
      `${path.basename(appBinary)} itself carries no valid signature (an unsigned local build), `
        + "so the helper signatures are not asserted for this payload"
    );
    return { issues, notes };
  }

  for (const helper of helpers) {
    let signature;
    try {
      signature = inspectSignature(helper, target.platform);
    } catch (error) {
      issues.push(`${path.basename(helper)}: ${error.message}`);
      continue;
    }
    if (!signature.verified) {
      issues.push(
        `${path.basename(helper)} is NOT signed (or its signature does not verify) inside a SIGNED app: `
          + `${signature.detail || "no detail reported"}.\n`
          + "      Add it to `mac.binaries` (macOS) or the Windows signing list in the "
          + "electron-builder profile: an unsigned nested executable is refused by the hardened "
          + "runtime and rejected by notarization, so the app would ship unable to sign a Lighter order."
      );
    }
  }
  return { issues, notes };
}

/** The packaged Windows application executable beside `resources/`. */
function findWindowsAppExecutable(appOutDir) {
  if (!existsSync(appOutDir)) return undefined;
  const executables = readdirSync(appOutDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".exe"))
    .map((entry) => path.join(appOutDir, entry.name));
  return executables.length === 1 ? executables[0] : undefined;
}

/**
 * The contract over ONE packaged app, addressed by the target it was packaged
 * for rather than by directory name.
 *
 * `appOutDir` is electron-builder's per-arch output directory (the afterPack
 * context field of the same name); `platform` is `electronPlatformName`
 * (darwin/win32/linux) and `arch` its resolved name (x64/arm64). Returns the
 * same three channels the CLI prints: `issues` are failures, `degraded` are the
 * named, tolerated losses of an optional capability, `undecided` are native
 * artifacts from modules still owed a candidate decision. `label` identifies
 * the app in a message.
 */
export function checkPayload(appOutDir, platform, arch) {
  const target = { platform, arch };
  const label = `${path.basename(appOutDir)} (${platform}/${arch})`;
  if (GOOS_BY_ELECTRON_PLATFORM[platform] === undefined || GO_ARCH_BY_ELECTRON_ARCH[arch] === undefined) {
    // Refused by NAME rather than checked against undefined expectations: an
    // arch this contract has never reviewed (a mac `universal` merge, say) must
    // not pass by comparing two undefineds.
    return {
      label,
      issues: [`no native payload contract for ${platform}/${arch}; this target has never been reviewed`],
      undecided: [],
      degraded: [],
    };
  }
  const payload = resolvePayloadForTarget(appOutDir, target);
  if (payload === undefined) {
    return { label, issues: [`no packaged app at ${appOutDir}`], undecided: [], degraded: [] };
  }
  return { label, ...inspectPayload(payload) };
}

function main() {
  const root = path.resolve(process.cwd());
  const explicit = process.argv.indexOf("--payload");
  let payloads;
  if (explicit !== -1) {
    const dir = process.argv[explicit + 1];
    if (dir === undefined) {
      console.error("--payload needs a directory (e.g. dist-electron/linux-unpacked)");
      process.exit(1);
    }
    const payload = resolvePayload(path.resolve(root, dir));
    if (payload === undefined) {
      console.error(
        `${dir} is not a recognised electron-builder --dir output. Known names: `
          + `${Object.keys(PAYLOAD_DIR_TARGETS).join(", ")}`
      );
      process.exit(1);
    }
    payloads = [payload];
  } else {
    payloads = discoverPayloads(root);
  }

  if (payloads.length === 0) {
    console.error(
      `${RED}No packaged app found under dist-electron/.${RESET}\n`
        + "  This gate asserts the REAL packaged payload, so it fails rather than passing\n"
        + "  vacuously. Run `pnpm --dir vex-app package` (electron-builder --dir) first."
    );
    process.exit(1);
  }

  let failed = 0;
  for (const payload of payloads) {
    const { issues, undecided, degraded } = inspectPayload(payload);
    // Post-signing, and CLI-only: `build/afterPack.mjs` runs BEFORE codesign,
    // where no helper signature exists yet.
    const signatures = verifyPackagedLighterSignerSignature(payload);
    issues.push(...signatures.issues);
    const label = `${payload.label} (${payload.target.platform}/${payload.target.arch})`;
    for (const note of signatures.notes) {
      console.log(`${YELLOW}!${RESET} ${label}: Lighter signer signature check - ${note}`);
    }
    if (degraded.length > 0) {
      // An accepted, documented capability loss. Printed by name every run so
      // "this target ships no native ws accelerator" is a fact someone chose to
      // live with, not one nobody noticed.
      console.log(`${YELLOW}!${RESET} ${label}: ${degraded.length} optional native module(s) DEGRADED to a JS fallback:`);
      for (const entry of degraded) console.log(`    ${entry}`);
    }
    if (undecided.length > 0) {
      // Printed every run, by name. An owed decision that nobody sees is the
      // same as no decision at all.
      console.log(
        `${YELLOW}!${RESET} ${label}: ${undecided.length} native artifact(s) from modules with NO `
          + "candidate decision yet (UNDECIDED_NATIVE_MODULES in native-payload-contract.mjs):"
      );
      for (const entry of undecided) console.log(`    ${entry}`);
    }
    if (issues.length === 0) {
      console.log(
        `${GREEN}✓${RESET} ${label} - one native candidate per module, all reviewed; `
          + "Lighter signer helper present and consistent with the app's signing state"
      );
    } else {
      failed += 1;
      console.log(`${RED}✗${RESET} ${label}`);
      for (const issue of issues) console.log(`    ${issue}`);
    }
  }

  if (failed > 0) {
    console.log(`\n${RED}${failed} packaged payload(s) FAILED the native candidate contract.${RESET}\n`);
    process.exit(1);
  }
  console.log(`\n${GREEN}All packaged payloads passed the native candidate contract.${RESET}\n`);
}

// CLI only when RUN as a script. build/afterPack.mjs imports `checkPayload`
// from this module, and a bare top-level CLI would run the dist-electron scan
// (and its `process.exit(1)` when nothing is packaged yet) on import.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
