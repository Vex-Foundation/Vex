/**
 * `agent-scan-lighter-mappers` - one `lighter_fills` row plus its market's
 * newest observation into one feed entry.
 *
 * Every mapped entry is parsed through `agentScanLighterFillEntrySchema`
 * before anything else is asserted: the mapper's real contract is not "returns
 * an object" but "returns something the IPC boundary accepts", and a shape the
 * DTO would refuse must fail HERE rather than as a blank page in front of the
 * user.
 *
 * The posture these tests pin comes from metamask-core's
 * `PendingTransactionTracker`: a fact is reported as OBSERVED, with its own
 * timestamp, and a fact nobody established is UNKNOWN - never a zero, never a
 * default, never the current value passed off as the historical one.
 */

import { describe, expect, it } from "vitest";

import {
  LIGHTER_SPOT_MARKET_INDEX_FLOOR,
  mapAgentScanLighterRow,
  type AgentScanLighterMappingStats,
} from "../agent-scan-lighter-mappers.js";
import { agentScanLighterFillEntrySchema } from "@shared/schemas/agent-scan-lighter-entry.js";
import type { AgentScanLighterRow } from "../agent-scan-lighter-types.js";

const TRADED_AT = new Date("2026-09-08T12:00:00.000Z");
const OBSERVED_AT = new Date("2026-09-08T12:00:03.000Z");
const POSITION_OBSERVED_AT = new Date("2026-09-08T16:49:00.000Z");

/** A perpetual ETH taker buy with a full account half and a proven integrator fee. */
function row(overrides: Partial<AgentScanLighterRow> = {}): AgentScanLighterRow {
  return {
    source_rank: 1,
    source_id: "77",
    cursor_ts: "2026-09-08T12:00:00.000000Z",
    traded_at: TRADED_AT,
    observed_at: OBSERVED_AT,
    environment: "core",
    market_index: 1,
    market_symbol: "ETH",
    side: "buy",
    trade_type: "trade",
    position_effect: "open",
    base_size: "0.0050",
    price: "2598.09",
    quote_notional: "12.99045",
    usd_amount: "12.99",
    block_height: "10453221",
    base_asset_symbol: "ETH",
    base_asset_decimals: 18,
    quote_asset_symbol: "USDC",
    quote_asset_decimals: 6,
    position_size_before: "0",
    entry_quote_before: "0",
    account_pnl: "0",
    initial_margin_fraction_before: 1000,
    fee_side: "taker",
    integrator_fee_charged_raw: "3247",
    integrator_fee_estimated_raw: "3247",
    integrator_fee_estimate_basis: "quote_notional",
    integrator_fee_estimate_tick_source: "observed",
    integrator_fee_estimated_usd: "0.003247",
    integrator_fee_asset_symbol: "USDC",
    integrator_fee_asset_decimals: 6,
    integrator_fee_tick_observed: 250,
    integrator_fee_tick_authorized: 250,
    exchange_fee_charged_raw: "1299",
    exchange_fee_estimated_usd: "0.001299",
    exchange_fee_tick_observed: 100,
    provider_trade_id: "918273645",
    provider_order_id: "112233",
    execution_intent_id: "lighter-exec-6f4c2c60-0d3f-4a77-8f7f-0b4ce9a11111",
    position_observed_at: null,
    position_open: null,
    position_now: null,
    ...overrides,
  };
}

/** Map, then prove the result survives the IPC output schema. */
function mapValid(
  source: AgentScanLighterRow,
  stats?: AgentScanLighterMappingStats,
) {
  const entry = mapAgentScanLighterRow(source, stats);
  const parsed = agentScanLighterFillEntrySchema.safeParse(entry);
  expect(parsed.success).toBe(true);
  return entry;
}

// ── Identity and market ───────────────────────────────────────────────────

describe("identity, time and market", () => {
  it("uses traded_at as the feed time and keeps observed_at as its own fact", () => {
    const entry = mapValid(row());
    expect(entry.source).toBe("lighter_fill");
    expect(entry.id).toBe("77");
    // The VENUE's match time, which is what the page is ordered and cut by.
    expect(entry.createdAt).toBe("2026-09-08T12:00:00.000Z");
    // When VEX saw it - a different fact, and never substituted for the first.
    expect(entry.observedAt).toBe("2026-09-08T12:00:03.000Z");
  });

  /**
   * The venue's own spot-market index boundary, measured by the engine's wire
   * mapper (`src/vex-agent/sync/agentscan-report/lighter-fill-event.ts:85` and
   * `src/vex-agent/tools/protocols/lighter/agentscan-activity.ts:95`). A spot
   * fill has no position, so the flag is what lets a renderer stop claiming
   * one.
   */
  it("classifies spot by the venue's own market index floor", () => {
    expect(LIGHTER_SPOT_MARKET_INDEX_FLOOR).toBe(2048);
    expect(mapValid(row({ market_index: 2047 })).spot).toBe(false);
    expect(mapValid(row({ market_index: 2048 })).spot).toBe(true);
    expect(mapValid(row({ market_index: 4096 })).spot).toBe(true);
  });

  it("falls back to the market index when the symbol is missing, never to a blank label", () => {
    expect(mapValid(row({ market_symbol: null, market_index: 12 })).marketSymbol).toBe("12");
  });
});

