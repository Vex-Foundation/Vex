/**
 * Electron Fuses applied in afterPack hook (skill §7), plus the Vex Studio
 * bridge and Lighter signer helper re-inspection.
 * Flips fuses BEFORE codesigning so signature covers the modified binary.
 *
 * Mandatory production-grade flags (even for unsigned dev builds):
 *   - RunAsNode: false
 *   - EnableNodeOptionsEnvironmentVariable: false
 *   - EnableNodeCliInspectArguments: false
 *   - EnableEmbeddedAsarIntegrityValidation: true
 *   - OnlyLoadAppFromAsar: true
 *   - EnableCookieEncryption: true
 *   - GrantFileProtocolExtraPrivileges: false
 *
 * Run via electron-builder `afterPack` hook.
 */

import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { flipFuses, FuseVersion, FuseV1Options } from "@electron/fuses";

import { artifactBinaryName, artifactsFor, assertBridgeArtifact, goTargetFor, PACKAGED_BRIDGE_SUBPATH } from "../scripts/bridge-artifact.mjs";
import { checkPayload, inspectPlatformSignature } from "../scripts/check-packaged-payload.mjs";
import {
  assertLighterSignerArtifact,
  assertLighterSignerBytes,
  builtLighterSignerDir,
  LIGHTER_SIGNER_DIGEST_FILE,
  lighterSignerBinaryName,
  lighterSignerTargetsForPlatform,
  PACKAGED_LIGHTER_SIGNER_SUBPATH,
  readLighterSignerDigests,
  sha256OfFile,
} from "../scripts/lighter-signer-artifact.mjs";

/**
 * The Vex Studio bridge artifacts, re-inspected where electron-builder
 * actually PUT them.
 *
 * `scripts/stage-bridge.mjs` already verified the binaries before packaging
 * began, but that proves the staging directory, not the package. Between the
 * two sits `extraResources` copying, an arch loop that can run several times
 * in one invocation, and any future config edit that repoints the mapping.
 * This is the check that the shipped bundle carries the right executables, and
 * it runs before the app bundle is codesigned, so a failure costs no signature.
 * It reads each file's own header only, which Authenticode does not touch, so
 * it is equally valid on Windows, where electron-builder has already signed
 * these `.exe` files while copying them in (winPackager.js
 * `createTransformerForExtraFiles`).
 *
 * WHICH artifacts is the table's answer, not this hook's: `vex-pipe-front` is
 * built for Windows only, so `artifactsFor` returns one entry on darwin and
 * linux and two on win32. Hard-coding the Windows-only name here would have
 * failed every macOS package; hard-coding only `vex-mcp` would have let a
 * Windows package ship without the front and pass every gate.
 *
 * Exported so a test can drive THIS function over a synthetic packaged tree.
 * The default export cannot serve that purpose: it also flips Electron fuses
 * and asserts the native payload, neither of which exists in a fake tree, so a
 * test that went through it would have to fake enough of electron-builder to
 * stop proving anything about this check. Returns the artifact names it
 * accepted.
 */
export async function verifyPackagedBridge(context) {
  const { electronPlatformName, appOutDir, arch, packager } = context;
  const { goos, goarch } = goTargetFor(electronPlatformName, Arch[arch] ?? String(arch));

  const resourcesDir = electronPlatformName === "darwin"
    ? path.join(appOutDir, `${packager.appInfo.productFilename}.app`, "Contents", "Resources")
    : path.join(appOutDir, "resources");

  const accepted = [];
  for (const artifact of artifactsFor(goos, goarch)) {
    const packaged = path.join(
      resourcesDir,
      PACKAGED_BRIDGE_SUBPATH,
      artifactBinaryName(artifact, goos)
    );
    try {
      const found = assertBridgeArtifact(packaged, goos, goarch);
      console.log(
        `afterPack: Vex Studio ${artifact.name} OK at ${packaged} `
          + `(${found.format} ${found.goos}/${found.arch})`
      );
      accepted.push(artifact.name);
    } catch (error) {
      throw new Error(
        `the packaged Vex Studio ${artifact.name} is wrong or missing: ${error.message}\n`
          + "    electron-builder only WARNS on a missing extraResources source, so this is "
          + "the gate that stops an unusable package from being signed and published."
      );
    }
  }
  return accepted;
}

