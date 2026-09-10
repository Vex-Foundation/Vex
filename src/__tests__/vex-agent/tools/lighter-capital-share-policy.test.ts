/**
 * Whose ceiling applies, and whether admission is really atomic.
 *
 * The arithmetic is proved in `lighter-capital-share.test.ts`. This suite proves
 * the two things the arithmetic cannot decide for itself:
 *
 * 1. The share is resolved for the wallet that OWNS THE TRADED ACCOUNT, from the
 *    live `l1_address`, not for whichever wallet the session happens to have
 *    selected. A user with two wallets and two different shares must not get one
 *    wallet's ceiling applied to the other's account.
 * 2. Admission goes through the LEDGER, in one serialized decision. Two sessions
 *    preparing at the same moment must not both pass the same remaining budget.
 *
 * Only the DATABASE boundary is faked, and the fake SERIALIZES exactly as the
 * real repo's advisory-locked transaction does. Everything else - the policy
 * resolution, the arithmetic, the refusal text - is the real code.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LighterPrivilegedAccountAuth } from "@tools/lighter/client.js";
import type {
  LighterAccount,
  LighterAccountLimitsResponse,
  LighterAccountOrdersResponse,
  LighterAccountPosition,
  LighterMarketDetail,
} from "@tools/lighter/types.js";
import type { LighterCapitalShareEvidenceClient } from "@vex-agent/tools/protocols/lighter/capital-share-policy.js";

const limitsRows = new Map<string, number | null>();
const readLighterTradingLimits = vi.fn(async (environment: string, walletAddress: string) => {
  const key = `${environment}:${walletAddress}`;
  if (!limitsRows.has(key)) return null;
  return {
    environment,
    walletAddress,
    agentCapitalSharePercent: limitsRows.get(key) ?? null,
    revision: 1,
    updatedAt: "2026-09-10T00:00:00.000Z",
  };
});

/**
 * A faithful stand-in for the advisory-locked admission transaction: it sums the
 * account's live rows and inserts in ONE step, so an interleaved second caller
 * always observes the first caller's row.
 */
interface Commitment {
  readonly intentId: string;
  readonly requiredUnits: string;
}
const ledger = new Map<string, Commitment[]>();
const admitLighterCapitalCommitment = vi.fn(async (input: {
  environment: string;
  accountIndex: number;
  intentId: string;
  requiredUnits: string;
  budgetUnits: string;
  providerCommittedUnits: string;
  excludeIntentId?: string;
}) => {
  const key = `${input.environment}:${input.accountIndex}`;
  const rows = ledger.get(key) ?? [];
  const live = rows
    .filter((row) => row.intentId !== input.excludeIntentId)
    .reduce((total, row) => total + BigInt(row.requiredUnits), 0n);
  const budget = BigInt(input.budgetUnits) - BigInt(input.providerCommittedUnits) - live;
  const remaining = budget > 0n ? budget : 0n;
  if (BigInt(input.requiredUnits) > remaining) {
    return { admitted: false as const, remainingUnits: remaining.toString(), liveCommittedUnits: live.toString() };
  }
  ledger.set(key, [...rows, { intentId: input.intentId, requiredUnits: input.requiredUnits }]);
  return { admitted: true as const, commitmentId: `c-${input.intentId}`, liveCommittedUnits: live.toString() };
});

/**
 * The ledger's retirement, controllable per test. Retirement runs AFTER a money
 * outcome is already settled, so a failing ledger must never become the error
 * the user or the agent sees.
 */
const retireLighterCapitalCommitment = vi.hoisted(() => vi.fn(async (_input: {
  intentId: string;
  reason: string;
}) => undefined));

/** The ledger's settlement stamp, which the terminal outcome paths call instead. */
const markLighterCapitalCommitmentSettled = vi.hoisted(
  () => vi.fn(async (_intentId: string) => undefined),
);

