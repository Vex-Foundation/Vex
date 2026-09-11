/**
 * THE FILL PAYLOAD - what actually leaves this machine for a Lighter fill.
 *
 * Three properties are load-bearing and each is asserted structurally rather
 * than field by field, because a new field added without thought is exactly
 * the regression these tests exist to catch:
 *
 *   1. THE SOURCE ROW ID IS NAMESPACED. AgentScan dedupes on
 *      (agent_hash, source_row_id). `agent_activity` row 41 and `lighter_fills`
 *      row 41 are different facts, and an un-namespaced id would make the
 *      server silently drop whichever arrived second (H0 revision 2,
 *      correction 1).
 *   2. NOTHING ABOUT THE COUNTERPARTY LEAVES. A public trade record carries
 *      the other side's account id, order id and position size. None of it has
 *      a line that reads it, and the payload's key set is pinned so adding one
 *      is a failing test rather than a privacy incident.
 *   3. AN UNPROVEN FEE IS NULL, NEVER ZERO. The two are different claims: one
 *      says "not known yet", the other says "nothing was charged".
 */

import { describe, it, expect } from "vitest";

import {
  isLighterFillMappingFailure,
  mapLighterFillEnrichmentToEvent,
  mapLighterFillToEvent,
  LIGHTER_FILL_SOURCE_ROW_PREFIX,
  type LighterFillEnrichmentEvent,
  type LighterFillEvent,
} from "@vex-agent/sync/agentscan-report/lighter-fill-event.js";

function ledgerRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 41,
    canonical_identity: "lighter:core:743799:1:99",
    environment: "core",
    account_index: "743799",
    market_index: 1,
    provider_trade_id: "99",
    provider_order_id: "8",
    client_order_id: "555",
    execution_intent_id: "intent-1",
    market_symbol: "ETH-USD",
    side: "buy",
    price: "2500.5",
    base_size: "0.4",
    quote_notional: "1000.2",
    base_asset_id: "lighter:core:asset:1",
    base_asset_symbol: "ETH",
    base_asset_decimals: 18,
    quote_asset_id: "lighter:core:asset:0",
    quote_asset_symbol: "USDC",
    quote_asset_decimals: 6,
    block_height: "12345",
    trade_type: "trade",
    // The venue's own match time; `observed_at` below is when Vex saw it.
    traded_at: new Date("2026-09-07T09:59:59.250Z"),
    transaction_time_us: "1757239199250731",
    // LIGHTER'S OWN USD notional, which is what the campaign sums as volume.
    usd_amount: "1000.20",
    position_size_before: "2.5",
    position_sign_changed: false,
    entry_quote_before: "6000.000000",
    account_pnl: "-0.022890",
    position_effect: "increase",
    fee_side: "taker",
    integrator_fee_tick_authorized: 1000,
    integrator_fee_tick_observed: 350,
    integrator_fee_asset_id: "lighter:core:asset:0",
    integrator_fee_asset_symbol: "USDC",
    integrator_fee_asset_decimals: 6,
    integrator_fee_estimated_raw: "1000200",
    integrator_fee_estimate_basis: "quote_notional",
    integrator_fee_estimate_tick_source: "observed",
    integrator_fee_charged_raw: null,
    exchange_fee_tick_observed: 5,
    exchange_fee_charged_raw: null,
    integrator_fee_estimated_usd: "0.350070",
    exchange_fee_estimated_usd: "0.005001",
    collector_account_index: "743799",
    fee_authorization_intent_id: "fee-intent-1",
    revision: 0,
    observed_at: new Date("2026-09-07T10:00:00Z"),
    created_at: new Date("2026-09-07T10:00:00Z"),
    ...overrides,
  };
}

function mapOrThrow(row: Record<string, unknown>): LighterFillEvent {
  const result = mapLighterFillToEvent(row);
  if (isLighterFillMappingFailure(result)) throw new Error(`unmappable: ${result.reason}`);
  return result;
}

