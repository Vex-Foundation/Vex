/**
 * `units_convert` — the money-math contract.
 *
 * Everything asserted here is a number the agent would otherwise compute in its
 * head, plus the refusals that keep a confused call from becoming a wrong
 * figure. The properties that must survive:
 *
 *   - conversions are EXACT within a family, and the gwei trap answers 0.0225;
 *   - an atomic unit refuses a decimal string BY NAME;
 *   - a cross-family conversion is refused BY NAME;
 *   - every floor that discards value reports a remainder;
 *   - nothing rounds up, ever, and no float is involved.
 */

import { describe, expect, it } from "vitest";

import { handleUnitsConvert } from "@vex-agent/tools/internal/units-convert.js";
import { UNITS_TOOLS } from "@vex-agent/tools/registry/units.js";
import { getToolDef } from "@vex-agent/tools/registry.js";
import { INTERNAL_TOOL_LOADERS } from "@vex-agent/tools/dispatcher/internal-loaders.js";
import { TOOL_MAP_CATEGORIES } from "@vex-agent/tools/registry/tool-map.js";

async function call(params: Record<string, unknown>): Promise<{
  success: boolean;
  output: string;
  data?: Record<string, unknown>;
}> {
  return handleUnitsConvert(params);
}

async function succeed(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await call(params);
  expect(result.success, result.output).toBe(true);
  return JSON.parse(result.output) as Record<string, unknown>;
}

async function refusal(params: Record<string, unknown>): Promise<string> {
  const result = await call(params);
  expect(result.success, `expected a refusal, got: ${result.output}`).toBe(false);
  return result.output;
}

describe("units_convert — unit_convert", () => {
  it("THE GWEI TRAP: 22518000 wei is 0.022518 gwei, not 22.5", async () => {
    const body = await succeed({ op: "unit_convert", value: "22518000", from: "wei", to: "gwei" });
    expect(body.result).toEqual({ raw: "22518000", decimals: 9, human: "0.022518" });
  });

  it("converts across the whole EVM family exactly", async () => {
    expect(
      (await succeed({ op: "unit_convert", value: "1", from: "eth", to: "wei" })).result,
    ).toEqual({ raw: "1000000000000000000", decimals: 0, human: "1000000000000000000" });

    expect(
      (await succeed({ op: "unit_convert", value: "0.0225", from: "gwei", to: "wei" })).result,
    ).toEqual({ raw: "22500000", decimals: 0, human: "22500000" });

    // Sub-unit: one wei is a real, readable amount of ETH.
    expect((await succeed({ op: "unit_convert", value: "1", from: "wei", to: "eth" })).result)
      .toEqual({ raw: "1", decimals: 18, human: "0.000000000000000001" });
  });

  it("converts the Solana family exactly", async () => {
    expect(
      (await succeed({ op: "unit_convert", value: "1047061", from: "lamports", to: "sol" })).result,
    ).toEqual({ raw: "1047061", decimals: 9, human: "0.001047061" });

    expect((await succeed({ op: "unit_convert", value: "0.5", from: "sol", to: "lamports" })).result)
      .toEqual({ raw: "500000000", decimals: 0, human: "500000000" });
  });

  it("reads the SAME raw number differently at different decimals", async () => {
    const atSix = await succeed({
      op: "unit_convert", value: "1047061", from: "raw", to: "human", decimals: 6,
    });
    const atNine = await succeed({
      op: "unit_convert", value: "1047061", from: "raw", to: "human", decimals: 9,
    });
    expect(atSix.result).toEqual({ raw: "1047061", decimals: 6, human: "1.047061" });
    expect(atNine.result).toEqual({ raw: "1047061", decimals: 9, human: "0.001047061" });
  });

  it("zero is legal and converts to zero", async () => {
    expect((await succeed({ op: "unit_convert", value: "0", from: "wei", to: "eth" })).result)
      .toEqual({ raw: "0", decimals: 18, human: "0" });
  });

  it("refuses a decimal string in an atomic unit BY NAME", async () => {
    for (const from of ["wei", "lamports", "raw"] as const) {
      const message = await refusal({
        op: "unit_convert", value: "1.5", from, to: from === "raw" ? "human" : from, decimals: 6,
      });
      expect(message).toContain("value must be digits only");
      expect(message).toContain("no decimal point");
      expect(message).toContain(from);
    }
  });

  it("refuses a value finer than the family's atomic unit instead of flooring it", async () => {
    const message = await refusal({
      op: "unit_convert", value: "0.0000000005", from: "gwei", to: "wei",
    });
    expect(message).toContain("finer than 1 wei");
    expect(message).toContain("at most 9 decimal places");
  });

  it("refuses a cross-family conversion BY NAME", async () => {
    const message = await refusal({ op: "unit_convert", value: "1", from: "wei", to: "sol" });
    expect(message).toContain("different unit families");
    expect(message).toContain("wei");
    expect(message).toContain("sol");
  });

  it("refuses raw/human without decimals BY NAME", async () => {
    const message = await refusal({ op: "unit_convert", value: "1047061", from: "raw", to: "human" });
    expect(message).toContain("decimals is required");
    expect(message).toContain("token_find");
  });

  it("refuses a negative value and a malformed value BY NAME", async () => {
    expect(await refusal({ op: "unit_convert", value: "-1", from: "wei", to: "gwei" }))
      .toContain("must not be negative");
    expect(await refusal({ op: "unit_convert", value: "1e18", from: "eth", to: "wei" }))
      .toContain("value must be a plain decimal number");
  });

  it("refuses a value past the uint256 digit ceiling", async () => {
    const message = await refusal({
      op: "unit_convert", value: "1".repeat(79), from: "wei", to: "gwei",
    });
    expect(message).toContain("more than 78 digits");
  });

  it("accepts exactly 78 digits", async () => {
    const value = "1".repeat(78);
    const body = await succeed({ op: "unit_convert", value, from: "wei", to: "wei" });
    expect(body.result).toMatchObject({ raw: value, decimals: 0 });
  });
});

