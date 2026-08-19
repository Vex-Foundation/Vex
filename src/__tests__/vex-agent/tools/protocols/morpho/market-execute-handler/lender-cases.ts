/**
 * The LENDER-side handler cases for `../market-execute-handler.test.ts`.
 *
 * They live here rather than in that file for the reason `../signed-broadcast/`
 * splits the same way: module mocking is per-test-file and must stay there,
 * while the CASES are a separate responsibility that can be named and moved.
 * The test file owns the mock surface and hands it in.
 */

import { describe, expect, it } from "vitest";

import type { MorphoBorrowOperation } from "@tools/morpho/mutations.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import type { ToolResult } from "@vex-agent/tools/types.js";

export interface MarketLenderCaseDeps {
  readonly morphoMarketSupply: MarketExecuteHandler;
  readonly morphoMarketSupplyCollateral: MarketExecuteHandler;
  readonly morphoMarketWithdraw: MarketExecuteHandler;
  readonly context: () => ProtocolExecutionContext;
  readonly payload: (result: ToolResult) => Record<string, unknown>;
  readonly section: (data: Record<string, unknown>, key: string) => Record<string, unknown>;
  readonly preview: { mockResolvedValue: (value: unknown) => void };
  readonly resolveIntent: { mockResolvedValue: (value: unknown) => void };
  readonly executeMarket: { mockResolvedValue: (value: unknown) => void };
  readonly signingWallet: unknown;
  readonly marketPreview: (operation: MorphoBorrowOperation) => Record<string, unknown>;
  readonly marketIntent: (operation: MorphoBorrowOperation) => Record<string, unknown>;
  readonly constants: {
    readonly MARKET_ID: string;
    readonly LOAN_AMOUNT_RAW: string;
    readonly COLLATERAL_AMOUNT_RAW: string;
    readonly USDC: string;
    readonly WALLET: string;
  };
}

type MarketExecuteHandler = (
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
) => Promise<ToolResult>;