describe("the fill event's identity", () => {
  it("namespaces the source row id so the two ledgers cannot collide", () => {
    const event = mapOrThrow(ledgerRow({ id: 41 }));
    expect(event.sourceRowId).toBe("lighter_fill:41");
    expect(event.sourceRowId).toBe(`${LIGHTER_FILL_SOURCE_ROW_PREFIX}41`);
    // The bare id is what an `agent_activity` row of the same number reports.
    expect(event.sourceRowId).not.toBe("41");
  });

  it("groups every fill of one order under the execution intent", () => {
    const first = mapOrThrow(ledgerRow({ id: 41, canonical_identity: "lighter:core:743799:1:101", provider_trade_id: "101" }));
    const second = mapOrThrow(ledgerRow({ id: 42, canonical_identity: "lighter:core:743799:1:102", provider_trade_id: "102" }));
    expect(first.sourceExecutionId).toBe("intent-1");
    expect(second.sourceExecutionId).toBe("intent-1");
    expect(first.sourceRowId).not.toBe(second.sourceRowId);
  });

  it("groups an orphaned fill under its own venue identity rather than a guess", () => {
    const event = mapOrThrow(ledgerRow({ execution_intent_id: null }));
    expect(event.sourceExecutionId).toBe("lighter:core:743799:1:99");
  });

  it("carries the four fields the server derives the canonical identity from, and not the identity itself", () => {
    // The contract's fill object is strict and has no identity field: the
    // server computes `lighter:<environment>:<account>:<market>:<tradeId>`
    // from these four, so a client-sent copy could only ever disagree with it.
    const fill = mapOrThrow(ledgerRow()).lighterFill;
    expect(fill).toMatchObject({
      environment: "core",
      accountIndex: "743799",
      marketIndex: 1,
      providerTradeId: "99",
    });
    expect("canonicalIdentity" in fill).toBe(false);
  });
});

describe("the vocabulary and chain identity", () => {
  it("reports a perpetual as kind perp, role perp_fill", () => {
    const event = mapOrThrow(ledgerRow({ market_index: 1 }));
    expect(event.kind).toBe("perp");
    expect(event.eventRole).toBe("perp_fill");
  });

  it("reports a spot market as kind exchange, role spot_fill", () => {
    const event = mapOrThrow(ledgerRow({ market_index: 2049 }));
    expect(event.kind).toBe("exchange");
    expect(event.eventRole).toBe("spot_fill");
  });

  it("uses the lighter chain family and the environment's own L2 chain id", () => {
    const core = mapOrThrow(ledgerRow({ environment: "core" }));
    const rhc = mapOrThrow(ledgerRow({
      environment: "rhc",
      canonical_identity: "lighter:rhc:22869:1:99",
      base_asset_id: "lighter:rhc:asset:1",
      quote_asset_id: "lighter:rhc:asset:0",
      integrator_fee_asset_id: "lighter:rhc:asset:0",
    }));
    expect(core.chainFamily).toBe("lighter");
    expect(core.chainId).toBe("304");
    expect(rhc.chainId).toBe("466324");
    expect(core.protocol).toBe("lighter");
  });

  it("is economically confirmed and carries no transaction hash", () => {
    const event = mapOrThrow(ledgerRow());
    expect(event.status).toBe("confirmed");
    // A fill has no settlement transaction; a hash-shaped value here would ask
    // the chain receipt reader to verify something that does not exist.
    expect(event.txHash).toBeNull();
  });

  it("reports the VENUE's match time as the confirmation time, never our own", () => {
    const event = mapOrThrow(ledgerRow());
    // `traded_at` is Lighter's `trade.timestamp`; `observed_at` is when Vex
    // saw the fill, and the two are 750ms apart in this fixture precisely so
    // that reading the wrong one is visible.
    expect(event.confirmedAt).toBe("2026-09-07T09:59:59.250Z");
    expect(event.observedAt).toBe("2026-09-07T10:00:00.000Z");
    expect(event.confirmedAt).not.toBe(event.observedAt);
  });

  it("leaves the confirmation time null rather than substituting our clock", () => {
    const event = mapOrThrow(ledgerRow({ traded_at: null }));
    expect(event.confirmedAt).toBeNull();
    expect(event.lighterFill.tradedAt).toBeNull();
  });

  it("asserts attribution as client-asserted, never as verified origin", () => {
    expect(mapOrThrow(ledgerRow()).lighterFill.attribution).toBe("client_asserted");
  });
});