// ── Leverage ──────────────────────────────────────────────────────────────

describe("leverage before the fill", () => {
  /**
   * The display comes from `initialMarginFractionToLeverageDisplay`, the one
   * owner of Lighter's 10000-scale unit: TRUNCATED to two decimals, because
   * 3334 is 2.9994x and "3.00x" would state leverage the exchange will not give.
   */
  it.each([
    [10_000, "1.00"],
    [5000, "2.00"],
    [3334, "2.99"],
    [1000, "10.00"],
    [333, "30.03"],
    [200, "50.00"],
    [1, "10000.00"],
  ])("renders fraction %i as %s", (fraction, display) => {
    const entry = mapValid(row({ initial_margin_fraction_before: fraction }));
    expect(entry.leverage).toEqual({ initialMarginFraction: fraction, display });
  });

  /**
   * A public row and a row written before the column existed both hold NULL,
   * and both mean "unknown". Rendering a current leverage beside a historical
   * fill would state a fact nobody established.
   */
  it("reports NULL leverage as unknown, never as a number", () => {
    expect(mapValid(row({ initial_margin_fraction_before: null })).leverage).toBeNull();
  });

  /**
   * The unit owner THROWS outside 1..10000. A stored value outside that range
   * is data this reader cannot interpret, and degrading it to "unknown" keeps
   * one bad row from taking the whole page down.
   */
  it("degrades an out-of-range fraction to unknown instead of throwing", () => {
    expect(mapValid(row({ initial_margin_fraction_before: 0 })).leverage).toBeNull();
    expect(mapValid(row({ initial_margin_fraction_before: 10_001 })).leverage).toBeNull();
    expect(mapValid(row({ initial_margin_fraction_before: -5 })).leverage).toBeNull();
    expect(mapValid(row({ initial_margin_fraction_before: "garbage" })).leverage).toBeNull();
  });
});

// ── The account half ──────────────────────────────────────────────────────

describe("the account's own half of the trade record", () => {
  it("carries the account facts as stored, including a signed short and a loss", () => {
    const entry = mapValid(row({
      position_size_before: "-0.25",
      entry_quote_before: "-640.5",
      account_pnl: "-12.44",
      position_effect: "reduce",
    }));
    expect(entry.positionSizeBefore).toBe("-0.25");
    expect(entry.entryQuoteBefore).toBe("-640.5");
    expect(entry.accountPnl).toBe("-12.44");
    expect(entry.positionEffect).toBe("reduce");
  });

  /**
   * A public trade row carries no account half at all. Every field stays null:
   * a zero here would read as "the account held nothing and realized nothing",
   * which is a claim, not an absence.
   */
  it("reports a missing account half as null, never as 0", () => {
    const entry = mapValid(row({
      position_size_before: null,
      entry_quote_before: null,
      account_pnl: null,
      position_effect: null,
      initial_margin_fraction_before: null,
    }));
    expect(entry.positionSizeBefore).toBeNull();
    expect(entry.entryQuoteBefore).toBeNull();
    expect(entry.accountPnl).toBeNull();
    expect(entry.positionEffect).toBeNull();
    expect(entry.leverage).toBeNull();
  });

  /** Migration 152 admits a null `entry_quote_before` beside a present half. */
  it("admits a null entry quote beside the other account facts", () => {
    const entry = mapValid(row({ entry_quote_before: null }));
    expect(entry.entryQuoteBefore).toBeNull();
    expect(entry.accountPnl).toBe("0");
  });
});

// ── Fee provenance ────────────────────────────────────────────────────────