describe("units_convert — gas_cost", () => {
  it("multiplies units by price and answers in wei, gwei and eth", async () => {
    const body = await succeed({
      op: "gas_cost", gasUnits: "1000000", gasPriceWei: "22518000",
    });
    expect(body.cost).toEqual({
      wei: { raw: "22518000000000", decimals: 0, human: "22518000000000" },
      gwei: { raw: "22518000000000", decimals: 9, human: "22518" },
      eth: { raw: "22518000000000", decimals: 18, human: "0.000022518" },
    });
  });

  it("refuses a gas price with a decimal point BY NAME", async () => {
    const message = await refusal({ op: "gas_cost", gasUnits: "21000", gasPriceWei: "0.0225" });
    expect(message).toContain("gasPriceWei must be digits only");
  });
});

describe("units_convert — apply_bps", () => {
  it("splits an amount at 25 bps with human twins on both legs", async () => {
    const body = await succeed({
      op: "apply_bps", amountRaw: "1000000000", bps: 25, decimals: 9,
    });
    expect(body.fee).toEqual({ raw: "2500000", decimals: 9, human: "0.0025" });
    expect(body.net).toEqual({ raw: "997500000", decimals: 9, human: "0.9975" });
  });

  it("0 bps takes nothing and 10000 bps takes everything", async () => {
    const zero = await succeed({ op: "apply_bps", amountRaw: "12345", bps: 0, decimals: 6 });
    expect(zero.fee).toMatchObject({ raw: "0" });
    expect(zero.net).toMatchObject({ raw: "12345" });

    const all = await succeed({ op: "apply_bps", amountRaw: "12345", bps: 10000, decimals: 6 });
    expect(all.fee).toMatchObject({ raw: "12345" });
    expect(all.net).toMatchObject({ raw: "0" });
  });

  it("reports the floored ten-thousandths as a remainder, and fee+net still equals the input", async () => {
    const body = await succeed({ op: "apply_bps", amountRaw: "1001", bps: 25, decimals: 6 });
    // 1001 × 25 = 25025; 25025 / 10000 = 2 remainder 5025.
    expect(body.fee).toEqual({ raw: "2", decimals: 6, human: "0.000002", remainder: "5025" });
    expect(body.net).toEqual({ raw: "999", decimals: 6, human: "0.000999" });
    expect(BigInt((body.fee as { raw: string }).raw) + BigInt((body.net as { raw: string }).raw))
      .toBe(1001n);
  });

  it("refuses bps outside 0..10000 BY NAME", async () => {
    expect(await refusal({ op: "apply_bps", amountRaw: "1", bps: 10001, decimals: 6 }))
      .toContain("bps must be between 0 and 10000");
    expect(await refusal({ op: "apply_bps", amountRaw: "1", bps: -1, decimals: 6 }))
      .toContain("bps must be between 0 and 10000");
  });

  it("refuses decimals outside 0..36 BY NAME", async () => {
    expect(await refusal({ op: "apply_bps", amountRaw: "1", bps: 25, decimals: 37 }))
      .toContain("decimals must be between 0 and 36");
  });
});