vi.mock("@vex-agent/db/repos/lighter-trading-limits.js", () => ({
  readLighterTradingLimits: (...args: [string, string]) => readLighterTradingLimits(...args),
}));
vi.mock("@vex-agent/db/repos/lighter-capital-commitments.js", () => ({
  admitLighterCapitalCommitment: (input: Parameters<typeof admitLighterCapitalCommitment>[0]) =>
    admitLighterCapitalCommitment(input),
  listLiveLighterCapitalCommitments: async (environment: string, accountIndex: number) =>
    ledger.get(`${environment}:${accountIndex}`) ?? [],
  retireLighterCapitalCommitment: (input: { intentId: string; reason: string }) =>
    retireLighterCapitalCommitment(input),
  markLighterCapitalCommitmentSettled: (intentId: string) =>
    markLighterCapitalCommitmentSettled(intentId),
}));
vi.mock("@vex-agent/tools/protocols/lighter/read-account-auth.js", () => ({
  resolveLighterReadOnlyAccountAuth: async () => null,
}));

const {
  admitLighterOrderCapitalCommitment,
  markLighterOrderCapitalCommitmentSettled,
  resolveLighterCapitalSharePolicy,
  retireLighterOrderCapitalCommitment,
} = await import("@vex-agent/tools/protocols/lighter/capital-share-policy.js");

// The provider returns a CHECKSUMMED address; the limits row is keyed lower-case.
const WALLET_A_CHECKSUMMED = "0x33eF6673BD80cB11fcC41b82Bc2181E65cC4d2fA";
const WALLET_A = WALLET_A_CHECKSUMMED.toLowerCase();
const WALLET_B = "0x1111111111111111111111111111111111111111";

const BTC_MARKET = {
  symbol: "BTC",
  market_id: 1,
  market_type: "perp",
  status: "active",
  base_asset_id: 1,
  quote_asset_id: 0,
  taker_fee: "0.0000",
  maker_fee: "0.0000",
  liquidation_fee: "0.0000",
  min_base_amount: "0.00010",
  min_quote_amount: "10.000000",
  order_quote_limit: "1000000.000000",
  is_maker_fee_enabled: false,
  is_taker_fee_enabled: false,
  supported_size_decimals: 5,
  supported_price_decimals: 1,
  supported_quote_decimals: 6,
  default_initial_margin_fraction: 5000,
  min_initial_margin_fraction: 200,
  mark_price: "77329.8",
} satisfies LighterMarketDetail;

/**
 * A complete position row. Only the fields a test names carry meaning; the rest
 * exist because the provider always sends them and the wire type requires them.
 */
function position(overrides: Partial<LighterAccountPosition> = {}): LighterAccountPosition {
  return {
    market_id: 1,
    symbol: "BTC",
    initial_margin_fraction: "50.00",
    open_order_count: 0,
    pending_order_count: 0,
    position_tied_order_count: 0,
    sign: 0,
    position: "0.00000",
    avg_entry_price: "0.0",
    position_value: "0.000000",
    unrealized_pnl: "0.000000",
    realized_pnl: "0.000000",
    liquidation_price: "0.0",
    margin_mode: 0,
    allocated_margin: "0.000000",
    ...overrides,
  };
}

function account(overrides: Partial<LighterAccount> = {}): LighterAccount {
  return {
    account_index: 24226,
    l1_address: WALLET_A_CHECKSUMMED,
    collateral: "7.884034",
    available_balance: "7.884034",
    cross_initial_margin_requirement: "0.000000",
    total_order_count: 0,
    positions: [],
    ...overrides,
  };
}

function order(overrides: Record<string, unknown> = {}) {
  return {
    market: BTC_MARKET,
    // 0.00020 BTC at 77329.8 is 15.465960, needing 7.732980 at 2x.
    baseAmountInteger: "20",
    approvedPriceInteger: "773298",
    approvedPriceRole: "worst_acceptable_price" as const,
    side: "buy" as const,
    reduceOnly: false,
    vexIntegratorTakerFeeTicks: null,
    ...overrides,
  };
}

