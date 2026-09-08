/**
 * THE BOUNDARY FOR LIGHTER'S ACCOUNT-RELATIVE TRADE FIELDS.
 *
 * Two sources produce the same trade record and one of them knows less. The
 * PUBLIC `recentTrades` tape carries the position sizes before the trade but
 * neither the realized PnL nor (for the resting side) the sign-changed flag;
 * the AUTHENTICATED read for the account carries all of it. Both are valid
 * responses, and the defect this file pins is treating either one as the
 * shape:
 *
 *   - a validator that REQUIRED the account fields would reject the public
 *     tape outright, taking the whole market-data surface down with it;
 *   - a validator that accepted anything would let a `null` position size or a
 *     `"1e-7"` PnL through to the ledger, where a CHECK constraint refuses it
 *     far from the reason.
 *
 * The fixtures are real: the public row is the response of
 * `GET /api/v1/recentTrades?market_id=1&limit=2` on Core, probed 2026-09-08.
 */

import { describe, it, expect } from "vitest";

import {
  validateLighterAccount,
  validateLighterMarketDetails,
  validateLighterRecentTrades,
} from "@tools/lighter/validation.js";

/** VERBATIM from the live public Core tape, 2026-09-08. */
const PUBLIC_TRADE = {
  trade_id: 29748467352,
  trade_id_str: "29748467352",
  tx_hash: "b96029f761027daa20466fdf3ba7c1d269b1871a3f857aab91fab6d4bac4266ca92944d5edba1ae9",
  type: "trade",
  market_id: 1,
  size: "0.02000",
  price: "78354.1",
  usd_amount: "1567.082000",
  ask_id: 562953293892152,
  ask_id_str: "562953293892152",
  bid_id: 844421545413234,
  bid_id_str: "844421545413234",
  ask_client_id: 223126120761038,
  ask_client_id_str: "223126120761038",
  bid_client_id: 230078951108215,
  bid_client_id_str: "230078951108215",
  ask_account_id: 737624,
  bid_account_id: 702384,
  is_maker_ask: false,
  block_height: 328303571,
  timestamp: 1788858716527,
  taker_position_size_before: "0.00000",
  taker_entry_quote_before: "0.000000",
  taker_initial_margin_fraction_before: 500,
  taker_position_sign_changed: true,
  maker_fee: 28,
  maker_position_size_before: "14.07123",
  maker_entry_quote_before: "1103252.791990",
  maker_initial_margin_fraction_before: 3333,
  transaction_time: 1788858716531726,
  ask_order_version: 0,
  bid_order_version: 0,
};

/**
 * The authenticated shape: the same record plus the fields Lighter fills for
 * the account the read was authorized for. Every optional field the DTO
 * declares appears at least once across the two fixtures (rule 10 item 3), so
 * "the projection reads null" is never an assertion about a fixture that had
 * nothing to read.
 */
const AUTHENTICATED_TRADE = {
  ...PUBLIC_TRADE,
  trade_id: 29748467353,
  trade_id_str: "29748467353",
  taker_fee: 350,
  maker_position_sign_changed: false,
  ask_account_pnl: "1.989696",
  bid_account_pnl: "-0.022890",
  integrator_taker_fee: 1000,
  integrator_taker_fee_collector_index: 743799,
  integrator_maker_fee: 2500,
  integrator_maker_fee_collector_index: 743799,
  taker_allocated_margin_usdc_before: 1100000000000000,
  taker_allocated_margin_usdc_after: 150000000000000,
  maker_allocated_margin_usdc_before: 210000000000000,
  maker_allocated_margin_usdc_after: 250000000000000,
};

function recentTrades(trades: readonly unknown[]): unknown {
  return { code: 200, trades: [...trades] };
}

