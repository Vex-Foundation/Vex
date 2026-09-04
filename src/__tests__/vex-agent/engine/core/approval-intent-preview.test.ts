/**
 * Approval intent preview + policy snapshot builders — pure-function tests.
 *
 * Puzzle 5 phase 2 (2026-05-23). Pins the renderer-safe projection:
 * allow-listed keys only, coerced scalars, no nested blobs / bigints / leaks.
 */

import { describe, it, expect } from "vitest";
import type { InternalToolContext } from "@vex-agent/tools/internal/types.js";
import { makeTestContext } from "../../tools/_test-context.js";
import {
  buildIntentPreview,
  buildPolicySnapshot,
  sanitizeRequestingClientName,
  REQUESTING_CLIENT_NAME_MAX,
} from "@vex-agent/engine/core/approval-intent-preview.js";

/**
 * The Vex fee statement a matched quote made, as the prequote gate hands it to
 * the card. It is HOST-SIDE data: it never comes from `args`, which is the
 * whole reason a spoofed `feeBps` cannot move the line below.
 */
function boundVexFee(
  overrides: Record<string, unknown> = {},
): NonNullable<Parameters<typeof buildIntentPreview>[2]>["vexFee"] {
  return {
    v: "vex-fee-v1",
    charged: true,
    bps: 25,
    chargedOn: "currency_in",
    tokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    tokenSymbol: "USDC",
    tokenDecimals: 6,
    feeAmountRaw: "2500",
    feeAmountDecimal: "0.0025",
    receiver: "0xTREASURY",
    totalDebitedRaw: "1000000",
    netAmountRaw: "997500",
    collection: "separate_transfer_after_success",
    ...overrides,
  } as NonNullable<Parameters<typeof buildIntentPreview>[2]>["vexFee"];
}