/**
 * The read-only account token an admission path already holds. The ceiling reads
 * the account's own exchange fee tier through it, so a test without one proves
 * the refusal, not the arithmetic.
 */
const AUTH: LighterPrivilegedAccountAuth = { accountIndex: 24226, token: "read-only-token" };

/** THIS ACCOUNT's exchange taker-fee tier, in hundredths of a basis point. */
let accountTakerFeeTicks = 0;
const getAccountLimits = vi.fn(async (): Promise<LighterAccountLimitsResponse> => ({
  code: 200,
  user_tier: "0",
  user_tier_name: "standard",
  current_maker_fee_tick: 0,
  current_taker_fee_tick: accountTakerFeeTicks,
}));
/**
 * No scenario here leaves the account with resting orders Vex is allowed to
 * read, so a call is a defect and must surface as one rather than as an empty
 * commitment that would silently widen the ceiling.
 */
const getAccountActiveOrders = vi.fn(async (): Promise<LighterAccountOrdersResponse> => {
  throw new Error("getAccountActiveOrders must not be called in this suite");
});
const client: LighterCapitalShareEvidenceClient = { getAccountActiveOrders, getAccountLimits };

beforeEach(() => {
  limitsRows.clear();
  ledger.clear();
  accountTakerFeeTicks = 0;
  admitLighterCapitalCommitment.mockClear();
  readLighterTradingLimits.mockClear();
  getAccountLimits.mockClear();
  markLighterCapitalCommitmentSettled.mockClear();
});

describe("resolveLighterCapitalSharePolicy", () => {
  it("looks the share up by the TRADED account's owning wallet, lower-cased", () => {
    // The provider sends a checksummed address and `lighter_trading_limits`
    // stores it lower-case, so a policy that skipped the normalization would
    // find no row and silently apply NO ceiling.
    limitsRows.set(`rhc:${WALLET_A}`, 25);
    return expect(resolveLighterCapitalSharePolicy({
      environment: "rhc",
      accountIndex: 24226,
      account: account(),
    })).resolves.toMatchObject({ walletAddress: WALLET_A, agentCapitalSharePercent: 25 });
  });

  it("refuses when the account reports no owning L1 address rather than guessing one", async () => {
    await expect(resolveLighterCapitalSharePolicy({
      environment: "rhc",
      accountIndex: 24226,
      account: account({ l1_address: undefined }),
    })).rejects.toThrow(/no owning L1 address/);
  });

  it("applies NO ceiling when that wallet has no limits row", async () => {
    await expect(resolveLighterCapitalSharePolicy({
      environment: "rhc",
      accountIndex: 24226,
      account: account(),
    })).resolves.toMatchObject({ agentCapitalSharePercent: null });
  });
});