describe("legs and amounts", () => {
  it("puts the spent asset in and the received asset out for a buy", () => {
    const event = mapOrThrow(ledgerRow({ side: "buy" }));
    expect(event.tokenIn?.symbol).toBe("USDC");
    expect(event.tokenOut?.symbol).toBe("ETH");
  });

  it("mirrors the legs for a sell", () => {
    const event = mapOrThrow(ledgerRow({ side: "sell" }));
    expect(event.tokenIn?.symbol).toBe("ETH");
    expect(event.tokenOut?.symbol).toBe("USDC");
  });

  it("declares venue asset ids rather than inventing EVM addresses", () => {
    const event = mapOrThrow(ledgerRow());
    expect(event.tokenIn?.address).toBe("lighter:core:asset:0");
    expect(event.tokenOut?.address).toBe("lighter:core:asset:1");
    expect(event.tokenIn?.address).not.toMatch(/^0x/);
  });

  it("keeps the exact figures as decimal strings, never as raw-integer fields", () => {
    const event = mapOrThrow(ledgerRow());
    // The contract's raw-amount fields are integer strings; a decimal size put
    // there would be refused, and a rounded one would be a fabricated amount.
    expect(event.amountInRaw).toBeNull();
    expect(event.executedOutRaw).toBeNull();
    expect(event.lighterFill.baseSize).toBe("0.4");
    expect(event.lighterFill.quoteNotional).toBe("1000.2");
    expect(event.lighterFill.price).toBe("2500.5");
  });
});

describe("fees", () => {
  it("keeps the authorized tick, the estimate and the charged amount apart", () => {
    const fill = mapOrThrow(ledgerRow()).lighterFill;
    expect(fill.integratorFeeTickAuthorized).toBe(1000);
    expect(fill.integratorFeeEstimatedRaw).toBe("1000200");
    // The estimate's basis travels as the asset it is denominated in: the
    // quote asset here, which is what "quote_notional" means on the wire.
    expect(fill.integratorFeeAsset).toEqual({ venueAssetId: "lighter:core:asset:0", symbol: "USDC", decimals: 6 });
    expect(fill.integratorFeeChargedRaw).toBeNull();
    // No charged exchange fee, so no asset is claimed for one.
    expect(fill.exchangeFeeChargedRaw).toBeNull();
    expect(fill.exchangeFeeAsset).toBeNull();
  });

  it("names the asset of a charged exchange fee: the quote asset, or the received base on a spot buy", () => {
    const perp = mapOrThrow(ledgerRow({ exchange_fee_charged_raw: "-250" })).lighterFill;
    expect(perp.exchangeFeeChargedRaw).toBe("-250");
    expect(perp.exchangeFeeAsset).toEqual({ venueAssetId: "lighter:core:asset:0", symbol: "USDC", decimals: 6 });

    const spotBuy = mapOrThrow(ledgerRow({ market_index: 2048, side: "buy", exchange_fee_charged_raw: "10" })).lighterFill;
    expect(spotBuy.exchangeFeeAsset).toEqual({ venueAssetId: "lighter:core:asset:1", symbol: "ETH", decimals: 18 });

    const spotSell = mapOrThrow(ledgerRow({ market_index: 2048, side: "sell", exchange_fee_charged_raw: "10" })).lighterFill;
    expect(spotSell.exchangeFeeAsset).toEqual({ venueAssetId: "lighter:core:asset:0", symbol: "USDC", decimals: 6 });
  });

  it("carries the OBSERVED ticks beside the authorized one, never instead of it", () => {
    // The authorization permits 1000; the provider stamped 350 on this trade
    // and charged its own tier at 5. Three separate facts, three fields.
    const fill = mapOrThrow(ledgerRow()).lighterFill;
    expect(fill.integratorFeeTickAuthorized).toBe(1000);
    expect(fill.integratorFeeTickObserved).toBe(350);
    expect(fill.exchangeFeeTickObserved).toBe(5);
    expect(fill.integratorFeeEstimateTickSource).toBe("observed");
  });

  it("says the estimate stands on the AUTHORIZED tick when the provider reported none", () => {
    const fill = mapOrThrow(ledgerRow({
      integrator_fee_tick_observed: null,
      integrator_fee_estimate_tick_source: "authorized",
    })).lighterFill;
    expect(fill.integratorFeeTickObserved).toBeNull();
    expect(fill.integratorFeeEstimateTickSource).toBe("authorized");
  });

  it("reports an unproven charge as null, never as zero", () => {
    const fill = mapOrThrow(ledgerRow({ integrator_fee_charged_raw: null })).lighterFill;
    expect(fill.integratorFeeChargedRaw).toBeNull();
    expect(fill.integratorFeeChargedRaw).not.toBe("0");
  });

  it("reports a proven charge once enrichment has written it", () => {
    const fill = mapOrThrow(ledgerRow({ integrator_fee_charged_raw: "1000000" })).lighterFill;
    expect(fill.integratorFeeChargedRaw).toBe("1000000");
  });

  it("admits a negative exchange fee, because a rebate is a real reported figure", () => {
    const fill = mapOrThrow(ledgerRow({ exchange_fee_charged_raw: "-250" })).lighterFill;
    expect(fill.exchangeFeeChargedRaw).toBe("-250");
  });

  it("carries the fee authorization as provenance beside the collector", () => {
    const fill = mapOrThrow(ledgerRow()).lighterFill;
    expect(fill.feeAuthorizationIntentId).toBe("fee-intent-1");
    expect(fill.collectorAccountIndex).toBe("743799");
  });
});

