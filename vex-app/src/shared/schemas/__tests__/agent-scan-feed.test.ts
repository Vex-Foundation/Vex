/**
 * `agent-scan-feed` schema tests — the Agent Scan page's IPC contract.
 *
 * Three things are pinned here, in priority order:
 *  1. INPUT IS BOUNDED. Every filter array has a hard cap and every scalar a
 *     hard length/shape, so a hostile or buggy renderer cannot turn one read
 *     into an unbounded SQL predicate.
 *  2. OUTPUT IS TOLERANT. `activityKind` / `eventRole` / `status` /
 *     `failureCode` are OPEN strings — the repo has burned three live outages
 *     on closed re-declared enums (`portfolio-moves.ts:18-34`,
 *     `token-history.ts:239-244`), so an engine that mints a new vocabulary
 *     value must never blank the page.
 *  3. OUTPUT IS STILL BOUNDED. Tolerant does not mean unbounded: every open
 *     string carries an explicit `.max(...)`.
 */

import { describe, expect, it } from "vitest";
import {
  AGENT_SCAN_BRIDGE_LEGS_MAX,
  AGENT_SCAN_FILTER_KINDS_MAX,
  AGENT_SCAN_FILTER_PROTOCOLS_MAX,
  AGENT_SCAN_PAGE_SIZE,
  agentScanCursorSchema,
  agentScanDtoSchema,
  agentScanEntrySchema,
  agentScanReadInputSchema,
  type AgentScanEntry,
} from "../agent-scan-feed.js";

// ── Fixtures ──────────────────────────────────────────────────────────────

function leg(overrides: Record<string, unknown> = {}) {
  return {
    address: "0xbeefbeefbeefbeefbeefbeefbeefbeefbeefbeef",
    symbol: "USDC",
    displaySymbol: "USDC",
    decimals: 6,
    amountHuman: "1.5",
    amountRaw: "1500000",
    executedAmountHuman: null,
    executedAmountRaw: "1500000",
    displayAmount: "1.5",
    usdEst: "1.50",
    ...overrides,
  };
}

function entry(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: "42",
    createdAt: "2026-05-21T10:00:00.000Z",
    activityKind: "swap",
    eventRole: "swap",
    status: "confirmed",
    protocol: "kyberswap",
    chainId: 8453,
    chainFamily: "eip155",
    chainSlug: "base",
    fromChain: null,
    toChain: null,
    input: leg(),
    output: leg({ symbol: "NATIVE", displaySymbol: "NATIVE (ETH)" }),
    amountBasis: null,
    vexFee: null,
    usdFeeEst: null,
    failureCode: null,
    failureReason: null,
    txHash: "0xabc",
    explorerUrl: "https://basescan.org/tx/0xabc",
    legs: [],
    providerOrderId: null,
    lastCheckedAt: null,
    // Wave P — DERIVED, never a stored status. Default fixture is a row we have
    // had no trouble verifying.
    stalledVerification: false,
    stalledReason: null,
    pendingReason: null,
    ...overrides,
  };
}

const CURSOR = {
  createdAt: "2026-05-21T10:00:00.123456Z",
  sourceId: "42",
};

// ── Input: cursor ─────────────────────────────────────────────────────────

