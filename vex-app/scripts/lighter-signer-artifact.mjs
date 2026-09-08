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
 * The PRE-SIGN Authenticode content manifest `scripts/stage-lighter-signer.mjs`
 * writes beside the staged Windows helpers.
 *
 * It records `authenticodeContentSha256` over the bytes the pinned Go toolchain
 * produced, which is the ONE value that survives Authenticode signing. See that
 * function for why the plain sha256 cannot serve here.
 */
export const LIGHTER_SIGNER_AUTHENTICODE_FILE = "AUTHENTICODE-SHA256SUMS";

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
 * The sha256 of a PE file's Authenticode-covered CONTENT: every byte of the
 * executable EXCEPT the three regions signing is allowed to rewrite.
 *
 * WHY THIS EXISTS. On Windows the helper is Authenticode-signed while
 * electron-builder copies it into `resources` (app-builder-lib winPackager
 * `createTransformerForExtraFiles`), so the packaged bytes no longer match the
 * `SHA256SUMS` line the pinned Go toolchain wrote, and a plain digest can
 * prove nothing about them. A VALID SIGNATURE cannot stand in for provenance
 * either: a helper from an older release, signed by the same publisher, carries
 * a perfectly valid signature. This digest is what binds the two - it is
 * computed identically over the unsigned build output and over the signed
 * package, so "these signed bytes are that build's helper" becomes a fact
 * anyone can recompute.
 *
 * It is the same content the signing authority itself hashes: the Authenticode
 * PE algorithm (Windows Authenticode Portable Executable Signature Format,
 * section "Calculating the PE Image Hash"), which excludes
 *
 *   - the OptionalHeader CheckSum field (4 bytes), rewritten on signing,
 *   - the Certificate Table data directory entry (8 bytes), which points at the
 *     signature,
 *   - the attribute certificate table itself (the appended signature blob),
 *
 * and covers everything else, section by section, in file order. Nesting a
 * second signature (electron-builder signs sha1 then sha256 by default) only
 * grows that trailing blob, so the value is stable across dual signing and
 * across timestamping too.
 *
 * IT IS A READER, NEVER A WRITER. Stripping a signature back out of a PE would
 * mean writing one, and a PE writer's bugs are indistinguishable from a
 * tampered helper. Every unexpected shape here THROWS with the reason named:
 * this value gates a signing helper, so "could not parse" must never read as
 * "matched".
 */
export function authenticodeContentSha256(file) {
  const bytes = readFileSync(file);
  const layout = parsePeForAuthenticode(bytes, file);
  const hash = createHash("sha256");

  // 1-3: the headers, minus the checksum and the certificate table pointer.
  hash.update(bytes.subarray(0, layout.checksumOffset));
  hash.update(bytes.subarray(layout.checksumOffset + 4, layout.certificateEntryOffset));
  hash.update(bytes.subarray(layout.certificateEntryOffset + 8, layout.sizeOfHeaders));

  // 4: every section's raw data, in file order rather than table order, which
  // is what the algorithm specifies and what a linker is free to permute.
  let hashed = layout.sizeOfHeaders;
  for (const section of [...layout.sections].sort((left, right) => left.offset - right.offset)) {
    hash.update(bytes.subarray(section.offset, section.offset + section.size));
    hashed += section.size;
  }

  // 5: trailing data that belongs to no section, excluding the signature blob.
  const contentEnd = bytes.length - layout.certificateSize;
  if (contentEnd > hashed) {
    hash.update(bytes.subarray(hashed, contentEnd));
  }
  return hash.digest("hex");
}

/**
 * The offsets `authenticodeContentSha256` needs, or a refusal naming the field
 * that did not make sense. Every read is bounds-checked before it happens.
 */
