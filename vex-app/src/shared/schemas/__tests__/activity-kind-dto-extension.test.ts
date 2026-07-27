/**
 * `activityKind` / `eventRole` on the EXISTING feed DTOs — the re-skin seam.
 *
 * The Agent Scan work retires the SPOT taxonomy from the UI. Before the
 * renderer can stop reading `productType`/`tradeSide`, the two feeds that
 * predate the canonical vocabulary must CARRY it: `MoveItem` and the
 * `token-history` swap/bridge entries gain `activityKind` + `eventRole`.
 *
 * Two properties are pinned here.
 *
 *  1. BACKWARD COMPATIBLE. Both fields are optional AND nullable, so a payload
 *     minted before this change still parses. The DTOs are validated on BOTH
 *     sides of IPC; a required field would have turned a version skew into an
 *     empty panel — the exact failure mode `portfolio-moves.ts`'s header
 *     documents. Optional rather than `.default(null)` additionally keeps every
 *     existing construction site compiling, so the vocabulary can roll out
 *     across surfaces without a lockstep edit. `undefined` and `null` carry the
 *     SAME meaning ("no canonical vocabulary on this row"), which is why every
 *     assertion below reads the field as `?? null`.
 *
 *  2. LEGACY ROWS DERIVE, THEY DO NOT GO NULL. A legacy `proj_activity` row
 *     carries a canonical `activityKind` derived server-side from its
 *     `product_type` (`bridge`→bridge, send→transfer, spot→swap, unknown→the
 *     neutral `activity`). Without that the renderer could not drop
 *     `productType`/`tradeSide` without losing legacy Moves semantics. Only
 *     `eventRole` stays null on a legacy row — `proj_activity` has no such
 *     concept, and inventing one would be a lie.
 *
 * The SQL that performs the derivation is pinned in the db suites; this file
 * pins the CONTRACT that lets it travel.
 */

import { describe, expect, it } from "vitest";
import { moveItemSchema } from "../portfolio-moves.js";
import { tokenHistoryEntrySchema } from "../token-history.js";
import {
  ACTIVITY_KIND_MAX_LENGTH,
  EVENT_ROLE_MAX_LENGTH,
  NEUTRAL_ACTIVITY_KIND,
} from "../../agent-activity-vocabulary.js";

const ISO = "2026-05-21T10:00:00.000Z";
const EVM_ADDR = "0xbeefbeefbeefbeefbeefbeefbeefbeefbeefbeef";

function moveFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "success:42",
    source: "success",
    status: null,
    failureCode: null,
    tradeSide: "buy",
    productType: "spot",
    venue: "kyberswap",
    inputToken: "USDC",
    inputTokenSymbol: "USDC",
    inputAmount: "100",
    outputToken: "ETH",
    outputTokenSymbol: "ETH",
    outputAmount: "0.03",
    valueUsd: 100,
    captureStatus: "executed",
    instrumentKey: "eth-usdc",
    chain: "ethereum",
    txRef: "0xabc123",
    walletAddress: EVM_ADDR,
    createdAt: ISO,
    ...overrides,
  };
}

function tokenHistorySwapFixture(overrides: Record<string, unknown> = {}) {
  const leg = {
    token: EVM_ADDR,
    symbol: "USDC",
    localSymbol: null,
    amount: { value: "1.5", unitProvenance: "human" as const },
    valueUsd: { value: "1.50", usdProvenance: "recorded" as const },
  };
  return {
    kind: "swap",
    id: "activity:1",
    createdAt: ISO,
    txRefs: [{ chainId: 8453, ref: "0xdeadbeef" }],
    chain: "base",
    venue: "kyberswap",
    tradeSide: "buy",
    productType: "spot",
    input: leg,
    output: leg,
    unitPriceUsd: "1.00",
    captureStatus: "executed",
    status: null,
    failureCode: null,
    ...overrides,
  };
}

function tokenHistoryBridgeFixture(overrides: Record<string, unknown> = {}) {
  const leg = {
    token: EVM_ADDR,
    symbol: "USDC",
    localSymbol: null,
    amount: { value: "1.5", unitProvenance: "human" as const },
    valueUsd: { value: "1.50", usdProvenance: "estimated" as const },
  };
  return {
    kind: "bridge",
    id: "agent_activity:7",
    createdAt: ISO,
    txRefs: [],
    originChain: "base",
    destinationChain: "arbitrum",
    venue: "khalani",
    input: leg,
    output: leg,
    captureStatus: null,
    ...overrides,
  };
}

// ── MoveItem ──────────────────────────────────────────────────────────────

