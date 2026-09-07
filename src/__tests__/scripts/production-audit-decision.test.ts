/**
 * The production dependency audit's decision rules, tested against the pure
 * half of the gate so no registry, lockfile or child process is involved.
 *
 * What each block would catch if the rule were dropped:
 *
 *  - exact matching: an advisory absorbed by a NEARBY exception (same package,
 *    different version, severity or reachability path). That is the failure
 *    mode an allowlist has: it keeps passing after the thing it excused moved.
 *  - staleness: an exception that outlives its finding, which is how a list of
 *    excuses grows and stops meaning anything.
 *  - expiry: exceptions surviving `reviewBy` by inattention. The gate must
 *    refuse on the date whatever the findings say.
 *  - shape: a malformed allowlist or a changed pnpm report shape failing
 *    CLOSED rather than being read as "no findings".
 */

import { describe, it, expect, beforeAll } from "vitest";

// The gate script is plain ESM without type declarations. It is loaded at run
// time through a resolved specifier and typed once at this seam (the fields the
// tests observe), so the test carries no suppression comment.
interface ProductionAuditDecision {
  readonly ok: boolean;
  readonly failures: readonly string[];
  readonly unexpected: readonly Record<string, unknown>[];
  readonly stale: readonly Record<string, unknown>[];
  readonly exceptions: readonly Record<string, unknown>[];
}
type EvaluateProductionAudit = (input: {
  readonly allowlist: unknown;
  readonly advisories: unknown;
  readonly now: Date | string;
}) => ProductionAuditDecision;
let evaluateProductionAudit: EvaluateProductionAudit;

beforeAll(async () => {
  const specifier = new URL("../../../scripts/production-audit-decision.mjs", import.meta.url).href;
  const loaded = (await import(specifier)) as { readonly evaluateProductionAudit: EvaluateProductionAudit };
  evaluateProductionAudit = loaded.evaluateProductionAudit;
});

const REVIEW_BY = "2026-09-18";
const BEFORE_REVIEW = new Date("2026-09-07T12:00:00.000Z");
const ON_REVIEW = new Date("2026-09-18T00:00:00.000Z");

const STREAM_JSON = {
  url: "https://github.com/advisories/GHSA-528h-pc64-c93x",
  package: "stream-json",
  severity: "moderate",
  version: "1.9.1",
  path: ".>@solana/web3.js>jayson>stream-json",
} as const;

/** One pnpm `audit --json` advisories object carrying the given findings. */
function advisoriesFor(...entries: readonly (typeof STREAM_JSON)[]): unknown {
  const advisories: Record<string, unknown> = {};
  for (const [index, entry] of entries.entries()) {
    advisories[String(index)] = {
      url: entry.url,
      module_name: entry.package,
      severity: entry.severity,
      findings: [{ version: entry.version, paths: [entry.path] }],
    };
  }
  return advisories;
}

function allowlistFor(...entries: readonly (typeof STREAM_JSON)[]): unknown {
  return { reviewBy: REVIEW_BY, exceptions: entries.map((entry) => ({ ...entry, rationale: "reviewed" })) };
}

describe("production audit decision", () => {
  it("passes when every finding is carried verbatim by the allowlist", () => {
    const result = evaluateProductionAudit({
      allowlist: allowlistFor(STREAM_JSON),
      advisories: advisoriesFor(STREAM_JSON),
      now: BEFORE_REVIEW,
    });
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.exceptions).toHaveLength(1);
  });

  it("passes when there is nothing to excuse and nothing excused", () => {
    const result = evaluateProductionAudit({
      allowlist: { reviewBy: REVIEW_BY, exceptions: [] },
      advisories: {},
      now: BEFORE_REVIEW,
    });
    expect(result.ok).toBe(true);
  });

  it("refuses an advisory that no exception carries", () => {
    const result = evaluateProductionAudit({
      allowlist: { reviewBy: REVIEW_BY, exceptions: [] },
      advisories: advisoriesFor(STREAM_JSON),
      now: BEFORE_REVIEW,
    });
    expect(result.ok).toBe(false);
    expect(result.unexpected).toEqual([STREAM_JSON]);
    expect(result.failures.join(" ")).toContain("outside the reviewed exception list");
  });

  for (const field of ["url", "severity", "version", "path"] as const) {
    it(`refuses a finding whose ${field} differs from the exception`, () => {
      const drifted = { ...STREAM_JSON, [field]: `${STREAM_JSON[field]}-drifted` };
      const result = evaluateProductionAudit({
        allowlist: allowlistFor(STREAM_JSON),
        advisories: advisoriesFor(drifted),
        now: BEFORE_REVIEW,
      });
      expect(result.ok).toBe(false);
      expect(result.unexpected).toEqual([drifted]);
      expect(result.stale).toEqual([STREAM_JSON]);
    });
  }

  it("refuses an exception the audit no longer reports", () => {
    const result = evaluateProductionAudit({
      allowlist: allowlistFor(STREAM_JSON),
      advisories: {},
      now: BEFORE_REVIEW,
    });
    expect(result.ok).toBe(false);
    expect(result.stale).toEqual([STREAM_JSON]);
    expect(result.failures.join(" ")).toContain("stale dependency-audit exceptions");
  });

  it("refuses on the review date even when every finding matches", () => {
    const result = evaluateProductionAudit({
      allowlist: allowlistFor(STREAM_JSON),
      advisories: advisoriesFor(STREAM_JSON),
      now: ON_REVIEW,
    });
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toContain(`expired for mandatory review on ${REVIEW_BY}`);
    expect(result.unexpected).toEqual([]);
  });

  it("passes on the day before the review date", () => {
    const result = evaluateProductionAudit({
      allowlist: allowlistFor(STREAM_JSON),
      advisories: advisoriesFor(STREAM_JSON),
      now: new Date(ON_REVIEW.getTime() - 1),
    });
    expect(result.ok).toBe(true);
  });

  it("refuses an unparseable reviewBy instead of treating it as no deadline", () => {
    const result = evaluateProductionAudit({
      allowlist: { reviewBy: "whenever", exceptions: [] },
      advisories: {},
      now: BEFORE_REVIEW,
    });
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toContain("invalid reviewBy");
  });

  it("refuses an exception missing an identity field rather than matching loosely", () => {
    const { version: _dropped, ...incomplete } = STREAM_JSON;
    const result = evaluateProductionAudit({
      allowlist: { reviewBy: REVIEW_BY, exceptions: [incomplete] },
      advisories: advisoriesFor(STREAM_JSON),
      now: BEFORE_REVIEW,
    });
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toContain("missing a valid version");
    expect(result.unexpected).toEqual([STREAM_JSON]);
  });

  it("refuses a report whose findings lost their identity fields", () => {
    const result = evaluateProductionAudit({
      allowlist: { reviewBy: REVIEW_BY, exceptions: [] },
      advisories: { "0": { url: STREAM_JSON.url, module_name: STREAM_JSON.package, findings: [{ paths: ["."] }] } },
      now: BEFORE_REVIEW,
    });
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toContain("the report shape changed");
  });

  it("refuses an allowlist with no exceptions array", () => {
    const result = evaluateProductionAudit({
      allowlist: { reviewBy: REVIEW_BY },
      advisories: {},
      now: BEFORE_REVIEW,
    });
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toContain("no exceptions array");
  });
});
