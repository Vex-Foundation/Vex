/**
 * The BORROWER-side Morpho Blue market executes, at the handler layer:
 * `morpho.market.supplyCollateral`, `morpho.market.withdrawCollateral`,
 * `morpho.market.borrow` and `morpho.market.repay`. The LENDER'S two are the
 * same spine and their cases live in `./market-execute-handler/lender-cases.ts`,
 * registered at the bottom of this file: module mocking is per-test-file and
 * has to stay here, while the cases are their own responsibility.
 *
 * The EXECUTION SPINE is not under test here. It has its own suite and its own
 * fork harness, and it is stubbed so these cases can assert only what the agent
 * layer owns, which is two things:
 *
 *   - `dryRun`, which must produce the whole preview while resolving no signing
 *     wallet, building no signing client and reaching no execution path at all;
 *   - the rendering of the four execution endings, where the agent-facing text
 *     is the only thing standing between a `unproven` broadcast and an agent
 *     retrying a transaction that may already have moved real funds.
 *
 * The DISCLOSURE projection (`market-shared.ts`) runs for real in both, because
 * a health factor or a liquidity figure that the handler drops is invisible in
 * the reply and would leave the approval prompt with nothing to show.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import { definedValue, mutableRecord } from "../../../../_test-value-guards.js";
import { registerMarketLenderCases } from "./market-execute-handler/lender-cases.js";
import type { ToolResult } from "@vex-agent/tools/types.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import {
  COLLATERAL_AMOUNT_RAW,
  LOAN_AMOUNT_RAW,
  MARKET_ID,
  PRIVATE_KEY,
  USDC,
  WALLET,
  fullDebtRepayPreview,
  marketIntent,
  marketPreview,
  marketState,
} from "./market-handler-fixtures.js";

const preview = vi.hoisted(() => vi.fn());
const readMarket = vi.hoisted(() => vi.fn());
const resolveIntent = vi.hoisted(() => vi.fn());
const executeMarket = vi.hoisted(() => vi.fn());
// Typed parameters, so the assertions on what was FILED read the call through
// the real argument shape rather than through an empty tuple.
const recordRefusal = vi.hoisted(() => vi.fn(
  async (_plan: { readonly toolId: string }, _failureCode: string, _reason: string) => 1,
));
const evmClients = vi.hoisted(() => vi.fn());
const publicClient = vi.hoisted(() => vi.fn());
const selectedAddress = vi.hoisted(() => vi.fn());
const signingWallet = vi.hoisted(() => vi.fn());

// Only the four engine entry points the handler calls are replaced; the
// disclosure projection reads `formatWad` and the health-factor floor from this
// same module and must keep the REAL ones, or the numbers under assertion would
// be the fixture's own.
vi.mock("@tools/morpho/mutations.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tools/morpho/mutations.js")>(),
  previewMorphoMarketOperation: preview,
  readMorphoBlueMarket: readMarket,
  resolveMorphoBorrowIntent: resolveIntent,
  morphoActionsExtension: () => (client: unknown) => client,
}));

vi.mock("@tools/morpho/evm-client.js", () => ({
  getMorphoEvmClients: evmClients,
  getMorphoPublicClient: publicClient,
}));

// The wallet RESOLUTION has its own suite and its own failure taxonomy.
// Stubbing it keeps these assertions on the handler contract rather than on a
// fixture of the session's wallet inventory.
vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: selectedAddress,
  resolveSigningWallet: signingWallet,
  walletScopeErrorToResult: (err: unknown) => ({
    success: false,
    output: err instanceof Error ? err.message : "wallet scope error",
  }),
}));

vi.mock(
  "../../../../../vex-agent/tools/protocols/morpho/handlers/signed-broadcast.js",
  () => ({
    executeMorphoMarketOperation: executeMarket,
    recordMorphoBorrowRefusal: recordRefusal,
  }),
);

const {
  morphoMarketBorrow,
  morphoMarketRepay,
  morphoMarketSupply,
  morphoMarketSupplyCollateral,
  morphoMarketWithdraw,
  morphoMarketWithdrawCollateral,
} = await import("../../../../../vex-agent/tools/protocols/morpho/handlers/market-execute.js");

function context(overrides: Partial<ProtocolExecutionContext> = {}): ProtocolExecutionContext {
  return {
    sessionPermission: "full",
    approved: true,
    sessionId: "session-1",
    walletResolution: { source: "default" },
    walletPolicy: { kind: "none" },
    ...overrides,
  };
}

function payload(result: ToolResult): Record<string, unknown> {
  return definedValue(result.data, "tool result data");
}

function section(data: Record<string, unknown>, key: string): Record<string, unknown> {
  return mutableRecord(data[key], key);
}

function borrowParams(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { marketId: MARKET_ID, chain: "base", borrowAmountRaw: LOAN_AMOUNT_RAW, ...overrides };
}

function supplyParams(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { marketId: MARKET_ID, chain: "base", supplyCollateralAmountRaw: COLLATERAL_AMOUNT_RAW, ...overrides };
}

function repayParams(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { marketId: MARKET_ID, chain: "base", repayAmountRaw: LOAN_AMOUNT_RAW, ...overrides };
}

/** A confirmed borrow, in the shape the execution spine returns. */
function confirmedBorrow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "confirmed",
    executionId: 41,
    txHash: "0xborrowed",
    executed: {
      amountInRaw: null,
      amountInHuman: null,
      amountOutRaw: LOAN_AMOUNT_RAW,
      // A whole number of tokens: the ledger's amount grammar needs the dotted
      // form, and the handler is what has to add it.
      amountOutHuman: "500",
    },
    tokens: { outSymbol: "USDC", outAddress: USDC, outDecimals: 6 },
    shares: null,
    message: "morpho.market.borrow: Borrowed 500 USDC. Tx: 0xborrowed.",
    ...overrides,
  };
}

