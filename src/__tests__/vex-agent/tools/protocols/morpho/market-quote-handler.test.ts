/**
 * `morpho.market.quote` handler behaviour: the agent-facing contract of the read
 * that gates the four Blue market executes.
 *
 * The preview ENGINE is stubbed. It has its own suite and its own fork harness,
 * and replacing it here leaves exactly the things the agent layer owns under
 * assertion:
 *
 *   - whose position is being priced, and the reply saying so honestly when the
 *     answer is "nobody's";
 *   - the disclosure and the two SEPARATE token scales reaching the output,
 *     since a raw amount without the decimals to read it is the thousandfold
 *     error rules/90 names;
 *   - the ONE leg per operation, with no mirrored second side invented;
 *   - `nextStep` naming the single execute this quote authorizes, because a
 *     supplyCollateral quote standing in for a borrow is the difference between
 *     an operation that cannot be liquidated and one that can;
 *   - a failed preview failing the whole call rather than inventing numbers.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import { VEX_DEFAULT_SLIPPAGE_BPS } from "@vex-agent/tools/protocols/slippage-policy.js";
import { definedValue, mutableRecord } from "../../../../_test-value-guards.js";
import type { ToolResult } from "@vex-agent/tools/types.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import {
  COLLATERAL_AMOUNT_RAW,
  LOAN_AMOUNT_RAW,
  MARKET_ID,
  USDC,
  WALLET,
  WALLET_MIXED,
  fullDebtRepayPreview,
  marketPreview,
} from "./market-handler-fixtures.js";

const preview = vi.hoisted(() => vi.fn());
const publicClient = vi.hoisted(() => vi.fn());
const selectedAddress = vi.hoisted(() => vi.fn());

// Only the preview itself is replaced: the disclosure projection reads
// `formatWad` and the health-factor floor from this same module, and stubbing
// those would put the fixture's own numbers under assertion instead of the
// handler's rendering of them.
vi.mock("@tools/morpho/mutations.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tools/morpho/mutations.js")>(),
  previewMorphoMarketOperation: preview,
  morphoActionsExtension: () => (client: unknown) => client,
}));

vi.mock("@tools/morpho/evm-client.js", () => ({
  getMorphoPublicClient: publicClient,
}));

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: selectedAddress,
}));

const { morphoMarketQuote } = await import(
  "../../../../../vex-agent/tools/protocols/morpho/handlers/market-quote.js"
);

function context(): ProtocolExecutionContext {
  return {
    sessionPermission: "full",
    approved: true,
    sessionId: "session-1",
    walletResolution: { source: "default" },
    walletPolicy: { kind: "none" },
  };
}

function payload(result: ToolResult): Record<string, unknown> {
  return definedValue(result.data, "tool result data");
}

function section(data: Record<string, unknown>, key: string): Record<string, unknown> {
  return mutableRecord(data[key], key);
}

function borrowQuote(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { marketId: MARKET_ID, chain: "base", direction: "borrow", borrowAmountRaw: LOAN_AMOUNT_RAW, ...overrides };
}

beforeEach(() => {
  preview.mockReset();
  publicClient.mockReset();
  selectedAddress.mockReset();
  selectedAddress.mockReturnValue(WALLET);
  publicClient.mockReturnValue({ extend: () => ({}) });
  preview.mockResolvedValue(marketPreview("borrow"));
});

describe("morpho.market.quote prices ONE named position", () => {
  it("prices the wallet the caller named, checksummed, over the session's selected one", async () => {
    await morphoMarketQuote(borrowQuote({ walletAddress: WALLET_MIXED }), context());

    const passed = String(preview.mock.calls[0]?.[1].walletAddress);
    expect(passed.toLowerCase()).toBe(WALLET);
    expect(selectedAddress).not.toHaveBeenCalled();
  });

  it("falls back to the session's selected wallet when the caller named none", async () => {
    await morphoMarketQuote(borrowQuote(), context());

    expect(String(preview.mock.calls[0]?.[1].walletAddress).toLowerCase()).toBe(WALLET);
  });

  it("says the projection belongs to NOBODY when no wallet is named and none is selected", async () => {
    selectedAddress.mockImplementation(() => { throw new Error("no eip155 wallet in this session"); });
    preview.mockResolvedValue(marketPreview("borrow", { walletAddressWasSupplied: false }));

    const result = await morphoMarketQuote(borrowQuote(), context());

    expect(result.success).toBe(true);
    expect(preview.mock.calls[0]?.[1].walletAddress).toBeUndefined();
    const wallet = String(section(payload(result), "notes")["wallet"]);
    expect(wallet).toContain("NO POSITION");
    expect(wallet).toContain("Re-run with `walletAddress`");
  });

  it("resolves an omitted tolerance to the ONE Vex default and passes it down explicitly", async () => {
    const result = await morphoMarketQuote(borrowQuote(), context());

    expect(preview.mock.calls[0]?.[1].slippageBps).toBe(VEX_DEFAULT_SLIPPAGE_BPS);
    expect(section(payload(result), "filtersApplied")["slippageBps"]).toBe(VEX_DEFAULT_SLIPPAGE_BPS);
  });

  it("passes a large raw amount down exactly, with no float rounding", async () => {
    const huge = "123456789012345678901234567890";

    await morphoMarketQuote(borrowQuote({ borrowAmountRaw: huge }), context());

    expect(preview.mock.calls[0]?.[1].amountRaw).toBe(BigInt(huge));
  });

  it("never resolves a signing wallet: the client it holds is a PUBLIC one", async () => {
    await morphoMarketQuote(borrowQuote(), context());

    expect(publicClient).toHaveBeenCalledWith(8453);
  });
});

describe("morpho.market.quote states what a person needs to allow the execute", () => {
  it("carries the oracle vouching, the health-factor projection and its floor", async () => {
    const market = section(payload(await morphoMarketQuote(borrowQuote(), context())), "market");

    expect(section(market, "oracle")["vouching"]).toBe("verified-oracle-legs");
    const health = section(market, "healthFactor");
    expect(health["before"]).toBe("1.72");
    expect(health["after"]).toBe("1.31");
    expect(health["floor"]).toBe("1.25");
    expect(String(health["note"])).toContain("NO CLOSE FACTOR");
  });

  it("keeps the market's two token scales apart, and says why they must not be compared", async () => {
    const data = payload(await morphoMarketQuote(borrowQuote(), context()));

    const pair = section(section(data, "market"), "pair");
    expect(pair["loanDecimals"]).toBe(6);
    expect(pair["collateralDecimals"]).toBe(8);
    expect(String(section(data, "notes")["scales"])).toContain("never compare a collateral raw amount");
  });

  it("reports the market's free liquidity in the LOAN token, raw and human", async () => {
    const liquidity = section(section(payload(await morphoMarketQuote(borrowQuote(), context())), "market"), "liquidity");

    expect(liquidity["availableRaw"]).toBe("12000000000");
    expect(liquidity["availableHuman"]).toBe("12000");
    expect(liquidity["loanDecimals"]).toBe(6);
  });

  it("carries the ONE leg the operation moves and invents no mirror side", async () => {
    const data = payload(await morphoMarketQuote(borrowQuote(), context()));

    expect(data["tokenOut"]).toBe("USDC");
    expect(data["amountOut"]).toBe("500.0");
    expect(data["tokenIn"]).toBeUndefined();
    expect(section(data, "leg")).toMatchObject({ direction: "out", tokenSymbol: "USDC", decimals: 6, tokenAddress: USDC });
    expect(String(section(data, "notes")["oneLeg"])).toContain("never both");
  });

  it("prices a collateral supply in the COLLATERAL token's own scale, not the loan token's", async () => {
    preview.mockResolvedValue(marketPreview("supply_collateral"));

    const data = payload(await morphoMarketQuote({
      marketId: MARKET_ID,
      chain: "base",
      direction: "supplyCollateral",
      supplyCollateralAmountRaw: COLLATERAL_AMOUNT_RAW,
    }, context()));

    expect(data["tokenIn"]).toBe("cbBTC");
    expect(data["amountIn"]).toBe("1.0");
  });

  it("reports the position it priced against, every figure in its own raw scale", async () => {
    const position = section(payload(await morphoMarketQuote(borrowQuote(), context())), "position");

    expect(position).toEqual({
      collateralRaw: "100000000",
      borrowSharesRaw: "500000000000000",
      borrowAssetsRaw: "500000001",
      maxBorrowAssetsRaw: "860000000",
    });
  });

  it("renders the approval a pulling operation needs, and NO plan for one that pulls nothing", async () => {
    preview.mockResolvedValue(marketPreview("repay"));
    const repay = payload(await morphoMarketQuote({
      marketId: MARKET_ID, chain: "base", direction: "repay", repayAmountRaw: LOAN_AMOUNT_RAW,
    }, context()));
    preview.mockResolvedValue(marketPreview("borrow"));
    const borrow = payload(await morphoMarketQuote(borrowQuote(), context()));

    const allowance = section(repay, "allowancePlan");
    expect(allowance["spenderRole"]).toBe("GeneralAdapter1");
    expect(allowance["requiredAmountRaw"]).toBe(LOAN_AMOUNT_RAW);
    expect(allowance["currentAllowanceRaw"]).toBe("0");
    expect(section(repay, "transaction")["pullAmountRaw"]).toBe(LOAN_AMOUNT_RAW);

    expect(borrow["allowancePlan"]).toBeNull();
    expect(section(borrow, "transaction")["pullAmountRaw"]).toBeNull();
    expect(section(borrow, "transaction")["approvalAmountRaw"]).toBeNull();
  });

  it("names the transaction shape each operation really takes", async () => {
    const borrow = section(payload(await morphoMarketQuote(borrowQuote(), context())), "transaction");
    preview.mockResolvedValue(marketPreview("repay"));
    const repay = section(payload(await morphoMarketQuote({
      marketId: MARKET_ID, chain: "base", direction: "repay", repayAmountRaw: LOAN_AMOUNT_RAW,
    }, context())), "transaction");

    expect(borrow["shape"]).toBe("direct-blue-call");
    expect(repay["shape"]).toBe("bundler3-multicall");
    // Lowercased so the ledger and the explorer link agree on one form.
    expect(String(borrow["to"])).toBe(String(borrow["to"]).toLowerCase());
  });

  it("distinguishes a full-debt repayment from a partial one, and carries the share count", async () => {
    preview.mockResolvedValue(fullDebtRepayPreview());
    const full = payload(await morphoMarketQuote({
      marketId: MARKET_ID, chain: "base", direction: "repay", repayFullDebt: true,
    }, context()));
    preview.mockResolvedValue(marketPreview("repay"));
    const partial = payload(await morphoMarketQuote({
      marketId: MARKET_ID, chain: "base", direction: "repay", repayAmountRaw: LOAN_AMOUNT_RAW,
    }, context()));

    expect(section(full, "leg")["borrowSharesRaw"]).toBe("500000000000000");
    expect(String(section(full, "notes")["repayMode"])).toContain("only way to close a Morpho debt completely");
    expect(section(partial, "leg")["borrowSharesRaw"]).toBeNull();
    expect(String(section(partial, "notes")["repayMode"])).toContain("LEAVES THE POSITION OPEN");
  });

  it("carries no repayMode note on an operation that is not a repayment", async () => {
    expect(section(payload(await morphoMarketQuote(borrowQuote(), context())), "notes")["repayMode"]).toBeUndefined();
  });
});

describe("morpho.market.quote is honest about what it committed and what it authorizes", () => {
  it("states that nothing was signed, sent, approved or recorded", async () => {
    const notes = section(payload(await morphoMarketQuote(borrowQuote(), context())), "notes");

    expect(String(notes["committed"])).toContain("NOTHING WAS SIGNED, SENT, APPROVED OR RECORDED AS EXECUTED");
    expect(String(notes["committed"])).toContain("not a promise about what it will do");
  });

  it("names the SINGLE execute this direction authorizes, and refuses to imply it authorizes another", async () => {
    const nextStep = String(payload(await morphoMarketQuote(borrowQuote(), context()))["nextStep"]);

    expect(nextStep).toContain("morpho.market.borrow");
    expect(nextStep).not.toContain("morpho.market.supplyCollateral");
    expect(nextStep).toContain("does not authorize it");
    expect(nextStep).toContain("spends real funds");
  });

  it("authorizes a DIFFERENT execute for a different direction, one each and never a set", async () => {
    preview.mockResolvedValue(marketPreview("supply_collateral"));

    const nextStep = String(payload(await morphoMarketQuote({
      marketId: MARKET_ID,
      chain: "base",
      direction: "supplyCollateral",
      supplyCollateralAmountRaw: COLLATERAL_AMOUNT_RAW,
    }, context()))["nextStep"]);

    expect(nextStep).toContain("morpho.market.supplyCollateral");
    expect(nextStep).not.toContain("morpho.market.borrow");
  });

  it("echoes every parameter it acted on, including the tolerance it defaulted", async () => {
    const data = payload(await morphoMarketQuote(borrowQuote({ walletAddress: WALLET_MIXED }), context()));

    expect(section(data, "filtersApplied")).toEqual({
      marketId: MARKET_ID,
      chain: "base",
      direction: "borrow",
      borrowAmountRaw: LOAN_AMOUNT_RAW,
      slippageBps: VEX_DEFAULT_SLIPPAGE_BPS,
      walletAddress: WALLET,
    });
  });

  it("passes the simulation verdict through as itself, revert reason included", async () => {
    preview.mockResolvedValue(marketPreview("repay"));

    const data = payload(await morphoMarketQuote({
      marketId: MARKET_ID, chain: "base", direction: "repay", repayAmountRaw: LOAN_AMOUNT_RAW,
    }, context()));

    expect(section(data, "preflight")["verdict"]).toBe("reverted");
    expect(String(section(data, "notes")["simulation"])).toContain("expected shape before it lands");
  });

  it("fails the whole call when the preview refuses, naming the real cause and inventing no numbers", async () => {
    preview.mockRejectedValue(new Error("this borrow would leave the health factor at 1.02, below Vex's floor"));

    const result = await morphoMarketQuote(borrowQuote(), context());

    expect(result.success).toBe(false);
    expect(result.output).toContain("below Vex's floor");
    expect(result.output).toContain("morpho.market.quote");
    expect(result.output).toContain("Nothing was signed or sent");
    expect(result.output).not.toContain("unexpected error");
    expect(result.data).toBeUndefined();
  });

  it("refuses a direction that does not exist rather than picking the nearest one", async () => {
    const result = await morphoMarketQuote(borrowQuote({ direction: "liquidate" }), context());

    expect(result.success).toBe(false);
    expect(result.output).toContain("direction");
    expect(preview).not.toHaveBeenCalled();
  });
});