/**
 * ONE packaged helper: right format, right machine, and provenance proven the
 * way this platform's packaging order allows.
 *
 * Returns the header inspection plus `digest` and `provenance`, which is
 * `"build-digest"` when the packaged bytes are still the ones SHA256SUMS
 * records and `"staged-digest+authenticode"` when Windows signing changed them.
 * Throws with the mismatch named. See `verifyPackagedLighterSigner` for why the
 * two platforms differ.
 */
function verifyOnePackagedHelper(packaged, target, digests, electronPlatformName, inspectSignature) {
  if (electronPlatformName !== "win32") {
    return { ...assertLighterSignerBytes(packaged, target, digests), provenance: "build-digest" };
  }

  const found = assertLighterSignerArtifact(packaged, target);
  const name = lighterSignerBinaryName(target);
  const expected = digests.get(name);
  if (expected === undefined) {
    throw new Error(`${name} is not listed in ${LIGHTER_SIGNER_DIGEST_FILE}; it was not built here`);
  }
  const digest = sha256OfFile(packaged);
  if (digest === expected) {
    // Unsigned Windows build: nothing rewrote the file on its way in.
    return { ...found, digest, provenance: "build-digest" };
  }

  let signature;
  try {
    signature = inspectSignature(packaged, "win32");
  } catch (error) {
    throw new Error(
      `${packaged} has sha256 ${digest}, but ${LIGHTER_SIGNER_DIGEST_FILE} records ${expected} for `
        + `${name}. On Windows that is expected AFTER electron-builder signs the helper while `
        + `copying it into resources, so the signature is what has to prove it - and the signature `
        + `tool could not be run: ${error.message}`
    );
  }
  if (!signature.verified) {
    throw new Error(
      `${packaged} has sha256 ${digest}, but ${LIGHTER_SIGNER_DIGEST_FILE} records ${expected} for `
        + `${name}, and the packaged file carries NO valid Authenticode signature `
        + `(${signature.detail || "no detail reported"}).\n`
        + "    Signed-during-copy is the only reason these bytes may differ from the build "
        + "manifest; without a valid signature the helper is simply not the one this repository "
        + "built, and a Vex that spawns an unverified signer must never be signed."
    );
  }
  return { ...found, digest, provenance: "staged-digest+authenticode" };
}