describe("admitLighterOrderCapitalCommitment: whose ceiling", () => {
  it("uses the OWNING wallet's share, not another wallet's", async () => {
    // Wallet A allows 100% (the order fits); wallet B allows 10% (it does not).
    // The account belongs to A, so the order must be admitted even though B has
    // a stricter share on the same install.
    limitsRows.set(`rhc:${WALLET_A}`, 100);
    limitsRows.set(`rhc:${WALLET_B}`, 10);
    const outcome = await admitLighterOrderCapitalCommitment({
      environment: "rhc",
      accountIndex: 24226,
      account: account(),
      intentId: "intent-a",
      kind: "create",
      order: order(),
      client,
      auth: AUTH,
    });
    expect(outcome.applies && "assessment" in outcome && outcome.assessment.passes).toBe(true);
    expect(readLighterTradingLimits).toHaveBeenCalledWith("rhc", WALLET_A);
  });

  it("refuses with BOTH numbers and the remedy when the order exceeds the share", async () => {
    // 25% of 7.884034 is 1.971008; the order needs 7.732980.
    limitsRows.set(`rhc:${WALLET_A}`, 25);
    await expect(admitLighterOrderCapitalCommitment({
      environment: "rhc",
      accountIndex: 24226,
      account: account(),
      intentId: "intent-a",
      kind: "create",
      order: order(),
      client,
      auth: AUTH,
    })).rejects.toThrow(/7\.732980[\s\S]*1\.971008[\s\S]*Settings -> Lighter -> Trading setup/);
    expect(ledger.get("rhc:24226") ?? []).toHaveLength(0);
  });

  it("never resizes the order to fit", async () => {
    limitsRows.set(`rhc:${WALLET_A}`, 25);
    await expect(admitLighterOrderCapitalCommitment({
      environment: "rhc",
      accountIndex: 24226,
      account: account(),
      intentId: "intent-a",
      kind: "create",
      order: order(),
      client,
      auth: AUTH,
    })).rejects.toThrow(/NOT resized/);
  });

  it("skips the ledger entirely when no share is configured", async () => {
    const outcome = await admitLighterOrderCapitalCommitment({
      environment: "rhc",
      accountIndex: 24226,
      account: account(),
      intentId: "intent-a",
      kind: "create",
      order: order(),
      client,
      auth: AUTH,
    });
    expect(outcome).toEqual({ applies: false, exemption: "no_share_configured" });
    expect(admitLighterCapitalCommitment).not.toHaveBeenCalled();
  });

  it("exempts a reduce-only order without touching the ledger", async () => {
    limitsRows.set(`rhc:${WALLET_A}`, 1);
    const outcome = await admitLighterOrderCapitalCommitment({
      environment: "rhc",
      accountIndex: 24226,
      account: account(),
      intentId: "intent-a",
      kind: "create",
      order: order({ reduceOnly: true }),
      client,
      auth: AUTH,
    });
    expect(outcome).toEqual({ applies: false, exemption: "reduce_only" });
    expect(admitLighterCapitalCommitment).not.toHaveBeenCalled();
  });
});

describe("admitLighterOrderCapitalCommitment: atomic admission", () => {
  it("admits only the order that FITS when two sessions prepare against one budget", async () => {
    // 100% of 7.884034 leaves room for exactly one 7.732980 order. A loose
    // read-then-write would let both pass; the serialized admission must not.
    limitsRows.set(`rhc:${WALLET_A}`, 100);
    const prepare = (intentId: string) => admitLighterOrderCapitalCommitment({
      environment: "rhc",
      accountIndex: 24226,
      account: account(),
      intentId,
      kind: "create",
      order: order(),
      client,
      auth: AUTH,
    });

    const results = await Promise.allSettled([prepare("intent-1"), prepare("intent-2")]);
    const admitted = results.filter((result) => result.status === "fulfilled");
    const refused = results.filter((result) => result.status === "rejected");
    expect(admitted).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect((refused[0] as PromiseRejectedResult).reason.message).toMatch(/exceeds/);
    // Exactly ONE commitment exists for the account.
    expect(ledger.get("rhc:24226")).toHaveLength(1);
  });

  it("does NOT count an intent's own commitment against itself on revalidation", async () => {
    // At execute time the intent is already committed. Without
    // `excludeIntentId` it would be charged twice and refuse its own order.
    limitsRows.set(`rhc:${WALLET_A}`, 100);
    await admitLighterOrderCapitalCommitment({
      environment: "rhc",
      accountIndex: 24226,
      account: account(),
      intentId: "intent-1",
      kind: "create",
      order: order(),
      client,
      auth: AUTH,
    });
    await expect(admitLighterOrderCapitalCommitment({
      environment: "rhc",
      accountIndex: 24226,
      account: account(),
      intentId: "intent-1",
      kind: "create",
      order: order(),
      client,
      auth: AUTH,
      excludeIntentId: "intent-1",
    })).resolves.toMatchObject({ applies: true });
  });

  it("refuses at revalidation when the live account SHRANK after approval", async () => {
    // The user withdrew collateral between approval and signing. The order that
    // fitted at prepare must not sign against the smaller account.
    limitsRows.set(`rhc:${WALLET_A}`, 100);
    await expect(admitLighterOrderCapitalCommitment({
      environment: "rhc",
      accountIndex: 24226,
      account: account({ collateral: "1.000000", available_balance: "1.000000" }),
      intentId: "intent-1",
      kind: "create",
      order: order(),
      client,
      auth: AUTH,
      excludeIntentId: "intent-1",
    })).rejects.toThrow(/exceeds/);
  });

  it("admits only the DELTA of a modification, so an increase is charged once", async () => {
    limitsRows.set(`rhc:${WALLET_A}`, 100);
    await admitLighterOrderCapitalCommitment({
      environment: "rhc",
      accountIndex: 24226,
      account: account(),
      intentId: "intent-modify",
      kind: "modify",
      order: order(),
      client,
      auth: AUTH,
      // Nearly all of the new requirement is already committed by the order
      // being modified, so only the small increase is admitted.
      alreadyCommittedUnits: "7700000",
    });
    expect(admitLighterCapitalCommitment).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "modify", requiredUnits: "32980" }),
    );
  });

  it("admits a DECREASE as zero, so shrinking an order always passes", async () => {
    limitsRows.set(`rhc:${WALLET_A}`, 1);
    await admitLighterOrderCapitalCommitment({
      environment: "rhc",
      accountIndex: 24226,
      account: account(),
      intentId: "intent-modify",
      kind: "modify",
      order: order(),
      client,
      auth: AUTH,
      alreadyCommittedUnits: "9000000",
    });
    expect(admitLighterCapitalCommitment).toHaveBeenCalledWith(
      expect.objectContaining({ requiredUnits: "0" }),
    );
  });
});

