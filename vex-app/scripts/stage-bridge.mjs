/**
 * PREFLIGHT: stage the Vex Studio bridge binary for one packaging target, or
 * fail the build.
 *
 * Runs BEFORE electron-builder in every packaging path. electron-builder 26
 * only warns on a missing `extraResources` source and packages on, so without
 * this step a tag could publish a Vex with no bridge and nobody would learn
 * until a user's MCP client failed to start.
 *
 * Staging into `resources/bridge-<electronArch>/` rather than pointing
 * electron-builder at `bridge/dist/<goos>-<goarch>/` is deliberate:
 * electron-builder's `${arch}` macro speaks Electron's vocabulary (`x64`) and
 * the Go output speaks Go's (`amd64`), and a mapping expressed in a YAML macro
 * would be a second, silent source of truth for the packaging identity. It
 * lives here instead, in the one place that also verifies the bytes.
 *
 * The staging directory is CLEARED first. A leftover binary from the previous
 * architecture is the failure mode this script exists to make impossible, and
 * a copy alone would leave `vex-mcp` beside `vex-mcp.exe`.
 *
 * Usage:
 *   node scripts/stage-bridge.mjs --platform mac --arch arm64 --arch x64
 *   node scripts/stage-bridge.mjs            # defaults to this host
 *
 * `--arch` may repeat: the macOS release job packages both architectures in
 * ONE electron-builder invocation, so both bridges have to be staged before it
 * starts.
 */

import { copyFileSync, chmodSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertBridgeArtifact,
  bridgeBinaryName,
  builtBridgePath,
  goTargetFor,
  stagedBridgeDir,
} from "./bridge-artifact.mjs";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(APP_ROOT, "..");

function parseArgs(argv) {
  let platform = process.platform;
  const arches = [];
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--platform") {
      if (value === undefined) throw new Error("--platform needs a value");
      platform = value;
      i += 1;
      continue;
    }
    if (flag === "--arch") {
      if (value === undefined) throw new Error("--arch needs a value");
      arches.push(value);
      i += 1;
      continue;
    }
    throw new Error(`unknown argument ${flag}; accepts --platform and --arch`);
  }
  return { platform, arches: arches.length > 0 ? arches : [process.arch] };
}

export function stageBridge(electronPlatform, electronArch) {
  const { goos, goarch } = goTargetFor(electronPlatform, electronArch);
  const source = builtBridgePath(REPO_ROOT, goos, goarch);

  let inspection;
  try {
    inspection = assertBridgeArtifact(source, goos, goarch);
  } catch (error) {
    throw new Error(
      `the Vex Studio bridge for ${goos}-${goarch} is not usable: ${error.message}\n`
        + `    Build it first: bridge/build.sh ${goos} ${goarch}\n`
        + "    Packaging without the bridge would ship a Vex whose MCP clients cannot start."
    );
  }

  const destinationDir = stagedBridgeDir(APP_ROOT, electronArch);
  rmSync(destinationDir, { recursive: true, force: true });
  mkdirSync(destinationDir, { recursive: true });
  const destination = path.join(destinationDir, bridgeBinaryName(goos));
  copyFileSync(source, destination);
  // Executable for everyone, writable only by the owner. electron-builder
  // preserves the mode into the package, and a bridge without the execute bit
  // is a bridge the client cannot spawn.
  chmodSync(destination, 0o755);

  // Re-read the STAGED file, not the source: this is the byte sequence that
  // will actually be packaged.
  assertBridgeArtifact(destination, goos, goarch);
  return { source, destination, inspection };
}

function main() {
  const { platform, arches } = parseArgs(process.argv.slice(2));
  for (const arch of arches) {
    const staged = stageBridge(platform, arch);
    console.log(
      `bridge: staged ${path.relative(REPO_ROOT, staged.source)} -> `
        + `${path.relative(REPO_ROOT, staged.destination)} `
        + `(${staged.inspection.format} ${staged.inspection.goos}/${staged.inspection.arch})`
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