export function registerMarketLenderCases(deps: MarketLenderCaseDeps): void {
  const {
    morphoMarketSupply,
    morphoMarketSupplyCollateral,
    morphoMarketWithdraw,
    context,
    payload,
    section,
    preview,
    resolveIntent,
    executeMarket,
    signingWallet,
    marketPreview,
    marketIntent,
  } = deps;
  const { MARKET_ID, LOAN_AMOUNT_RAW, COLLATERAL_AMOUNT_RAW, USDC, WALLET } = deps.constants;

  /** The lender's own param builders. Their amount keys are the loan token's. */
  const lendParams = (overrides: Record<string, unknown> = {}): Record<string, unknown> =>
    ({ marketId: MARKET_ID, chain: "base", supplyAmountRaw: LOAN_AMOUNT_RAW, ...overrides });
  const unlendParams = (overrides: Record<string, unknown> = {}): Record<string, unknown> =>
    ({ marketId: MARKET_ID, chain: "base", withdrawAmountRaw: LOAN_AMOUNT_RAW, ...overrides });

  /**
   * THE LENDER'S TWO TOOLS.
   *
   * They share the spine with the borrower's four, so what needs pinning is not
   * the plumbing but the three places where the lender's side is genuinely
   * different and a copied assumption would be a lie to the agent:
   *
   *   1. the token is the LOAN asset, at the loan token's scale, never the
   *      collateral's - a market pairing 8-decimal cbBTC against 6-decimal USDC
   *      makes that a hundredfold error;
   *   2. `supply` PULLS and therefore approves, while `withdraw` pulls nothing and
   *      carries no allowance plan at all;
   *   3. the borrower's amount keys are refused BY NAME, in both directions, since
   *      `supplyAmountRaw` and `supplyCollateralAmountRaw` differ by one word and
   *      name two different tokens.
   */
  describe("the lender's supply and withdraw move the LOAN asset", () => {
    it("refuses the COLLATERAL key on a lender supply, naming both tokens", async () => {
      const result = await morphoMarketSupply(
        { marketId: MARKET_ID, chain: "base", supplyCollateralAmountRaw: COLLATERAL_AMOUNT_RAW },
        context(),
      );
      expect(result.success).toBe(false);
      expect(result.output).toContain("supplyCollateralAmountRaw");
      expect(result.output).toContain("collateral token");
    });

    it("refuses the lender key on a COLLATERAL supply, so the confusion cannot run the other way", async () => {
      const result = await morphoMarketSupplyCollateral(
        { marketId: MARKET_ID, chain: "base", supplyAmountRaw: LOAN_AMOUNT_RAW },
        context(),
      );
      expect(result.success).toBe(false);
      expect(result.output).toContain("supplyAmountRaw");
    });

    it("refuses the collateral withdrawal key on a lender withdrawal", async () => {
      const result = await morphoMarketWithdraw(
        { marketId: MARKET_ID, chain: "base", withdrawCollateralAmountRaw: COLLATERAL_AMOUNT_RAW },
        context(),
      );
      expect(result.success).toBe(false);
      expect(result.output).toContain("withdrawCollateralAmountRaw");
    });

    it("refuses a caller-supplied walletAddress, exactly like every other execute", async () => {
      const result = await morphoMarketSupply(lendParams({ walletAddress: WALLET }), context());
      expect(result.success).toBe(false);
      expect(result.output).toContain("walletAddress");
    });

    it("previews a supply as an INBOUND leg in the loan token's own scale", async () => {
      preview.mockResolvedValue(marketPreview("supply"));
      const result = await morphoMarketSupply(lendParams({ dryRun: true }), context());
      const data = payload(result);
      expect(data.direction).toBe("supply");
      // The wallet SENDS, so the leg is `tokenIn`, and the human amount is
      // rendered at the LOAN token's six decimals rather than the collateral's
      // eight. At eight the same raw amount would read as 5, not 500.
      expect(data.tokenOut).toBeUndefined();
      expect(data.tokenIn).toBe("USDC");
      expect(data.amountIn).toBe("500.0");
    });

    it("previews a withdrawal as an OUTBOUND leg with NO allowance plan at all", async () => {
      preview.mockResolvedValue(marketPreview("withdraw"));
      const result = await morphoMarketWithdraw(unlendParams({ dryRun: true }), context());
      const data = payload(result);
      expect(data.direction).toBe("withdraw");
      expect(data.tokenOut).toBeDefined();
      expect(data.tokenIn).toBeUndefined();
      // It only RECEIVES, so a standing allowance would be spending authority
      // nobody in this flow consumes.
      expect(data.allowancePlan).toBeNull();
    });

    it("plans an exact-amount approval for the supply, which does pull", async () => {
      preview.mockResolvedValue(marketPreview("supply"));
      const result = await morphoMarketSupply(lendParams({ dryRun: true }), context());
      const plan = section(payload(result), "allowancePlan");
      expect(plan.requiredAmountRaw).toBe(LOAN_AMOUNT_RAW);
    });

    it("signs nothing on a dryRun and resolves no signing wallet", async () => {
      preview.mockResolvedValue(marketPreview("supply"));
      await morphoMarketSupply(lendParams({ dryRun: true }), context());
      expect(signingWallet).not.toHaveBeenCalled();
      expect(executeMarket).not.toHaveBeenCalled();
    });

    it("reports a confirmed supply with the amount PROVEN from the receipt", async () => {
      resolveIntent.mockResolvedValue(marketIntent("supply"));
      executeMarket.mockResolvedValue({
        kind: "confirmed",
        executionId: 71,
        txHash: "0xlent",
        executed: {
          amountInRaw: LOAN_AMOUNT_RAW,
          amountInHuman: "500",
          amountOutRaw: null,
          amountOutHuman: null,
        },
        tokens: { inSymbol: "USDC", inAddress: USDC, inDecimals: 6 },
        shares: null,
        message: "morpho.market.supply: Supplied 500 USDC. Tx: 0xlent.",
      });
      const result = await morphoMarketSupply(lendParams(), context());
      const data = payload(result);
      expect(result.success).toBe(true);
      expect(data.status).toBe("confirmed");
      expect(data.toolId).toBe("morpho.market.supply");
      expect(data.operation).toBe("supply");
      expect(data.tokenSymbol).toBe("USDC");
    });

    it("carries no repayMode note, because a lender has no debt to close", async () => {
      preview.mockResolvedValue(marketPreview("supply"));
      const result = await morphoMarketSupply(lendParams({ dryRun: true }), context());
      expect(section(payload(result), "notes").repayMode).toBeUndefined();
    });
  });
}
