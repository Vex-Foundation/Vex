/**
 * A2 (live test 2026-09-03): a bounded ToolSearch answer names a route that
 * actually exists.
 *
 * THE DEFECT, measured against the running app: `vex_ToolSearch` answered "20
 * of 74 matches" with the warning "Increase limit to see more". 20 IS
 * `MAX_DISCOVERY_LIMIT`, so there was no larger limit to ask for, and the agent
 * reported the remaining 54 as unreachable and moved on. The cut itself is
 * legitimate (`totalCount` is echoed, which is what the owner's silent-cutting
 * decree allows), but the decree's test is whether the reader can tell how to
 * get what was left out. Pointing at a knob already at its stop fails that test
 * exactly as a silent cut would.
 *
 * THE CONTRACT asserted here: below the ceiling the warning still offers the
 * larger limit, because that is the cheapest route; AT the ceiling it says the
 * ceiling is the ceiling and names the two narrowing routes instead, neither of
 * which is a cursor, because query mode has none by design.
 *
 * The query is EMPTY on purpose. That path scores the whole advertised catalog
 * without touching the embedding provider, so this is a deterministic offline
 * test of the warning contract rather than of retrieval quality.
 */

import { describe, it, expect } from "vitest";

import {
  MAX_DISCOVERY_LIMIT,
  discoverProtocolCapabilities,
} from "../../../vex-agent/tools/protocols/discovery.js";

function boundedWarning(warnings: readonly string[]): string {
  const found = warnings.find((warning) => warning.includes("matching capabilities"));
  expect(found, `no bounded-answer warning in ${JSON.stringify(warnings)}`).toBeDefined();
  return found ?? "";
}

describe("A2: a bounded ToolSearch answer names a reachable route", () => {
  it("below the ceiling, offers the larger limit AND the narrowing routes", async () => {
    const result = await discoverProtocolCapabilities({ query: "", limit: 3 });

    expect(result.count).toBe(3);
    expect(result.totalCount).toBeGreaterThan(3);
    expect(result.hasMore).toBe(true);

    const warning = boundedWarning(result.warnings);
    expect(warning).toContain(`Showing first 3 of ${String(result.totalCount)}`);
    expect(warning).toContain(`Raise limit (up to ${String(MAX_DISCOVERY_LIMIT)})`);
    expect(warning).toContain("pass `namespace` alone to list one protocol in full");
    expect(warning).toContain("None of the remaining matches are unreachable.");
  });

  it("AT the ceiling, never points at a limit that cannot be raised", async () => {
    const result = await discoverProtocolCapabilities({
      query: "",
      limit: MAX_DISCOVERY_LIMIT,
    });

    expect(result.count).toBe(MAX_DISCOVERY_LIMIT);
    expect(result.totalCount).toBeGreaterThan(MAX_DISCOVERY_LIMIT);
    expect(result.hasMore).toBe(true);

    const warning = boundedWarning(result.warnings);

    // THE REGRESSION THIS FILE EXISTS FOR. The old sentence ended here with
    // "Increase limit to see more", which is false at the ceiling.
    expect(warning).not.toContain("Increase limit");
    expect(warning).not.toContain("Raise limit");

    expect(warning).toContain(
      `${String(MAX_DISCOVERY_LIMIT)} rows is the most one query returns and there is no cursor`,
    );
    expect(warning).toContain("pass `namespace` alone to list one protocol in full");
    expect(warning).toContain("ask a tighter query");
    expect(warning).toContain("None of the remaining matches are unreachable.");

    // The count that exists is still echoed beside the count returned, which is
    // the half of the contract that was already correct and must stay.
    expect(warning).toContain(
      `Showing first ${String(MAX_DISCOVERY_LIMIT)} of ${String(result.totalCount)}`,
    );
  });

  it("says nothing about narrowing when nothing was left out", async () => {
    const result = await discoverProtocolCapabilities({
      query: "",
      namespace: "dexscreener",
      limit: MAX_DISCOVERY_LIMIT,
    });

    if (result.hasMore) {
      // The namespace outgrew the ceiling; this arm has nothing to prove and
      // the ceiling case above already covers it.
      return;
    }
    expect(result.warnings.some((w) => w.includes("matching capabilities"))).toBe(false);
  });
});
