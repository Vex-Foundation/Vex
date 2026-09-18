/**
 * The Settings leverage overview, through the real reader.
 *
 * THE DEFECT THIS SUITE EXISTS FOR: the market list was built from the
 * account's POSITION ROWS, so a market the account had never traded could not
 * be selected at all. On the owner's measured account that was BTC; on a fresh
 * account it was every market. The overview now lists the provider's CATALOGUE
 * of active perpetual markets and fills each row's current terms from the
 * position row when one exists.
 *
 * The second contract here is `unresolved`: the durable list of leverage
 * changes whose outcome Vex has not proved. It comes from the intents table, so
 * closing Settings or restarting Vex cannot lose the person's way back to
 * Reconcile.
 *
 * The provider client and the intents table are faked; everything else is the
 * shipping module, including the margin-fraction conversions.
 */

import { describe, expect, it, vi } from "vitest";
import type { LighterMarketDetail } from "@tools/lighter/types.js";
import type { LighterLeverageIntentRow } from "@vex-agent/db/repos/lighter-leverage-intents.js";
import {
  getLighterLeverageOverview,
  prepareLighterLeverage,
  type LighterLeveragePreparationDeps,
} from "../leverage-preparation.js";

const WALLET = `0x${"1".repeat(40)}`;
const ACCOUNT = 24_226;

function perp(overrides: Partial<LighterMarketDetail> & { market_id: number; symbol: string }) {
  return {
    market_type: "perp",
    status: "active",
    base_asset_id: 0,
    quote_asset_id: 1,
    taker_fee: "0",
    maker_fee: "0",
    liquidation_fee: "0",
    min_base_amount: "0.0002",
    min_quote_amount: "10",
    supported_size_decimals: 5,
    supported_price_decimals: 1,
    supported_quote_decimals: 6,
    order_quote_limit: "0",
    is_maker_fee_enabled: true,
    is_taker_fee_enabled: true,
    default_initial_margin_fraction: 5000,
    min_initial_margin_fraction: 200,
    ...overrides,
  } as LighterMarketDetail;
}

/** One BTC position row set to 10x, and no row for any other market. */
function positionRow(marketId: number) {
  return {
    market_id: marketId,
    symbol: "BTC",
    initial_margin_fraction: "10.00",
    open_order_count: 0,
    pending_order_count: 0,
    position_tied_order_count: 0,
    sign: 1,
    position: "0.5000",
    avg_entry_price: "0",
    position_value: "0",
    unrealized_pnl: "0",
    realized_pnl: "0",
    liquidation_price: "0",
    margin_mode: 1,
    allocated_margin: "0",
  };
}

function intentRow(overrides: Partial<LighterLeverageIntentRow>): LighterLeverageIntentRow {
  return {
    intentId: "lighter-leverage-1",
    environment: "rhc",
    walletAddress: WALLET.toLowerCase(),
    accountIndex: ACCOUNT,
    apiKeyIndex: 4,
    marketIndex: 3,
    requestedInitialMarginFraction: 400,
    requestedMarginMode: 0,
    observedBefore: {
      symbol: "SOL",
      currentInitialMarginFraction: 5000,
      currentMarginMode: 0,
      currentSource: "market_default",
      marketMinInitialMarginFraction: 200,
      openPositionSize: "0",
      openPositionSide: "none",
      publicKey: "ab".repeat(20),
      liquidationPrice: null,
      openOrderCount: 0,
    },
    executionState: "ambiguous",
    consentedAt: new Date("2030-01-01T00:00:00Z"),
    revalidation: null,
    nonceValue: "7",
    txExpiryMs: 1,
    signerTxHash: "cd".repeat(20),
    sendAttemptStartedAt: new Date("2030-01-01T00:00:00Z"),
    providerOutcome: null,
    failureReason: null,
    expiresAt: new Date("2030-01-01T00:02:00Z"),
    createdAt: new Date("2030-01-01T00:00:00Z"),
    updatedAt: new Date("2030-01-01T00:01:00Z"),
    ...overrides,
  };
}

