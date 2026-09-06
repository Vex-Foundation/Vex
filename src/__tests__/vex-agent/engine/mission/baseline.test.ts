/**
 * Mission start baseline - the frozen start-of-run capital figure.
 *
 * The single most important property under test is the NO-THROW contract:
 * `buildMissionBaseline` runs at the pre-commit seam of `mission.start`, so a
 * rejection there would make starting a mission newly failure-prone. Every
 * failure must become an `absent` baseline carrying a NAMED reason, because a
 * reason the agent can read is the deliverable; a silent zero is not.
 *
 * The second is that a `$0.00` total is only ever presented as a real total
 * when something actually had a price. "Nothing was priced" is recorded as
 * `no_usd_prices` and downgraded to `partial`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { SOLANA_SYNTHETIC_CHAIN_ID } from "../../../../constants/solana-chain.js";
import { SOLANA_NATIVE_PERSISTED_ADDRESS } from "@tools/solana-ecosystem/shared/solana-asset-identity.js";
import { SOL_MINT } from "@tools/solana-ecosystem/shared/solana-constants.js";
import type { DeployedCapital } from "../../../../vex-agent/engine/types.js";

const mockGetPortfolioValuation = vi.fn();
const mockGetAssetHolding = vi.fn();
const mockListWallets = vi.fn();

vi.mock("@vex-agent/db/repos/balances.js", () => ({
  getPortfolioValuation: (...a: unknown[]) => mockGetPortfolioValuation(...a),
  getAssetHolding: (...a: unknown[]) => mockGetAssetHolding(...a),
}));

vi.mock("@tools/wallet/inventory.js", () => ({
  listWallets: (...a: unknown[]) => mockListWallets(...a),
  walletAddressesEqual: (family: string, a: string, b: string) =>
    family === "evm" ? a.toLowerCase() === b.toLowerCase() : a === b,
}));

vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const {
  MISSION_BASELINE_VERSION,
  MISSION_BASELINE_REASONS,
  absentBaseline,
  buildMissionBaseline,
  readMissionBaseline,
} = await import("../../../../vex-agent/engine/mission/baseline.js");

const EVM_WALLET = "0x1111111111111111111111111111111111111111";
const SOL_WALLET = "So11111111111111111111111111111111111111112";
const TOKEN = "0x0f9f0000000000000000000000000000000000ee";

const DECLARED: DeployedCapital = {
  amountRaw: "3044000000000000000000",
  decimals: 18,
  chainId: 4663,
  assetAddress: TOKEN,
  assetKind: "token",
  assetSymbol: "VEX",
};

function freshValuation(overrides: Record<string, unknown> = {}) {
  return {
    totalUsdEstimate: 32.1,
    pricedRowCount: 2,
    unpricedRowCount: 0,
    oldestSyncedAt: new Date().toISOString(),
    newestSyncedAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockListWallets.mockImplementation((family: string) =>
    family === "evm"
      ? [{ id: "evm-1", address: EVM_WALLET }]
      : [{ id: "sol-1", address: SOL_WALLET }],
  );
  mockGetPortfolioValuation.mockResolvedValue(freshValuation());
  mockGetAssetHolding.mockResolvedValue({
    heldAmountRaw: "6802264854000000000000",
    heldDecimals: 18,
    heldUsdEstimate: 30,
    rowCount: 1,
    hasUnpricedRow: false,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("buildMissionBaseline - recorded", () => {
  it("records the portfolio and the declared capital over the matched wallets", async () => {
    const baseline = await buildMissionBaseline({
      missionId: "mission-1",
      allowedWallets: [EVM_WALLET.toUpperCase()],
      deployedCapital: DECLARED,
    });

    expect(baseline.status).toBe("recorded");
    expect(baseline.reasons).toEqual([]);
    expect(baseline.version).toBe(MISSION_BASELINE_VERSION);
    expect(baseline.source).toBe("proj_balances");
    // The INSTALLED address is the one measured over, so the "now" side can
    // reuse the exact set the projection is keyed by.
    expect(baseline.scope.addresses).toEqual([EVM_WALLET]);
    expect(baseline.portfolio?.totalUsdEstimate).toBe(32.1);
    expect(baseline.deployedCapitalAtStart).toEqual({
      chainId: 4663,
      assetAddress: TOKEN,
      assetKind: "token",
      assetSymbol: "VEX",
      declaredAmountRaw: DECLARED.amountRaw,
      declaredDecimals: 18,
      heldAmountRaw: "6802264854000000000000",
      heldDecimals: 18,
      heldUsdEstimate: 30,
    });
    // Both reads carry a SERVER-side bound just inside the 4000 ms caller
    // budget: the race abandons the wait, only the statement timeout ends the
    // query and frees the pooled connection.
    expect(mockGetPortfolioValuation).toHaveBeenCalledWith([EVM_WALLET], 3_500);
    expect(mockGetAssetHolding).toHaveBeenCalledWith([EVM_WALLET], 4663, TOKEN, 3_500);
    expect(readMissionBaseline(JSON.parse(JSON.stringify(baseline)))).not.toBeNull();
  });

  it("matches a Solana wallet by exact base58 case", async () => {
    const baseline = await buildMissionBaseline({
      missionId: "mission-1",
      allowedWallets: [SOL_WALLET],
      deployedCapital: null,
    });

    expect(baseline.status).toBe("recorded");
    expect(baseline.scope.addresses).toEqual([SOL_WALLET]);
    expect(baseline.deployedCapitalAtStart).toBeNull();
  });

  it("reads canonical native SOL from its distinct projection key", async () => {
    mockGetAssetHolding.mockResolvedValue({
      heldAmountRaw: "1500000000",
      heldDecimals: 9,
      heldUsdEstimate: 150,
      rowCount: 1,
      hasUnpricedRow: false,
    });
    const deployedCapital: DeployedCapital = {
      amountRaw: "1000000000",
      decimals: 9,
      chainId: SOLANA_SYNTHETIC_CHAIN_ID,
      assetAddress: SOL_MINT,
      assetKind: "native",
      assetSymbol: "SOL",
    };

    const baseline = await buildMissionBaseline({
      missionId: "mission-sol",
      allowedWallets: [SOL_WALLET],
      deployedCapital,
    });

    expect(mockGetAssetHolding).toHaveBeenCalledWith(
      [SOL_WALLET],
      SOLANA_SYNTHETIC_CHAIN_ID,
      SOLANA_NATIVE_PERSISTED_ADDRESS,
      3_500,
    );
    expect(baseline.deployedCapitalAtStart).toMatchObject({
      assetAddress: SOL_MINT,
      assetKind: "native",
      assetSymbol: "SOL",
      heldAmountRaw: "1500000000",
      heldDecimals: 9,
    });
  });

  it("names the pre-first-sync legacy merged SOL row as ambiguous without using its amount", async () => {
    mockGetAssetHolding
      .mockResolvedValueOnce({
        heldAmountRaw: null,
        heldDecimals: null,
        heldUsdEstimate: null,
        rowCount: 0,
        hasUnpricedRow: false,
      })
      .mockResolvedValueOnce({
        heldAmountRaw: "9000000000",
        heldDecimals: 9,
        heldUsdEstimate: 900,
        rowCount: 1,
        hasUnpricedRow: false,
      });
    const deployedCapital: DeployedCapital = {
      amountRaw: "1000000000",
      decimals: 9,
      chainId: SOLANA_SYNTHETIC_CHAIN_ID,
      assetAddress: SOL_MINT,
      assetKind: "native",
      assetSymbol: "SOL",
    };

    const baseline = await buildMissionBaseline({
      missionId: "mission-sol-before-sync",
      allowedWallets: [SOL_WALLET],
      deployedCapital,
    });

    expect(mockGetAssetHolding).toHaveBeenNthCalledWith(
      1,
      [SOL_WALLET],
      SOLANA_SYNTHETIC_CHAIN_ID,
      SOLANA_NATIVE_PERSISTED_ADDRESS,
      3_500,
    );
    expect(mockGetAssetHolding).toHaveBeenNthCalledWith(
      2,
      [SOL_WALLET],
      SOLANA_SYNTHETIC_CHAIN_ID,
      SOL_MINT,
      3_500,
    );
    expect(baseline.status).toBe("partial");
    expect(baseline.reasons).toContain("deployed_capital_asset_ambiguous");
    expect(baseline.deployedCapitalAtStart).toMatchObject({
      assetKind: "native",
      heldAmountRaw: null,
      heldDecimals: null,
      heldUsdEstimate: null,
    });
  });

  it("reads wSOL from the token row when the structural kind is token", async () => {
    const deployedCapital: DeployedCapital = {
      amountRaw: "500000000",
      decimals: 9,
      chainId: SOLANA_SYNTHETIC_CHAIN_ID,
      assetAddress: SOL_MINT,
      assetKind: "token",
      assetSymbol: "wSOL",
    };

    await buildMissionBaseline({
      missionId: "mission-wsol",
      allowedWallets: [SOL_WALLET],
      deployedCapital,
    });

    expect(mockGetAssetHolding).toHaveBeenCalledWith(
      [SOL_WALLET],
      SOLANA_SYNTHETIC_CHAIN_ID,
      SOL_MINT,
      3_500,
    );
  });

  it("leaves a legacy SOL_MINT declaration ambiguous instead of guessing native or wSOL", async () => {
    const legacy = { ...DECLARED,
      decimals: 9,
      chainId: SOLANA_SYNTHETIC_CHAIN_ID,
      assetAddress: SOL_MINT,
      assetKind: null,
      assetSymbol: "SOL",
    } satisfies DeployedCapital;

    const baseline = await buildMissionBaseline({
      missionId: "mission-legacy-sol",
      allowedWallets: [SOL_WALLET],
      deployedCapital: legacy,
    });

    expect(mockGetAssetHolding).not.toHaveBeenCalled();
    expect(baseline.status).toBe("partial");
    expect(baseline.reasons).toContain("deployed_capital_asset_ambiguous");
    expect(baseline.deployedCapitalAtStart).toMatchObject({
      assetAddress: SOL_MINT,
      assetKind: null,
      heldAmountRaw: null,
    });
  });

  it("does not match a Solana wallet whose case was folded", async () => {
    const baseline = await buildMissionBaseline({
      missionId: "mission-1",
      allowedWallets: [SOL_WALLET.toLowerCase()],
      deployedCapital: null,
    });

    expect(baseline.status).toBe("absent");
    expect(baseline.reasons).toEqual(["wallets_not_in_inventory"]);
  });
});

describe("buildMissionBaseline - every named reason", () => {
  it("no_allowed_wallets when the contract listed none", async () => {
    const baseline = await buildMissionBaseline({
      missionId: "mission-1",
      allowedWallets: [],
      deployedCapital: DECLARED,
    });

    expect(baseline.status).toBe("absent");
    expect(baseline.reasons).toEqual(["no_allowed_wallets"]);
    expect(baseline.portfolio).toBeNull();
    expect(mockGetPortfolioValuation).not.toHaveBeenCalled();
  });

  it("wallets_not_in_inventory when nothing installed matches", async () => {
    const baseline = await buildMissionBaseline({
      missionId: "mission-1",
      allowedWallets: ["0x2222222222222222222222222222222222222222"],
      deployedCapital: null,
    });

    expect(baseline.status).toBe("absent");
    expect(baseline.reasons).toEqual(["wallets_not_in_inventory"]);
    expect(mockGetPortfolioValuation).not.toHaveBeenCalled();
  });

  it("no_projection_rows when the projection holds nothing for those wallets", async () => {
    mockGetPortfolioValuation.mockResolvedValue(
      freshValuation({ totalUsdEstimate: 0, pricedRowCount: 0, unpricedRowCount: 0 }),
    );

    const baseline = await buildMissionBaseline({
      missionId: "mission-1",
      allowedWallets: [EVM_WALLET],
      deployedCapital: null,
    });

    expect(baseline.status).toBe("absent");
    expect(baseline.reasons).toEqual(["no_projection_rows"]);
    expect(baseline.portfolio).toBeNull();
  });

  it("no_usd_prices downgrades a $0 total that only means nothing had a price", async () => {
    mockGetPortfolioValuation.mockResolvedValue(
      freshValuation({ totalUsdEstimate: 0, pricedRowCount: 0, unpricedRowCount: 3 }),
    );

    const baseline = await buildMissionBaseline({
      missionId: "mission-1",
      allowedWallets: [EVM_WALLET],
      deployedCapital: null,
    });

    expect(baseline.status).toBe("partial");
    expect(baseline.reasons).toEqual(["no_usd_prices"]);
    expect(baseline.portfolio?.unpricedRowCount).toBe(3);
  });

  it("stale_projection when the newest projection row predates the freshness budget", async () => {
    const old = new Date(Date.now() - 20 * 60_000).toISOString();
    mockGetPortfolioValuation.mockResolvedValue(
      freshValuation({ oldestSyncedAt: old, newestSyncedAt: old }),
    );

    const baseline = await buildMissionBaseline({
      missionId: "mission-1",
      allowedWallets: [EVM_WALLET],
      deployedCapital: null,
    });

    expect(baseline.status).toBe("partial");
    expect(baseline.reasons).toEqual(["stale_projection"]);
  });

  it("deployed_capital_decimals_mismatch nulls the held triple and never rescales", async () => {
    mockGetAssetHolding.mockResolvedValue({
      heldAmountRaw: "1047061",
      heldDecimals: 6,
      heldUsdEstimate: 1.05,
      rowCount: 1,
      hasUnpricedRow: false,
    });

    const baseline = await buildMissionBaseline({
      missionId: "mission-1",
      allowedWallets: [EVM_WALLET],
      deployedCapital: DECLARED,
    });

    expect(baseline.status).toBe("partial");
    expect(baseline.reasons).toEqual(["deployed_capital_decimals_mismatch"]);
    expect(baseline.deployedCapitalAtStart).toEqual({
      chainId: 4663,
      assetAddress: TOKEN,
      assetKind: "token",
      assetSymbol: "VEX",
      declaredAmountRaw: DECLARED.amountRaw,
      declaredDecimals: 18,
      heldAmountRaw: null,
      heldDecimals: null,
      heldUsdEstimate: null,
    });
  });

  it("deployed_capital_decimals_mismatch when the projection knows no decimals", async () => {
    mockGetAssetHolding.mockResolvedValue({
      heldAmountRaw: null,
      heldDecimals: null,
      heldUsdEstimate: 4,
      rowCount: 2,
      hasUnpricedRow: false,
    });

    const baseline = await buildMissionBaseline({
      missionId: "mission-1",
      allowedWallets: [EVM_WALLET],
      deployedCapital: DECLARED,
    });

    expect(baseline.status).toBe("partial");
    expect(baseline.reasons).toEqual(["deployed_capital_decimals_mismatch"]);
    expect(baseline.deployedCapitalAtStart?.heldUsdEstimate).toBeNull();
  });

  it("records a declared asset the wallets simply do not hold, with no caveat", async () => {
    mockGetAssetHolding.mockResolvedValue({
      heldAmountRaw: null,
      heldDecimals: null,
      heldUsdEstimate: null,
      rowCount: 0,
      hasUnpricedRow: false,
    });

    const baseline = await buildMissionBaseline({
      missionId: "mission-1",
      allowedWallets: [EVM_WALLET],
      deployedCapital: DECLARED,
    });

    expect(baseline.status).toBe("recorded");
    expect(baseline.reasons).toEqual([]);
    expect(baseline.deployedCapitalAtStart?.heldAmountRaw).toBeNull();
  });

  it("valuation_failed when the projection read REJECTS, and it never rejects itself", async () => {
    mockGetPortfolioValuation.mockRejectedValue(new Error("db connection reset"));

    const baseline = await buildMissionBaseline({
      missionId: "mission-1",
      allowedWallets: [EVM_WALLET],
      deployedCapital: DECLARED,
    });

    expect(baseline.status).toBe("absent");
    expect(baseline.reasons).toEqual(["valuation_failed"]);
    expect(baseline.portfolio).toBeNull();
  });

  it("valuation_failed when the wallet inventory read THROWS synchronously", async () => {
    mockListWallets.mockImplementation(() => {
      throw new Error("config unreadable");
    });

    const baseline = await buildMissionBaseline({
      missionId: "mission-1",
      allowedWallets: [EVM_WALLET],
      deployedCapital: null,
    });

    expect(baseline.status).toBe("absent");
    expect(baseline.reasons).toEqual(["valuation_failed"]);
  });

  it("valuation_timed_out when the read outlives the budget", async () => {
    vi.useFakeTimers();
    mockGetPortfolioValuation.mockReturnValue(new Promise(() => { /* never settles */ }));

    const pending = buildMissionBaseline({
      missionId: "mission-1",
      allowedWallets: [EVM_WALLET],
      deployedCapital: null,
    });
    await vi.advanceTimersByTimeAsync(4_000);
    const baseline = await pending;

    expect(baseline.status).toBe("absent");
    expect(baseline.reasons).toEqual(["valuation_timed_out"]);
  });

  it("names every reason in the vocabulary exactly once", () => {
    expect(new Set(MISSION_BASELINE_REASONS).size).toBe(MISSION_BASELINE_REASONS.length);
    expect(MISSION_BASELINE_REASONS).toContain("deployed_capital_decimals_mismatch");
  });

  it("accumulates independent caveats instead of dropping one", async () => {
    const old = new Date(Date.now() - 20 * 60_000).toISOString();
    mockGetPortfolioValuation.mockResolvedValue(
      freshValuation({
        totalUsdEstimate: 0,
        pricedRowCount: 0,
        unpricedRowCount: 2,
        oldestSyncedAt: old,
        newestSyncedAt: old,
      }),
    );

    const baseline = await buildMissionBaseline({
      missionId: "mission-1",
      allowedWallets: [EVM_WALLET],
      deployedCapital: null,
    });

    expect(baseline.status).toBe("partial");
    expect([...baseline.reasons].sort()).toEqual(["no_usd_prices", "stale_projection"]);
  });
});

