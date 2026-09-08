/**
 * `vitest run` over the whole vex-app suite EXCEPT the native watcher suite
 * (`src/main/studio/files/__tests__/files-real-fs.test.ts`).
 *
 * Why a script and not a flag: vitest 4.1.5 lets a project-level
 * `test.exclude` override the CLI `--exclude`, and the `node` project declares
 * one (`vitest.config.ts`), so `--exclude` aimed at that path is inert -
 * measured, `vitest list --filesOnly` stayed at 796 files under every variant.
 * The exclusion therefore lives in the config behind
 * `VEX_SKIP_NATIVE_FS_SUITE`, and this wrapper is what sets it. A shell-prefixed
 * `VEX_SKIP_NATIVE_FS_SUITE=1 vitest run` in package.json would not run on
 * Windows, where the vex-app suite is also a required CI job.
 *
 * Why the variable is copied rather than mutated in place: the child gets the
 * flag, and nothing else in this process's environment is disturbed.
 *
 * Extra argv is passed through to vitest, so
 * `pnpm run test:except-native-fs -- --reporter=dot` works.
 *
 * The companion `test:native-fs` script runs the excluded file alone. Together
 * they cover the same files as plain `pnpm test`; neither weakens an assertion.
 */

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."); // vex-app/

// Resolved out of vex-app's node_modules and run under the current node binary,
// the same way scripts/check-type-baseline.mjs reaches tsc: this does not depend
// on `.bin` shim symlinks existing (they may not, depending on the pnpm
// node-linker) and it needs no shell, so one code path serves POSIX and Windows.
//
// The entry point is read from the package's own `bin`, not spelled here:
// vitest's `exports` map does not publish the bin file (measured on 4.1.5 -
// `require.resolve("vitest/vitest.mjs")` throws ERR_PACKAGE_PATH_NOT_EXPORTED),
// while `./package.json` is exported, and a hand-spelled path would silently
// rot if the package ever renames it.
const vitestPackageJsonPath = require.resolve("vitest/package.json");
const vitestBinField = require(vitestPackageJsonPath).bin;
const vitestBinEntry =
  typeof vitestBinField === "string" ? vitestBinField : vitestBinField?.vitest;
if (!vitestBinEntry) {
  console.error(`vitest package at ${vitestPackageJsonPath} declares no vitest bin entry`);
  process.exit(1);
}
const vitestBin = path.resolve(path.dirname(vitestPackageJsonPath), vitestBinEntry);

const result = spawnSync(process.execPath, [vitestBin, "run", ...process.argv.slice(2)], {
  cwd: appRoot,
  stdio: "inherit",
  env: { ...process.env, VEX_SKIP_NATIVE_FS_SUITE: "1" },
});

if (result.error) {
  console.error(`failed to spawn vitest: ${result.error.message}`);
  process.exit(1);
}

// A killed child is not a passing run and must not become exit 0. Re-raise the
// signal on ourselves so the caller (CI shell, pnpm) sees the same cause the
// child died of; no handler is installed here, so the default disposition
// terminates this process.
if (result.signal) {
  process.kill(process.pid, result.signal);
}

process.exit(result.status ?? 1);