describe("buildIntentPreview", () => {
  it("returns toolName + allow-listed criticalArgs for a wallet transfer call", () => {
    const preview = buildIntentPreview("WalletSendPrepare", {
      network: "eip155",
      chain: "base",
      to: "0xabcdef1234567890",
      amount: "1.5",
      token: "USDC",
    });
    expect(preview.toolName).toBe("WalletSendPrepare");
    expect(preview.namespace).toBeUndefined(); // internal tool, no dot
    expect(preview.criticalArgs).toEqual({
      network: "eip155",
      chain: "base",
      to: "0xabcdef1234567890",
      amount: "1.5",
      token: "USDC",
    });
  });

  it("derives namespace from dotted protocol tool names", () => {
    const preview = buildIntentPreview("kyberswap.swap.execute", {
      chain: "ethereum",
      tokenIn: "USDC",
      tokenOut: "ETH",
      amountIn: "100",
    });
    expect(preview.namespace).toBe("kyberswap");
    expect(preview.criticalArgs.tokenIn).toBe("USDC");
  });

  it("itemises the Vex fee on an EVM swap card, from the matched quote not the model", () => {
    const preview = buildIntentPreview(
      "kyberswap.swap.execute",
      {
        chain: "base",
        tokenIn: "ETH",
        tokenOut: "0xdeadbeef",
        amountIn: "1.5",
        feeBps: 9999,
        feeReceiver: "0xattacker",
      },
      { vexFee: boundVexFee({ collection: "inside_route" }) },
    );
    expect(preview.criticalArgs.vexFee).toContain("0.25% (25 bps)");
    // The exact figures the quote committed to, with what is needed to read them.
    expect(preview.criticalArgs.vexFee).toContain("0.0025 USDC | 2500 raw units | 6 decimals");
    expect(preview.criticalArgs.vexFee).toContain("997500 raw units are swapped");
    expect(preview.criticalArgs.vexFee).toContain("paid to 0xTREASURY");
    // The spoof attempt reaches neither the fee line nor any other arg.
    expect(preview.criticalArgs.vexFee).not.toContain("9999");
    expect(preview.criticalArgs.vexFee).not.toContain("0xattacker");
    expect(preview.criticalArgs).not.toHaveProperty("feeBps");
    expect(preview.criticalArgs).not.toHaveProperty("feeReceiver");
  });

  it("states NO fee line for a fee-bearing venue when the channel carries nothing", () => {
    // The args-derived line is gone for these ids: a card that recomputed the
    // fee from `amountIn` is exactly the second derivation this channel removed.
    // In production the gate refuses such a call outright, so no card is built.
    const preview = buildIntentPreview("kyberswap.swap.execute", {
      chain: "base",
      tokenIn: "ETH",
      tokenOut: "0xdeadbeef",
      amountIn: "1.5",
    });
    expect(preview.criticalArgs).not.toHaveProperty("vexFee");
  });

  it("keeps the generic swap card at its current supplied-args and quote boundary", () => {
    const preview = buildIntentPreview(
      "kyberswap.swap.execute",
      {
        chain: "base",
        tokenIn: "0x1111111111111111111111111111111111111111",
        tokenOut: "0x2222222222222222222222222222222222222222",
        amountIn: "1.5",
      },
      {
        quoteBinding: {
          cardVersion: "kyber-quote-v1",
          snapshotId: "prequote-1",
          digest: "a".repeat(64),
          approvedAmountOutHuman: "2.5",
          approvedMinOutHuman: "2.4",
          approvedMinOutRaw: "2400000",
          tokenOutSymbol: "QUOTE_TIME_SYMBOL",
          effectiveSlippageBps: 400,
          expiresAt: "2026-08-31T12:00:00.000Z",
        },
      },
    );

    expect(preview.criticalArgs).toMatchObject({
      chain: "base",
      tokenIn: "0x1111111111111111111111111111111111111111",
      tokenOut: "0x2222222222222222222222222222222222222222",
      amountIn: "1.5",
    });
    expect(preview.criticalArgs.quoteBinding).toContain("QUOTE_TIME_SYMBOL");
    expect(preview.criticalArgs).not.toHaveProperty("tokenInDecimals");
    expect(preview.criticalArgs).not.toHaveProperty("tokenOutDecimals");
    expect(preview.criticalArgs).not.toHaveProperty("amountInRaw");
  });

  it("projects a bridge's amountRaw AND its fee, the amount being signed", () => {
    const preview = buildIntentPreview(
      "relay.bridge",
      {
        fromChain: "base",
        toChain: "arbitrum",
        fromToken: "0xUSDC",
        toToken: "0xUSDC",
        amountRaw: "1000000",
      },
      { vexFee: boundVexFee() },
    );
    expect(preview.criticalArgs.amountRaw).toBe("1000000");
    expect(preview.criticalArgs.vexFee).toContain("2500 raw units");
    expect(preview.criticalArgs.vexFee).toContain("997500 raw units are bridged");
  });

  /**
   * THE DEFECT THIS PINS (live test pass 2, I-2): a real approval card for a
   * 1 USDC bridge raised over MCP carried no fee line at all. The MCP surface
   * exports the ACTION ALIAS `BridgeExecute`, admission never rewrites the call
   * name, and the alias router resolves the venue later and asynchronously, so
   * the dotted venue id the fee table was keyed on never reached it. A human
   * was asked to approve a transfer whose 25 bps Vex fee was itemised nowhere.
   *
   * Revert the alias cases in `approval-vex-fee.ts` and these go red.
   */
  it.each([
    ["BridgeExecute", "the alias the MCP surface actually exports"],
    ["BridgeExecuteRelay", "the venue-pinned alias"],
    ["relay.bridge", "the resolved venue id"],
    ["khalani.bridge", "the other resolved venue id"],
  ])("itemises the bridge fee for %s (%s)", (toolName) => {
    const preview = buildIntentPreview(
      toolName,
      {
        fromChain: "8453",
        toChain: "42161",
        fromToken: "0xUSDC",
        toToken: "0xUSDC",
        amountRaw: "1000000",
      },
      { vexFee: boundVexFee() },
    );
    expect(preview.criticalArgs.vexFee).toContain("0.25% (25 bps)");
    expect(preview.criticalArgs.vexFee).toContain("2500 raw units");
    expect(preview.criticalArgs.vexFee).toContain("after the bridge confirms");
  });

  it("itemises the Uniswap fee under the alias name too", () => {
    const preview = buildIntentPreview(
      "SwapExecuteUniswap",
      { chain: "base", tokenIn: "ETH", tokenOut: "0xUSDC", amountIn: "2" },
      { vexFee: boundVexFee() },
    );
    expect(preview.criticalArgs.vexFee).toContain("after the swap confirms");
  });

  /**
   * THE SECOND HALF OF THE SAME DEFECT (I-2). `SwapExecute` is the name the MCP
   * surface exports for an EVM swap, and its card carried NO fee line at all,
   * on the stated ground that the venue was not yet decided. It IS decided -
   * `routeSwap` resolves it synchronously before the gate runs - and the typed
   * channel is name-independent, so the resolved venue's own statement reaches
   * the alias card unchanged.
   */
  it("itemises the fee for SwapExecute, the alias whose card carried none", () => {
    const preview = buildIntentPreview(
      "SwapExecute",
      { chain: "base", tokenIn: "ETH", tokenOut: "0xUSDC", amountIn: "2" },
      { vexFee: boundVexFee({ collection: "inside_route" }) },
    );
    expect(preview.criticalArgs.vexFee).toContain("0.25% (25 bps)");
    expect(preview.criticalArgs.vexFee).toContain("inside this transaction");
    expect(preview.criticalArgs.vexFee).toContain("997500 raw units are swapped");
  });

  it("states a fee that is NOT taken, which the args-derived line could not express", () => {
    const preview = buildIntentPreview(
      "BridgeExecute",
      { fromToken: "0xUSDC", amountRaw: "1000000" },
      {
        vexFee: {
          v: "vex-fee-v1",
          charged: false,
          bps: 0,
          reason: "the origin token is flagged as a honeypot, so Vex does not transfer it",
          totalDebitedRaw: "1000000",
          netAmountRaw: "1000000",
          collection: "separate_transfer_after_success",
        },
      },
    );
    expect(preview.criticalArgs.vexFee).toContain("Vex fee: none on this bridge");
    expect(preview.criticalArgs.vexFee).toContain("honeypot");
    expect(preview.criticalArgs.vexFee).toContain("the full 1000000 raw units are bridged");
  });

  /**
   * Rule 90 and the owner decree: no em dash in copy a human reads. The fee
   * line is human-facing card copy, and the measured card carried one.
   */
  it("puts no em dash in the fee line a human reads", () => {
    const bridge = buildIntentPreview(
      "BridgeExecute",
      { fromToken: "0xUSDC", amountRaw: "1000000" },
      { vexFee: boundVexFee() },
    );
    const swap = buildIntentPreview(
      "kyberswap.swap.execute",
      { tokenIn: "ETH", amountIn: "1.5" },
      { vexFee: boundVexFee({ collection: "inside_route" }) },
    );
    for (const line of [bridge.criticalArgs.vexFee, swap.criticalArgs.vexFee]) {
      expect(typeof line).toBe("string");
      expect(line).not.toContain(String.fromCharCode(0x2014));
    }
  });

  it("carries NO vexFee key for a tool that has no Vex fee (tolerant reader)", () => {
    const preview = buildIntentPreview("pendle.pt.buy", { chain: "base", amountIn: "1.5" });
    expect(preview.criticalArgs).not.toHaveProperty("vexFee");
  });

  it("unwraps an injected/execute_tool wrapper before rendering the fee", () => {
    const preview = buildIntentPreview(
      "execute_tool",
      { toolId: "uniswap.swap.execute", params: { tokenIn: "ETH", amountIn: "2" } },
      { vexFee: boundVexFee() },
    );
    expect(preview.toolName).toBe("uniswap.swap.execute");
    // The unwrapped TARGET id decides the noun, not the meta-tool name.
    expect(preview.criticalArgs.vexFee).toContain("after the swap confirms");
  });

  it("drops keys outside the allowlist (defense-in-depth against leak)", () => {
    const preview = buildIntentPreview("WalletSendPrepare", {
      to: "0xabc",
      amount: "1.0",
      secretField: "DO-NOT-LEAK",
      apiKey: "sk-test-xxx",
      privateKey: "0xdeadbeef",
    });
    expect(preview.criticalArgs).toEqual({
      to: "0xabc",
      amount: "1.0",
    });
    expect(preview.criticalArgs).not.toHaveProperty("secretField");
    expect(preview.criticalArgs).not.toHaveProperty("apiKey");
    expect(preview.criticalArgs).not.toHaveProperty("privateKey");
  });

  it("coerces bigint to string (JSON.stringify(bigint) throws otherwise)", () => {
    const preview = buildIntentPreview("kyberswap.swap.execute", {
      amount: 1234567890123456789n,
    });
    expect(preview.criticalArgs.amount).toBe("1234567890123456789");
  });

  it("truncates strings longer than 200 chars with ellipsis", () => {
    const longTo = "0x" + "a".repeat(300);
    const preview = buildIntentPreview("WalletSendPrepare", { to: longTo });
    const truncated = preview.criticalArgs.to as string;
    expect(truncated).toHaveLength(201); // 200 + ellipsis
    expect(truncated.endsWith("…")).toBe(true);
  });

  it("coerces nested objects to null (preview never embeds nested)", () => {
    const preview = buildIntentPreview("test_tool", {
      to: { nested: "should-not-leak" },
      amount: ["also", "no"],
      chain: "ethereum",
    });
    expect(preview.criticalArgs.to).toBeNull();
    expect(preview.criticalArgs.amount).toBeNull();
    expect(preview.criticalArgs.chain).toBe("ethereum");
  });

  it("preserves number and boolean scalars as-is", () => {
    const preview = buildIntentPreview("polymarket.clob.buy", {
      amountUsdc: 10,
      side: "yes",
      outcome: true,
    });
    expect(preview.criticalArgs.amountUsdc).toBe(10);
    expect(preview.criticalArgs.side).toBe("yes");
    expect(preview.criticalArgs.outcome).toBe(true);
  });

  it("coerces null and undefined argument values to null", () => {
    const preview = buildIntentPreview("test_tool", {
      to: null,
      amount: undefined,
    });
    expect(preview.criticalArgs.to).toBeNull();
    // undefined keys are still iterated by Object.keys, but coerced to null
    expect(preview.criticalArgs.amount).toBeNull();
  });

  it("returns empty criticalArgs map when no allow-listed key matches", () => {
    const preview = buildIntentPreview("non_allowlisted_tool", {
      topic: "overview", // not in allowlist
    });
    expect(preview.criticalArgs).toEqual({});
  });
});

