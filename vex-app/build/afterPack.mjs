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
  assertLighterSignerBytes,
  assertPackagedWindowsSignerBytes,
  builtLighterSignerDir,
  LIGHTER_SIGNER_AUTHENTICODE_FILE,
  LIGHTER_SIGNER_DIGEST_FILE,
  lighterSignerBinaryName,
  lighterSignerTargetsForPlatform,
  PACKAGED_LIGHTER_SIGNER_SUBPATH,
  readLighterSignerDigests,
  stagedLighterSignerDir,
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
 * Returns the header inspection plus `digest` and `provenance`, the sentence
 * the log prints about HOW these bytes were tied to this build. Throws with the
 * mismatch named. See `verifyPackagedLighterSigner` for why the platforms
 * differ.
 */
function verifyOnePackagedHelper(packaged, target, digests, electronPlatformName, options) {
  const { builtDir, stagedDir, inspectSignature } = options;
  if (electronPlatformName !== "win32") {
    return { ...assertLighterSignerBytes(packaged, target, digests), provenance: "build digest" };
  }

  // Header, machine, and the binding between this file and the helper this
  // build produced. `assertPackagedWindowsSignerBytes` owns that rule; both
  // this hook and `check:package` ask it the same question.
  const name = lighterSignerBinaryName(target);
  const found = assertPackagedWindowsSignerBytes(packaged, target, digests, builtDir);
  if (!found.transformed) {
    // Unsigned Windows build: nothing rewrote the file on its way in, so the
    // build digest answers by itself and no signature tool is consulted.
    return { ...found, provenance: "build digest (this build is unsigned)" };
  }

  const stagedRecord = readStagedAuthenticodeDigests(stagedDir);
  const stagedContent = stagedRecord?.get(name);
  if (stagedContent !== undefined && stagedContent !== found.content) {
    throw new Error(
      `${path.join(stagedDir, LIGHTER_SIGNER_AUTHENTICODE_FILE)} records ${stagedContent} for ${name}, `
        + `but the packaged helper's Authenticode content digest is ${found.content}. The staging `
        + "preflight and the packaged file disagree about which helper this is; nothing may be "
        + "signed on that."
    );
  }

  // The second fact, and only the second: the packaged bytes carry a signature
  // the platform accepts. Provenance is already settled above.
  let signature;
  try {
    signature = inspectSignature(packaged, "win32");
  } catch (error) {
    throw new Error(
      `${packaged} is this build's ${name} (Authenticode content ${found.content}) but its signature `
        + `could not be checked: ${error.message}. A gate that cannot look must not report "fine".`
    );
  }
  if (!signature.verified) {
    throw new Error(
      `${packaged} has sha256 ${found.digest}, not the ${digests.get(name)} `
        + `${LIGHTER_SIGNER_DIGEST_FILE} records for ${name}, and it carries NO valid Authenticode `
        + `signature (${signature.detail || "no detail reported"}).\n`
        + "    Signing during the copy is the only sanctioned reason for these bytes to differ. "
        + "Without a valid signature something else rewrote the helper, and a Vex that spawns an "
        + "unverified signer must never itself be signed."
    );
  }
  return { ...found, provenance: `Authenticode content ${found.content} + valid signature` };
}

/**
 * The pre-sign content digests `scripts/stage-lighter-signer.mjs` recorded for
 * the staged Windows helpers, or `undefined` when that directory carries no
 * such manifest.
 *
 * ABSENCE IS NOT A FAILURE and presence is not the proof: the authority is the
 * build output plus `SHA256SUMS`, which the caller has already checked. This
 * manifest is the preflight's own account of the same bytes, so a disagreement
 * means the staging directory changed between the preflight and the package -
 * which is worth refusing even though no path should produce it.
 */
function readStagedAuthenticodeDigests(stagedDir) {
  if (!existsSync(path.join(stagedDir, LIGHTER_SIGNER_AUTHENTICODE_FILE))) return undefined;
  return readLighterSignerDigests(stagedDir, LIGHTER_SIGNER_AUTHENTICODE_FILE);
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
 *        - win32, bytes unchanged: an unsigned build (no certificate
 *          configured, `signFile` logs "signing is skipped" and leaves the file
 *          alone), so the same digest proves provenance directly.
 *        - win32, bytes changed: the packaged file's AUTHENTICODE CONTENT
 *          DIGEST must equal the one computed over this build's own helper -
 *          every byte a signature is allowed to rewrite excluded, and nothing
 *          else. Then, as a SECOND fact, the signature over those bytes must
 *          verify.
 *
 * WHY THE CONTENT DIGEST AND NOT THE SIGNATURE ALONE. "Signed by us" is not
 * "built by this build": our own certificate signs whatever it is handed, so a
 * helper from an OLDER RELEASE - or from another branch, or a substitution made
 * between staging and packaging - carries a signature that verifies perfectly.
 * That was a real hole in this gate (Codex review, round 1, finding A1). The
 * Authenticode content digest is exactly the byte range the signing authority
 * itself hashes, so it is stable across signing, dual signing and timestamping,
 * and it is recomputable by anyone from the build output. It is a READER over
 * the PE, never a writer: an unparsable file throws instead of passing.
 *
 * The post-signing gate lives in the `check:package` CLI
 * (`scripts/check-packaged-payload.mjs`), which the release workflow runs after
 * electron-builder finishes, on the macOS and Windows jobs alike; it asserts
 * the same content binding over the shipped payload.
 *
 * Exported so a test can drive THIS function over a synthetic packaged tree,
 * for the same reason `verifyPackagedBridge` is. `builtDir` names where the
 * build output and its digest manifest live and defaults to this repository's;
 * `stagedDir` follows it (the staging directory is its sibling, by
 * `stagedLighterSignerDir`), and `inspectSignature` is the platform signature
 * tool, faked by tests that have neither a Windows host nor a signing identity.
 * Returns the helper names it accepted.
 */
export function verifyPackagedLighterSigner(
  context,
  {
    builtDir = builtLighterSignerDir(APP_ROOT),
    stagedDir = stagedLighterSignerDir(path.resolve(builtDir, "..", "..")),
    inspectSignature = inspectPlatformSignature,
  } = {}
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
      const found = verifyOnePackagedHelper(packaged, target, digests, electronPlatformName, {
        builtDir,
        stagedDir,
        inspectSignature,
      });
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