describe("privacy", () => {
  it("pins the payload's key set, so a new field is a decision and not an accident", () => {
    const fill = mapOrThrow(ledgerRow()).lighterFill;
    expect(Object.keys(fill).sort()).toEqual([
      "accountIndex",
      "accountPnl",
      "attribution",
      "baseAsset",
      "baseSize",
      "blockHeight",
      "clientOrderId",
      "collectorAccountIndex",
      "entryQuoteBefore",
      "environment",
      "exchangeFeeAsset",
      "exchangeFeeChargedRaw",
      "exchangeFeeTickObserved",
      "feeAuthorizationIntentId",
      "feeSide",
      "integratorFeeAsset",
      "integratorFeeChargedRaw",
      "integratorFeeEstimateTickSource",
      "integratorFeeEstimatedRaw",
      "integratorFeeTickAuthorized",
      "integratorFeeTickObserved",
      "lighterChainId",
      "marketIndex",
      "marketSymbol",
      "positionEffect",
      "positionSignChanged",
      "positionSizeBefore",
      "price",
      "providerOrderId",
      "providerTradeId",
      "quoteAsset",
      "quoteNotional",
      "side",
      "tradeType",
      "tradedAt",
      "usdAmount",
    ]);
  });

  it("keeps the leverage before the fill OFF the wire, ledger column or not", () => {
    // Migration 162 records `initial_margin_fraction_before` for the LOCAL
    // activity feed. The external server was never told about it, so a ledger
    // row that carries it must project exactly the payload above: a durable
    // column is not a wire field, and the two grow by separate decisions.
    const event = mapOrThrow(ledgerRow({ initial_margin_fraction_before: 1000 }));
    expect(event.lighterFill).not.toHaveProperty("initialMarginFractionBefore");
    expect(JSON.stringify(event)).not.toContain("initial_margin_fraction_before");
    expect(JSON.stringify(event)).not.toContain("MarginFraction");
  });

  it("never carries a counterparty, a credential, a nonce or an L1 address, even when the row does", () => {
    // A raw provider record smuggled onto the ledger row: none of it is read.
    const event = mapOrThrow(ledgerRow({
      ask_account_id: 111,
      bid_account_id: 743799,
      ask_id_str: "7",
      maker_position_size: "12.5",
      l1_address: "0x1234567890123456789012345678901234567890",
      session_id: "session-9",
      nonce: "17",
      auth_token: "secret-token",
      raw_provider_response: { anything: true },
    }));
    const serialized = JSON.stringify(event);
    for (const forbidden of [
      "ask_account_id",
      "maker_position_size",
      "0x1234567890123456789012345678901234567890",
      "session-9",
      "secret-token",
      "raw_provider_response",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe("rows the mapper refuses", () => {
  it.each([
    ["missing canonical identity", { canonical_identity: null }, "missing_identity"],
    ["an unknown environment", { environment: "testnet" }, "unknown_environment"],
    ["a malformed price", { price: "n/a" }, "malformed_amount"],
    ["a base asset without decimals", { base_asset_decimals: null }, "malformed_asset"],
  ])("refuses %s rather than sending a half event", (_label, overrides, reason) => {
    const result = mapLighterFillToEvent(ledgerRow(overrides));
    expect(isLighterFillMappingFailure(result)).toBe(true);
    expect(result).toEqual({ kind: "unmappable", reason });
  });
});

describe("the enrichment projection", () => {
  function enrichOrThrow(row: Record<string, unknown>, revision: number): LighterFillEnrichmentEvent {
    const result = mapLighterFillEnrichmentToEvent(row, revision);
    if (isLighterFillMappingFailure(result)) throw new Error(`unmappable: ${result.reason}`);
    return result;
  }

  it("reports the SAME identity as the fill, so the server updates one it already holds", () => {
    const enriched = enrichOrThrow(
      ledgerRow({ integrator_fee_charged_raw: "1000000", revision: 1 }),
      1,
    );
    const fill = mapOrThrow(ledgerRow());
    expect(enriched.sourceRowId).toBe(fill.sourceRowId);
    expect(enriched.sourceRowId).toBe(`${LIGHTER_FILL_SOURCE_ROW_PREFIX}41`);
    expect(enriched.lighterFillEnrichment.canonicalIdentity).toBe("lighter:core:743799:1:99");
  });

  it("carries the newly proven fees and the revision that delivers them", () => {
    const enriched = enrichOrThrow(
      ledgerRow({ integrator_fee_charged_raw: "1000000", exchange_fee_charged_raw: "-250", revision: 2 }),
      2,
    );
    expect(enriched.lighterFillEnrichment).toEqual({
      canonicalIdentity: "lighter:core:743799:1:99",
      revision: 2,
      integratorFeeChargedRaw: "1000000",
      exchangeFeeChargedRaw: "-250",
      integratorFeeAsset: { venueAssetId: "lighter:core:asset:0", symbol: "USDC", decimals: 6 },
      // The charged exchange fee names its asset, as the contract requires.
      exchangeFeeAsset: { venueAssetId: "lighter:core:asset:0", symbol: "USDC", decimals: 6 },
      // KNOWLEDGE TRAVELS WITH THE FEE. A fill first seen on a public row has
      // no account-relative fields; the authenticated observation that
      // supplies them bumps the same revision, and this is the only way they
      // reach a server that already holds the fill.
      positionEffect: "increase",
      positionSizeBefore: "2.5",
      positionSignChanged: false,
      entryQuoteBefore: "6000.000000",
      accountPnl: "-0.022890",
    });
  });

  it("carries the account knowledge for a fill whose effect was established later", () => {
    // The public-row case: the fill was delivered with nothing known about the
    // account's position, and the authenticated read that followed established
    // it once.
    const enriched = enrichOrThrow(ledgerRow({
      position_size_before: "-2.5",
      position_sign_changed: true,
      entry_quote_before: "-6000.000000",
      account_pnl: "1.989696",
      position_effect: "flip",
      revision: 1,
    }), 1);
    expect(enriched.lighterFillEnrichment.positionEffect).toBe("flip");
    expect(enriched.lighterFillEnrichment.accountPnl).toBe("1.989696");
    expect(enriched.lighterFillEnrichment.positionSizeBefore).toBe("-2.5");
  });

  it("reports an unestablished effect as null", () => {
    const enriched = enrichOrThrow(ledgerRow({
      position_size_before: null,
      position_sign_changed: null,
      entry_quote_before: null,
      account_pnl: null,
      position_effect: null,
      integrator_fee_charged_raw: "1000000",
      revision: 1,
    }), 1);
    expect(enriched.lighterFillEnrichment.positionEffect).toBeNull();
    expect(enriched.lighterFillEnrichment.accountPnl).toBeNull();
  });

  it("carries NO economics at all, so it cannot revise what the fill established", () => {
    // The whole point of H0 correction 4: an enrichment is an update to fees,
    // never a second fill and never a revision of price, size or notional.
    const enriched = enrichOrThrow(ledgerRow({ integrator_fee_charged_raw: "1000000", revision: 1 }), 1);
    expect(Object.keys(enriched.lighterFillEnrichment).sort()).toEqual([
      "accountPnl",
      "canonicalIdentity",
      "entryQuoteBefore",
      "exchangeFeeAsset",
      "exchangeFeeChargedRaw",
      "integratorFeeAsset",
      "integratorFeeChargedRaw",
      "positionEffect",
      "positionSignChanged",
      "positionSizeBefore",
      "revision",
    ]);
    expect(enriched.tokenIn).toBeNull();
    expect(enriched.tokenOut).toBeNull();
    expect(enriched.amountInRaw).toBeNull();
    expect(enriched.amountOutRaw).toBeNull();
    expect(enriched.executedInRaw).toBeNull();
    expect(enriched.executedOutRaw).toBeNull();
    const serialized = JSON.stringify(enriched);
    for (const economic of ["2500.5", "0.4", "1000.2"]) {
      expect(serialized).not.toContain(economic);
    }
  });

  it("refuses a revision that is not a real one rather than sending an update nobody can order", () => {
    expect(mapLighterFillEnrichmentToEvent(ledgerRow(), 0)).toEqual({
      kind: "unmappable",
      reason: "missing_identity",
    });
    expect(mapLighterFillEnrichmentToEvent(ledgerRow(), -1)).toEqual({
      kind: "unmappable",
      reason: "missing_identity",
    });
  });
});
