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
 *   3. nothing outside the reviewed paths carries a stray `.node`.
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
 * Run: `pnpm --dir vex-app check:package` after `electron-builder --dir`
 * (wired into the `package` script). Give it `--payload <dir>` to point at one
 * specific packaged app; with no argument it checks every packaged app it finds
 * under dist-electron/ and FAILS if there are none - a gate that silently
 * skips is not a gate.
 */

import { existsSync, readdirSync, statSync, constants } from "node:fs";
import path from "node:path";

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
  UNDECIDED_NATIVE_MODULES,
  WS_ACCELERATOR_MODULES,
  wsAcceleratorPrebuildDir,
} from "./native-payload-contract.mjs";

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

function checkPayload(payload) {
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
  const { issues, undecided, degraded } = checkPayload(payload);
  const label = `${payload.label} (${payload.target.platform}/${payload.target.arch})`;
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
    console.log(`${GREEN}✓${RESET} ${label} - one native candidate per module, all reviewed`);
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