describe("agentScanCursorSchema", () => {
  it("accepts the exact microsecond SQL serialization", () => {
    expect(agentScanCursorSchema.safeParse(CURSOR).success).toBe(true);
  });

  it("rejects a millisecond-precision timestamp (a Date round-trip)", () => {
    // `new Date(...).toISOString()` loses the sub-millisecond digits that keep
    // the keyset stable at ties — it must never be accepted as a cursor.
    const parsed = agentScanCursorSchema.safeParse({
      ...CURSOR,
      createdAt: "2026-05-21T10:00:00.123Z",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a non-numeric sourceId", () => {
    expect(
      agentScanCursorSchema.safeParse({ ...CURSOR, sourceId: "42; DROP" }).success,
    ).toBe(false);
    expect(agentScanCursorSchema.safeParse({ ...CURSOR, sourceId: "" }).success).toBe(
      false,
    );
    expect(agentScanCursorSchema.safeParse({ ...CURSOR, sourceId: "-1" }).success).toBe(
      false,
    );
  });

  it("rejects a sourceId wider than a signed bigint", () => {
    expect(
      agentScanCursorSchema.safeParse({ ...CURSOR, sourceId: "1".repeat(20) }).success,
    ).toBe(false);
  });

  it("rejects unknown keys", () => {
    expect(
      agentScanCursorSchema.safeParse({ ...CURSOR, sourceRank: 2 }).success,
    ).toBe(false);
  });
});

// ── Input: filters ────────────────────────────────────────────────────────

describe("agentScanReadInputSchema", () => {
  it("defaults an empty request to no cursor and no filters", () => {
    const parsed = agentScanReadInputSchema.safeParse({});
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.cursor).toBeNull();
    expect(parsed.data.filters).toEqual({});
  });

  it("accepts every filter together", () => {
    const parsed = agentScanReadInputSchema.safeParse({
      cursor: CURSOR,
      filters: {
        kinds: ["swap", "wrap"],
        statuses: ["pending", "confirmed"],
        protocols: ["kyberswap"],
        chainFamily: "solana",
        sessionId: "11111111-2222-4333-8444-555555555555",
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("bounds the kinds filter", () => {
    const tooMany = Array.from({ length: AGENT_SCAN_FILTER_KINDS_MAX + 1 }, (_, i) => `k${i}`);
    expect(
      agentScanReadInputSchema.safeParse({ filters: { kinds: tooMany } }).success,
    ).toBe(false);
    expect(
      agentScanReadInputSchema.safeParse({
        filters: { kinds: tooMany.slice(0, AGENT_SCAN_FILTER_KINDS_MAX) },
      }).success,
    ).toBe(true);
  });

  it("bounds the protocols filter", () => {
    const tooMany = Array.from(
      { length: AGENT_SCAN_FILTER_PROTOCOLS_MAX + 1 },
      (_, i) => `p${i}`,
    );
    expect(
      agentScanReadInputSchema.safeParse({ filters: { protocols: tooMany } }).success,
    ).toBe(false);
  });

  it("bounds each kind/protocol string length and rejects blanks", () => {
    expect(
      agentScanReadInputSchema.safeParse({ filters: { kinds: ["x".repeat(200)] } })
        .success,
    ).toBe(false);
    expect(
      agentScanReadInputSchema.safeParse({ filters: { protocols: [""] } }).success,
    ).toBe(false);
  });

  it("keeps the status filter a CLOSED vocabulary (it compiles to SQL)", () => {
    expect(
      agentScanReadInputSchema.safeParse({ filters: { statuses: ["definitively_failed"] } })
        .success,
    ).toBe(false);
    expect(
      agentScanReadInputSchema.safeParse({ filters: { statuses: ["failed"] } }).success,
    ).toBe(true);
  });

  it("keeps the chainFamily filter a CLOSED vocabulary", () => {
    expect(
      agentScanReadInputSchema.safeParse({ filters: { chainFamily: "evm" } }).success,
    ).toBe(false);
    expect(
      agentScanReadInputSchema.safeParse({ filters: { chainFamily: "eip155" } }).success,
    ).toBe(true);
  });

  it("requires sessionId to be a uuid", () => {
    expect(
      agentScanReadInputSchema.safeParse({ filters: { sessionId: "not-a-uuid" } }).success,
    ).toBe(false);
  });

  it("requires projectId to be a uuid", () => {
    expect(
      agentScanReadInputSchema.safeParse({ filters: { projectId: "not-a-uuid" } })
        .success,
    ).toBe(false);
    expect(
      agentScanReadInputSchema.safeParse({
        filters: { projectId: "33333333-4444-4555-8666-777777777777" },
      }).success,
    ).toBe(true);
  });

  it("REFUSES sessionId and projectId together, BY NAME - two scopes are not a scope", () => {
    const parsed = agentScanReadInputSchema.safeParse({
      filters: {
        sessionId: "11111111-2222-4333-8444-555555555555",
        projectId: "33333333-4444-4555-8666-777777777777",
      },
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    // Rule 90: a forbidden combination is refused by NAME, never silently
    // reduced to one of the two - a request that quietly dropped one id would
    // read a scope the caller never asked for.
    const issue = parsed.error.issues[0];
    expect(issue?.path).toEqual(["filters", "projectId"]);
    expect(issue?.message).toContain("projectId");
    expect(issue?.message).toContain("sessionId");
  });

  it("accepts a projectId beside the ordinary filters", () => {
    expect(
      agentScanReadInputSchema.safeParse({
        filters: {
          kinds: ["swap"],
          statuses: ["confirmed"],
          projectId: "33333333-4444-4555-8666-777777777777",
        },
      }).success,
    ).toBe(true);
  });

  it("rejects unknown top-level and filter keys", () => {
    expect(agentScanReadInputSchema.safeParse({ walletAddress: "0x1" }).success).toBe(
      false,
    );
    expect(
      agentScanReadInputSchema.safeParse({ filters: { wallets: ["0x1"] } }).success,
    ).toBe(false);
  });
});

// ── Output: tolerant entry ────────────────────────────────────────────────

describe("agentScanEntrySchema", () => {
  it("parses a well-formed entry", () => {
    expect(agentScanEntrySchema.safeParse(entry()).success).toBe(true);
  });

  it("accepts an UNKNOWN activityKind / eventRole / status (tolerant reader)", () => {
    const parsed = agentScanEntrySchema.safeParse(
      entry({
        activityKind: "perp_futures",
        eventRole: "perp_open",
        status: "settling",
      }),
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const value: AgentScanEntry = parsed.data;
    expect(value.activityKind).toBe("perp_futures");
    expect(value.eventRole).toBe("perp_open");
    expect(value.status).toBe("settling");
  });

  it("accepts an unknown failureCode and a long-but-bounded failureReason", () => {
    expect(
      agentScanEntrySchema.safeParse(
        entry({ status: "failed", failureCode: "brand_new_code", failureReason: "x".repeat(500) }),
      ).success,
    ).toBe(true);
  });

  it("BOUNDS every tolerant string", () => {
    for (const field of ["activityKind", "eventRole", "status", "protocol", "failureCode"]) {
      expect(
        agentScanEntrySchema.safeParse(entry({ [field]: "x".repeat(600) })).success,
      ).toBe(false);
    }
    expect(
      agentScanEntrySchema.safeParse(entry({ failureReason: "x".repeat(501) })).success,
    ).toBe(false);
    expect(
      agentScanEntrySchema.safeParse(entry({ explorerUrl: `https://x/${"y".repeat(600)}` }))
        .success,
    ).toBe(false);
  });

  it("keeps displaySymbol separate from the sanitized stored symbol", () => {
    // "NATIVE (ETH)" carries a space and parentheses — `sanitizeTokenSymbol`
    // rejects both BY DESIGN, so the annotation may only ever live on
    // `displaySymbol`, never on `symbol`.
    const parsed = agentScanEntrySchema.safeParse(entry());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.output.symbol).toBe("NATIVE");
    expect(parsed.data.output.displaySymbol).toBe("NATIVE (ETH)");
  });

  it("carries bridge legs with a tolerant role and a main-resolved explorerUrl", () => {
    const parsed = agentScanEntrySchema.safeParse(
      entry({
        activityKind: "bridge",
        eventRole: "bridge_fill_expected",
        fromChain: { chainId: 8453, slug: "base" },
        toChain: { chainId: 42161, slug: "arbitrum" },
        legs: [
          {
            role: "bridge_deposit",
            chainId: 8453,
            chainFamily: "eip155",
            chainSlug: "base",
            txHash: "0xdead",
            status: "confirmed",
            failureCode: null,
            explorerUrl: "https://basescan.org/tx/0xdead",
          },
          {
            role: "a_role_added_after_this_build",
            chainId: 42161,
            chainFamily: "eip155",
            chainSlug: null,
            txHash: null,
            status: null,
            failureCode: null,
            explorerUrl: null,
          },
        ],
      }),
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.legs).toHaveLength(2);
    expect(parsed.data.legs[1]?.role).toBe("a_role_added_after_this_build");
  });

  it("bounds the legs array", () => {
    const oneLeg = {
      role: "bridge_deposit",
      chainId: 8453,
      chainFamily: "eip155",
      chainSlug: "base",
      txHash: "0xdead",
      status: "confirmed",
      failureCode: null,
      explorerUrl: null,
    };
    const legs = Array.from({ length: AGENT_SCAN_BRIDGE_LEGS_MAX + 1 }, () => oneLeg);
    expect(agentScanEntrySchema.safeParse(entry({ legs })).success).toBe(false);
  });

  it("carries an optional vexFee", () => {
    expect(
      agentScanEntrySchema.safeParse(
        entry({ vexFee: { tokenSymbol: "USDC", amountHuman: "0.01" } }),
      ).success,
    ).toBe(true);
  });

  it("rejects unknown entry and leg keys", () => {
    expect(agentScanEntrySchema.safeParse(entry({ walletAddress: "0x1" })).success).toBe(
      false,
    );
    expect(
      agentScanEntrySchema.safeParse(entry({ input: leg({ routeProvenance: {} }) })).success,
    ).toBe(false);
  });
});

// ── Output: page union ────────────────────────────────────────────────────

describe("agentScanDtoSchema", () => {
  it("parses an available page", () => {
    const parsed = agentScanDtoSchema.safeParse({
      status: "available",
      entries: [entry()],
      nextCursor: CURSOR,
      hasMore: true,
    });
    expect(parsed.success).toBe(true);
  });

  it("parses the unavailable arm", () => {
    const parsed = agentScanDtoSchema.safeParse({
      status: "unavailable",
      reason: "query_timeout",
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.status).toBe("unavailable");
  });

  it("rejects an unavailable reason outside the closed set", () => {
    expect(
      agentScanDtoSchema.safeParse({ status: "unavailable", reason: "db_down" }).success,
    ).toBe(false);
  });

  it("fails closed on a page larger than the server-side cap", () => {
    const entries = Array.from({ length: AGENT_SCAN_PAGE_SIZE + 1 }, () => entry());
    expect(
      agentScanDtoSchema.safeParse({
        status: "available",
        entries,
        nextCursor: null,
        hasMore: false,
      }).success,
    ).toBe(false);
  });
});
