#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const allowlist = JSON.parse(
  readFileSync(path.join(root, "scripts", "production-audit-allowlist.json"), "utf8"),
);

const reviewBy = new Date(`${allowlist.reviewBy}T00:00:00.000Z`);
if (!Number.isFinite(reviewBy.getTime()) || Date.now() >= reviewBy.getTime()) {
  fail(`dependency-audit exceptions expired for mandatory review on ${allowlist.reviewBy}`);
}

const audit = spawnSync("corepack", ["pnpm", "audit", "--prod", "--json"], {
  cwd: root,
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

const actual = flattenFindings(report.advisories ?? {});
const expected = allowlist.exceptions.map(normalizeException);
const unexpected = actual.filter((finding) => !expected.some((entry) => sameFinding(entry, finding)));
const stale = expected.filter((entry) => !actual.some((finding) => sameFinding(entry, finding)));

if (unexpected.length > 0) {
  for (const finding of unexpected) {
    console.error(`Unexpected production advisory: ${finding.package}@${finding.version} ${finding.url} via ${finding.path}`);
  }
  fail("production dependency audit found advisories outside the reviewed exception list");
}
if (stale.length > 0) {
  for (const finding of stale) {
    console.error(`Stale production advisory exception: ${finding.package}@${finding.version} ${finding.url}`);
  }
  fail("remove or update stale dependency-audit exceptions after lockfile changes");
}

for (const entry of allowlist.exceptions) {
  console.warn(`Reviewed production advisory exception: ${entry.package}@${entry.version} (${entry.url}); review by ${allowlist.reviewBy}`);
}
console.log(`Production dependency audit passed with ${expected.length} exact reviewed exception(s).`);

function flattenFindings(advisories) {
  const findings = [];
  for (const advisory of Object.values(advisories)) {
    for (const finding of advisory.findings ?? []) {
      for (const dependencyPath of finding.paths ?? []) {
        findings.push(normalizeException({
          url: advisory.url,
          package: advisory.module_name,
          severity: advisory.severity,
          version: finding.version,
          path: dependencyPath,
        }));
      }
    }
  }
  return findings;
}

function normalizeException(entry) {
  for (const field of ["url", "package", "severity", "version", "path"]) {
    if (typeof entry[field] !== "string" || entry[field].length === 0) {
      fail(`dependency-audit exception has an invalid ${field}`);
    }
  }
  return {
    url: entry.url,
    package: entry.package,
    severity: entry.severity,
    version: entry.version,
    path: entry.path,
  };
}

function sameFinding(left, right) {
  return left.url === right.url
    && left.package === right.package
    && left.severity === right.severity
    && left.version === right.version
    && left.path === right.path;
}

function fail(message) {
  console.error(`Production dependency audit failed: ${message}.`);
  process.exit(1);
}