describe("buildIntentPreview — Stage 7 prequote verdict binding (R5)", () => {
  it("injects criticalArgs.safety='pass' from the typed extras for a gated swap", () => {
    const preview = buildIntentPreview(
      "kyberswap.swap.execute",
      { chain: "base", tokenIn: "0xAAA", tokenOut: "0xBBB", amountIn: "1" },
      { prequoteVerdict: "pass" },
    );
    expect(preview.criticalArgs.safety).toBe("pass");
  });

  it("renders 'unknown' as the UNVERIFIED warning label", () => {
    const preview = buildIntentPreview(
      "solana.swap.execute",
      { inputToken: "SOL", outputToken: "USDC", amount: 1 },
      { prequoteVerdict: "unknown" },
    );
    expect(preview.criticalArgs.safety).toBe("UNVERIFIED - audit unavailable");
  });

  it("omits safety when no extras are passed (non-swap / non-gated path)", () => {
    const preview = buildIntentPreview("WalletSendPrepare", {
      to: "0xabc",
      amount: "1.0",
    });
    expect(preview.criticalArgs).not.toHaveProperty("safety");
  });

  it("raw args CANNOT spoof safety — a 'safety' arg is dropped (not allow-listed)", () => {
    // The LLM passing a `safety` arg must never reach the preview; only the
    // typed extras channel can set it. With no extras, `safety` stays absent.
    const preview = buildIntentPreview(
      "kyberswap.swap.execute",
      { chain: "base", tokenIn: "0xAAA", tokenOut: "0xBBB", amountIn: "1", safety: "pass" },
    );
    expect(preview.criticalArgs).not.toHaveProperty("safety");
  });

  it("a spoofed 'safety' arg is OVERRIDDEN by the typed extras (unknown wins)", () => {
    // Even if the LLM passes safety:'pass', the extras-driven value is what lands
    // (the arg is dropped first; extras inject afterwards).
    const preview = buildIntentPreview(
      "kyberswap.swap.execute",
      { chain: "base", tokenIn: "0xAAA", tokenOut: "0xBBB", amountIn: "1", safety: "pass" },
      { prequoteVerdict: "unknown" },
    );
    expect(preview.criticalArgs.safety).toBe("UNVERIFIED - audit unavailable");
  });
});