describe("MoveItem.activityKind / eventRole", () => {
  it("parses a payload minted before these fields existed", () => {
    const parsed = moveItemSchema.safeParse(moveFixture());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.activityKind ?? null).toBeNull();
    expect(parsed.data.eventRole ?? null).toBeNull();
  });

  it("carries a derived canonical kind on a legacy row, with eventRole still null", () => {
    for (const kind of ["bridge", "transfer", "swap", NEUTRAL_ACTIVITY_KIND]) {
      const parsed = moveItemSchema.safeParse(
        moveFixture({ activityKind: kind, eventRole: null }),
      );
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;
      expect(parsed.data.activityKind).toBe(kind);
      expect(parsed.data.eventRole ?? null).toBeNull();
    }
  });

  it("carries the real vocabulary on an agent_activity row", () => {
    const parsed = moveItemSchema.safeParse(
      moveFixture({
        source: "agent_activity",
        activityKind: "bridge",
        eventRole: "bridge_fill_expected",
      }),
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.activityKind).toBe("bridge");
    expect(parsed.data.eventRole).toBe("bridge_fill_expected");
  });

  it("stays TOLERANT — an unknown kind/role the engine mints still parses", () => {
    const parsed = moveItemSchema.safeParse(
      moveFixture({ activityKind: "perp_futures", eventRole: "perp_open" }),
    );
    expect(parsed.success).toBe(true);
  });

  it("is still BOUNDED — tolerant is not unbounded", () => {
    expect(
      moveItemSchema.safeParse(
        moveFixture({ activityKind: "x".repeat(ACTIVITY_KIND_MAX_LENGTH + 1) }),
      ).success,
    ).toBe(false);
    expect(
      moveItemSchema.safeParse(
        moveFixture({ eventRole: "x".repeat(EVENT_ROLE_MAX_LENGTH + 1) }),
      ).success,
    ).toBe(false);
  });

  it("keeps productType/tradeSide intact (their consumers retire separately)", () => {
    const parsed = moveItemSchema.safeParse(
      moveFixture({ activityKind: "swap", eventRole: null }),
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.productType).toBe("spot");
    expect(parsed.data.tradeSide).toBe("buy");
  });
});

// ── token-history swap + bridge entries ───────────────────────────────────

describe("token-history entries: activityKind / eventRole", () => {
  it("parses a pre-existing swap entry payload", () => {
    const parsed = tokenHistoryEntrySchema.safeParse(tokenHistorySwapFixture());
    expect(parsed.success).toBe(true);
    if (!parsed.success || parsed.data.kind !== "swap") return;
    expect(parsed.data.activityKind ?? null).toBeNull();
    expect(parsed.data.eventRole ?? null).toBeNull();
  });

  it("parses a pre-existing bridge entry payload", () => {
    const parsed = tokenHistoryEntrySchema.safeParse(tokenHistoryBridgeFixture());
    expect(parsed.success).toBe(true);
    if (!parsed.success || parsed.data.kind !== "bridge") return;
    expect(parsed.data.activityKind ?? null).toBeNull();
    expect(parsed.data.eventRole ?? null).toBeNull();
  });

  it("does NOT collide with the entry union discriminant `kind`", () => {
    // `kind` stays swap|bridge|transfer — the DTO's own shape discriminant.
    // The engine vocabulary rides `activityKind`, so a lend row is
    // `kind: "swap"` + `activityKind: "lend"` without either field lying.
    const parsed = tokenHistoryEntrySchema.safeParse(
      tokenHistorySwapFixture({
        productType: "lend",
        activityKind: "lend",
        eventRole: "lend_deposit",
        status: "confirmed",
      }),
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success || parsed.data.kind !== "swap") return;
    expect(parsed.data.kind).toBe("swap");
    expect(parsed.data.activityKind).toBe("lend");
    expect(parsed.data.eventRole).toBe("lend_deposit");
  });

  it("carries a derived kind on a legacy swap entry with eventRole null", () => {
    const parsed = tokenHistoryEntrySchema.safeParse(
      tokenHistorySwapFixture({ activityKind: NEUTRAL_ACTIVITY_KIND, eventRole: null }),
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success || parsed.data.kind !== "swap") return;
    expect(parsed.data.activityKind).toBe(NEUTRAL_ACTIVITY_KIND);
    expect(parsed.data.eventRole ?? null).toBeNull();
  });

  it("stays tolerant and bounded on both entry shapes", () => {
    expect(
      tokenHistoryEntrySchema.safeParse(
        tokenHistorySwapFixture({ activityKind: "brand_new", eventRole: "brand_new_role" }),
      ).success,
    ).toBe(true);
    expect(
      tokenHistoryEntrySchema.safeParse(
        tokenHistoryBridgeFixture({ activityKind: "brand_new" }),
      ).success,
    ).toBe(true);
    expect(
      tokenHistoryEntrySchema.safeParse(
        tokenHistorySwapFixture({ activityKind: "x".repeat(ACTIVITY_KIND_MAX_LENGTH + 1) }),
      ).success,
    ).toBe(false);
    expect(
      tokenHistoryEntrySchema.safeParse(
        tokenHistoryBridgeFixture({ eventRole: "x".repeat(EVENT_ROLE_MAX_LENGTH + 1) }),
      ).success,
    ).toBe(false);
  });
});
