/**
 * PREFLIGHT: stage the Vex Studio bridge binaries for one packaging target, or
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
 * The staging directory is CLEARED first, ONCE, before any artifact is copied
 * into it. A leftover binary from the previous architecture is the failure mode
 * this script exists to make impossible, and a copy alone would leave `vex-mcp`
 * beside `vex-mcp.exe`.
 *
 * That clear now has a second job, and the reason it stays a single `rmSync` at
 * the top rather than a per-file delete: the directory legitimately holds MORE
 * THAN ONE name. On Windows it carries `vex-mcp.exe` and `vex-pipe-front.exe`,
 * and the whole directory is what `extraResources` copies into the package. So
 * "clear, then write exactly the artifacts the table lists for this target" is
 * what makes the staged set EXACTLY the shipped set - a per-file overwrite
 * would leave a Windows staging directory's `vex-pipe-front.exe` in place while
 * re-staging for macOS, and ship it.
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
  artifactBinaryName,
  artifactsFor,
  assertBridgeArtifact,
  builtArtifactPath,
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

/**
 * Stage every artifact the table lists for one Electron platform/arch.
 *
 * Returns one entry per staged artifact. EVERY source is verified before ANY
 * file is written: a target whose second artifact is missing must fail with the
 * previous staging directory intact, not with a half-populated one that a later
 * step could mistake for a complete set.
 */
export function stageBridge(electronPlatform, electronArch) {
  const { goos, goarch } = goTargetFor(electronPlatform, electronArch);
  const artifacts = artifactsFor(goos, goarch);

  const verified = artifacts.map((artifact) => {
    const source = builtArtifactPath(REPO_ROOT, artifact, goos, goarch);
    try {
      return { artifact, source, inspection: assertBridgeArtifact(source, goos, goarch) };
    } catch (error) {
      throw new Error(
        `the Vex Studio ${artifact.name} for ${goos}-${goarch} is not usable: ${error.message}\n`
          + `    Build it first: bridge/build.sh ${goos} ${goarch}\n`
          + "    Packaging without it would ship a Vex whose MCP clients cannot start."
      );
    }
  });

  const destinationDir = stagedBridgeDir(APP_ROOT, electronArch);
  rmSync(destinationDir, { recursive: true, force: true });
  mkdirSync(destinationDir, { recursive: true });

  return verified.map(({ artifact, source, inspection }) => {
    const destination = path.join(destinationDir, artifactBinaryName(artifact, goos));
    copyFileSync(source, destination);
    // Executable for everyone, writable only by the owner. electron-builder
    // preserves the mode into the package, and a bridge without the execute bit
    // is a bridge the client cannot spawn.
    chmodSync(destination, 0o755);

    // Re-read the STAGED file, not the source: this is the byte sequence that
    // will actually be packaged.
    assertBridgeArtifact(destination, goos, goarch);
    return { name: artifact.name, source, destination, inspection };
  });
}

function main() {
  const { platform, arches } = parseArgs(process.argv.slice(2));
  for (const arch of arches) {
    for (const staged of stageBridge(platform, arch)) {
      console.log(
        `bridge: staged ${path.relative(REPO_ROOT, staged.source)} -> `
          + `${path.relative(REPO_ROOT, staged.destination)} `
          + `(${staged.inspection.format} ${staged.inspection.goos}/${staged.inspection.arch})`
      );
    }
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