describe("buildIntentPreview — Stage 9 fee-on-transfer disclosure (FIX 3)", () => {
  it("appends the FoT tax to the safety label when fotTax is in the typed extras", () => {
    // FoT is now a verdict `pass` (only a confirmed honeypot blocks); the human
    // must still see the tax. It rides the typed extras alongside the verdict.
    const preview = buildIntentPreview(
      "kyberswap.swap.execute",
      { chain: "base", tokenIn: "0xAAA", tokenOut: "0xBBB", amountIn: "1" },
      { prequoteVerdict: "pass", fotTax: 60 },
    );
    expect(preview.criticalArgs.safety).toBe("pass - fee-on-transfer 60%");
  });

  it("a clean pass (no fotTax) renders a plain 'pass' — no FoT suffix", () => {
    const preview = buildIntentPreview(
      "kyberswap.swap.execute",
      { chain: "base", tokenIn: "0xAAA", tokenOut: "0xBBB", amountIn: "1" },
      { prequoteVerdict: "pass" },
    );
    expect(preview.criticalArgs.safety).toBe("pass");
  });

  it("fotTax is NOT spoofable from raw args — only the typed extras channel sets it", () => {
    // A raw `fotTax` arg (and a spoofed `safety` arg) must never reach the
    // preview; with no extras the safety label is absent entirely.
    const preview = buildIntentPreview(
      "kyberswap.swap.execute",
      { chain: "base", tokenIn: "0xAAA", tokenOut: "0xBBB", amountIn: "1", fotTax: 60, safety: "pass - fee-on-transfer 60%" },
    );
    expect(preview.criticalArgs).not.toHaveProperty("safety");
    expect(preview.criticalArgs).not.toHaveProperty("fotTax");
  });

  it("fotTax has no effect without a verdict (the FoT rides the same matched prequote)", () => {
    // Defensive: `fotTax` alone (no `prequoteVerdict`) never fabricates a safety
    // label — the verdict is the gate for the whole safety line.
    const preview = buildIntentPreview(
      "kyberswap.swap.execute",
      { chain: "base", tokenIn: "0xAAA", tokenOut: "0xBBB", amountIn: "1" },
      { fotTax: 60 },
    );
    expect(preview.criticalArgs).not.toHaveProperty("safety");
  });
});