describe("units_convert — USD round trips", () => {
  it("buys the exact number of base units at 6 decimals", async () => {
    const body = await succeed({
      op: "usd_to_token_amount", usd: "250.75", priceUsd: "1", decimals: 6,
    });
    expect(body.result).toEqual({ raw: "250750000", decimals: 6, human: "250.75" });
  });

  it("floors at 18 decimals and reports the discarded numerator", async () => {
    const body = await succeed({
      op: "usd_to_token_amount", usd: "1", priceUsd: "3", decimals: 18,
    });
    // 10^18 / 3 = 333333333333333333 remainder 1.
    expect(body.result).toEqual({
      raw: "333333333333333333",
      decimals: 18,
      human: "0.333333333333333333",
      remainder: "1",
    });
  });

  it("values a base-unit amount in USD, floored to micro-dollars with the residue reported", async () => {
    const exact = await succeed({
      op: "token_amount_to_usd", amountRaw: "250750000", priceUsd: "1", decimals: 6,
    });
    expect(exact).toMatchObject({ usd: "250.75", usdPrecision: 6, remainder: "0" });

    const floored = await succeed({
      op: "token_amount_to_usd", amountRaw: "1", priceUsd: "0.00031415", decimals: 18,
    });
    // One wei-scale unit at that price is far below a micro-dollar.
    expect(floored).toMatchObject({ usd: "0", usdPrecision: 6 });
    expect(BigInt((floored as { remainder: string }).remainder)).toBeGreaterThan(0n);
  });

  it("round-trips a whole token through both USD ops without drift", async () => {
    const bought = await succeed({
      op: "usd_to_token_amount", usd: "100", priceUsd: "2.5", decimals: 6,
    });
    expect(bought.result).toMatchObject({ raw: "40000000", human: "40" });
    const valued = await succeed({
      op: "token_amount_to_usd", amountRaw: "40000000", priceUsd: "2.5", decimals: 6,
    });
    expect(valued).toMatchObject({ usd: "100", remainder: "0" });
  });

  it("refuses a zero or negative price BY NAME", async () => {
    expect(await refusal({ op: "usd_to_token_amount", usd: "1", priceUsd: "0", decimals: 6 }))
      .toContain("priceUsd must be greater than zero");
    expect(await refusal({ op: "token_amount_to_usd", amountRaw: "1", priceUsd: "-2", decimals: 6 }))
      .toContain("priceUsd must not be negative");
  });

  it("refuses a decimal string in amountRaw BY NAME", async () => {
    expect(
      await refusal({ op: "token_amount_to_usd", amountRaw: "1.5", priceUsd: "2", decimals: 6 }),
    ).toContain("amountRaw must be digits only");
  });
});

describe("units_convert — argument boundary", () => {
  it("names the legal ops when `op` is unknown or missing", async () => {
    expect(await refusal({ op: "convert", value: "1", from: "wei", to: "gwei" }))
      .toContain("op");
    expect(await refusal({})).toContain("op");
  });

  it("refuses a number where a string amount is required, without echoing the value", async () => {
    const message = await refusal({ op: "unit_convert", value: 22518000, from: "wei", to: "gwei" });
    expect(message).toContain("value");
    expect(message).not.toContain("22518000");
  });

  it("refuses an unknown key instead of silently stripping it (strict branches)", async () => {
    // Codex final review 2026-08-05: plain z.object strips unknown keys, so a
    // caller misspelling a field (e.g. `gasPrice` for `gasPriceWei`) would get
    // an answer computed from defaults instead of a correction. Every union
    // branch is .strict() so the misspelling is named.
    const message = await refusal({
      op: "unit_convert",
      value: "1",
      from: "wei",
      to: "gwei",
      decimalz: 9,
    });
    expect(message).toContain("decimalz");
  });
});

describe("units_convert — registration", () => {
  it("is registered, read-only, and reachable by the dispatcher", () => {
    const def = getToolDef("units_convert");
    expect(def).toBeDefined();
    expect(def?.kind).toBe("internal");
    expect(def?.mutating).toBe(false);
    expect(def?.pressureSafety).toBe("read_only");
    expect(Object.keys(INTERNAL_TOOL_LOADERS)).toContain("units_convert");
    expect(TOOL_MAP_CATEGORIES.flatMap(c => c.toolNames)).toContain("units_convert");
  });

  it("carries no visibility gate — it must be available in every session", () => {
    const def = UNITS_TOOLS[0];
    expect(def?.requiresEnv).toBeUndefined();
    expect(def?.visibility).toBeUndefined();
    expect(def?.proactive).toBeUndefined();
  });

  it("teaches the gwei trap and the decimals trap in its manifest", () => {
    const description = UNITS_TOOLS[0]?.description ?? "";
    expect(description).toContain("22518000");
    expect(description).toContain("0.0225");
    expect(description).toContain("NOT 22.5");
    expect(description).toContain("1.047061");
    expect(description).toContain("token_find");
  });
});
