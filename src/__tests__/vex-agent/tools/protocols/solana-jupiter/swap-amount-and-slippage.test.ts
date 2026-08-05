/**
 * W5a + W4a — the two pure seams the Solana swap pair now shares.
 *
 * `humanAmountToAtomic` replaced `uiToTokenAmount`'s
 * `BigInt(Math.round(uiAmount * 10 ** decimals))`: the amount is a HUMAN
 * decimal STRING and reaches atomic units through integer math only.
 *
 * `resolveJupiterSwapKnobs` MATERIALIZES Vex's slippage default instead of
 * letting Jupiter substitute its own — the provider must not own Vex's only
 * price protection.
 */

import { describe, it, expect } from "vitest";

import { SOLANA_JUPITER_TOOLS } from "@vex-agent/tools/protocols/solana-jupiter/manifest.js";
import { validateProtocolParams } from "@vex-agent/tools/protocols/runtime/params.js";
import { humanAmountToAtomic } from "@vex-agent/tools/protocols/solana-jupiter/handlers/core/swap-amount.js";
import { resolveJupiterSwapKnobs } from "@vex-agent/tools/protocols/solana-jupiter/handlers/core/swap-policy.js";
import { VEX_DEFAULT_SLIPPAGE_BPS } from "@vex-agent/tools/protocols/slippage-policy.js";

describe("humanAmountToAtomic (W5a — no float on the swap amount)", () => {
  it("converts a human decimal string exactly, with no rounding step", () => {
    expect(humanAmountToAtomic("amountIn", "1.5", 6, "USDC")).toEqual({ ok: true, amountRaw: "1500000" });
    expect(humanAmountToAtomic("amountIn", "1", 9, "SOL")).toEqual({ ok: true, amountRaw: "1000000000" });
    expect(humanAmountToAtomic("amountIn", "0.000000001", 9, "SOL")).toEqual({ ok: true, amountRaw: "1" });
  });

  it("is exact where the old float path was not", () => {
    // The retired conversion was `BigInt(Math.round(ui * 10 ** decimals))`.
    // 4.35 at 9 decimals is 4350000000.0000005 in IEEE-754 — the old path
    // survived only because Math.round hid it. A 6-decimal case that does NOT
    // survive rounding is the real point: the string path never computes a
    // float at all.
    expect(humanAmountToAtomic("amountIn", "4.35", 9, "SOL")).toEqual({ ok: true, amountRaw: "4350000000" });

    // Beyond Number.MAX_SAFE_INTEGER the float path loses digits outright.
    const huge = "18446744073709.551615";
    expect(humanAmountToAtomic("amountIn", huge, 6, "USDC")).toEqual({
      ok: true,
      amountRaw: "18446744073709551615",
    });
    expect(String(Math.round(Number(huge) * 10 ** 6))).not.toBe("18446744073709551615");
  });

  it("REJECTS more precision than the mint has rather than silently rounding it away", () => {
    const result = humanAmountToAtomic("amountIn", "1.0000001", 6, "USDC");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("6");
    expect(result.ok === false && result.reason).toContain("USDC");
  });

  it("rejects every non-decimal spelling and zero, naming the parameter", () => {
    for (const bad of ["", "abc", "-1", "1e3", "1,000", " ", "0x10", "1.5 SOL"]) {
      const result = humanAmountToAtomic("amountIn", bad, 6, "USDC");
      expect(result.ok, `expected "${bad}" to be rejected`).toBe(false);
      expect(result.ok === false && result.reason).toContain("amountIn");
    }
    expect(humanAmountToAtomic("amountIn", "0", 6, "USDC").ok).toBe(false);
    expect(humanAmountToAtomic("amountIn", "0.000", 6, "USDC").ok).toBe(false);
  });
});