function parsePeForAuthenticode(bytes, file) {
  const refuse = (reason) => {
    throw new Error(`${file} is not a PE this repository can hash for Authenticode content: ${reason}`);
  };
  if (bytes.length < 0x40 || bytes.readUInt16LE(0) !== 0x5a4d) refuse("no MZ header");
  const peOffset = bytes.readUInt32LE(0x3c);
  if (peOffset + 24 > bytes.length) refuse(`the PE header offset ${peOffset} is past the end of the file`);
  if (bytes.readUInt32LE(peOffset) !== 0x00004550) refuse(`no PE signature at offset ${peOffset}`);

  const coff = peOffset + 4;
  const sectionCount = bytes.readUInt16LE(coff + 2);
  const optionalSize = bytes.readUInt16LE(coff + 16);
  const optional = coff + 20;
  if (optional + optionalSize > bytes.length) refuse("the optional header runs past the end of the file");

  const magic = optionalSize >= 2 ? bytes.readUInt16LE(optional) : 0;
  // PE32 keeps four-byte ImageBase and BaseOfData, so its data directories
  // start 16 bytes earlier. CheckSum and SizeOfHeaders sit at the same offsets
  // in both, because they follow the fields whose width differs.
  const dataDirectories = magic === 0x20b ? optional + 112 : magic === 0x10b ? optional + 96 : refuse(
    `optional header magic 0x${magic.toString(16)} is neither PE32 nor PE32+`
  );
  const rvaAndSizes = bytes.readUInt32LE(dataDirectories - 4);
  if (rvaAndSizes < 5) refuse(`only ${rvaAndSizes} data directories, so there is no certificate table entry`);
  const certificateEntryOffset = dataDirectories + 4 * 8;
  if (certificateEntryOffset + 8 > optional + optionalSize) {
    refuse("the certificate table entry falls outside the optional header");
  }

  const checksumOffset = optional + 64;
  const sizeOfHeaders = bytes.readUInt32LE(optional + 60);
  if (sizeOfHeaders < certificateEntryOffset + 8 || sizeOfHeaders > bytes.length) {
    refuse(`SizeOfHeaders ${sizeOfHeaders} does not contain the headers it describes`);
  }

  const sectionTable = optional + optionalSize;
  if (sectionTable + sectionCount * 40 > bytes.length) refuse("the section table runs past the end of the file");
  const sections = [];
  for (let index = 0; index < sectionCount; index += 1) {
    const entry = sectionTable + index * 40;
    const size = bytes.readUInt32LE(entry + 16);
    const offset = bytes.readUInt32LE(entry + 20);
    if (size === 0) continue;
    if (offset + size > bytes.length) refuse(`section ${index} claims bytes past the end of the file`);
    sections.push({ offset, size });
  }

  const certificateOffset = bytes.readUInt32LE(certificateEntryOffset);
  const certificateSize = bytes.readUInt32LE(certificateEntryOffset + 4);
  if (certificateSize !== 0) {
    // signtool and Trusted Signing both append the attribute certificate table
    // at the very end. A signature anywhere else would make the subtraction
    // below hash the wrong range, so it is refused rather than guessed at.
    if (certificateOffset + certificateSize !== bytes.length) {
      refuse(
        `the attribute certificate table (${certificateSize} bytes at ${certificateOffset}) `
          + `does not end the ${bytes.length}-byte file`
      );
    }
  }
  return { checksumOffset, certificateEntryOffset, sizeOfHeaders, sections, certificateSize };
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
 * Read a `<sha256>  <name>` manifest, refusing a malformed line by name.
 *
 * `file` names WHICH manifest: `SHA256SUMS` (the build's own, the default) or
 * `AUTHENTICODE-SHA256SUMS` (the staged Windows helpers' pre-sign content
 * digests). Both have the same format and the same failure modes, so they have
 * one reader.
 *
 * Returns a Map from file name to digest. The manifest is a BUILD-TIME
 * artifact: it records the bytes the Go toolchain produced, which is the last
 * moment those bytes are unambiguous. On macOS and Windows the SHIPPED helper
 * is signed after packaging and no longer matches, which is why signature
 * verification is a separate, post-signing gate rather than a second digest.
 */
export function readLighterSignerDigests(dir, file = LIGHTER_SIGNER_DIGEST_FILE) {
  const manifest = path.join(dir, file);
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
 * THE WINDOWS BINDING: is this packaged `.exe` the helper THIS build produced,
 * after electron-builder was allowed to Authenticode-sign it?
 *
 * The one owner of that question, because two gates ask it - `build/afterPack.mjs`
 * on the tree electron-builder just packaged, and `scripts/check-packaged-payload.mjs`
 * on the shipped payload - and a second implementation is how one of them
 * accepts what the other rejects.
 *
 * It answers in the only two ways the packaging order allows:
 *
 *   - the packaged sha256 still equals `SHA256SUMS`: nothing rewrote the file,
 *     so this is an unsigned build and the build digest settles it
 *     (`transformed: false`);
 *   - the bytes differ: then their AUTHENTICODE CONTENT digest must equal the
 *     one computed over this build's own helper in `builtDir`, whose sha256 is
 *     checked against `SHA256SUMS` first (`transformed: true`). The caller adds
 *     the second fact, that the signature over those bytes verifies.
 *
 * Anything else throws with the reason named. Note what this refuses that a
 * signature check alone accepts: a helper from an OLDER RELEASE, signed by the
 * same publisher. Our certificate signs whatever it is given, so "signed by us"
 * was never provenance.
 *
 * Returns `{ ...inspection, digest, content, transformed }`; `content` is
 * undefined for an untouched file, which never needed the PE parsed.
 */
export function assertPackagedWindowsSignerBytes(packaged, target, digests, builtDir) {
  const inspection = assertLighterSignerArtifact(packaged, target);
  const name = lighterSignerBinaryName(target);
  const expected = digests.get(name);
  if (expected === undefined) {
    throw new Error(`${name} is not listed in ${LIGHTER_SIGNER_DIGEST_FILE}; it was not built here`);
  }
  const digest = sha256OfFile(packaged);
  if (digest === expected) {
    return { ...inspection, digest, content: undefined, transformed: false };
  }

  const built = path.join(builtDir, name);
  if (!existsSync(built)) {
    throw new Error(
      `${packaged} was rewritten on its way into the package (sha256 ${digest}, not the ${expected} `
        + `${LIGHTER_SIGNER_DIGEST_FILE} records), and ${built} is not there to bind it back to. `
        + "The build output a package is made from must still be present when it is verified."
    );
  }
  assertLighterSignerBytes(built, target, digests);
  const expectedContent = authenticodeContentSha256(built);
  const content = authenticodeContentSha256(packaged);
  if (content !== expectedContent) {
    throw new Error(
      `${packaged} is NOT this build's ${name}. Its Authenticode content digest is ${content}; the `
        + `helper this build produced hashes to ${expectedContent} (sha256 ${expected}).\n`
        + "    That digest covers every byte a signature may not touch, so signing cannot change it, "
        + "and a mismatch means a different executable: a helper from an older release, a helper "
        + "from another branch, or a substitution. A valid signature does not answer this question - "
        + "our own certificate signs whatever it is given."
    );
  }
  return { ...inspection, digest, content, transformed: true };
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
