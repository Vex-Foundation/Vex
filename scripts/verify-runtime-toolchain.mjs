#!/usr/bin/env node
/**
 * The pinned build toolchain: Node, pnpm and Go.
 *
 * Node and pnpm are pinned by `package.json`. Go is pinned by
 * `src/tools/lighter/signer-runtime/go.mod`, which is also what
 * `actions/setup-go` reads in CI (`go-version-file`), so the pin has exactly
 * one home. It matters because that module compiles the Lighter SIGNER
 * HELPER - the process that holds a trading private key - and a helper built by
 * an unknown compiler is an unreviewed input to a signed, notarized bundle.
 *
 * A DIFFERENT local Go is refused. An ABSENT local Go is reported and
 * tolerated: most jobs and most contributors never build the helper, and the
 * step that does need Go (`scripts/build-lighter-signer-runtime.mjs`) refuses
 * to run without it.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Where the Go pin lives, and what CI's `go-version-file` points at. */
export const SIGNER_RUNTIME_GO_MOD = path.join(
  "src", "tools", "lighter", "signer-runtime", "go.mod"
);

/**
 * The exact Go version this repository builds the signer helper with, read from
 * the `toolchain` directive of the signer runtime's go.mod.
 *
 * The `toolchain` directive rather than the `go` directive: the `go` line is a
 * language-version floor, while `toolchain` names the compiler, which is what a
 * reproducible binary depends on. The directive is kept strictly above the `go`
 * floor so `go mod tidy` cannot drop it as redundant. This reader refuses a
 * go.mod with no toolchain directive rather than falling back to the floor,
 * because a missing pin must fail loudly instead of silently widening.
 */
function readPinnedGoVersion(repoRoot = root) {
  const goMod = path.join(repoRoot, SIGNER_RUNTIME_GO_MOD);
  const directive = /^toolchain go(\d+\.\d+(?:\.\d+)?)$/m.exec(readFileSync(goMod, "utf8"));
  if (directive === null) {
    throw new Error(
      `${SIGNER_RUNTIME_GO_MOD} must pin the compiler with an exact `
        + "`toolchain go<major>.<minor>.<patch>` directive"
    );
  }
  return directive[1];
}

/**
 * The local Go version, or `null` when no Go is installed.
 *
 * `go version` prints `go version go1.27.0 linux/amd64`. A Go that exists but
 * answers something unparseable is a failure, not an absence: it is a Go whose
 * identity this gate cannot establish.
 */
function detectLocalGoVersion() {
  const result = spawnSync("go", ["version"], { encoding: "utf8" });
  if (result.error !== undefined || result.status !== 0) return null;
  const found = /\bgo(\d+\.\d+(?:\.\d+)?)\b/.exec(result.stdout ?? "");
  if (found === null) {
    throw new Error(
      `\`go version\` printed something this gate cannot read: ${(result.stdout ?? "").trim()}`
    );
  }
  return found[1];
}

/**
 * Compare the local Go against the pin.
 *
 * Returns `{ pinned, actual, state }` where `state` is `"match"`, `"absent"` or
 * `"mismatch"`. Callers decide whether absence is fatal: it is for the helper
 * build, it is not for a job that only runs TypeScript.
 */
export function checkPinnedGoToolchain(repoRoot = root) {
  const pinned = readPinnedGoVersion(repoRoot);
  const actual = detectLocalGoVersion();
  if (actual === null) return { pinned, actual, state: "absent" };
  return { pinned, actual, state: actual === pinned ? "match" : "mismatch" };
}

function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function fail(message) {
  console.error(`Toolchain verification failed: ${message}.`);
  process.exit(1);
}

function main() {
  const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

  const expectedPnpm = /^pnpm@(\d+\.\d+\.\d+)$/.exec(packageJson.packageManager)?.[1];
  if (expectedPnpm === undefined) {
    fail("package.json must pin packageManager to an exact pnpm version");
  }

  const requiredNode = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(packageJson.engines?.node ?? "");
  if (requiredNode === null) {
    fail("package.json engines.node must use an explicit >=major.minor.patch minimum");
  }

  const actualNode = process.versions.node;
  if (compareVersions(actualNode, requiredNode.slice(1).join(".")) < 0) {
    fail(`Node ${actualNode} is below the required ${packageJson.engines.node}`);
  }

  const userAgent = process.env.npm_config_user_agent ?? "";
  const actualPnpm = /(?:^|\s)pnpm\/(\d+\.\d+\.\d+)(?:\s|$)/.exec(userAgent)?.[1];
  if (actualPnpm === undefined) {
    fail("the toolchain check must be run through the pinned pnpm executable");
  }
  if (actualPnpm !== expectedPnpm) {
    fail(`pnpm ${actualPnpm} does not match the pinned pnpm ${expectedPnpm}`);
  }

  let go = { state: "absent", pinned: "unknown", actual: null };
  try {
    go = checkPinnedGoToolchain();
  } catch (error) {
    fail(error.message);
  }
  if (go.state === "mismatch") {
    fail(
      `Go ${go.actual} does not match the Go ${go.pinned} pinned by ${SIGNER_RUNTIME_GO_MOD}. `
        + "The Lighter signer helper is a signing binary: it is built by the pinned compiler or not at all"
    );
  }

  const goLine = go.state === "match"
    ? `Go ${go.actual}`
    : `Go not installed (pin ${go.pinned}; needed only to build the Lighter signer helper)`;
  console.log(`Toolchain verified: Node ${actualNode}, pnpm ${actualPnpm}, ${goLine}`);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
