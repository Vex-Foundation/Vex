/**
 * The Lighter signer helper artifact: which binaries exist, where they live,
 * and what they must actually be.
 *
 * The helper is the process that holds a Lighter API private key on stdin and
 * produces signed transactions, so every gate around it is a money-path gate.
 * It is packaged the way the Vex Studio bridge is packaged, and for the same
 * reasons: electron-builder 26 only WARNS on a missing `extraResources`
 * source, so a config edit or a skipped build step would otherwise ship an app
 * whose signing helper is absent, stale, or built for another machine, and
 * nobody would learn until a user tried to place an order.
 *
 * This module is the ONE owner of:
 *   - the target table (which platform/arch pairs the helper is built for),
 *   - the file names (Electron's vocabulary, because the runtime resolver in
 *     `src/tools/lighter/signer-binary-adapter.ts` composes them from
 *     `process.platform` and `process.arch`),
 *   - the built and staged directories,
 *   - the SHA256SUMS manifest written at build time and re-read by every later
 *     gate.
 *
 * It deliberately reuses `bridge-artifact.mjs` for the executable-header
 * inspection: the question "is this file really a Mach-O for arm64" has one
 * answer in this repository, and a second implementation of it is how one gate
 * accepts what another rejects.
 *
 * WHY THE FILE NAMES CARRY THE PLATFORM (unlike the bridge, which uses one
 * name per directory): the helper's name is resolved at RUNTIME by the adapter
 * from `process.platform`/`process.arch`, so the name is part of a contract
 * that reaches beyond packaging. Renaming a file here without changing that
 * resolver ships an app that cannot find its own signer.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { inspectExecutable } from "./bridge-artifact.mjs";

/** The packaged location, relative to the app's resources directory. */
export const PACKAGED_LIGHTER_SIGNER_SUBPATH = "lighter-signer";

/** The digest manifest written by `scripts/build-lighter-signer-runtime.mjs`. */
export const LIGHTER_SIGNER_DIGEST_FILE = "SHA256SUMS";

/**
 * Every helper the Go build emits.
 *
 * `platform`/`arch` are ELECTRON's names because they are what the runtime
 * resolver sees; `goos`/`goarch` are what the compiler is asked for. Both
 * halves live in this one row so the mapping can never drift between the
 * builder, the stager and the packaged-tree gate.
 */
export const LIGHTER_SIGNER_TARGETS = Object.freeze([
  Object.freeze({ platform: "darwin", arch: "arm64", goos: "darwin", goarch: "arm64" }),
  Object.freeze({ platform: "darwin", arch: "x64", goos: "darwin", goarch: "amd64" }),
  Object.freeze({ platform: "linux", arch: "arm64", goos: "linux", goarch: "arm64" }),
  Object.freeze({ platform: "linux", arch: "x64", goos: "linux", goarch: "amd64" }),
  Object.freeze({ platform: "win32", arch: "arm64", goos: "windows", goarch: "arm64" }),
  Object.freeze({ platform: "win32", arch: "x64", goos: "windows", goarch: "amd64" }),
]);

/** electron-builder and Electron platform spellings to this table's names. */
const CANONICAL_PLATFORM = Object.freeze({
  darwin: "darwin",
  mac: "darwin",
  macos: "darwin",
  win32: "win32",
  win: "win32",
  windows: "win32",
  linux: "linux",
});

/**
 * Normalise a platform spelling, refusing an unknown one BY NAME.
 *
 * electron-builder says `darwin` in an afterPack context and `mac` on its CLI,
 * and the release workflow passes the CLI spelling to the staging script. A
 * silent fallback here would stage nothing and let the package go on.
 */
export function canonicalLighterSignerPlatform(platform) {
  const canonical = CANONICAL_PLATFORM[platform];
  if (canonical === undefined) {
    throw new Error(
      `unknown packaging platform "${platform}"; the Lighter signer maps `
        + `${Object.keys(CANONICAL_PLATFORM).join(", ")}`
    );
  }
  return canonical;
}

/** One target's file name, `.exe` on Windows and nowhere else. */
export function lighterSignerBinaryName(target) {
  const suffix = target.platform === "win32" ? ".exe" : "";
  return `vex-lighter-signer-${target.platform}-${target.arch}${suffix}`;
}

/**
 * Every helper ONE packaged platform ships.
 *
 * Both architectures, on purpose: a macOS release packages arm64 and x64 in a
 * single electron-builder invocation and `mac.binaries` names both helper
 * paths, so both must be present in each bundle or codesign fails on a path
 * that does not exist. The cost is one extra 2 MB helper per artifact; the
 * benefit is that the signing list, the staged set and the packaged set are
 * the same three sentences.
 */
export function lighterSignerTargetsForPlatform(platform) {
  const canonical = canonicalLighterSignerPlatform(platform);
  const targets = LIGHTER_SIGNER_TARGETS.filter((target) => target.platform === canonical);
  if (targets.length === 0) {
    throw new Error(`the Lighter signer builds nothing for ${canonical}`);
  }
  return targets;
}

/** Where `scripts/build-lighter-signer-runtime.mjs` writes its output. */
export function builtLighterSignerDir(appRoot) {
  return path.join(appRoot, "resources", "lighter-signer");
}