beforeEach(() => {
  preview.mockReset();
  readMarket.mockReset();
  resolveIntent.mockReset();
  executeMarket.mockReset();
  recordRefusal.mockClear();
  evmClients.mockReset();
  publicClient.mockReset();
  selectedAddress.mockReset();
  signingWallet.mockReset();

  selectedAddress.mockReturnValue(WALLET);
  signingWallet.mockReturnValue({ family: "eip155", address: WALLET, privateKey: PRIVATE_KEY });
  publicClient.mockReturnValue({ extend: () => ({}) });
  evmClients.mockReturnValue({ publicClient: { extend: () => ({}) }, walletClient: {} });
  readMarket.mockResolvedValue(marketState());
  resolveIntent.mockResolvedValue(marketIntent("borrow"));
  preview.mockResolvedValue(marketPreview("borrow"));
});

// ── Input contract ────────────────────────────────────────────────────────

describe("an execute refuses rather than substitutes", () => {
  it("refuses ANOTHER operation's amount key by name, naming both tokens", async () => {
    const result = await morphoMarketBorrow(
      { marketId: MARKET_ID, chain: "base", supplyCollateralAmountRaw: COLLATERAL_AMOUNT_RAW },
      context(),
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("supplyCollateralAmountRaw");
    expect(result.output).toContain("different tokens");
    expect(executeMarket).not.toHaveBeenCalled();
    expect(preview).not.toHaveBeenCalled();
  });

  it("refuses a caller-supplied walletAddress, because an execute signs with the session's wallet", async () => {
    const result = await morphoMarketBorrow(borrowParams({ walletAddress: WALLET }), context());

    expect(result.success).toBe(false);
    expect(result.output).toContain("walletAddress");
    expect(result.output).toContain("session's selected wallet");
    expect(executeMarket).not.toHaveBeenCalled();
  });

  it("refuses a call with no session, because every attempt is recorded against one", async () => {
    const result = await morphoMarketBorrow(borrowParams(), context({ sessionId: undefined }));

    expect(result.success).toBe(false);
    expect(result.output).toContain("session");
    expect(executeMarket).not.toHaveBeenCalled();
    expect(preview).not.toHaveBeenCalled();
  });
});

// ── dryRun ────────────────────────────────────────────────────────────────

describe("dryRun previews the whole operation and signs nothing", () => {
  it("returns the disclosure the approval prompt needs: oracle, health factor and liquidity", async () => {
    const result = await morphoMarketBorrow(borrowParams({ dryRun: true }), context());

    expect(result.success).toBe(true);
    const data = payload(result);
    expect(data["dryRun"]).toBe(true);
    expect(data["direction"]).toBe("borrow");
    const market = section(data, "market");
    expect(market["marketId"]).toBe(MARKET_ID);
    expect(section(market, "oracle")["vouching"]).toBe("verified-oracle-legs");
    const health = section(market, "healthFactor");
    expect(health["before"]).toBe("1.72");
    expect(health["after"]).toBe("1.31");
    expect(health["floor"]).toBe("1.25");
    expect(section(market, "liquidity")["availableHuman"]).toBe("12000");
  });

  it("resolves no signing wallet, builds no signing client and reaches no execution path", async () => {
    await morphoMarketBorrow(borrowParams({ dryRun: true }), context());

    expect(signingWallet).not.toHaveBeenCalled();
    expect(evmClients).not.toHaveBeenCalled();
    expect(executeMarket).not.toHaveBeenCalled();
    expect(recordRefusal).not.toHaveBeenCalled();
  });

  it("carries the ONE leg the operation moves and never invents the other side", async () => {
    const result = await morphoMarketBorrow(borrowParams({ dryRun: true }), context());

    const data = payload(result);
    expect(data["tokenOut"]).toBe("USDC");
    expect(data["amountOut"]).toBe("500.0");
    expect(data["tokenIn"]).toBeUndefined();
    expect(data["amountIn"]).toBeUndefined();
    expect(String(section(data, "notes")["oneLeg"])).toContain("never both");
  });

  it("states the leg a collateral supply moves, in the COLLATERAL token's own scale", async () => {
    preview.mockResolvedValue(marketPreview("supply_collateral"));

    const result = await morphoMarketSupplyCollateral(supplyParams({ dryRun: true }), context());

    const data = payload(result);
    // 100000000 raw at 8 decimals is 1 cbBTC, not 100 USDC.
    expect(data["tokenIn"]).toBe("cbBTC");
    expect(data["amountIn"]).toBe("1.0");
    expect(data["tokenOut"]).toBeUndefined();
  });

  it("states the TWO-transaction consent on a pulling operation and the single one otherwise", async () => {
    preview.mockResolvedValue(marketPreview("supply_collateral"));
    const supply = await morphoMarketSupplyCollateral(supplyParams({ dryRun: true }), context());
    preview.mockResolvedValue(marketPreview("withdraw_collateral"));
    const withdraw = await morphoMarketWithdrawCollateral(
      { marketId: MARKET_ID, chain: "base", withdrawCollateralAmountRaw: COLLATERAL_AMOUNT_RAW, dryRun: true },
      context(),
    );

    expect(String(payload(supply)["plan"])).toContain("TWO transactions");
    expect(String(payload(withdraw)["plan"])).toContain("ONE transaction");
  });

  it("renders the allowance plan a pulling operation faces, and NO plan for one that pulls nothing", async () => {
    preview.mockResolvedValue(marketPreview("repay"));
    const repay = await morphoMarketRepay(repayParams({ dryRun: true }), context());
    preview.mockResolvedValue(marketPreview("borrow"));
    const borrow = await morphoMarketBorrow(borrowParams({ dryRun: true }), context());

    const allowance = section(payload(repay), "allowancePlan");
    expect(allowance["shape"]).toBe("approve");
    expect(allowance["requiredAmountRaw"]).toBe(LOAN_AMOUNT_RAW);
    expect(allowance["currentAllowanceRaw"]).toBe("0");
    expect(allowance["steps"]).toEqual([{ kind: "approve", amountRaw: LOAN_AMOUNT_RAW }]);
    expect(payload(borrow)["allowancePlan"]).toBeNull();
  });

  it("distinguishes a SHARES repayment from an assets one, since only one can close the debt", async () => {
    preview.mockResolvedValue(fullDebtRepayPreview());
    const full = await morphoMarketRepay(repayParams({ repayAmountRaw: undefined, repayFullDebt: true, dryRun: true }), context());
    preview.mockResolvedValue(marketPreview("repay"));
    const partial = await morphoMarketRepay(repayParams({ dryRun: true }), context());

    expect(String(section(payload(full), "notes")["repayMode"])).toContain("borrow SHARES");
    expect(String(section(payload(partial), "notes")["repayMode"])).toContain("LEAVES THE POSITION OPEN");
  });

  it("carries no repayMode note on an operation that is not a repayment", async () => {
    const result = await morphoMarketBorrow(borrowParams({ dryRun: true }), context());

    expect(section(payload(result), "notes")["repayMode"]).toBeUndefined();
  });

  it("states plainly that NOTHING was signed, sent, approved or recorded", async () => {
    const result = await morphoMarketBorrow(borrowParams({ dryRun: true }), context());

    expect(String(section(payload(result), "notes")["committed"])).toContain(
      "NOTHING WAS SIGNED, SENT, APPROVED OR RECORDED AS EXECUTED",
    );
  });

  it("prices against the session's selected wallet and says the projection is that wallet's", async () => {
    const result = await morphoMarketBorrow(borrowParams({ dryRun: true }), context());

    // Checksummed on the way down, which is the form the engine's `Address`
    // contract expects; the account itself is the session's selected one.
    const passed = String(preview.mock.calls[0]?.[1].walletAddress);
    expect(passed).not.toBe(WALLET);
    expect(passed.toLowerCase()).toBe(WALLET);
    expect(String(section(payload(result), "notes")["wallet"])).toContain("session's selected wallet");
  });

  it("degrades to a STAND-IN when no wallet is selected, and refuses to imply the projection is anybody's", async () => {
    selectedAddress.mockImplementation(() => { throw new Error("no eip155 wallet in this session"); });
    preview.mockResolvedValue(marketPreview("borrow", { walletAddressWasSupplied: false }));

    const result = await morphoMarketBorrow(borrowParams({ dryRun: true }), context());

    expect(result.success).toBe(true);
    expect(preview.mock.calls[0]?.[1].walletAddress).toBeUndefined();
    const wallet = String(section(payload(result), "notes")["wallet"]);
    expect(wallet).toContain("NO POSITION");
    expect(wallet).toContain("stand-in");
  });

  it("names the REAL cause when the preview cannot be built, and signs nothing on the way out", async () => {
    preview.mockRejectedValue(new Error("the market's oracle was minted by no vouched factory"));

    const result = await morphoMarketBorrow(borrowParams({ dryRun: true }), context());

    expect(result.success).toBe(false);
    expect(result.output).toContain("minted by no vouched factory");
    expect(result.output).toContain("Nothing was signed or sent");
    expect(result.output).not.toContain("unexpected error");
    expect(recordRefusal).not.toHaveBeenCalled();
    expect(executeMarket).not.toHaveBeenCalled();
  });
});

// ── Outcome rendering ─────────────────────────────────────────────────────

describe("all four execution endings are reported as themselves", () => {
  it("reports a confirmed borrow with the PROVEN amount, in the dotted form the ledger reads", async () => {
    executeMarket.mockResolvedValue(confirmedBorrow());

    const result = await morphoMarketBorrow(borrowParams(), context());

    expect(result.success).toBe(true);
    const data = payload(result);
    expect(data["status"]).toBe("confirmed");
    expect(data["txHash"]).toBe("0xborrowed");
    expect(data["tokenOut"]).toBe("USDC");
    expect(data["amountOut"]).toBe("500.0");
    expect(data["tokenSymbol"]).toBe("USDC");
    expect(data["tokenDecimals"]).toBe(6);
    expect(data["summary"]).toBe("morpho.market.borrow: Borrowed 500 USDC. Tx: 0xborrowed.");
    expect(String(section(data, "notes")["proven"])).toContain("PROVEN from the receipt's own Morpho Blue event");
  });

  it("takes the settled amount from the side the wallet actually received or sent", async () => {
    resolveIntent.mockResolvedValue(marketIntent("supply_collateral"));
    executeMarket.mockResolvedValue({
      ...confirmedBorrow(),
      executed: { amountInRaw: COLLATERAL_AMOUNT_RAW, amountInHuman: "1", amountOutRaw: null, amountOutHuman: null },
    });

    const result = await morphoMarketSupplyCollateral(supplyParams(), context());

    const data = payload(result);
    // The wallet SENDS on a collateral supply, so the proven amount is the `in`
    // side; reading the `out` one would report a null as the settled amount.
    expect(data["tokenIn"]).toBe("cbBTC");
    expect(data["amountIn"]).toBe("1.0");
    expect(data["tokenOut"]).toBeUndefined();
  });

  it("keeps the SHARES note on a confirmed full-debt repayment, which is the only closing shape", async () => {
    resolveIntent.mockResolvedValue(
      marketIntent("repay", { amountRaw: null, sharesRaw: 500_000_000_000_000n, repayMode: "shares" }),
    );
    executeMarket.mockResolvedValue({
      ...confirmedBorrow(),
      executed: { amountInRaw: "500000001", amountInHuman: "500.000001", amountOutRaw: null, amountOutHuman: null },
      message: "morpho.market.repay: Repaid the whole debt.",
    });

    const result = await morphoMarketRepay(repayParams({ repayAmountRaw: undefined, repayFullDebt: true }), context());

    expect(String(section(payload(result), "notes")["repayMode"])).toContain("borrow SHARES");
    expect(payload(result)["amountIn"]).toBe("500.000001");
  });

  it("reports a refusal as a failure in the execution layer's own words, with no transaction hash", async () => {
    executeMarket.mockResolvedValue({
      kind: "refused",
      executionId: 42,
      role: "lend_borrow_operate",
      message: "The node refused the approval: insufficient balance for gas. Top up the wallet.",
    });

    const result = await morphoMarketBorrow(borrowParams(), context());

    expect(result.success).toBe(false);
    expect(result.output).toContain("insufficient balance for gas");
    const data = payload(result);
    expect(data["status"]).toBe("refused");
    expect(data["role"]).toBe("lend_borrow_operate");
    expect(data["txHash"]).toBeUndefined();
  });

  it("reports a revert WITH its transaction hash, because that gas was really spent", async () => {
    executeMarket.mockResolvedValue({
      kind: "reverted",
      executionId: 43,
      role: "lend_borrow_operate",
      txHash: "0xreverted",
      message: "The borrow mined and reverted; the collateral never moved.",
    });

    const result = await morphoMarketBorrow(borrowParams(), context());

    expect(result.success).toBe(false);
    const data = payload(result);
    expect(data["status"]).toBe("reverted");
    expect(data["txHash"]).toBe("0xreverted");
  });

  it("reports an UNPROVEN broadcast as neither success nor plain failure, carrying its do-not-retry", async () => {
    executeMarket.mockResolvedValue({
      kind: "unproven",
      executionId: 44,
      role: "lend_borrow_operate",
      reason: "ambiguous",
      txHash: "0xmaybe",
      message:
        "Cannot prove whether this borrow landed. Do not retry: it may already have moved real funds. The attempt is "
        + "recorded as pending and resolves automatically.",
    });

    const result = await morphoMarketBorrow(borrowParams(), context());

    expect(result.success).toBe(false);
    expect(result.output).toContain("Do not retry");
    const data = payload(result);
    expect(data["status"]).toBe("unproven");
    expect(data["reason"]).toBe("ambiguous");
    expect(data["txHash"]).toBe("0xmaybe");
  });

  it("identifies the operation the same way on every ending, so a failed row is as findable as a confirmed one", async () => {
    const endings = [
      confirmedBorrow(),
      { kind: "refused", executionId: 41, role: "lend_borrow_operate", message: "refused" },
      { kind: "reverted", executionId: 41, role: "lend_borrow_operate", txHash: "0xr", message: "reverted" },
      { kind: "unproven", executionId: 41, role: "lend_borrow_operate", reason: "undecodable", txHash: "0xu", message: "unproven" },
    ];

    for (const ending of endings) {
      executeMarket.mockResolvedValue(ending);
      const data = payload(await morphoMarketBorrow(borrowParams(), context()));
      expect(data["toolId"], String(ending.kind)).toBe("morpho.market.borrow");
      expect(data["operation"], String(ending.kind)).toBe("borrow");
      expect(data["marketId"], String(ending.kind)).toBe(MARKET_ID);
      expect(data["chain"], String(ending.kind)).toBe("base");
      expect(data["executionId"], String(ending.kind)).toBe(41);
      // The runtime's adoption key. Without it `captureExecution` records a
      // SECOND protocol_executions row and this lane's intent row is stranded
      // at execution_status 'intent' - unresolved money state for the
      // compaction gate. Measured on every Morpho execution, 2026-08-17.
      expect(data["_executionId"], String(ending.kind)).toBe(41);
      expect(String(data["plan"]), String(ending.kind)).toContain("ONE transaction");
    }
  });
});

// ── Refusals before anything is signed ────────────────────────────────────

describe("a refusal before signing says so, and files nothing it cannot prove", () => {
  it("reports a market-gate refusal without a row, because no operation was ever resolved", async () => {
    readMarket.mockRejectedValue(new Error("this market's IRM is not the chain's pinned AdaptiveCurveIRM"));

    const result = await morphoMarketBorrow(borrowParams(), context());

    expect(result.success).toBe(false);
    expect(result.output).toContain("pinned AdaptiveCurveIRM");
    expect(result.output).toContain("no gas was spent");
    expect(executeMarket).not.toHaveBeenCalled();
    expect(recordRefusal).not.toHaveBeenCalled();
  });

  it("RECORDS a plan-time refusal, with its real cause rather than a generic error", async () => {
    executeMarket.mockRejectedValue(new Error("the built transaction does not survive Vex's own decode"));

    const result = await morphoMarketBorrow(borrowParams(), context());

    expect(result.success).toBe(false);
    expect(result.output).toContain("does not survive Vex's own decode");
    expect(result.output).toContain("No transaction was sent");
    expect(result.output).not.toContain("unexpected error");
    expect(recordRefusal).toHaveBeenCalledTimes(1);
    expect(recordRefusal.mock.calls[0]?.[0].toolId).toBe("morpho.market.borrow");
    expect(recordRefusal.mock.calls[0]?.[1]).toBe("unknown");
  });

  it("refuses a non-EVM signing wallet by name instead of trying to sign with it", async () => {
    signingWallet.mockReturnValue({ family: "solana", address: "So111", privateKey: PRIVATE_KEY });

    const result = await morphoMarketBorrow(borrowParams(), context());

    expect(result.success).toBe(false);
    expect(result.output).toContain("EVM wallet");
    expect(result.output).toContain("solana");
    expect(executeMarket).not.toHaveBeenCalled();
  });

  it("resolves the chain id from Vex's own registry and the key from the session, never from model input", async () => {
    executeMarket.mockResolvedValue(confirmedBorrow());

    await morphoMarketBorrow(borrowParams(), context());

    expect(evmClients).toHaveBeenCalledWith(8453, PRIVATE_KEY);
    expect(publicClient).not.toHaveBeenCalled();
  });
});

// The LENDER-side cases, handed this file's mock surface. See the header.
registerMarketLenderCases({
  morphoMarketSupply, morphoMarketSupplyCollateral, morphoMarketWithdraw, context,
  payload, section, preview, resolveIntent, executeMarket, signingWallet,
  marketPreview, marketIntent,
  constants: { MARKET_ID, LOAN_AMOUNT_RAW, COLLATERAL_AMOUNT_RAW, USDC, WALLET },
});