describe("resolveJupiterSwapKnobs (W4a — Vex owns the slippage default)", () => {
  it("materializes Vex's default when the caller omits slippageBps", () => {
    expect(resolveJupiterSwapKnobs({}).slippageBps).toBe(VEX_DEFAULT_SLIPPAGE_BPS);
  });

  it("never overrides an explicit caller value", () => {
    expect(resolveJupiterSwapKnobs({ slippageBps: 250 }).slippageBps).toBe(250);
    expect(resolveJupiterSwapKnobs({ slippageBps: 0 }).slippageBps).toBe(0);
  });

  it("leaves every other knob resolving exactly as before", () => {
    const knobs = resolveJupiterSwapKnobs({ dexes: "Raydium", maxAccounts: 40 });
    expect(knobs.dexes).toBe("Raydium");
    expect(knobs.maxAccounts).toBe(40);
    expect(knobs.wrapAndUnwrapSol).toBe(true);
  });
});

/**
 * W5a/W5c/W7 — the boundary contract the renames rest on. The old spellings
 * must be REJECTED (never silently ignored, which would let a caller believe
 * it had set an amount), and `solana.lend.withdraw`'s XOR must be enforced by
 * the schema rather than only by the handler.
 */
describe("solana manifest boundary — retired spellings and the withdraw XOR", () => {
  function manifest(toolId: string) {
    const found = SOLANA_JUPITER_TOOLS.find((tool) => tool.toolId === toolId);
    if (!found) throw new Error(`missing manifest ${toolId}`);
    return found;
  }

  const RETIRED: ReadonlyArray<readonly [string, Record<string, unknown>, string]> = [
    ["solana.swap.quote", { inputToken: "SOL", tokenOut: "USDC", amountIn: "1" }, "inputToken"],
    ["solana.swap.quote", { tokenIn: "SOL", outputToken: "USDC", amountIn: "1" }, "outputToken"],
    ["solana.swap.execute", { tokenIn: "SOL", tokenOut: "USDC", amount: 1 }, "amount"],
    ["solana.lend.deposit", { asset: "USDC", amount: "1000000" }, "amount"],
    ["solana.predict.positions", { address: "Wallet1" }, "address"],
    ["solana.predict.suggestedEvents", { pubkey: "Wallet1" }, "pubkey"],
  ];

  for (const [toolId, params, retiredKey] of RETIRED) {
    it(`${toolId} rejects the retired \`${retiredKey}\`, naming what it accepts instead`, () => {
      const result = validateProtocolParams(manifest(toolId), params);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toContain(retiredKey);
      // The rejection must be actionable: the allowed keys are named, so the
      // agent's next call is the right one rather than another guess.
      expect(result.reason).toMatch(/tokenIn|tokenOut|amountIn|amountRaw|walletAddress/);
    });
  }

  it("solana.lend.withdraw enforces EXACTLY one of amountRaw / withdrawAll", () => {
    const withdraw = manifest("solana.lend.withdraw");
    expect(withdraw.exclusiveParamGroups).toEqual([["amountRaw", "withdrawAll"]]);

    expect(validateProtocolParams(withdraw, { asset: "USDC", amountRaw: "1000000" }).ok).toBe(true);
    expect(validateProtocolParams(withdraw, { asset: "USDC", withdrawAll: true }).ok).toBe(true);

    const both = validateProtocolParams(withdraw, { asset: "USDC", amountRaw: "1", withdrawAll: true });
    expect(both.ok).toBe(false);
    if (!both.ok) expect(both.reason).toContain("withdrawAll");

    const neither = validateProtocolParams(withdraw, { asset: "USDC" });
    expect(neither.ok).toBe(false);
    if (!neither.ok) expect(neither.reason).toContain("amountRaw");
  });

  // borrowOperate is AT-MOST-one per leg, not exactly-one, so it deliberately
  // declares NO exclusive group — declaring one would reject every legitimate
  // single-leg call. The handler owns that rule (see borrow-operate-params.ts).
  it("solana.lend.borrowOperate declares no exclusive group (its rule is at-most-one per leg)", () => {
    expect(manifest("solana.lend.borrowOperate").exclusiveParamGroups).toBeUndefined();
    expect(validateProtocolParams(manifest("solana.lend.borrowOperate"), {
      vaultId: 1, depositAmountRaw: "1000",
    }).ok).toBe(true);
  });
});
