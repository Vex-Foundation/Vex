/**
 * The pure decision half of the production dependency audit.
 *
 * The runner (`audit-production-dependencies.mjs`) owns the process side:
 * spawning the pinned `pnpm audit`, reading the allowlist file, running the
 * reachability verifiers and choosing an exit code. Everything that decides
 * whether a tree PASSES lives here, takes plain data and returns plain data,
 * so the gate's own rules are testable without a registry, a lockfile or a
 * child process.
 *
 * The decision is deliberately EXACT-MATCH in both directions:
 *
 *   - an advisory finding the allowlist does not carry verbatim (same URL,
 *     package, severity, version and dependency path) fails the gate, so a
 *     new advisory, a bumped version or a new reachability path cannot be
 *     absorbed by a stale exception;
 *   - an allowlisted exception the audit no longer reports fails the gate
 *     too, so exceptions cannot outlive the finding that justified them.
 *
 * `reviewBy` is a hard expiry, not a reminder: once the date passes, the gate
 * refuses regardless of the findings. An exception that nobody renewed is not
 * an exception.
 */

/** Fields that identify a finding. Order matters only for error messages. */
const IDENTITY_FIELDS = ["url", "package", "severity", "version", "path"];

/**
 * @typedef {{ url: string, package: string, severity: string, version: string, path: string }} Finding
 * @typedef {{ readonly reason: string }} Failure
 */

/**
 * Decides whether the audit output is acceptable under the allowlist.
 *
 * Pure: no I/O, no clock, no exit. `now` is supplied by the caller so expiry
 * is testable, and `advisories` is the `advisories` object of pnpm's
 * `audit --json` report exactly as parsed.
 *
 * @param {{ allowlist: unknown, advisories: unknown, now: Date }} input
 * @returns {{
 *   ok: boolean,
 *   failures: readonly string[],
 *   unexpected: readonly Finding[],
 *   stale: readonly Finding[],
 *   exceptions: readonly Finding[],
 *   reviewBy: string | null,
 * }}
 */
export function evaluateProductionAudit({ allowlist, advisories, now }) {
  const failures = [];
  if (allowlist === null || typeof allowlist !== "object") {
    return refuse(failures, "the dependency-audit allowlist is not an object");
  }

  const reviewBy = typeof allowlist.reviewBy === "string" ? allowlist.reviewBy : null;
  const deadline = reviewBy === null ? Number.NaN : Date.parse(`${reviewBy}T00:00:00.000Z`);
  if (!Number.isFinite(deadline)) {
    return refuse(failures, `the dependency-audit allowlist has an invalid reviewBy (${String(allowlist.reviewBy)})`);
  }
  if (now.getTime() >= deadline) {
    failures.push(`dependency-audit exceptions expired for mandatory review on ${reviewBy}`);
  }

  if (!Array.isArray(allowlist.exceptions)) {
    return refuse(failures, "the dependency-audit allowlist has no exceptions array", { reviewBy });
  }

  const exceptions = [];
  for (const [index, entry] of allowlist.exceptions.entries()) {
    const identity = identify(entry);
    if (identity === null) {
      failures.push(`dependency-audit exception ${index} is missing a valid ${missingField(entry)}`);
      continue;
    }
    exceptions.push(identity);
  }

  const actual = [];
  for (const advisory of Object.values(asRecord(advisories))) {
    for (const finding of asArray(asRecord(advisory).findings)) {
      for (const dependencyPath of asArray(asRecord(finding).paths)) {
        const identity = identify({
          url: asRecord(advisory).url,
          package: asRecord(advisory).module_name,
          severity: asRecord(advisory).severity,
          version: asRecord(finding).version,
          path: dependencyPath,
        });
        if (identity === null) {
          failures.push("pnpm audit reported a finding without a complete identity; the report shape changed");
          continue;
        }
        actual.push(identity);
      }
    }
  }

  const unexpected = actual.filter((finding) => !exceptions.some((entry) => sameFinding(entry, finding)));
  const stale = exceptions.filter((entry) => !actual.some((finding) => sameFinding(entry, finding)));
  if (unexpected.length > 0) {
    failures.push("production dependency audit found advisories outside the reviewed exception list");
  }
  if (stale.length > 0) {
    failures.push("remove or update stale dependency-audit exceptions after lockfile changes");
  }

  return { ok: failures.length === 0, failures, unexpected, stale, exceptions, reviewBy };
}

function refuse(failures, reason, extra = {}) {
  failures.push(reason);
  return {
    ok: false,
    failures,
    unexpected: [],
    stale: [],
    exceptions: [],
    reviewBy: null,
    ...extra,
  };
}

function identify(entry) {
  const record = asRecord(entry);
  for (const field of IDENTITY_FIELDS) {
    if (typeof record[field] !== "string" || record[field].length === 0) return null;
  }
  return {
    url: record.url,
    package: record.package,
    severity: record.severity,
    version: record.version,
    path: record.path,
  };
}

function missingField(entry) {
  const record = asRecord(entry);
  return IDENTITY_FIELDS.find((field) => typeof record[field] !== "string" || record[field].length === 0) ?? "field";
}

function sameFinding(left, right) {
  return IDENTITY_FIELDS.every((field) => left[field] === right[field]);
}

function asRecord(value) {
  return value !== null && typeof value === "object" ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}