describe("admitLighterOrderCapitalCommitment: unbounded commitments fail closed", () => {
  it("refuses when resting orders exist that Vex cannot read", async () => {
    // A zero here would silently WIDEN the user's ceiling, so an unreadable
    // commitment is a refusal, not an assumed absence.
    limitsRows.set(`rhc:${WALLET_A}`, 100);
    await expect(admitLighterOrderCapitalCommitment({
      environment: "rhc",
      accountIndex: 24226,
      account: account({
        total_order_count: 2,
        positions: [position({ open_order_count: 2 })],
      }),
      intentId: "intent-a",
      kind: "create",
      order: order(),
      client,
      // The vault is locked, so no read-only account token exists.
      auth: null,
    })).rejects.toThrow(/resting orders whose reserved margin Vex could not read/);
  });

  it("refuses when THIS ACCOUNT's exchange fee tier cannot be read", async () => {
    // A defaulted zero here would price every order at the market's own fee,
    // which is exactly how an order at the ceiling was admitted without
    // reserving what the exchange will charge it.
    limitsRows.set(`rhc:${WALLET_A}`, 100);
    await expect(admitLighterOrderCapitalCommitment({
      environment: "rhc",
      accountIndex: 24226,
      account: account(),
      intentId: "intent-a",
      kind: "create",
      order: order(),
      client,
      auth: null,
    })).rejects.toThrow(/exchange fee tier/);
    expect(ledger.get("rhc:24226") ?? []).toHaveLength(0);
  });

  it("charges the account's fee tier, so a tier rise can push an order past the share", async () => {
    // Same order, same collateral, same market taker fee of zero. Only the
    // ACCOUNT's own tier differs, and it is the difference between admitted and
    // refused. Without the account leg both runs would be admitted.
    limitsRows.set(`rhc:${WALLET_A}`, 100);
    accountTakerFeeTicks = 0;
    await expect(admitLighterOrderCapitalCommitment({
      environment: "rhc",
      accountIndex: 24226,
      account: account({ collateral: "7.732980", available_balance: "7.732980" }),
      intentId: "intent-free",
      kind: "create",
      order: order(),
      client,
      auth: AUTH,
    })).resolves.toMatchObject({ applies: true });

    ledger.clear();
    // 1 tick of 15.465960 is 0.0000154..., which rounds UP to a single unit and
    // that single unit no longer fits.
    accountTakerFeeTicks = 1;
    await expect(admitLighterOrderCapitalCommitment({
      environment: "rhc",
      accountIndex: 24226,
      account: account({ collateral: "7.732980", available_balance: "7.732980" }),
      intentId: "intent-fee",
      kind: "create",
      order: order(),
      client,
      auth: AUTH,
    })).rejects.toThrow(/exceeds/);
  });

  it("refuses when a position carries a margin mode Vex does not recognise", async () => {
    // Skipping the row would drop its allocated margin out of `committed` and
    // WIDEN the ceiling by an amount nobody could classify.
    limitsRows.set(`rhc:${WALLET_A}`, 100);
    await expect(admitLighterOrderCapitalCommitment({
      environment: "rhc",
      accountIndex: 24226,
      account: account({
        positions: [position({
          market_id: 2,
          symbol: "ETH",
          margin_mode: 7,
          allocated_margin: "5.000000",
          position: "1.00000",
          sign: 1,
        })],
      }),
      intentId: "intent-a",
      kind: "create",
      order: order(),
      client,
      auth: AUTH,
    })).rejects.toThrow(/margin mode 7[\s\S]*NOT skipped/);
    expect(ledger.get("rhc:24226") ?? []).toHaveLength(0);
  });

  it("refuses a market order carrying no approved price bound", async () => {
    limitsRows.set(`rhc:${WALLET_A}`, 100);
    await expect(admitLighterOrderCapitalCommitment({
      environment: "rhc",
      accountIndex: 24226,
      account: account(),
      intentId: "intent-a",
      kind: "create",
      order: order({ approvedPriceInteger: "0" }),
      client,
      auth: AUTH,
    })).rejects.toThrow(/no approved price bound/);
  });
});