function deps(options: {
  readonly markets?: readonly LighterMarketDetail[];
  readonly positions?: readonly ReturnType<typeof positionRow>[];
  readonly unresolved?: readonly LighterLeverageIntentRow[];
  readonly positionFraction?: string;
  readonly positionMode?: 0 | 1;
} = {}) {
  const markets = options.markets ?? [
    perp({ market_id: 0, symbol: "ETH" }),
    perp({ market_id: 1, symbol: "BTC", min_initial_margin_fraction: 100 }),
    perp({ market_id: 3, symbol: "SOL" }),
  ];
  return {
    client: {
      getAccount: vi.fn(async () => ({
        code: 200,
        accounts: [
          {
            account_index: ACCOUNT,
            l1_address: WALLET,
            positions: [...(
              options.positions
              ?? (options.positionFraction === undefined
                ? []
                : [{
                    ...positionRow(1),
                    initial_margin_fraction: options.positionFraction,
                    margin_mode: options.positionMode ?? 0,
                  }])
            )],
          },
        ],
      })),
      getAllMarketDetails: vi.fn(async () => ({
        code: 200,
        order_book_details: [...markets],
        spot_order_book_details: [],
      })),
      getMarketDetails: vi.fn(async (_environment, input) => ({
        code: 200,
        order_book_details: markets.filter((row) => row.market_id === input.marketId),
        spot_order_book_details: [],
      })),
      getApiKeys: vi.fn(async () => ({
        code: 200,
        api_keys: [{
          account_index: ACCOUNT,
          api_key_index: 4,
          nonce: 0,
          public_key: "ab".repeat(20),
          transaction_time: 0,
        }],
      })),
    },
    listUnresolvedIntents: vi.fn(async () => options.unresolved ?? []),
    expireStaleProposals: vi.fn(async () => 0),
    findLiveIntent: vi.fn(async () => null),
    createIntent: vi.fn(async (input) => intentRow({
      intentId: input.intentId,
      marketIndex: input.marketIndex,
      requestedInitialMarginFraction: input.requestedInitialMarginFraction,
      requestedMarginMode: input.requestedMarginMode,
      observedBefore: input.observedBefore,
      expiresAt: input.expiresAt,
    })),
    listResolvedAccounts: vi.fn(async () => [
      { environment: "rhc" as const, walletAddress: WALLET.toLowerCase(), accountIndex: ACCOUNT },
    ]),
    listCredentialScopes: vi.fn(() => [{ environment: "rhc" as const, accountIndex: ACCOUNT, apiKeyIndex: 4 }]),
    derivePublicKey: vi.fn(async () => "ab".repeat(20)),
    vaultUnlocked: () => true,
    now: () => Date.parse("2030-01-01T00:00:00Z"),
  } satisfies LighterLeveragePreparationDeps;
}

const input = { environment: "rhc" as const, walletAddress: WALLET };

