/**
 * Electron Fuses applied in afterPack hook (skill §7), plus the Vex Studio
 * bridge re-inspection.
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

import path from "node:path";
import { flipFuses, FuseVersion, FuseV1Options } from "@electron/fuses";

import { artifactBinaryName, artifactsFor, assertBridgeArtifact, goTargetFor, PACKAGED_BRIDGE_SUBPATH } from "../scripts/bridge-artifact.mjs";
import { checkPayload } from "../scripts/check-packaged-payload.mjs";

/**
 * The Vex Studio bridge artifacts, re-inspected where electron-builder
 * actually PUT them.
 *
 * `scripts/stage-bridge.mjs` already verified the binaries before packaging
 * began, but that proves the staging directory, not the package. Between the
 * two sits `extraResources` copying, an arch loop that can run several times
 * in one invocation, and any future config edit that repoints the mapping.
 * This is the check that the shipped bundle carries the right executables, and
 * it runs BEFORE codesigning so a failure costs no signature.
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

export default async function afterPack(context) {
  const { electronPlatformName, appOutDir, packager } = context;

  // Fail closed BEFORE the fuses are flipped and before codesigning: a package
  // without its bridge must never reach a signature.
  await verifyPackagedBridge(context);
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