describe("absentBaseline", () => {
  it("is a valid absent baseline with the given reason", () => {
    const baseline = absentBaseline("valuation_failed");

    expect(baseline.status).toBe("absent");
    expect(baseline.reasons).toEqual(["valuation_failed"]);
    expect(baseline.portfolio).toBeNull();
    expect(baseline.deployedCapitalAtStart).toBeNull();
    expect(baseline.scope.addresses).toEqual([]);
    expect(readMissionBaseline(JSON.parse(JSON.stringify(baseline)))).not.toBeNull();
  });
});

describe("readMissionBaseline", () => {
  const recorded = {
    version: 1,
    capturedAt: "2026-08-10T13:12:04.000Z",
    status: "recorded",
    reasons: [],
    source: "proj_balances",
    scope: { addresses: [EVM_WALLET] },
    portfolio: {
      totalUsdEstimate: 32.1,
      pricedRowCount: 2,
      unpricedRowCount: 0,
      oldestSyncedAt: "2026-08-10T13:00:00.000Z",
      newestSyncedAt: "2026-08-10T13:12:04.000Z",
    },
    deployedCapitalAtStart: null,
  };

  it("parses a well-formed recorded blob", () => {
    expect(readMissionBaseline(recorded)?.status).toBe("recorded");
  });

  it("returns null for absent input", () => {
    expect(readMissionBaseline(undefined)).toBeNull();
    expect(readMissionBaseline(null)).toBeNull();
    expect(readMissionBaseline({})).toBeNull();
    expect(readMissionBaseline("not a baseline")).toBeNull();
  });

  it("returns null for an unknown version", () => {
    expect(readMissionBaseline({ ...recorded, version: 2 })).toBeNull();
  });

  it("returns null for an unknown key (strict)", () => {
    expect(readMissionBaseline({ ...recorded, surprise: true })).toBeNull();
  });

  it("returns null for an unknown reason code", () => {
    expect(
      readMissionBaseline({ ...recorded, status: "partial", reasons: ["made_up"] }),
    ).toBeNull();
  });

  it("REJECTS a recorded blob that carries reasons", () => {
    expect(
      readMissionBaseline({ ...recorded, reasons: ["stale_projection"] }),
    ).toBeNull();
  });

  it("REJECTS a partial blob with no reason at all", () => {
    expect(readMissionBaseline({ ...recorded, status: "partial", reasons: [] })).toBeNull();
  });

  it("REJECTS a recorded blob whose portfolio is null, so it can never render as usable", () => {
    expect(readMissionBaseline({ ...recorded, portfolio: null })).toBeNull();
  });

  it("REJECTS a partial blob whose portfolio is null", () => {
    expect(
      readMissionBaseline({
        ...recorded,
        status: "partial",
        reasons: ["stale_projection"],
        portfolio: null,
      }),
    ).toBeNull();
  });

  it("REJECTS an absent blob that carries a portfolio", () => {
    expect(
      readMissionBaseline({ ...recorded, status: "absent", reasons: ["valuation_failed"] }),
    ).toBeNull();
  });

  it("parses a Solana-scoped baseline without folding the mint case", () => {
    const parsed = readMissionBaseline({
      ...recorded,
      scope: { addresses: [SOL_WALLET] },
      deployedCapitalAtStart: {
        chainId: SOLANA_SYNTHETIC_CHAIN_ID,
        assetAddress: SOL_WALLET,
        assetKind: null,
        assetSymbol: "SOL",
        declaredAmountRaw: "1000000000",
        declaredDecimals: 9,
        heldAmountRaw: null,
        heldDecimals: null,
        heldUsdEstimate: null,
      },
    });

    expect(parsed?.deployedCapitalAtStart?.assetAddress).toBe(SOL_WALLET);
  });
});