/**
 * The Lighter signer helpers, re-inspected where electron-builder actually PUT
 * them.
 *
 * TWO DIFFERENT FACTS, deliberately separated, because a single "digest equals
 * SHA256SUMS" assertion conflates them and is FALSE on a signed Windows build:
 *
 *   PROVENANCE - these bytes are what the pinned Go toolchain produced.
 *   PACKAGING INTEGRITY - the right helper for this platform and arch is in the
 *   package, in one loadable place, and has not been swapped for something else
 *   on its way there.
 *
 * THE ACTUAL PER-PLATFORM ORDER, read out of the installed app-builder-lib 26
 * rather than assumed (platformPackager.js `doPack`: `copyFiles` over the
 * extraResource matchers runs BEFORE `emitAfterPack`):
 *
 *   - macOS: extraResources are copied verbatim, this hook runs, THEN
 *     `doSignAfterPack` signs the bundle (macPackager.js: `emitAfterPack` then
 *     `doAddElectronFuses` then `doSignAfterPack`). The packaged helper is
 *     still the unsigned build output here, so its sha256 must equal SHA256SUMS.
 *   - Linux: no platform signing at all; the packaged helper is the unsigned
 *     build output for the life of the artifact.
 *   - Windows: `createTransformerForExtraFiles` (winPackager.js) wraps the copy
 *     in a `CopyFileTransformer` that calls `signIf` on every `.exe` it accepts,
 *     so the helper is Authenticode-signed DURING the copy and reaches this
 *     hook ALREADY SIGNED, with different bytes. Demanding the build digest
 *     here would fail every signed Windows release while passing every unsigned
 *     local one, which is exactly the shape of defect that reaches production.
 *
 * So the assertions are:
 *
 *   1. EXACTLY the two helpers for the packaged platform are present. The
 *      `extraResources` entry used to copy the whole build directory, so every
 *      artifact shipped all six - two Windows PE files and two Linux ELF files
 *      inside a notarized macOS bundle, none of them signed, none of them
 *      executable there. A foreign helper is a failure, not a curiosity.
 *   2. Each one's OWN header says it is the format and machine this package
 *      targets, so a stale copy at the right path cannot pass. Signing does not
 *      touch the PE machine field, so this holds on every platform.
 *   3. PROVENANCE, proven differently where the bytes differ:
 *        - darwin and linux: sha256 equals `SHA256SUMS`, the manifest the
 *          pinned Go toolchain wrote at build time.
 *        - win32: if the bytes still match SHA256SUMS this is an unsigned build
 *          (no certificate configured, `signFile` logs "signing is skipped" and
 *          leaves the file alone) and the digest proves provenance directly. If
 *          they do not match, the helper must carry a VALID Authenticode
 *          signature; provenance then rests on `stage-lighter-signer.mjs`, which
 *          verified header, machine and digest on these same bytes minutes
 *          earlier, and integrity on the signature, which the signing authority
 *          computed over the file electron-builder copied and which no later
 *          edit can survive.
 *
 * A byte-for-byte content comparison of the signed file against the staged one
 * is deliberately NOT attempted: stripping an Authenticode signature back out
 * of a PE requires parsing the certificate table and the checksum, that is,
 * a second PE writer in this repository whose bugs would be indistinguishable
 * from a tampered helper. "Staged bytes were verified" plus "the signature over
 * the packaged bytes verifies" is the correct pair of facts, and both are
 * evidence someone else computed.
 *
 * The post-signing gate for macOS lives in the `check:package` CLI
 * (`scripts/check-packaged-payload.mjs`), which the release workflow runs after
 * electron-builder finishes, on the Windows job as well.
 *
 * Exported so a test can drive THIS function over a synthetic packaged tree,
 * for the same reason `verifyPackagedBridge` is; `builtDir` names where the
 * digest manifest lives and defaults to this repository's build output, and
 * `inspectSignature` is the platform signature tool, faked by tests that have
 * neither a Windows host nor a signing identity. Returns the helper names it
 * accepted.
 */
export function verifyPackagedLighterSigner(
  context,
  { builtDir = builtLighterSignerDir(APP_ROOT), inspectSignature = inspectPlatformSignature } = {}
) {
  const { electronPlatformName, appOutDir, packager } = context;
  const targets = lighterSignerTargetsForPlatform(electronPlatformName);

  const resourcesDir = electronPlatformName === "darwin"
    ? path.join(appOutDir, `${packager.appInfo.productFilename}.app`, "Contents", "Resources")
    : path.join(appOutDir, "resources");
  const packagedDir = path.join(resourcesDir, PACKAGED_LIGHTER_SIGNER_SUBPATH);

  if (!existsSync(packagedDir)) {
    throw new Error(
      `the packaged Lighter signer directory is missing at ${packagedDir}.\n`
        + "    Stage it before packaging: `node scripts/stage-lighter-signer.mjs --platform "
        + `${electronPlatformName}\`. electron-builder only WARNS on a missing extraResources `
        + "source, so this is the gate that stops an app that cannot sign a Lighter order from "
        + "being signed and published."
    );
  }

  const digests = readLighterSignerDigests(builtDir);
  const expected = targets.map((target) => lighterSignerBinaryName(target));
  const present = readdirSync(packagedDir).filter((name) => name.startsWith("vex-lighter-signer-"));
  const foreign = present.filter((name) => !expected.includes(name));
  if (foreign.length > 0) {
    throw new Error(
      `the package for ${electronPlatformName} carries signer helpers for other platforms: `
        + `${foreign.join(", ")}.\n`
        + "    Only this platform's helpers may ship: an unsignable foreign executable inside a "
        + "hardened, notarized bundle is exactly what `scripts/stage-lighter-signer.mjs` exists to "
        + "prevent."
    );
  }

  const accepted = [];
  for (const target of targets) {
    const name = lighterSignerBinaryName(target);
    const packaged = path.join(packagedDir, name);
    try {
      const found = verifyOnePackagedHelper(packaged, target, digests, electronPlatformName, inspectSignature);
      console.log(
        `afterPack: Lighter signer ${name} OK at ${packaged} `
          + `(${found.format} ${found.goos}/${found.arch} sha256 ${found.digest}, `
          + `provenance: ${found.provenance})`
      );
      accepted.push(name);
    } catch (error) {
      throw new Error(
        `the packaged Lighter signer helper ${name} is wrong or missing: ${error.message}\n`
          + "    A Vex that cannot spawn a verified signer cannot place a Lighter order, and one "
          + "that spawns an unverified binary must never be signed."
      );
    }
  }
  return accepted;
}