describe("fee provenance", () => {
  it("carries the exact charged integrator fee with its own asset", () => {
    const entry = mapValid(row());
    expect(entry.integratorFee.charged).toEqual({
      raw: "3247",
      symbol: "USDC",
      decimals: 6,
    });
    expect(entry.integratorFee.tickObserved).toBe(250);
    expect(entry.integratorFee.tickAuthorized).toBe(250);
  });

  /**
   * NULL is UNPROVEN, never zero (migration 152 says so in the column comment).
   * The estimate stays beside it with its basis and the tick it used, so a
   * renderer can show an estimate MARKED as one rather than a fabricated exact
   * charge of nothing.
   */
  it("reports an unproven charged fee as null and keeps the estimate with its basis", () => {
    const entry = mapValid(row({ integrator_fee_charged_raw: null }));
    expect(entry.integratorFee.charged).toBeNull();
    expect(entry.integratorFee.estimate).toEqual({
      raw: "3247",
      symbol: "USDC",
      decimals: 6,
      basis: "quote_notional",
      tickSource: "observed",
      usd: "0.003247",
    });
  });

  it("reports no estimate at all when the ledger holds none", () => {
    const entry = mapValid(row({
      integrator_fee_estimated_raw: null,
      integrator_fee_estimate_basis: null,
      integrator_fee_estimate_tick_source: null,
      integrator_fee_estimated_usd: null,
    }));
    expect(entry.integratorFee.estimate).toBeNull();
  });

  /** The USD estimate is NULL for the integrator fee on a spot BUY (migration 152). */
  it("keeps a null USD estimate null rather than inventing a dollar figure", () => {
    const entry = mapValid(row({ integrator_fee_estimated_usd: null }));
    expect(entry.integratorFee.estimate?.usd).toBeNull();
  });

  /**
   * The exchange fee has no asset columns of its own, so the DENOMINATION is
   * resolved by the venue's own rule: the received BASE on a spot buy, the
   * QUOTE asset otherwise (`lighter-fill-event.ts:513`).
   */
  it("denominates the exchange fee in the quote asset on a perpetual, either side", () => {
    expect(mapValid(row({ side: "buy" })).exchangeFee.charged?.symbol).toBe("USDC");
    expect(mapValid(row({ side: "sell" })).exchangeFee.charged?.symbol).toBe("USDC");
  });

  it("denominates the exchange fee in the received BASE on a spot buy only", () => {
    const spotBuy = mapValid(row({ market_index: 2048, side: "buy" }));
    expect(spotBuy.exchangeFee.charged).toEqual({ raw: "1299", symbol: "ETH", decimals: 18 });
    const spotSell = mapValid(row({ market_index: 2048, side: "sell" }));
    expect(spotSell.exchangeFee.charged?.symbol).toBe("USDC");
  });

  /** The exchange reports a rebate as a NEGATIVE charged amount; the sign survives. */
  it("carries a rebate as a negative charged amount, not as a charge", () => {
    const entry = mapValid(row({ exchange_fee_charged_raw: "-412" }));
    expect(entry.exchangeFee.charged?.raw).toBe("-412");
  });

  it("reports an unproven exchange fee as null and keeps its USD estimate", () => {
    const entry = mapValid(row({ exchange_fee_charged_raw: null }));
    expect(entry.exchangeFee.charged).toBeNull();
    expect(entry.exchangeFee.estimatedUsd).toBe("0.001299");
    expect(entry.exchangeFee.tickObserved).toBe(100);
  });
});

// ── positionNow ───────────────────────────────────────────────────────────

