#!/usr/bin/env node
/**
 * Production dependency audit gate.
 *
 * Runs the pinned `pnpm audit --prod --json` for one workspace, compares every
 * finding against that workspace's reviewed exception allowlist, and refuses on
 * anything the allowlist does not carry verbatim. The decision itself lives in
 * `production-audit-decision.mjs` (pure, unit-tested); this file owns the
 * process side only.
 *
 * Every exception claims the vulnerable code is UNREACHABLE from Vex. A claim
 * like that rots the moment a transitive dependency changes its imports or an
 * install builds a native binding, so each one has a verifier that reads the
 * INSTALLED module graph and fails when the claim stops holding. An exception
 * whose package has a verifier is never accepted on the rationale text alone.
 *
 * Usage: node scripts/audit-production-dependencies.mjs [allowlist] [workspace]
 * Both arguments are resolved from the repository root and default to the root
 * workspace.
 */

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { evaluateProductionAudit } from "./production-audit-decision.mjs";
import { verifyBigIntBufferException } from "./verify-bigint-buffer-exception.mjs";
import { verifyStreamJsonException } from "./verify-stream-json-exception.mjs";
import { verifyUuidException } from "./verify-uuid-exception.mjs";

/**
 * Package name to reachability verifier. A package listed here MUST pass its
 * verifier for its exception to hold; a package absent from the map is
 * accepted on its written rationale and is named as such in the output, so the
 * difference between "mechanically checked" and "argued" is never invisible.
 */
const REACHABILITY_VERIFIERS = new Map([
  ["bigint-buffer", verifyBigIntBufferException],
  ["stream-json", verifyStreamJsonException],
  ["uuid", verifyUuidException],
]);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = path.resolve(root, process.argv[2] ?? "scripts/production-audit-allowlist.json");
const auditRoot = path.resolve(root, process.argv[3] ?? ".");

let allowlist;
try {
  allowlist = JSON.parse(readFileSync(configPath, "utf8"));
} catch (error) {
  fail(`could not read the exception allowlist at ${configPath}: ${error.message}`);
}

// `corepack` is a .cmd shim on Windows, which spawnSync cannot exec by bare
// name. Naming the shim keeps a local Windows run honest instead of failing
// with ENOENT that reads like a broken gate.
const corepackCommand = process.platform === "win32" ? "corepack.cmd" : "corepack";
const audit = spawnSync(corepackCommand, ["pnpm", "audit", "--prod", "--json"], {
  cwd: auditRoot,
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
});
if (audit.error !== undefined) fail(`could not run the pinned pnpm audit: ${audit.error.message}`);

let report;
try {
  report = JSON.parse(audit.stdout);
} catch {
  const detail = audit.stderr.trim().split("\n").at(-1) ?? "no registry response";
  fail(`pnpm audit did not return valid JSON (${detail})`);
}

const decision = evaluateProductionAudit({
  allowlist,
  advisories: report.advisories ?? {},
  now: new Date(),
});

for (const finding of decision.unexpected) {
  console.error(`Unexpected production advisory: ${finding.package}@${finding.version} ${finding.url} via ${finding.path}`);
}
for (const finding of decision.stale) {
  console.error(`Stale production advisory exception: ${finding.package}@${finding.version} ${finding.url}`);
}
if (!decision.ok) fail(decision.failures.join("; "));

for (const entry of decision.exceptions) {
  const verify = REACHABILITY_VERIFIERS.get(entry.package);
  if (verify === undefined) continue;
  try {
    await verify(auditRoot);
  } catch (error) {
    fail(`the ${entry.package} exception no longer holds against the installed graph: ${error.message}`);
  }
}

for (const entry of decision.exceptions) {
  const checked = REACHABILITY_VERIFIERS.has(entry.package)
    ? "reachability verified against the installed graph"
    : "accepted on its written rationale, no mechanical reachability check";
  console.warn(`Reviewed production advisory exception: ${entry.package}@${entry.version} (${entry.url}); ${checked}; review by ${decision.reviewBy}`);
}
console.log(`Production dependency audit passed with ${decision.exceptions.length} exact reviewed exception(s).`);

function fail(message) {
  console.error(`Production dependency audit failed: ${message}.`);
  process.exit(1);
}
