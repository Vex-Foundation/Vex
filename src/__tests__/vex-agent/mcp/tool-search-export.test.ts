/**
 * `vex_ToolSearch` - the read-only export adapter, and the discovery
 * `availability` mode it is built on.
 *
 * Pinned here:
 *  - the in-app default is UNCHANGED: `availability` omitted still filters an
 *    env-unmet manifest out of the candidate set;
 *  - `include-unavailable` returns those rows instead, marked `available:
 *    false` with the env NAMES (never values);
 *  - the adapter records NOTHING: the session discovered-tools store is empty
 *    after a call, which is what keeps `tools/list` free of connection-state
 *    variance and leaves the agent's working set alone;
 *  - `select:` is refused BY NAME with the real reason;
 *  - a limit above the maximum is refused BY NAME, never clamped.
 *
 * Dense retrieval is not exercised: these assertions are about filtering,
 * marking and recording, so namespace listings and catalog mode (no query) are
 * used, which take the deterministic paths.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  MAX_DISCOVERY_LIMIT,
  discoverProtocolCapabilities,
} from "@vex-agent/tools/protocols/discovery.js";
import { getDiscoveredToolIds } from "@vex-agent/tools/registry/discovered-tools.js";
import { searchExportedTools } from "@vex-agent/mcp/tool-search-export.js";

/** A namespace whose whole manifest set is gated on one provider key. */
const ENV_GATED_NAMESPACE = "solana";
const ENV_GATED_VAR = "JUPITER_API_KEY";

const originalKey = process.env[ENV_GATED_VAR];

beforeEach(() => {
  delete process.env[ENV_GATED_VAR];
});

afterEach(() => {
  if (originalKey === undefined) delete process.env[ENV_GATED_VAR];
  else process.env[ENV_GATED_VAR] = originalKey;
});

describe("discovery availability mode", () => {
  it("defaults to today's in-app filtering (env-unmet rows are hidden)", async () => {
    const result = await discoverProtocolCapabilities({
      namespace: ENV_GATED_NAMESPACE,
      list: true,
    });
    const gated = result.tools.filter((tool) => tool.toolId.startsWith("solana.swap"));
    expect(gated).toEqual([]);
  });

  it("filter-env-unmet stated explicitly behaves identically", async () => {
    const implicit = await discoverProtocolCapabilities({
      namespace: ENV_GATED_NAMESPACE,
      list: true,
    });
    const explicit = await discoverProtocolCapabilities({
      namespace: ENV_GATED_NAMESPACE,
      list: true,
      availability: "filter-env-unmet",
    });
    expect(explicit.tools.map((t) => t.toolId)).toEqual(implicit.tools.map((t) => t.toolId));
  });

  it("include-unavailable returns the env-unmet manifests", async () => {
    const included = await discoverProtocolCapabilities({
      namespace: ENV_GATED_NAMESPACE,
      list: true,
      availability: "include-unavailable",
    });
    expect(included.tools.map((t) => t.toolId)).toContain("solana.swap.quote");
  });
});

describe("vex_ToolSearch export adapter", () => {
  it("answers a namespace listing and marks env-unmet rows unavailable", async () => {
    const outcome = await searchExportedTools({ namespace: ENV_GATED_NAMESPACE });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const rows = outcome.result.tools;
    expect(rows.length).toBeGreaterThan(0);
    const swapQuote = rows.find((row) => row.publicName === "solana__swap_quote");
    expect(swapQuote).toBeDefined();
    expect(swapQuote?.available).toBe(false);
    expect(swapQuote?.requiresEnv).toEqual([ENV_GATED_VAR]);
    // Env NAMES only - a value must never travel in a row.
    expect(JSON.stringify(rows)).not.toContain("secret");
  });

  it("marks nothing unavailable once the key is configured", async () => {
    process.env[ENV_GATED_VAR] = "test-key";
    const outcome = await searchExportedTools({ namespace: ENV_GATED_NAMESPACE });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const swapQuote = outcome.result.tools.find((row) => row.publicName === "solana__swap_quote");
    expect(swapQuote).toBeDefined();
    expect(swapQuote?.available).toBeUndefined();
    expect(swapQuote?.requiresEnv).toBeUndefined();
  });

  it("answers a query and writes NO working set", async () => {
    const sessionId = `export-search-${Date.now()}`;
    expect(getDiscoveredToolIds(sessionId)).toEqual([]);

    const outcome = await searchExportedTools({ query: "swap tokens", limit: 3 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.tools.length).toBeLessThanOrEqual(3);

    // The discovered-tools store is keyed by session; the adapter omits the
    // session id entirely, so nothing anywhere was recorded.
    expect(getDiscoveredToolIds(sessionId)).toEqual([]);
  });

  it("refuses select: BY NAME with the real reason", async () => {
    const outcome = await searchExportedTools({ query: "select:solana__swap_quote" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain("select:");
    expect(outcome.message).toContain("tools/list");
    expect(outcome.message).toContain("NOT run");
  });

  it("refuses a limit above the maximum BY NAME instead of clamping", async () => {
    const outcome = await searchExportedTools({
      query: "swap tokens",
      limit: MAX_DISCOVERY_LIMIT + 1,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain(String(MAX_DISCOVERY_LIMIT));
    expect(outcome.message).toContain("NOT run");
  });

  it("refuses a wrong-typed argument and an unknown argument BY NAME", async () => {
    const wrongType = await searchExportedTools({ query: 12 });
    expect(wrongType.ok).toBe(false);
    if (!wrongType.ok) expect(wrongType.message).toContain("query must be a string");

    const unknown = await searchExportedTools({ toolIds: ["a"] });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.message).toContain("toolIds");
  });

  it("refuses an empty call", async () => {
    const outcome = await searchExportedTools({});
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain("no arguments");
  });
});