describe("the market's newest observed position", () => {
  /** Vex has never observed this market: not closed, not open - nothing to say. */
  it("is null when no observation exists for the market", () => {
    expect(mapValid(row()).positionNow).toBeNull();
  });

  /** Migration 152 stores `open = false, position = NULL` for a closed market. */
  it("reports an observed CLOSURE with its observation time and no details", () => {
    const entry = mapValid(row({
      position_observed_at: POSITION_OBSERVED_AT,
      position_open: false,
      position_now: null,
    }));
    expect(entry.positionNow).toEqual({
      observedAt: "2026-09-08T16:49:00.000Z",
      open: false,
      position: null,
    });
  });

  it("reports an open position with every projected fact", () => {
    const entry = mapValid(row({
      position_observed_at: POSITION_OBSERVED_AT,
      position_open: true,
      position_now: {
        marketIndex: 1,
        marketSymbol: "ETH",
        size: "0.0050",
        entryPrice: "2598.09",
        unrealizedPnl: "-0.0077",
        realizedPnl: "0",
        liquidationPrice: "2365.93",
        initialMarginFraction: 1000,
        marginMode: "isolated",
      },
    }));
    expect(entry.positionNow).toEqual({
      // VEX'S OWN observation time from the position sweep, not a venue clock.
      observedAt: "2026-09-08T16:49:00.000Z",
      open: true,
      position: {
        size: "0.0050",
        entryPrice: "2598.09",
        unrealizedPnl: "-0.0077",
        realizedPnl: "0",
        liquidationPrice: "2365.93",
        leverage: { initialMarginFraction: 1000, display: "10.00" },
        marginMode: "isolated",
      },
    });
  });

  /**
   * An observation stored BEFORE leverage and margin mode were projected simply
   * has no such keys. It must still read, with those two facts unknown.
   */
  it("reads an OLD observation that predates the leverage and margin-mode keys", () => {
    const entry = mapValid(row({
      position_observed_at: POSITION_OBSERVED_AT,
      position_open: true,
      position_now: {
        marketIndex: 1,
        marketSymbol: "ETH",
        size: "-1.5",
        entryPrice: "2600",
        unrealizedPnl: null,
        realizedPnl: null,
        liquidationPrice: null,
      },
    }));
    expect(entry.positionNow).toEqual({
      observedAt: "2026-09-08T16:49:00.000Z",
      open: true,
      position: {
        size: "-1.5",
        entryPrice: "2600",
        unrealizedPnl: null,
        realizedPnl: null,
        liquidationPrice: null,
        leverage: null,
        marginMode: null,
      },
    });
  });

  /**
   * A malformed OPTIONAL fact is unknown on its own. Discarding the readable
   * size and entry price beside it would hide facts Vex really did observe.
   */
  it("nulls one malformed optional fact WITHOUT discarding its neighbours", () => {
    const entry = mapValid(row({
      position_observed_at: POSITION_OBSERVED_AT,
      position_open: true,
      position_now: {
        size: "0.5",
        entryPrice: "2600",
        unrealizedPnl: "not-a-number",
        realizedPnl: "1.25",
        liquidationPrice: "-40",
        initialMarginFraction: 99_999,
        marginMode: 7,
      },
    }));
    expect(entry.positionNow).toEqual({
      observedAt: "2026-09-08T16:49:00.000Z",
      open: true,
      position: {
        size: "0.5",
        entryPrice: "2600",
        unrealizedPnl: null,
        // A liquidation price is unsigned; a negative one is unreadable.
        liquidationPrice: null,
        realizedPnl: "1.25",
        leverage: null,
        marginMode: null,
      },
    });
  });

  /**
   * `size` is what makes a position a position. Without a readable one the
   * market is still OPEN - that is an observed fact - but its details are
   * unavailable, and the renderer says exactly that rather than hiding the
   * observation.
   */
  it("reports an open market with UNREADABLE stored details, and counts it", () => {
    const stats: AgentScanLighterMappingStats = { unreadablePositions: 0 };
    const entry = mapValid(row({
      position_observed_at: POSITION_OBSERVED_AT,
      position_open: true,
      position_now: { size: "not-a-size", entryPrice: "2600" },
    }), stats);
    expect(entry.positionNow).toEqual({
      observedAt: "2026-09-08T16:49:00.000Z",
      open: true,
      position: null,
    });
    expect(stats.unreadablePositions).toBe(1);
  });

  it("treats a non-object stored position as unreadable rather than as a closure", () => {
    const stats: AgentScanLighterMappingStats = { unreadablePositions: 0 };
    const entry = mapValid(row({
      position_observed_at: POSITION_OBSERVED_AT,
      position_open: true,
      position_now: "corrupt",
    }), stats);
    expect(entry.positionNow).toEqual({
      observedAt: "2026-09-08T16:49:00.000Z",
      open: true,
      position: null,
    });
    expect(stats.unreadablePositions).toBe(1);
  });

  it("counts nothing when every observation reads", () => {
    const stats: AgentScanLighterMappingStats = { unreadablePositions: 0 };
    mapValid(row({
      position_observed_at: POSITION_OBSERVED_AT,
      position_open: true,
      position_now: { size: "1", entryPrice: null },
    }), stats);
    expect(stats.unreadablePositions).toBe(0);
  });
});

// ── Identifiers ───────────────────────────────────────────────────────────

describe("identifiers", () => {
  it("carries the provider and intent ids exactly, never clamped", () => {
    const entry = mapValid(row());
    expect(entry.providerTradeId).toBe("918273645");
    expect(entry.providerOrderId).toBe("112233");
    expect(entry.intentId).toBe("lighter-exec-6f4c2c60-0d3f-4a77-8f7f-0b4ce9a11111");
    expect(entry.blockHeight).toBe("10453221");
  });

  it("admits a missing provider order id", () => {
    expect(mapValid(row({ provider_order_id: null })).providerOrderId).toBeNull();
  });
});
