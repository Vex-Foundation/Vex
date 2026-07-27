/**
 * `explainDrops` — the VALUE a dropped row lost by, not just the filter's name.
 *
 * THE MEASURED FRICTION (persona gate, ranked [high])
 *
 * `droppedByFilter` names the filter but never the number. With one pool
 * rejected by `minQuoteDepthTokens`, an agent cannot tell whether it missed the
 * floor by 0.1 or by 100x — i.e. whether to loosen the filter or abandon the
 * candidate. That decision is the whole point of the filter, and it cost a
 * second call every time.
 *
 * THE INVARIANTS THIS SUITE EXISTS TO HOLD
 *
 * 1. **Default payloads are byte-identical** when `explainDrops` is absent or
 *    false. A diagnostic that costs bytes on every call is a regression to the
 *    blob this whole phase exists to remove.
 * 2. **The accounting invariant is untouched**: `returned + Σ droppedByFilter
 *    === providerReturned` still holds, because `droppedRows` is a SAMPLE and
 *    `droppedByFilter` remains the census.
 * 3. **At most 10 records**, and a truncated sample says so — a 30-row window
 *    fully rejected must not quietly imply it explained everything.
 * 4. **One row, one rejection** — the FIRST failed filter, exactly as
 *    `droppedByFilter` counts it, so the sample and the census cannot disagree.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getDexScreenerClient } from "@tools/dexscreener/client.js";
import { DEXSCREENER_HANDLERS } from "@vex-agent/tools/protocols/dexscreener/handlers.js";
import { DEXSCREENER_TOOLS } from "@vex-agent/tools/protocols/dexscreener/manifest.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

import {
  boostsLatest,
  metasTrending,
  profilesLatest,
} from "./_feed-captures.js";
import { searchUsdc } from "./_pair-captures.js";

const READ_CTX: ProtocolExecutionContext = {
  sessionPermission: "restricted",
  approved: false,
  walletResolution: { source: "default" },
  walletPolicy: { kind: "none" },
};

interface DroppedRow {
  providerRowIndex: number;
  rowId: string | null;
  filter: string;
  value: unknown;
  threshold: unknown;
}

interface Payload extends Record<string, unknown> {
  droppedByFilter: Record<string, number>;
  droppedRows?: DroppedRow[];
  droppedRowsTruncated?: boolean;
  returned: number;
  providerWindow: { providerReturned: number };
}

async function call(toolId: string, params: Record<string, unknown>): Promise<Payload> {
  const handler = DEXSCREENER_HANDLERS[toolId];
  if (handler === undefined) throw new Error(`no handler for ${toolId}`);
  const result = await handler(params, READ_CTX);
  expect(result.success, result.output).toBe(true);
  return JSON.parse(result.output) as Payload;
}

/** Everything but our clock, which is the one field allowed to differ per call. */
function withoutClock(payload: Payload): unknown {
  const copy: Record<string, unknown> = { ...payload };
  delete copy.asOfMs;
  return copy;
}

function totalDropped(dropped: Record<string, number>): number {
  return Object.values(dropped).reduce((sum, count) => sum + count, 0);
}

