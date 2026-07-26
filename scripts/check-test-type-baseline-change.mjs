#!/usr/bin/env node
/**
 * Prevent a baseline edit from laundering new test type debt. CI supplies a
 * merge-base revision. Reductions are always allowed; new/grown fingerprints
 * need the exact, reviewed allowlist entry used by the ratchet itself.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const baselineRelativePath = "scripts/test-type-baseline.json";
const baselinePath = path.join(repositoryRoot, baselineRelativePath);
const allowlistPath = path.join(scriptDirectory, "test-type-baseline-allowlist.json");

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function argumentValue(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

function readJson(pathname, label) {
  try {
    return JSON.parse(readFileSync(pathname, "utf8"));
  } catch (error) {
    fail(`${label} is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readBaselineAt(revision) {
  try {
    return JSON.parse(execFileSync("git", ["show", `${revision}:${baselineRelativePath}`], {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }));
  } catch {
    return null;
  }
}

function main() {
  const base = argumentValue("--base");
  if (!base) fail("requires --base <merge-base revision>");
  if (!existsSync(baselinePath)) fail(`${baselineRelativePath} is missing`);

  const previous = readBaselineAt(base);
  if (previous === null) {
    if (!process.argv.includes("--allow-bootstrap")) {
      fail(`no baseline exists at ${base}; initial baseline creation requires --allow-bootstrap and review`);
    }
    console.log(`✓ bootstrap baseline acknowledged against ${base}`);
    return;
  }

  const current = readJson(baselinePath, "current baseline");
  const allowlist = readJson(allowlistPath, "baseline allowlist").entries;
  if (typeof previous.diagnostics !== "object" || typeof current.diagnostics !== "object" || typeof allowlist !== "object") {
    fail("baseline or allowlist has an unsupported shape");
  }

  const violations = [];
  for (const [key, entry] of Object.entries(current.diagnostics)) {
    const previousCount = previous.diagnostics[key]?.count ?? 0;
    if (entry.count <= previousCount) continue;
    const allowance = allowlist[key];
    if (!(allowance && Number.isInteger(allowance.maxCount) && allowance.maxCount >= entry.count && typeof allowance.reason === "string" && allowance.reason.trim() !== "")) {
      violations.push({ key, previousCount, currentCount: entry.count });
    }
  }

  if (violations.length > 0) {
    console.error(`✗ ${violations.length} baseline fingerprint(s) grew or were added without a reviewed allowlist entry:`);
    for (const violation of violations) console.error(`  ${violation.key} — baseline ${violation.previousCount}, now ${violation.currentCount}`);
    process.exit(1);
  }
  console.log(`✓ baseline did not grow beyond reviewed allowlist entries relative to ${base}`);
}

main();
