#!/usr/bin/env node
/**
 * Build the Lighter signer helper for every packaged target, and record what
 * was built.
 *
 * The helper is the only process that ever holds a Lighter API private key, so
 * its provenance is part of the money path:
 *
 *   - the COMPILER is pinned (`toolchain` directive in the runtime's go.mod,
 *     the same file CI's `setup-go` reads) and a different local Go is
 *     refused rather than silently used;
 *   - `GOTOOLCHAIN=local` forbids the module from downloading another
 *     toolchain mid-build, which would defeat that pin;
 *   - `GOFLAGS=-mod=readonly` forbids the build from editing go.mod/go.sum, so
 *     the dependency graph is exactly the reviewed, committed one
 *     (elliottech/lighter-go v1.0.7 and its transitive pins);
 *   - every produced binary is re-read from disk and checked against the
 *     target it was asked for, then hashed into `SHA256SUMS`.
 *
 * SHA256SUMS is the PRE-SIGNING record: it names the bytes the compiler
 * produced, which the staging preflight and the afterPack gate re-verify
 * before electron-builder signs anything. After signing, those bytes change by
 * design, so the shipped helper is proven by its SIGNATURE instead - see
 * `vex-app/scripts/check-packaged-payload.mjs`.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  assertLighterSignerArtifact,
  LIGHTER_SIGNER_DIGEST_FILE,
  LIGHTER_SIGNER_TARGETS,
  lighterSignerBinaryName,
  renderLighterSignerDigests,
  sha256OfFile,
} from "../vex-app/scripts/lighter-signer-artifact.mjs";
import { checkPinnedGoToolchain, SIGNER_RUNTIME_GO_MOD } from "./verify-runtime-toolchain.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(repoRoot, "src", "tools", "lighter", "signer-runtime");
const outputDir = path.join(repoRoot, "vex-app", "resources", "lighter-signer");

function fail(message) {
  console.error(`[lighter-signer] ${message}`);
  process.exit(1);
}

const go = checkPinnedGoToolchain(repoRoot);
if (go.state === "absent") {
  fail(
    `Go ${go.pinned} is required to build the signer helper and no \`go\` was found on PATH. `
      + `The pin lives in ${SIGNER_RUNTIME_GO_MOD}.`
  );
}
if (go.state === "mismatch") {
  fail(
    `Go ${go.actual} is installed but this repository builds the signer helper with Go ${go.pinned} `
      + `(pinned in ${SIGNER_RUNTIME_GO_MOD}). A signing binary is built by the pinned compiler or not at all.`
  );
}

mkdirSync(outputDir, { recursive: true });

// Clear BOTH the previous binaries and the previous manifest, before building
// anything: a manifest that survives a failed build would describe binaries
// that are no longer there, and every later gate reads that manifest.
for (const name of readdirSync(outputDir)) {
  if (name.startsWith("vex-lighter-signer-") || name === LIGHTER_SIGNER_DIGEST_FILE) {
    rmSync(path.join(outputDir, name), { force: true });
  }
}

const digests = [];
for (const target of LIGHTER_SIGNER_TARGETS) {
  const name = lighterSignerBinaryName(target);
  const outputPath = path.join(outputDir, name);
  const result = spawnSync(
    "go",
    ["build", "-trimpath", "-ldflags=-s -w", "-o", outputPath, "."],
    {
      cwd: sourceDir,
      env: {
        ...process.env,
        CGO_ENABLED: "0",
        GOOS: target.goos,
        GOARCH: target.goarch,
        GOTOOLCHAIN: "local",
        GOFLAGS: "-mod=readonly",
      },
      stdio: "inherit",
    },
  );

  if (result.error) {
    fail(`failed to launch Go compiler: ${result.error.message}`);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  if (!existsSync(outputPath)) {
    fail(`go build reported success but produced no ${name}`);
  }

  try {
    assertLighterSignerArtifact(outputPath, target);
  } catch (error) {
    fail(`the built helper is not what it should be: ${error.message}`);
  }

  const digest = sha256OfFile(outputPath);
  digests.push({ name, digest });
  console.log(`[lighter-signer] built ${path.relative(repoRoot, outputPath)} (sha256 ${digest})`);
}

writeFileSync(
  path.join(outputDir, LIGHTER_SIGNER_DIGEST_FILE),
  renderLighterSignerDigests(digests)
);

console.log(
  `[lighter-signer] ${digests.length} helper binary target(s) ready, `
    + `digests recorded in ${path.relative(repoRoot, path.join(outputDir, LIGHTER_SIGNER_DIGEST_FILE))} `
    + `(Go ${go.actual})`
);