describe("markLighterOrderCapitalCommitmentSettled", () => {
  it("stamps the settlement rather than retiring the commitment", async () => {
    await markLighterOrderCapitalCommitmentSettled("intent-1");

    expect(markLighterCapitalCommitmentSettled).toHaveBeenCalledWith("intent-1");
    expect(retireLighterCapitalCommitment).not.toHaveBeenCalled();
  });

  it("never turns a settled money outcome into an error when the ledger fails", async () => {
    markLighterCapitalCommitmentSettled.mockRejectedValueOnce(new Error("database is down"));

    // Resolves. The order really filled and the user must be told so; a missed
    // stamp only delays retirement, because the admission sweep stamps the row
    // itself the next time it sees the terminal intent.
    await expect(markLighterOrderCapitalCommitmentSettled("intent-2")).resolves.toBeUndefined();
  });
});

describe("retireLighterOrderCapitalCommitment", () => {
  it("passes the terminal cause through to the ledger", async () => {
    retireLighterCapitalCommitment.mockClear();

    await retireLighterOrderCapitalCommitment({
      intentId: "intent-1",
      reason: "provider_confirmed_filled",
    });

    expect(retireLighterCapitalCommitment).toHaveBeenCalledWith({
      intentId: "intent-1",
      reason: "provider_confirmed_filled",
    });
  });

  it("never turns a settled money outcome into an error when the ledger fails", async () => {
    retireLighterCapitalCommitment.mockClear();
    retireLighterCapitalCommitment.mockRejectedValueOnce(new Error("database is down"));

    // Resolves. The order really filled, and the user must be told so; a row
    // that stays live only over-counts, which tightens the ceiling, and the
    // next admission retires it after the observation lag.
    await expect(retireLighterOrderCapitalCommitment({
      intentId: "intent-2",
      reason: "provider_confirmed_filled",
    })).resolves.toBeUndefined();
  });
});