describe("explainDrops — the shared list vocabulary", () => {
  beforeEach(() => {
    const client = getDexScreenerClient();
    vi.spyOn(client, "search").mockResolvedValue(searchUsdc());
    vi.spyOn(client, "getProfiles").mockResolvedValue(profilesLatest());
    vi.spyOn(client, "getBoosts").mockResolvedValue(boostsLatest());
    vi.spyOn(client, "getMetasTrending").mockResolvedValue(metasTrending());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── It is declared on every family, with one spelling ────────────

  it("is declared on every list tool that can drop a row", () => {
    const withFilters = DEXSCREENER_TOOLS.filter((tool) =>
      tool.params.some((param) => param.key === "chainIds" || param.key === "minTokenCount"),
    );
    expect(withFilters.length).toBeGreaterThan(5);
    for (const tool of withFilters) {
      const param = tool.params.find((p) => p.key === "explainDrops");
      expect(param, `${tool.toolId} declares explainDrops`).toBeDefined();
      expect(param?.type).toBe("boolean");
      // The index is only meaningful inside one response, and saying so is the
      // difference between a debugging aid and a fabricated row identity.
      expect(param?.description).toMatch(/not stable across calls/i);
    }
  });

  // ── Invariant 1: the default payload does not change ─────────────

  it("absent and false produce a payload byte-identical to the default", async () => {
    const bare = await call("dexscreener.search", { query: "USDC", chainIds: "ethereum" });
    const explicitFalse = await call("dexscreener.search", {
      query: "USDC",
      chainIds: "ethereum",
      explainDrops: false,
    });
    expect(withoutClock(explicitFalse)).toEqual(withoutClock(bare));
    expect("droppedRows" in bare).toBe(false);
    expect("droppedRowsTruncated" in bare).toBe(false);
    expect(bare.filtersApplied).not.toHaveProperty("explainDrops");
  });

  // ── Invariant 2 + 3: sample vs census ───────────────────────────

  it("explains the drops without disturbing the accounting", async () => {
    const data = await call("dexscreener.search", {
      query: "USDC",
      chainIds: "ethereum",
      explainDrops: true,
    });
    expect(data.droppedByFilter).toEqual({ chainIds: 30 });
    expect(data.returned + totalDropped(data.droppedByFilter)).toBe(
      data.providerWindow.providerReturned,
    );
    // The sample is capped and says so; the census still reports all 30.
    expect(data.droppedRows).toHaveLength(10);
    expect(data.droppedRowsTruncated).toBe(true);
  });

  it("flags an untruncated sample as untruncated rather than leaving it ambiguous", async () => {
    const data = await call("dexscreener.search", {
      query: "USDC",
      chainIds: "ethereum",
      limit: 1,
      offset: 29,
      minLiquidityUsd: 0,
      explainDrops: true,
    });
    expect(data.droppedRowsTruncated).toBe(true);

    const few = await call("dexscreener.search", {
      query: "USDC",
      quoteSymbols: "USDC,USDT,WETH,SOL,WBNB,DAI,WPLS,WAVAX,WMATIC,USDbC,axlUSDC,CRO,WETH9,BUSD",
      explainDrops: true,
    });
    const sample = few.droppedRows ?? [];
    expect(sample.length).toBe(Math.min(totalDropped(few.droppedByFilter), 10));
    expect(few.droppedRowsTruncated).toBe(sample.length < totalDropped(few.droppedByFilter));
  });

  // ── The record contract ─────────────────────────────────────────

  it("each record carries the pre-filter input index, an identity, and both sides of the comparison", async () => {
    const data = await call("dexscreener.search", {
      query: "USDC",
      chainIds: "ethereum",
      explainDrops: true,
    });
    const rows = data.droppedRows ?? [];
    expect(rows.length).toBeGreaterThan(0);

    // 0-based PRE-FILTER index within THIS response: the provider window order.
    expect(rows.map((row) => row.providerRowIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    for (const row of rows) {
      expect(row.filter).toBe("chainIds");
      // Threshold is the parameter value AS PASSED (normalised), so the agent
      // can compare it against `value` without re-deriving anything.
      expect(row.threshold).toEqual(["ethereum"]);
      expect(typeof row.value).toBe("string");
      expect(row.value).not.toBe("ethereum");
      // Best-effort family identity — a pair address here.
      expect(typeof row.rowId === "string" || row.rowId === null).toBe(true);
    }
  });

  it("a numeric filter reports the row's own number, which is the point", async () => {
    const data = await call("dexscreener.search", {
      query: "USDC",
      minLiquidityUsd: 999_999_999,
      explainDrops: true,
    });
    const rows = data.droppedRows ?? [];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.filter).toBe("minLiquidityUsd");
      expect(row.threshold).toBe(999_999_999);
      expect(row.value === null || typeof row.value === "number").toBe(true);
    }
    // At least one row must carry a real number — a sample of all-nulls would
    // be the "fixture only encodes the empty case" trap.
    expect(rows.some((row) => typeof row.value === "number")).toBe(true);
  });

  it("attributes a multi-fail row to the FIRST failed filter, exactly as the census counts it", async () => {
    const data = await call("dexscreener.search", {
      query: "USDC",
      chainIds: "ethereum",
      minLiquidityUsd: 999_999_999,
      explainDrops: true,
    });
    expect(data.droppedByFilter).toEqual({ chainIds: 30 });
    expect((data.droppedRows ?? []).every((row) => row.filter === "chainIds")).toBe(true);
  });

  it("emits an empty sample rather than nothing when the filters dropped nothing", async () => {
    const data = await call("dexscreener.search", { query: "USDC", explainDrops: true });
    expect(data.droppedByFilter).toEqual({});
    expect(data.droppedRows).toEqual([]);
    expect(data.droppedRowsTruncated).toBe(false);
  });

  // ── The other two families ──────────────────────────────────────

  it("feeds explain their drops and identify the row by token address", async () => {
    const data = await call("dexscreener.profiles", {
      chainIds: "robinhood",
      explainDrops: true,
    });
    const rows = data.droppedRows ?? [];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.filter).toBe("chainIds");
    expect(typeof rows[0]?.rowId).toBe("string");
    expect(data.returned + totalDropped(data.droppedByFilter)).toBe(
      data.providerWindow.providerReturned,
    );
  });

  it("narratives explain their drops and identify the row by slug", async () => {
    const data = await call("dexscreener.trending", {
      minTokenCount: 100_000,
      explainDrops: true,
    });
    const rows = data.droppedRows ?? [];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.filter).toBe("minTokenCount");
    expect(rows[0]?.threshold).toBe(100_000);
    expect(typeof rows[0]?.rowId).toBe("string");
  });

  it("the attention merge indexes rows in MERGE order, which it discloses", async () => {
    const data = await call("dexscreener.attention", {
      chainIds: "robinhood",
      explainDrops: true,
    });
    const rows = data.droppedRows ?? [];
    expect(rows.length).toBeGreaterThan(0);
    const indexes = rows.map((row) => row.providerRowIndex);

    // Boost rows first, then profile-only rows — deterministic within the
    // response, never claimed to be stable across calls.
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
    expect(new Set(indexes).size).toBe(indexes.length);
    for (const index of indexes) {
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(data.providerWindow.providerReturned);
    }
    // The index counts the PRE-FILTER input, not a position in droppedRows: rows
    // that survived leave gaps. This call keeps some, so the sequence cannot be
    // 0,1,2,… — which is exactly what distinguishes the two readings.
    expect(data.returned).toBeGreaterThan(0);
    expect(indexes).not.toEqual(indexes.map((_, position) => position));
  });

  it("is rejected as a non-boolean rather than read as truthy", async () => {
    const handler = DEXSCREENER_HANDLERS["dexscreener.search"];
    if (handler === undefined) throw new Error("no handler");
    const result = await handler({ query: "USDC", explainDrops: "yes" }, READ_CTX);
    expect(result.success).toBe(false);
    expect(result.output).toContain("explainDrops");
  });
});