/**
 * The one-loadable-candidate native contract, asserted on THIS packaged app.
 *
 * `pnpm check:package` asserts the same contract, but only after a separate
 * `--dir` run: the release workflow packages, signs, notarizes and UPLOADS in a
 * single `electron-builder --publish always` invocation and never reaches a
 * standalone gate, so a violation the CLI would have caught is already on
 * GitHub by the time anyone could run it. Here it fails the build instead, per
 * packaged arch, before signing - which is the only place the macOS job's
 * non-runner architecture is checked at all.
 *
 * Failures throw. A DEGRADE (an optional ws accelerator with no prebuild for
 * this target, running its JS fallback) is a documented, named warning and does
 * not stop the build; see scripts/native-payload-contract.mjs for why those two
 * modules differ from the rest.
 */
function verifyPackagedPayload(context) {
  const { electronPlatformName, appOutDir, arch } = context;
  const archName = Arch[arch] ?? String(arch);
  const { issues, degraded, undecided, label } = checkPayload(appOutDir, electronPlatformName, archName);

  for (const entry of degraded) {
    console.log(`afterPack: ${label} native payload DEGRADED to a JS fallback - ${entry}`);
  }
  for (const entry of undecided) {
    console.log(`afterPack: ${label} native artifact with no candidate decision yet - ${entry}`);
  }
  if (issues.length > 0) {
    throw new Error(
      `the packaged native payload violates the one-candidate contract for ${label}:\n`
        + issues.map((issue) => `    - ${issue}`).join("\n")
        + "\n    Policy and the selected/excluded candidates: scripts/native-payload-contract.mjs."
    );
  }
  console.log(`afterPack: ${label} native payload OK - one candidate per module, all reviewed`);
}

/**
 * electron-builder passes `arch` as its own numeric Arch enum. The names are
 * fixed by app-builder-lib and mapped here rather than imported, so this hook
 * stays a plain module with no build-time dependency on its internals.
 */
const Arch = { 0: "ia32", 1: "x64", 2: "armv7l", 3: "arm64", 4: "universal" };

/** The vex-app root, where `resources/lighter-signer/SHA256SUMS` was written. */
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export default async function afterPack(context) {
  const { electronPlatformName, appOutDir, packager } = context;

  // Fail closed before the fuses are flipped and before the APP BUNDLE is
  // codesigned: a package without its bridge must never reach a signature.
  // (The Windows `.exe` extraResources are already signed at this point; see
  // `verifyPackagedLighterSigner` for the per-platform order.)
  await verifyPackagedBridge(context);
  verifyPackagedLighterSigner(context);
  verifyPackagedPayload(context);

  let appPath;
  if (electronPlatformName === "darwin") {
    appPath = path.join(appOutDir, `${packager.appInfo.productFilename}.app`);
  } else if (electronPlatformName === "win32") {
    appPath = path.join(appOutDir, `${packager.appInfo.productFilename}.exe`);
  } else if (electronPlatformName === "linux") {
    appPath = path.join(appOutDir, packager.executableName);
  } else {
    return;
  }

  await flipFuses(appPath, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  });
}
