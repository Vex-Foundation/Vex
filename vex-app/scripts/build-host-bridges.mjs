/**
 * Build the Vex Studio bridge for BOTH architectures of the host platform.
 *
 * `electron-builder.yml` - the internal dev/test profile - targets x64 AND
 * arm64 on every platform, so `pnpm --dir vex-app make` produces two bundles
 * and each needs its own bridge. Staging only the host architecture would
 * leave the other bundle without one, and electron-builder 26 answers a
 * missing `extraResources` source with a warning rather than a failure.
 *
 * The release profile is narrower (mac arm64+x64, win x64, linux x64) and its
 * jobs call `bridge/build.sh` with explicit targets, so this script is the dev
 * path only.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { GOOS_BY_ELECTRON_PLATFORM } from "./bridge-artifact.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const goos = GOOS_BY_ELECTRON_PLATFORM[process.platform];
if (goos === undefined) {
  console.error(`::error::cannot build the Vex Studio bridge on ${process.platform}`);
  process.exit(1);
}

for (const goarch of ["amd64", "arm64"]) {
  const result = spawnSync("bash", [path.join(REPO_ROOT, "bridge", "build.sh"), goos, goarch], {
    stdio: "inherit",
    cwd: REPO_ROOT,
  });
  if (result.status !== 0) {
    console.error(
      `::error::bridge/build.sh ${goos} ${goarch} failed. Go ${"go1.27.0"} is a build `
        + "prerequisite; see vex-app/DEV.md.",
    );
    process.exit(result.status ?? 1);
  }
}
