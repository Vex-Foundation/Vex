/**
 * Build the Vex Studio bridge for this host, skipping the build when the
 * artifact on disk is already the one these sources and this toolchain produce.
 *
 * TWO CALLERS, TWO SCOPES:
 *
 *   `--current-arch`  the DEV path (`predev`). One target: this platform AND
 *                     this architecture, because that is the only binary
 *                     `locateStudioBridge` will ever look for on this machine.
 *                     Building the other architecture here would double the
 *                     cost of every fresh `pnpm dev` for a file nothing reads.
 *
 *   no flag           the PACKAGING path (`build:bridge`).
 *                     `electron-builder.yml` - the internal dev/test profile -
 *                     targets x64 AND arm64 on every platform, so
 *                     `pnpm --dir vex-app make` produces two bundles and each
 *                     needs its own bridge. Staging only the host architecture
 *                     would leave the other bundle without one, and
 *                     electron-builder 26 answers a missing `extraResources`
 *                     source with a warning rather than a failure.
 *
 * The release profile is narrower (mac arm64+x64, win x64, linux x64) and its
 * jobs call `bridge/build.sh` with explicit targets, so this script is the dev
 * and internal-packaging path only.
 *
 * A MISSING OR WRONG GO TOOLCHAIN STOPS THE RUN. It is not skipped past: a dev
 * session without a bridge is a Vex Studio that writes no coding-agent config
 * files, and the failure surfaces much later and much less clearly than here.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  GOOS_BY_ELECTRON_PLATFORM,
  assertBridgeArtifact,
  builtBridgePath,
} from "./bridge-artifact.mjs";
import {
  BRIDGE_BUILD_SCRIPT,
  evaluateBridgeFreshness,
  hashBridgeSources,
  hostGoTarget,
  resolveGoToolchain,
  writeManifest,
} from "./bridge-freshness.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function parseArgs(argv) {
  let currentArchOnly = false;
  for (const flag of argv) {
    if (flag === "--current-arch") {
      currentArchOnly = true;
      continue;
    }
    throw new Error(`unknown argument ${flag}; accepts --current-arch`);
  }
  return { currentArchOnly };
}

function targetsFor(currentArchOnly) {
  if (currentArchOnly) {
    const { goos, goarch } = hostGoTarget();
    return [{ goos, goarch }];
  }
  const goos = GOOS_BY_ELECTRON_PLATFORM[process.platform];
  if (goos === undefined) {
    throw new Error(`cannot build the Vex Studio bridge on ${process.platform}`);
  }
  return [
    { goos, goarch: "amd64" },
    { goos, goarch: "arm64" },
  ];
}

function main() {
  const { currentArchOnly } = parseArgs(process.argv.slice(2));
  const targets = targetsFor(currentArchOnly);

  const toolchain = resolveGoToolchain(REPO_ROOT);
  if (toolchain.kind === "refused") {
    throw new Error(toolchain.message);
  }

  // Hashed once: the inputs are the same for every target in this run, and
  // only the triple differs.
  const sourcesDigest = hashBridgeSources(REPO_ROOT);

  for (const { goos, goarch } of targets) {
    const freshness = evaluateBridgeFreshness({
      repoRoot: REPO_ROOT,
      goos,
      goarch,
      goVersion: toolchain.version,
      sourcesDigest,
    });
    if (freshness.kind === "fresh") {
      console.log(
        `bridge: ${goos}-${goarch} is up to date (${toolchain.version}, sources `
          + `${sourcesDigest.slice(0, 12)}); nothing to build`
      );
      continue;
    }

    console.log(`bridge: building ${goos}-${goarch} - ${freshness.reason}`);
    const result = spawnSync(
      "bash",
      [path.join(REPO_ROOT, BRIDGE_BUILD_SCRIPT), goos, goarch],
      { stdio: "inherit", cwd: REPO_ROOT }
    );
    if (result.status !== 0) {
      throw new Error(
        `${BRIDGE_BUILD_SCRIPT} ${goos} ${goarch} failed (exit ${result.status ?? "signal"}). `
          + `Go ${toolchain.version} is on PATH, so this is a build failure rather than a `
          + "missing prerequisite; the compiler's own output is above."
      );
    }

    // What the build wrote is checked BEFORE it is recorded as good. A binary
    // for the wrong machine would otherwise be stamped fresh by the manifest
    // and then rejected by the freshness check on every later run, turning a
    // loud failure here into a silent rebuild loop later.
    assertBridgeArtifact(builtBridgePath(REPO_ROOT, goos, goarch), goos, goarch);

    const record = writeManifest(REPO_ROOT, {
      goos,
      goarch,
      goVersion: toolchain.version,
      sourcesDigest,
    });
    console.log(`bridge: recorded ${goos}-${goarch} build ${record.artifactDigest.slice(0, 12)}`);
  }
}

try {
  main();
} catch (error) {
  console.error(`::error::${error.message}`);
  process.exit(1);
}