describe("buildIntentPreview — Stage 9 swap money/safety leg visibility", () => {
  it("surfaces recipient / slippageBps / approveExact for a gated swap (now bound, not secrets)", () => {
    const preview = buildIntentPreview(
      "kyberswap.swap.execute",
      {
        chain: "base",
        tokenIn: "0xAAA",
        tokenOut: "0xBBB",
        amountIn: "1",
        recipient: "0xRECIPIENT",
        slippageBps: 50,
        approveExact: true,
      },
      { prequoteVerdict: "pass" },
    );
    // The bound money/safety leg is now visible in the human-facing preview.
    expect(preview.criticalArgs.recipient).toBe("0xRECIPIENT");
    expect(preview.criticalArgs.slippageBps).toBe(50);
    expect(preview.criticalArgs.approveExact).toBe(true);
    // The typed safety verdict still rides the separate, non-spoofable channel.
    expect(preview.criticalArgs.safety).toBe("pass");
  });

  it("recipient / slippageBps / approveExact are NORMAL args — they cannot become the safety field", () => {
    // A 'safety' arg is still dropped; the money/safety leg appears under its own
    // keys and never bleeds into criticalArgs.safety (no extras → no safety key).
    const preview = buildIntentPreview("kyberswap.swap.execute", {
      chain: "base",
      tokenIn: "0xAAA",
      tokenOut: "0xBBB",
      amountIn: "1",
      recipient: "0xRECIPIENT",
      slippageBps: 100,
      approveExact: false,
      safety: "pass",
    });
    expect(preview.criticalArgs.recipient).toBe("0xRECIPIENT");
    expect(preview.criticalArgs.slippageBps).toBe(100);
    expect(preview.criticalArgs.approveExact).toBe(false);
    // No typed extras → no safety field; the spoofed arg is not allow-listed.
    expect(preview.criticalArgs).not.toHaveProperty("safety");
  });

  // 2026-07-25 restoration: the Borrow disclosure printed raw amounts against
  // bare mint addresses, so a human approver could not tell whether a debt of
  // "1047061" was 1.05 or 0.00105 of the debt token.
  it("names each Borrow leg's symbol and decimals next to its raw amount", () => {
    const preview = buildIntentPreview(
      "solana.lend.borrowOperate",
      { vaultId: 1 },
      {
        riskPreview: {
          vaultId: 1,
          market: "main",
          positionId: 0,
          supplyTokenAddress: "So11111111111111111111111111111111111111112",
          supplyTokenSymbol: "WSOL",
          supplyTokenDecimals: 9,
          borrowTokenAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          borrowTokenSymbol: "USDC",
          borrowTokenDecimals: 6,
          maxLtvPercent: "80.0%",
          liquidationThresholdPercent: "85.0%",
          existingSupplyRaw: "0",
          existingBorrowRaw: "0",
          projectedSupplyRaw: "1000000000",
          projectedBorrowRaw: "1047061",
          estimatedLtvPercent: "1.05%",
          riskNote: "Estimated LTV uses current Jupiter market prices and is APPROXIMATE.",
        },
      },
    );
    const disclosure = String(preview.criticalArgs.lendBorrowRisk);
    expect(disclosure).toContain("1000000000 raw units of WSOL (9 decimals");
    expect(disclosure).toContain("1047061 raw units of USDC (6 decimals");
    // The mint addresses stay — symbol alone is not an identity.
    expect(disclosure).toContain("So11111111111111111111111111111111111111112");
    expect(disclosure).toContain("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  });
});

describe("buildIntentPreview — injected discovered-tool name", () => {
  it("shows the human the DOTTED toolId, never the wire-safe mapped name", () => {
    // Owner decision 2026-08-03: a discovered manifest is called directly under
    // `<toolId with . → __>` and its arguments ARE the params (no envelope).
    // The approval preview is the human's last look before a fund-moving
    // action, so it must resolve back to the real tool.
    const preview = buildIntentPreview("kyberswap__swap_execute", {
      chain: "base",
      tokenIn: "ETH",
      tokenOut: "USDC",
      amountIn: "1.0",
    });

    expect(preview.toolName).toBe("kyberswap.swap.execute");
    expect(preview.namespace).toBe("kyberswap");
    expect(preview.criticalArgs.chain).toBe("base");
    expect(preview.criticalArgs.amountIn).toBe("1.0");
  });
});

describe("buildIntentPreview — execute_tool wrapper unwrap", () => {
  it("unwraps execute_tool({toolId, params}) → target tool preview", () => {
    const preview = buildIntentPreview("execute_tool", {
      toolId: "kyberswap.swap.execute",
      params: {
        chain: "base",
        tokenIn: "ETH",
        tokenOut: "USDC",
        amountIn: "1.0",
        slippageBps: 50,
      },
    });
    // toolName comes from args.toolId, NOT the wrapper name
    expect(preview.toolName).toBe("kyberswap.swap.execute");
    // namespace derived from the TARGET dotted id
    expect(preview.namespace).toBe("kyberswap");
    // criticalArgs come from nested `params`, not the wrapper args. Stage 9:
    // `slippageBps` is now allow-listed (it is bound into the prequote identity
    // and surfaced to the human), so it appears in the preview. NO `vexFee` key:
    // this venue's fee is stated by its matched quote and reaches the card on
    // the typed channel, which this call does not supply, and the card no longer
    // derives a second figure of its own from the arguments.
    expect(preview.criticalArgs).toEqual({
      chain: "base",
      tokenIn: "ETH",
      tokenOut: "USDC",
      amountIn: "1.0",
      slippageBps: 50,
    });
  });

  it("unwraps execute_tool for polymarket CLOB order", () => {
    const preview = buildIntentPreview("execute_tool", {
      toolId: "polymarket.clob.buy",
      params: {
        conditionId: "0xabc",
        outcome: "yes",
        amountUsdc: 10,
        side: "BUY",
      },
    });
    expect(preview.toolName).toBe("polymarket.clob.buy");
    expect(preview.namespace).toBe("polymarket");
    expect(preview.criticalArgs).toEqual({
      conditionId: "0xabc",
      outcome: "yes",
      amountUsdc: 10,
      side: "BUY",
    });
  });

  it("falls back to wrapper preview when execute_tool has no string toolId", () => {
    const preview = buildIntentPreview("execute_tool", {
      params: { chain: "base" },
      // toolId missing
    });
    expect(preview.toolName).toBe("execute_tool");
    expect(preview.namespace).toBeUndefined();
    // wrapper args don't have allow-listed keys (toolId/params aren't in allowlist)
    expect(preview.criticalArgs).toEqual({});
  });

  it("falls back to wrapper preview when execute_tool params is not an object", () => {
    const preview = buildIntentPreview("execute_tool", {
      toolId: "kyberswap.swap.execute",
      params: "not-an-object",
    });
    // toolId is honored → toolName + namespace resolved
    expect(preview.toolName).toBe("kyberswap.swap.execute");
    expect(preview.namespace).toBe("kyberswap");
    // params not an object → empty criticalArgs (defensive)
    expect(preview.criticalArgs).toEqual({});
  });

  it("does not unwrap non-execute_tool calls even if args look similar", () => {
    const preview = buildIntentPreview("some_other_tool", {
      toolId: "should-not-unwrap",
      params: { to: "0xabc" },
    });
    // wrapper name preserved
    expect(preview.toolName).toBe("some_other_tool");
    // criticalArgs come from wrapper args (params is not in allowlist; toolId neither)
    expect(preview.criticalArgs).toEqual({});
  });
});

describe("buildPolicySnapshot", () => {
  const baseContext: InternalToolContext = makeTestContext({
    sessionId: "00000000-0000-4000-8000-000000000001",
    missionRunId: "run-1",
    missionId: "mission-1",
    sessionKind: "mission",
    contextUsageBand: "warning",
  });

  it("snapshots the documented policy fields verbatim", () => {
    const snap = buildPolicySnapshot(baseContext);
    expect(snap).toEqual({
      permission: "restricted",
      sessionKind: "mission",
      missionRunActive: true,
      contextUsageBand: "warning",
      missionId: "mission-1",
      missionRunId: "run-1",
      // Nobody external asked: this is Vex's own agent loop, so the snapshot
      // records no client and the card names none rather than inventing one.
      requestedByClient: null,
    });
  });

  it("derives missionRunActive=false when missionRunId is null", () => {
    const snap = buildPolicySnapshot({ ...baseContext, missionRunId: null });
    expect(snap.missionRunActive).toBe(false);
    expect(snap.missionRunId).toBeNull();
  });

  it("captures permission='full' in the approval audit snapshot", () => {
    const snap = buildPolicySnapshot({ ...baseContext, sessionPermission: "full" });
    expect(snap.permission).toBe("full");
  });

  it("captures contextUsageBand at enqueue time (not re-derived later)", () => {
    const snap = buildPolicySnapshot({ ...baseContext, contextUsageBand: "critical" });
    expect(snap.contextUsageBand).toBe("critical");
  });
});

/**
 * WHO ASKED, as the approval card will show it.
 *
 * The name is the one field on the card that an EXTERNAL PROCESS chooses for
 * itself (an MCP client's `initialize` handshake), so these are boundary tests
 * rather than formatting tests: every case below is a value another process can
 * put on the wire, and the assertion is what a human ends up reading because
 * of it.
 */
describe("sanitizeRequestingClientName", () => {
  const context: InternalToolContext = makeTestContext({
    sessionId: "00000000-0000-4000-8000-000000000002",
  });

  it("keeps a plain client name, trimmed", () => {
    expect(sanitizeRequestingClientName("  Claude Code  ")).toBe("Claude Code");
  });

  // Control characters are refused because the actor row is a LINE a human
  // reads on a money-path card: a newline inside the name forges a second one.
  it.each([
    ["a newline", "Claude Code\nVEX APPROVED"],
    ["a carriage return", "Claude\rCode"],
    ["a NUL", "Claude\u0000Code"],
    ["an ANSI escape introducer", "\u001b[31mClaude Code"],
    ["DEL", "Claude\u007fCode"],
  ])("refuses %s rather than rendering it", (_label, name) => {
    expect(sanitizeRequestingClientName(name)).toBeNull();
  });

  it.each([
    ["a number", 42],
    ["undefined", undefined],
    ["an object", { name: "Claude Code" }],
    ["the empty string", ""],
    ["whitespace only", "   "],
  ])("refuses %s", (_label, value) => {
    expect(sanitizeRequestingClientName(value)).toBeNull();
  });

  it("keeps a name exactly at the bound", () => {
    const name = "c".repeat(REQUESTING_CLIENT_NAME_MAX);
    expect(sanitizeRequestingClientName(name)).toBe(name);
  });

  /**
   * The invariant a "just shorten it" change would break: "Claude Cod..." and
   * "Claude Code" read the same to a human deciding a transfer, and only one of
   * them is a name that person can verify. An over-long name is DROPPED whole,
   * and the card then says "an MCP client", which claims less rather than more.
   */
  it("DROPS an over-long name whole, never shortens it", () => {
    const name = "c".repeat(REQUESTING_CLIENT_NAME_MAX + 1);
    expect(sanitizeRequestingClientName(name)).toBeNull();
  });

  it("carries a sanitized name onto the policy snapshot the card reads", () => {
    expect(buildPolicySnapshot(context, " Claude Code ").requestedByClient).toBe(
      "Claude Code",
    );
  });

  it("records no client for Vex's own agent loop", () => {
    expect(buildPolicySnapshot(context).requestedByClient).toBeNull();
  });

  it("records no client when the declared name is unusable", () => {
    expect(
      buildPolicySnapshot(context, "Claude\nCode").requestedByClient,
    ).toBeNull();
  });

  /**
   * The card must never show a fee, a rate or a destination that came from the
   * client's NAME. Nothing branches on this value; it lands in `policy_json`
   * and stops there.
   */
  it("keeps the client name out of the preview the digest binds", () => {
    const preview = buildIntentPreview("WalletSendConfirm", {
      intentId: "int-1",
      clientName: "Claude Code",
    });
    expect(preview.criticalArgs).not.toHaveProperty("clientName");
    expect(preview.criticalArgs).not.toHaveProperty("requestedByClient");
  });
});
