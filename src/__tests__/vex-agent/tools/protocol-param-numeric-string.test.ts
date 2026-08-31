/**
 * Lossless numeric-string coercion for DECLARED-NUMBER params.
 *
 * THE DEFECT THIS CLOSES, measured in a live session (2026-07-30)
 *
 * A weaker model called `execute_tool` with
 * `{toolId: "dexscreener.search", query: "robinhood", limit: "10", …}`. Once
 * the flat-args lift (see `execute-tool-flat-args.test.ts`) put `limit` in the
 * bag, the strict gate answered
 * `Parameter "limit" for dexscreener__pairs_search has invalid type: expected number,
 * got string` — correct, and still a burnt call for a value that means exactly
 * one number and nothing else.
 *
 * WHY THIS IS SAFE ON A MONEY REPO. Amounts in this repository travel as
 * STRING params by design (rule 90 — a raw amount must not pass through a
 * float), so a param DECLARED `type: "number"` is structurally non-monetary:
 * limits, counts, offsets, thresholds, ids. The string-typed amount params are
 * never in reach of this transform, and the last test in this file proves an
 * amount-class string param arrives byte-identical.
 */

import { describe, expect, it } from "vitest";
import "./_dispatcher-test-mocks.js";
import { makeTestContext } from "./_test-context.js";

import { coerceNumericStringParams } from "@vex-agent/tools/protocols/runtime/numeric-string-coercion.js";
import { validateProtocolParams } from "@vex-agent/tools/protocols/runtime/params.js";
import type {
  ProtocolParamDef,
  ProtocolToolManifest,
} from "@vex-agent/tools/protocols/types.js";

const { dispatchTool } = await import("../../../vex-agent/tools/dispatcher.js");

const LIMIT_PARAM: ProtocolParamDef = {
  key: "limit",
  type: "number",
  description: "Max rows to return.",
};

/**
 * The amount-class param this repo actually uses for money: a STRING carrying a
 * raw on-chain amount. It must never be touched by numeric coercion.
 */
const AMOUNT_PARAM: ProtocolParamDef = {
  key: "amount",
  type: "string",
  required: true,
  description: "Raw amount in the token's smallest unit.",
};

const ENABLED_PARAM: ProtocolParamDef = {
  key: "dryRun",
  type: "boolean",
  description: "Simulate only.",
};

const MANIFEST: ProtocolToolManifest = {
  toolId: "test.numeric_string",
  publicName: "test__numeric_string",
  namespace: "dexscreener",
  lifecycle: "active",
  description: "Fixture manifest for the numeric-string boundary.",
  mutating: false,
  actionKind: "read",
  params: [AMOUNT_PARAM, LIMIT_PARAM, ENABLED_PARAM],
  exampleParams: { amount: "1000000" },
};

describe("coerceNumericStringParams — a losslessly numeric string becomes its number", () => {
  it("coerces the live failing value", () => {
    const outcome = coerceNumericStringParams(MANIFEST, { amount: "1", limit: "10" });
    expect(outcome.params.limit).toBe(10);
    expect(outcome.coercedKeys).toEqual(["limit"]);
  });

  it("coerces every spelling that prints back identically", () => {
    for (const [supplied, expected] of [
      ["0", 0],
      ["-3", -3],
      ["2.5", 2.5],
      [" 20 ", 20],
    ] as const) {
      const outcome = coerceNumericStringParams(MANIFEST, { amount: "1", limit: supplied });
      expect(outcome.params.limit, `for ${JSON.stringify(supplied)}`).toBe(expected);
    }
  });

  it("returns the SAME object reference when nothing was coerced", () => {
    const params = { amount: "1", limit: 10 };
    const outcome = coerceNumericStringParams(MANIFEST, params);
    expect(outcome.params).toBe(params);
    expect(outcome.coercedKeys).toEqual([]);
  });

  it("leaves a non-lossless string alone so the strict gate names the real problem", () => {
    // `"1e3"` and `"2.50"` are unambiguous to a human and still refused: they
    // do not print back identically, and the round-trip is the whole rule.
    for (const supplied of [
      "   ", "10.5abc", "abc", "0x10", "1,000", "10n",
      "Infinity", "NaN", "010", "1e3", "2.50",
    ]) {
      const outcome = coerceNumericStringParams(MANIFEST, { amount: "1", limit: supplied });
      expect(outcome.params.limit, `for ${JSON.stringify(supplied)}`).toBe(supplied);
      expect(outcome.coercedKeys).toEqual([]);

      const validation = validateProtocolParams(MANIFEST, outcome.params);
      expect(validation.ok, `expected rejection for ${JSON.stringify(supplied)}`).toBe(false);
    }
  });

  it("leaves an empty string alone, preserving empty-means-absent on an optional", () => {
    // `""` is "missing" to `validateProtocolParams` (its documented pre-B-002
    // semantics). Coercing it to `0` would invent a limit the model never sent,
    // so it is refused here and stays absent there.
    const outcome = coerceNumericStringParams(MANIFEST, { amount: "1", limit: "" });
    expect(outcome.params.limit).toBe("");
    expect(outcome.coercedKeys).toEqual([]);
    expect(validateProtocolParams(MANIFEST, outcome.params).ok).toBe(true);
  });

  it("never touches a boolean-declared param spelled as a string", () => {
    const outcome = coerceNumericStringParams(MANIFEST, { amount: "1", dryRun: "1" });
    expect(outcome.params.dryRun).toBe("1");
    expect(outcome.coercedKeys).toEqual([]);
  });

  it("NEVER touches a string-declared amount param — the money contract", () => {
    // Every one of these is losslessly numeric. A number-typed param would be
    // coerced; the amount param is declared `string`, so it is not considered
    // at all and arrives byte-identical, precision intact.
    for (const amount of ["1000000", "0", "1047061", "115792089237316195423570985008687907853269984665640564039457584007913129639935"]) {
      const outcome = coerceNumericStringParams(MANIFEST, { amount });
      expect(outcome.params.amount).toBe(amount);
      expect(typeof outcome.params.amount).toBe("string");
      expect(outcome.coercedKeys).toEqual([]);
    }
  });
});

describe("execute_tool — the live `limit: \"10\"` call now reaches the handler", () => {
  it("accepts the flat live call whose only remaining defect was the string limit", async () => {
    const result = await dispatchTool(
      {
        name: "execute_tool",
        args: { toolId: "dexscreener.search", query: "robinhood", limit: "10" },
        toolCallId: "call_numeric_1",
      },
      makeTestContext(),
    );

    expect(result.output).not.toContain("invalid type");
    expect(result.output).not.toContain("expected number");
  });

  it("still rejects a non-lossless numeric string with the precise type error", async () => {
    const result = await dispatchTool(
      {
        name: "execute_tool",
        args: { toolId: "dexscreener.search", query: "robinhood", limit: "10.5abc" },
        toolCallId: "call_numeric_2",
      },
      makeTestContext(),
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain('Parameter "limit" for dexscreener__pairs_search has invalid type');
    expect(result.output).toContain("expected number, got string");
  });
});
