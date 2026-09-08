/**
 * PREFLIGHT: stage the Lighter signer helpers for ONE packaging platform, or
 * fail the build.
 *
 * Runs before electron-builder in every packaging path, exactly like
 * `stage-bridge.mjs`, and for the same fail-closed reason: electron-builder 26
 * only warns on a missing `extraResources` source, so without this step a tag
 * could publish an app whose order-signing helper is missing or built for
 * another machine.
 *
 * It also fixes a second, quieter defect. `extraResources` used to copy the
 * whole built directory with a `vex-lighter-signer-*` filter, so every artifact
 * carried all SIX helpers: a macOS bundle shipped two Windows PE files and two
 * Linux ELF files it can never execute, and each of them was one more unsigned
 * binary inside a notarized bundle. Staging selects the two helpers for the
 * platform being packaged, and the packaged-tree gate in `build/afterPack.mjs`
 * refuses any extra.
 *
 * BOTH ARCHITECTURES of the platform are staged, unlike the bridge's per-arch
 * directories: `mac.binaries` in both electron-builder profiles names the
 * arm64 AND x64 helper paths, and codesign fails on a listed path that does not
 * exist. The macOS job packages both arches in one invocation, so both helpers
 * belong in both bundles.
 *
 * The staging directory is CLEARED first, once, before anything is copied into
 * it: a leftover helper from the previous platform is the exact failure this
 * script exists to make impossible.
 *
 * Usage:
 *   node scripts/stage-lighter-signer.mjs --platform mac
 *   node scripts/stage-lighter-signer.mjs            # defaults to this host
 */

import { chmodSync, copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertLighterSignerArtifact,
  assertLighterSignerBytes,
  builtLighterSignerDir,
  lighterSignerBinaryName,
  lighterSignerTargetsForPlatform,
  readLighterSignerDigests,
  stagedLighterSignerDir,
} from "./lighter-signer-artifact.mjs";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(APP_ROOT, "..");

function parseArgs(argv) {
  let platform = process.platform;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--platform") {
      if (value === undefined) throw new Error("--platform needs a value");
      platform = value;
      i += 1;
      continue;
    }
    throw new Error(`unknown argument ${flag}; accepts --platform only`);
  }
  return { platform };
}

/**
 * Stage both helpers for one packaging platform.
 *
 * EVERY source is verified - header, machine and build-time digest - before ANY
 * file is written, so a target whose second helper is missing fails with the
 * previous staging directory intact rather than half-populated.
 *
 * Returns one entry per staged helper.
 */
export function stageLighterSigner(platform) {
  const targets = lighterSignerTargetsForPlatform(platform);
  const builtDir = builtLighterSignerDir(APP_ROOT);
  const digests = readLighterSignerDigests(builtDir);

  const verified = targets.map((target) => {
    const source = path.join(builtDir, lighterSignerBinaryName(target));
    try {
      return { target, source, inspection: assertLighterSignerBytes(source, target, digests) };
    } catch (error) {
      throw new Error(
        `the Lighter signer helper for ${target.platform}-${target.arch} is not usable: ${error.message}\n`
          + "    Build it first: node scripts/build-lighter-signer-runtime.mjs (from the repository root).\n"
          + "    Packaging without it would ship a Vex that cannot sign a Lighter order."
      );
    }
  });

  const destinationDir = stagedLighterSignerDir(APP_ROOT);
  rmSync(destinationDir, { recursive: true, force: true });
  mkdirSync(destinationDir, { recursive: true });
  // Build output, never source. The directory is recreated on every staging
  // run, so it carries its own ignore rule rather than relying on a pattern in
  // the repository root that a future rename would silently outdate.
  writeFileSync(path.join(destinationDir, ".gitignore"), "*\n");

  return verified.map(({ target, source, inspection }) => {
    const destination = path.join(destinationDir, lighterSignerBinaryName(target));
    copyFileSync(source, destination);
    // Executable for everyone, writable only by the owner. electron-builder
    // preserves the mode into the package, and a helper without the execute bit
    // is a helper the main process cannot spawn.
    chmodSync(destination, 0o755);

    // Re-read the STAGED file: this is the byte sequence that gets packaged.
    assertLighterSignerArtifact(destination, target);
    return { name: lighterSignerBinaryName(target), source, destination, inspection };
  });
}

function main() {
  const { platform } = parseArgs(process.argv.slice(2));
  for (const staged of stageLighterSigner(platform)) {
    console.log(
      `lighter-signer: staged ${path.relative(REPO_ROOT, staged.source)} -> `
        + `${path.relative(REPO_ROOT, staged.destination)} `
        + `(${staged.inspection.format} ${staged.inspection.goos}/${staged.inspection.arch} `
        + `sha256 ${staged.inspection.digest})`
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(1);
  }
}