describe("Lighter trade validation across both sources", () => {
  it("accepts the live public tape, whose account fields are simply absent", () => {
    const parsed = validateLighterRecentTrades(recentTrades([PUBLIC_TRADE]));
    const trade = parsed.trades[0];
    expect(trade.usd_amount).toBe("1567.082000");
    expect(trade.taker_position_size_before).toBe("0.00000");
    expect(trade.maker_position_size_before).toBe("14.07123");
    expect(trade.taker_position_sign_changed).toBe(true);
    // What a public row does NOT carry, and what the ledger therefore holds
    // null until an authenticated observation supplies it.
    expect(trade.ask_account_pnl ?? null).toBeNull();
    expect(trade.bid_account_pnl ?? null).toBeNull();
    expect(trade.maker_position_sign_changed ?? null).toBeNull();
  });

  it("accepts the authenticated row with every account-relative field present", () => {
    const parsed = validateLighterRecentTrades(recentTrades([AUTHENTICATED_TRADE]));
    const trade = parsed.trades[0];
    expect(trade.ask_account_pnl).toBe("1.989696");
    expect(trade.bid_account_pnl).toBe("-0.022890");
    expect(trade.maker_position_sign_changed).toBe(false);
    expect(trade.taker_fee).toBe(350);
    expect(trade.taker_allocated_margin_usdc_after).toBe(150000000000000);
    expect(trade.ask_order_version).toBe(0);
  });

  it("accepts an explicit null where the provider says it knows nothing", () => {
    const parsed = validateLighterRecentTrades(recentTrades([
      { ...PUBLIC_TRADE, ask_account_pnl: null, taker_position_sign_changed: null },
    ]));
    expect(parsed.trades[0].ask_account_pnl).toBeNull();
    expect(parsed.trades[0].taker_position_sign_changed).toBeNull();
  });

  it("keeps the signed decimals exactly as strings, never as numbers", () => {
    const parsed = validateLighterRecentTrades(recentTrades([
      { ...AUTHENTICATED_TRADE, maker_position_size_before: "-14.07123", bid_account_pnl: "-0.022890" },
    ]));
    expect(parsed.trades[0].maker_position_size_before).toBe("-14.07123");
    expect(parsed.trades[0].bid_account_pnl).toBe("-0.022890");
  });

  it.each([
    ["a PnL in exponent notation", { ask_account_pnl: "1e-7" }],
    ["a PnL as a number", { ask_account_pnl: 1.98 }],
    ["a position size with a trailing dot", { taker_position_size_before: "14." }],
    ["a position size with a leading plus", { taker_position_size_before: "+14.0" }],
    ["a sign-changed flag as a string", { taker_position_sign_changed: "true" }],
    ["an allocated margin as a decimal string", { taker_allocated_margin_usdc_before: "1100000" }],
  ])("refuses %s at the boundary", (_name, override) => {
    expect(() => validateLighterRecentTrades(recentTrades([{ ...AUTHENTICATED_TRADE, ...override }])))
      .toThrow();
  });
});

