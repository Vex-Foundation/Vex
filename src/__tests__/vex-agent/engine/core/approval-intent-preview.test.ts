/**
 * Approval intent preview + policy snapshot builders — pure-function tests.
 *
 * Puzzle 5 phase 2 (2026-05-23). Pins the renderer-safe projection:
 * allow-listed keys only, coerced scalars, no nested blobs / bigints / leaks.
 */

import { describe, it, expect } from "vitest";
import type { InternalToolContext } from "@vex-agent/tools/internal/types.js";
import {
  buildIntentPreview,
  buildPolicySnapshot,
} from "@vex-agent/engine/core/approval-intent-preview.js";

describe("buildIntentPreview", () => {
  it("returns toolName + allow-listed criticalArgs for a wallet transfer call", () => {
    const preview = buildIntentPreview("wallet_send_prepare", {
      network: "eip155",
      chain: "base",
      to: "0xabcdef1234567890",
      amount: "1.5",
      token: "USDC",
    });
    expect(preview.toolName).toBe("wallet_send_prepare");
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
    const preview = buildIntentPreview("kyberswap.swap.sell", {
      chain: "ethereum",
      tokenIn: "USDC",
      tokenOut: "ETH",
      amountIn: "100",
    });
    expect(preview.namespace).toBe("kyberswap");
    expect(preview.criticalArgs.tokenIn).toBe("USDC");
  });

  it("drops keys outside the allowlist (defense-in-depth against leak)", () => {
    const preview = buildIntentPreview("wallet_send_prepare", {
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
    const preview = buildIntentPreview("kyberswap.swap.sell", {
      amount: 1234567890123456789n,
    });
    expect(preview.criticalArgs.amount).toBe("1234567890123456789");
  });

  it("truncates strings longer than 200 chars with ellipsis", () => {
    const longTo = "0x" + "a".repeat(300);
    const preview = buildIntentPreview("wallet_send_prepare", { to: longTo });
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

describe("buildIntentPreview — Hyperliquid signed economics", () => {
  it.each([
    ["hyperliquid.spot.trade", { side: "buy", size: "2", price: "101" }, { side: "buy", size: "2", price: "101" }],
    ["hyperliquid.perp.close", { side: "sell", size: "3", markPrice: "99" }, { side: "sell", size: "3", markPrice: "99" }],
    ["hyperliquid.perp.twap", { side: "buy", size: "4", minutes: 15, randomize: true }, { side: "buy", size: "4", minutes: 15, randomize: true }],
    ["hyperliquid.perp.adjustMargin", { ntli: -250 }, { ntli: -250 }],
    ["hyperliquid.withdraw", { amount: "5", destination: "0xrecipient" }, { amount: "5", destination: "0xrecipient" }],
    ["hyperliquid.transfer.usdClass", { amount: "6", toPerp: true }, { amount: "6", toPerp: true }],
    ["hyperliquid.deposit", { amountUsd: "7" }, { amountUsd: "7" }],
  ] as const)("shows every signed economic and directional field for %s", (toolName, args, expected) => {
    expect(buildIntentPreview(toolName, args).criticalArgs).toMatchObject(expected);
  });

  it("renders a trusted destination class without accepting a raw spoof", () => {
    const preview = buildIntentPreview(
      "hyperliquid.deposit",
      { amountUsd: "7", destinationClass: "spoofed" },
      { hyperliquid: { destinationClass: "Hyperliquid bridge deposit" } },
    );
    expect(preview.criticalArgs).toMatchObject({ amountUsd: "7", destinationClass: "Hyperliquid bridge deposit" });
  });
});

describe("buildIntentPreview — Stage 7 prequote verdict binding (R5)", () => {
  it("injects criticalArgs.safety='pass' from the typed extras for a gated swap", () => {
    const preview = buildIntentPreview(
      "kyberswap.swap.sell",
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
    expect(preview.criticalArgs.safety).toBe("UNVERIFIED — audit unavailable");
  });

  it("omits safety when no extras are passed (non-swap / non-gated path)", () => {
    const preview = buildIntentPreview("wallet_send_prepare", {
      to: "0xabc",
      amount: "1.0",
    });
    expect(preview.criticalArgs).not.toHaveProperty("safety");
  });

  it("raw args CANNOT spoof safety — a 'safety' arg is dropped (not allow-listed)", () => {
    // The LLM passing a `safety` arg must never reach the preview; only the
    // typed extras channel can set it. With no extras, `safety` stays absent.
    const preview = buildIntentPreview(
      "kyberswap.swap.sell",
      { chain: "base", tokenIn: "0xAAA", tokenOut: "0xBBB", amountIn: "1", safety: "pass" },
    );
    expect(preview.criticalArgs).not.toHaveProperty("safety");
  });

  it("a spoofed 'safety' arg is OVERRIDDEN by the typed extras (unknown wins)", () => {
    // Even if the LLM passes safety:'pass', the extras-driven value is what lands
    // (the arg is dropped first; extras inject afterwards).
    const preview = buildIntentPreview(
      "kyberswap.swap.sell",
      { chain: "base", tokenIn: "0xAAA", tokenOut: "0xBBB", amountIn: "1", safety: "pass" },
      { prequoteVerdict: "unknown" },
    );
    expect(preview.criticalArgs.safety).toBe("UNVERIFIED — audit unavailable");
  });
});

describe("buildIntentPreview — Stage 9 fee-on-transfer disclosure (FIX 3)", () => {
  it("appends the FoT tax to the safety label when fotTax is in the typed extras", () => {
    // FoT is now a verdict `pass` (only a confirmed honeypot blocks); the human
    // must still see the tax. It rides the typed extras alongside the verdict.
    const preview = buildIntentPreview(
      "kyberswap.swap.sell",
      { chain: "base", tokenIn: "0xAAA", tokenOut: "0xBBB", amountIn: "1" },
      { prequoteVerdict: "pass", fotTax: 60 },
    );
    expect(preview.criticalArgs.safety).toBe("pass — fee-on-transfer 60%");
  });

  it("a clean pass (no fotTax) renders a plain 'pass' — no FoT suffix", () => {
    const preview = buildIntentPreview(
      "kyberswap.swap.sell",
      { chain: "base", tokenIn: "0xAAA", tokenOut: "0xBBB", amountIn: "1" },
      { prequoteVerdict: "pass" },
    );
    expect(preview.criticalArgs.safety).toBe("pass");
  });

  it("fotTax is NOT spoofable from raw args — only the typed extras channel sets it", () => {
    // A raw `fotTax` arg (and a spoofed `safety` arg) must never reach the
    // preview; with no extras the safety label is absent entirely.
    const preview = buildIntentPreview(
      "kyberswap.swap.sell",
      { chain: "base", tokenIn: "0xAAA", tokenOut: "0xBBB", amountIn: "1", fotTax: 60, safety: "pass — fee-on-transfer 60%" },
    );
    expect(preview.criticalArgs).not.toHaveProperty("safety");
    expect(preview.criticalArgs).not.toHaveProperty("fotTax");
  });

  it("fotTax has no effect without a verdict (the FoT rides the same matched prequote)", () => {
    // Defensive: `fotTax` alone (no `prequoteVerdict`) never fabricates a safety
    // label — the verdict is the gate for the whole safety line.
    const preview = buildIntentPreview(
      "kyberswap.swap.sell",
      { chain: "base", tokenIn: "0xAAA", tokenOut: "0xBBB", amountIn: "1" },
      { fotTax: 60 },
    );
    expect(preview.criticalArgs).not.toHaveProperty("safety");
  });
});

describe("buildIntentPreview — Stage 9 swap money/safety leg visibility", () => {
  it("surfaces recipient / slippageBps / approveExact for a gated swap (now bound, not secrets)", () => {
    const preview = buildIntentPreview(
      "kyberswap.swap.sell",
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
    const preview = buildIntentPreview("kyberswap.swap.sell", {
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
});

describe("buildIntentPreview — execute_tool wrapper unwrap", () => {
  it("unwraps execute_tool({toolId, params}) → target tool preview", () => {
    const preview = buildIntentPreview("execute_tool", {
      toolId: "kyberswap.swap.sell",
      params: {
        chain: "base",
        tokenIn: "ETH",
        tokenOut: "USDC",
        amountIn: "1.0",
        slippageBps: 50,
      },
    });
    // toolName comes from args.toolId, NOT the wrapper name
    expect(preview.toolName).toBe("kyberswap.swap.sell");
    // namespace derived from the TARGET dotted id
    expect(preview.namespace).toBe("kyberswap");
    // criticalArgs come from nested `params`, not the wrapper args. Stage 9:
    // `slippageBps` is now allow-listed (it is bound into the prequote identity
    // and surfaced to the human), so it appears in the preview.
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
      toolId: "kyberswap.swap.sell",
      params: "not-an-object",
    });
    // toolId is honored → toolName + namespace resolved
    expect(preview.toolName).toBe("kyberswap.swap.sell");
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
  const baseContext: InternalToolContext = {
    sessionId: "00000000-0000-4000-8000-000000000001",
    loadedDocuments: new Map(),
    sessionPermission: "restricted",
    approved: false,
    role: "parent",
    missionRunId: "run-1",
    missionId: "mission-1",
    sessionKind: "mission",
    contextUsageBand: "warning",
  };

  it("snapshots the documented policy fields verbatim", () => {
    const snap = buildPolicySnapshot(baseContext);
    expect(snap).toEqual({
      permission: "restricted",
      sessionKind: "mission",
      missionRunActive: true,
      contextUsageBand: "warning",
      missionId: "mission-1",
      missionRunId: "run-1",
      role: "parent",
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

  it("captures role='subagent' when set", () => {
    const snap = buildPolicySnapshot({ ...baseContext, role: "subagent" });
    expect(snap.role).toBe("subagent");
  });

  it("captures contextUsageBand at enqueue time (not re-derived later)", () => {
    const snap = buildPolicySnapshot({ ...baseContext, contextUsageBand: "critical" });
    expect(snap.contextUsageBand).toBe("critical");
  });
});