describe("getLighterLeverageOverview", () => {
  it("lists every active perpetual market, not only the ones with a position row", async () => {
    const d = deps();

    const overview = await getLighterLeverageOverview(input, d);

    expect(overview.markets.map((row) => row.symbol)).toEqual(["ETH", "BTC", "SOL"]);
    expect(overview.omitted.count).toBe(0);
    // One catalogue call, not one call per market.
    expect(d.client.getAllMarketDetails).toHaveBeenCalledTimes(1);
  });

  it("reads the current terms from the position row when there is one", async () => {
    const overview = await getLighterLeverageOverview(input, deps({ positions: [positionRow(1)] }));

    const btc = overview.markets.find((row) => row.marketId === 1);
    expect(btc?.current).toEqual({
      initialMarginFraction: 1000,
      leverageDisplay: "10.00",
      marginMode: "isolated",
      source: "position_row",
    });
    expect(btc?.openPosition).toEqual({ size: "0.5000", side: "long" });
    expect(btc?.max).toEqual({ initialMarginFraction: 100, leverageDisplay: "100.00" });
  });

  it("falls back to the market's own default, saying so, when there is no row", async () => {
    const overview = await getLighterLeverageOverview(input, deps({ positions: [positionRow(1)] }));

    const sol = overview.markets.find((row) => row.marketId === 3);
    expect(sol?.current).toEqual({
      initialMarginFraction: 5000,
      leverageDisplay: "2.00",
      marginMode: "cross",
      source: "market_default",
    });
    expect(sol?.openPosition).toBeNull();
  });

  it("omits only the markets whose leverage limits Vex cannot state, and counts them", async () => {
    const overview = await getLighterLeverageOverview(
      input,
      deps({
        markets: [
          perp({ market_id: 0, symbol: "ETH" }),
          // No usable minimum: a row here would be a leverage bound Vex invented.
          perp({ market_id: 2, symbol: "BROKEN", min_initial_margin_fraction: undefined }),
          perp({ market_id: 4, symbol: "SPOTLIKE", status: "inactive" }),
        ],
      }),
    );

    expect(overview.markets.map((row) => row.symbol)).toEqual(["ETH"]);
    // The inactive market is not "omitted": it is not an active perp at all.
    expect(overview.omitted.count).toBe(1);
    expect(overview.omitted.reason).toContain("leverage limits");
  });

  it("exposes unresolved changes durably, so Reconcile survives a restart", async () => {
    const overview = await getLighterLeverageOverview(
      input,
      deps({ unresolved: [intentRow({})] }),
    );

    expect(overview.unresolved).toEqual([
      {
        intentId: "lighter-leverage-1",
        marketId: 3,
        symbol: "SOL",
        executionState: "ambiguous",
        updatedAt: "2030-01-01T00:01:00.000Z",
      },
    ]);
  });

  it("returns an empty unresolved list when nothing is outstanding", async () => {
    const overview = await getLighterLeverageOverview(input, deps());
    expect(overview.unresolved).toEqual([]);
  });
});

describe("prepareLighterLeverage", () => {
  it("accepts the largest whole selector for an irregular market minimum and names it without decimals", async () => {
    const markets = [perp({ market_id: 1, symbol: "BTC", min_initial_margin_fraction: 295 })];
    const accepted = deps({ markets });

    const proposal = await prepareLighterLeverage(
      {
        environment: "rhc",
        walletAddress: WALLET,
        marketId: 1,
        leverage: 34,
        marginMode: "cross",
      },
      accepted,
    );

    expect(proposal).toMatchObject({
      kind: "proposal",
      target: { initialMarginFraction: 295, leverageDisplay: "33.89" },
    });

    const refused = deps({ markets });
    await expect(
      prepareLighterLeverage(
        {
          environment: "rhc",
          walletAddress: WALLET,
          marketId: 1,
          leverage: 35,
          marginMode: "cross",
        },
        refused,
      ),
    ).rejects.toThrow("BTC allows at most 34x leverage on Lighter.");
    expect(refused.createIntent).not.toHaveBeenCalled();
  });

  it("preserves the live canonical fraction for a mode-only change", async () => {
    const d = deps({ positionFraction: "2.95", positionMode: 0 });

    const proposal = await prepareLighterLeverage(
      {
        environment: "rhc",
        walletAddress: WALLET,
        marketId: 1,
        leverage: "current",
        marginMode: "isolated",
      },
      d,
    );

    expect(proposal).toMatchObject({
      kind: "proposal",
      current: { initialMarginFraction: 295, leverageDisplay: "33.89", marginMode: "cross" },
      target: { initialMarginFraction: 295, leverageDisplay: "33.89", marginMode: "isolated" },
    });
    expect(d.createIntent).toHaveBeenCalledWith(
      expect.objectContaining({ requestedInitialMarginFraction: 295, requestedMarginMode: 1 }),
    );
  });

  it("does not persist a current selector when the mode is unchanged", async () => {
    const d = deps({ positionFraction: "2.95", positionMode: 0 });

    const result = await prepareLighterLeverage(
      {
        environment: "rhc",
        walletAddress: WALLET,
        marketId: 1,
        leverage: "current",
        marginMode: "cross",
      },
      d,
    );

    expect(result).toMatchObject({ kind: "already_configured" });
    expect(d.createIntent).not.toHaveBeenCalled();
  });
});