describe("Lighter market detail validation for the margin and reference prices", () => {
  const PERP_DETAIL = {
    symbol: "ETH",
    market_id: 0,
    market_type: "perp",
    base_asset_id: 1,
    quote_asset_id: 0,
    status: "active",
    taker_fee: "0.0350",
    maker_fee: "0.0000",
    liquidation_fee: "0.0100",
    min_base_amount: "0.001",
    min_quote_amount: "10",
    supported_size_decimals: 4,
    supported_price_decimals: 2,
    supported_quote_decimals: 6,
    order_quote_limit: "1000000",
    is_maker_fee_enabled: true,
    is_taker_fee_enabled: true,
    // K2's live RHC market 0 reading, on the provider's 10000 scale.
    default_initial_margin_fraction: 5000,
    min_initial_margin_fraction: 200,
    maintenance_margin_fraction: 120,
    closeout_margin_fraction: 80,
    mark_price: "3024.66",
    index_price: "3024.10",
  };

  it("accepts a perpetual market with the margin fractions and both prices", () => {
    const parsed = validateLighterMarketDetails({
      code: 200,
      order_book_details: [PERP_DETAIL],
      spot_order_book_details: [],
    });
    const detail = parsed.order_book_details[0];
    expect(detail.default_initial_margin_fraction).toBe(5000);
    expect(detail.maintenance_margin_fraction).toBe(120);
    expect(detail.mark_price).toBe("3024.66");
    expect(detail.index_price).toBe("3024.10");
  });

  it("accepts a spot market that carries none of them", () => {
    const { mark_price, index_price, ...spot } = PERP_DETAIL;
    void mark_price;
    void index_price;
    const parsed = validateLighterMarketDetails({
      code: 200,
      order_book_details: [],
      spot_order_book_details: [{ ...spot, market_type: "spot", market_id: 2048 }],
    });
    const detail = parsed.spot_order_book_details[0];
    expect(detail.mark_price ?? null).toBeNull();
    expect(detail.index_price ?? null).toBeNull();
  });

  it("refuses a mark price the provider sent as a number", () => {
    expect(() => validateLighterMarketDetails({
      code: 200,
      order_book_details: [{ ...PERP_DETAIL, mark_price: 3024.66 }],
      spot_order_book_details: [],
    })).toThrow();
  });
});

/**
 * THE OMITTED APPROVAL LIST, which blocked the first authorization of every
 * fresh account.
 *
 * Lighter serializes `approved_integrators` with Go's `omitempty`, so an
 * account that has never approved an integrator returns the key ABSENT - not
 * null, not `[]`. Verified live on RHC account 24226
 * (GET /api/v1/account?by=index&value=24226, 2026-09-08). The validator's
 * transform mapped only `null` to `[]`, `undefined` survived it,
 * `Array.isArray` said false in `fee-authorization-preparation.ts`, and the
 * preparation answered "Lighter did not return fee-authorization evidence" -
 * refusing the one case where an empty list is the honest answer.
 *
 * The fixture omits the key, which is the variant a fixture carrying `null`
 * cannot exercise (rule 10 item 3).
 */
describe("Lighter account validation when the approval list is omitted", () => {
  const ACCOUNT_WITHOUT_APPROVALS = {
    index: 24226,
    account_index: 24226,
    l1_address: "0x0000000000000000000000000000000000000001",
    status: 1,
    collateral: "10.000000",
    available_balance: "10.000000",
    positions: [],
    assets: [],
  };

  it("parses an omitted approval list as the empty list, not as absent evidence", () => {
    const parsed = validateLighterAccount({ code: 200, total: 1, accounts: [ACCOUNT_WITHOUT_APPROVALS] });
    const account = parsed.accounts[0];
    expect(Array.isArray(account.approved_integrators)).toBe(true);
    expect(account.approved_integrators).toEqual([]);
  });

  it("parses an explicit null the same way", () => {
    const parsed = validateLighterAccount({
      code: 200,
      total: 1,
      accounts: [{ ...ACCOUNT_WITHOUT_APPROVALS, approved_integrators: null }],
    });
    expect(parsed.accounts[0].approved_integrators).toEqual([]);
  });

  it("keeps a real approval list untouched", () => {
    const parsed = validateLighterAccount({
      code: 200,
      total: 1,
      accounts: [{
        ...ACCOUNT_WITHOUT_APPROVALS,
        approved_integrators: [
          {
            account_index: 743799,
            name: "VEX",
            max_perps_taker_fee: 1000,
            max_perps_maker_fee: 2500,
            max_spot_taker_fee: 1000,
            max_spot_maker_fee: 2500,
            approval_expiry: 1788858716527,
          },
        ],
      }],
    });
    expect(parsed.accounts[0].approved_integrators).toHaveLength(1);
    expect(parsed.accounts[0].approved_integrators?.[0].account_index).toBe(743799);
  });
});