/**
 * Where `scripts/stage-lighter-signer.mjs` puts the helpers for the ONE
 * platform being packaged, and what `extraResources` copies from.
 *
 * A single directory rather than the bridge's per-arch pair: one
 * electron-builder invocation packages exactly one PLATFORM (it may package
 * several arches of it), and the platform is what selects the helper set.
 */
export function stagedLighterSignerDir(appRoot) {
  return path.join(appRoot, "resources", "lighter-signer-staged");
}

/**
 * Assert that `file` is the Lighter signer helper for exactly this target.
 *
 * Returns the header inspection; throws with the mismatch named. Format and
 * machine are read from the file's own bytes, so a stale copy that merely sits
 * at the right path cannot pass.
 */
export function assertLighterSignerArtifact(file, target) {
  const found = inspectExecutable(file);
  if (found.goos !== target.goos) {
    throw new Error(
      `${file} is a ${found.format} executable for ${found.goos}; this target needs ${target.goos}`
    );
  }
  if (found.arch !== target.goarch) {
    throw new Error(
      `${file} is a ${found.goos} executable for ${found.arch}; this target needs ${target.goarch}`
    );
  }
  return found;
}

/** The lowercase hex sha256 of a file's bytes. */
export function sha256OfFile(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/**
 * Render the digest manifest, in the `sha256sum` format so a human can check it
 * with the system tool: `<digest>  <name>`, one line per helper, sorted by name.
 */
export function renderLighterSignerDigests(entries) {
  return `${[...entries]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => `${entry.digest}  ${entry.name}`)
    .join("\n")}\n`;
}

/**
 * Read the digest manifest a build wrote, refusing a malformed line by name.
 *
 * Returns a Map from file name to digest. The manifest is a BUILD-TIME
 * artifact: it records the bytes the Go toolchain produced, which is the last
 * moment those bytes are unambiguous. On macOS and Windows the SHIPPED helper
 * is signed after packaging and no longer matches, which is why signature
 * verification is a separate, post-signing gate rather than a second digest.
 */
export function readLighterSignerDigests(dir) {
  const manifest = path.join(dir, LIGHTER_SIGNER_DIGEST_FILE);
  if (!existsSync(manifest)) {
    throw new Error(
      `missing ${manifest}. Run \`node scripts/build-lighter-signer-runtime.mjs\` from the repository root.`
    );
  }
  const digests = new Map();
  const lines = readFileSync(manifest, "utf8").split("\n");
  for (const [index, line] of lines.entries()) {
    if (line.trim().length === 0) continue;
    const match = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line);
    if (match === null) {
      throw new Error(`${manifest} line ${index + 1} is not a \`<sha256>  <name>\` record: ${line}`);
    }
    digests.set(match[2], match[1]);
  }
  if (digests.size === 0) {
    throw new Error(`${manifest} lists no helper; an empty manifest verifies nothing`);
  }
  return digests;
}

/**
 * The full contract over one helper file: right format, right machine, and the
 * exact bytes this repository's build produced.
 *
 * `digests` comes from `readLighterSignerDigests`. A helper the manifest does
 * not mention is a FAILURE rather than a skip: an unlisted binary is precisely
 * the one nobody built here.
 */
export function assertLighterSignerBytes(file, target, digests) {
  const inspection = assertLighterSignerArtifact(file, target);
  const name = lighterSignerBinaryName(target);
  const expected = digests.get(name);
  if (expected === undefined) {
    throw new Error(`${name} is not listed in ${LIGHTER_SIGNER_DIGEST_FILE}; it was not built here`);
  }
  const actual = sha256OfFile(file);
  if (actual !== expected) {
    throw new Error(
      `${file} has sha256 ${actual}, but ${LIGHTER_SIGNER_DIGEST_FILE} records ${expected} for ${name}`
    );
  }
  return { ...inspection, digest: actual };
}

/**
 * The BUILT helper set, as `{ issues, verified }`.
 *
 * Used by `check-build-artifacts.mjs`; collects rather than throws so one run
 * reports every missing or altered helper instead of the first. `verified`
 * carries the digest of each helper that passed, so the check can PRINT what it
 * accepted - a gate whose output is only "ok" cannot be compared across builds.
 */
export function evaluateBuiltLighterSigners(builtDir) {
  const issues = [];
  if (!existsSync(builtDir)) {
    return {
      issues: [
        `missing signer resource dir: ${builtDir}. `
          + "Run `node ../scripts/build-lighter-signer-runtime.mjs` from vex-app/.",
      ],
      verified: [],
    };
  }
  let digests;
  try {
    digests = readLighterSignerDigests(builtDir);
  } catch (error) {
    return { issues: [error.message], verified: [] };
  }
  const verified = [];
  for (const target of LIGHTER_SIGNER_TARGETS) {
    const name = lighterSignerBinaryName(target);
    const file = path.join(builtDir, name);
    if (!existsSync(file)) {
      issues.push(`${name}: missing`);
      continue;
    }
    try {
      const found = assertLighterSignerBytes(file, target, digests);
      verified.push({ name, digest: found.digest, format: found.format });
    } catch (error) {
      issues.push(`${name}: ${error.message}`);
    }
  }
  const unexpected = [...digests.keys()].filter(
    (name) => !LIGHTER_SIGNER_TARGETS.some((target) => lighterSignerBinaryName(target) === name)
  );
  for (const name of unexpected) {
    issues.push(`${name}: recorded in ${LIGHTER_SIGNER_DIGEST_FILE} but not a target this repository builds`);
  }
  return { issues, verified };
}
