/**
 * Equivalence tests for the Zod conversion of the KyberSwap ZaaS response
 * validators (codex-002 Phase 2). These assert the converted
 * `validateZapRouteResponse` / `validateZapBuildResponse` reproduce the EXACT
 * accept/reject/default/coerce behaviour of the original hand-written
 * `createFieldValidators`-based code, including the financial-critical
 * `data.callData` / `data.routerAddress` strict checks.
 *
 * The original semantics being pinned:
 *   - non-record root → plain `Error` with the exact message (both fns).
 *   - `code`: `typeof === "number" ? : 0` (NO NaN check → accepts NaN AND
 *     ±Infinity). Proves we did NOT use z.number() (rejects Infinity) or
 *     zNumberField (rejects NaN).
 *   - lenient string fields use bare `typeof === "string"` → empty "" passes.
 *   - sub-records (poolDetails/positionDetails) only built when parent is a
 *     record, else the whole sub-object is undefined.
 *   - build: `data.callData`/`data.routerAddress` are STRICT → throw
 *     VexError(KYBER_API_ERROR) with the `missing <field>` message; the
 *     `?? data.data` fallback is nullish (empty "" does NOT fall through).
 *
 * Etap 4 DIVERGENCE: the ROUTE validator's `data.route`/`data.routerAddress` are
 * no longer lenient-defaulting — they are now STRICT required non-empty strings
 * (same fail-closed contract as the build validator's callData/routerAddress).
 * Every OTHER route field stays lenient exactly as before, so the lenient cases
 * below simply carry a valid route/routerAddress pair while exercising the field
 * under test; the two former "route/routerAddress default to undefined" cases
 * become strict-rejection cases.
 */

import { describe, it, expect } from "vitest";
import {
  validateZapRouteResponse,
  validateZapBuildResponse,
} from "@tools/kyberswap/zaas/validation.js";
import { VexError, ErrorCodes } from "../../errors.js";

const ROUTER = "0x0e97c887b61ccd952a53578b04763e7134429e05";

/**
 * Merge a valid strict route/routerAddress pair (Etap 4 requires both) into a
 * partial `data`, so a lenient-field case can exercise its field without
 * tripping the strict route/routerAddress checks.
 */
function withRoute(data: Record<string, unknown>): Record<string, unknown> {
  return { route: "encoded_route", routerAddress: ROUTER, ...data };
}

describe("validateZapRouteResponse — equivalence", () => {
  it("non-record root throws plain Error (not VexError) with exact message", () => {
    for (const bad of [null, undefined, 42, "x", true, [1, 2]]) {
      try {
        validateZapRouteResponse(bad);
        throw new Error("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        expect(err).not.toBeInstanceOf(VexError);
        expect((err as Error).message).toBe("Expected ZaaS route response object");
      }
    }
  });

  it("parses a full valid response", () => {
    const raw = {
      code: 0,
      message: "ok",
      data: {
        routeSummary: { foo: "bar" },
        zapDetails: { actions: [] },
        route: "encoded_route",
        routerAddress: ROUTER,
        poolDetails: { category: "concentrated", token0: "0xaaa", token1: "0xbbb", fee: 3000, address: "0xpool" },
        positionDetails: { tokenId: "123", tickLower: -100, tickUpper: 100, liquidity: "999" },
        gas: "21000",
        gasUsd: "1.50",
      },
      requestId: "req-1",
    };
    const r = validateZapRouteResponse(raw);
    expect(r.code).toBe(0);
    expect(r.message).toBe("ok");
    expect(r.data.routeSummary).toEqual({ foo: "bar" });
    expect(r.data.zapDetails).toEqual({ actions: [] });
    expect(r.data.route).toBe("encoded_route");
    expect(r.data.routerAddress).toBe(ROUTER);
    expect(r.data.poolDetails).toEqual({ category: "concentrated", token0: "0xaaa", token1: "0xbbb", fee: 3000, address: "0xpool" });
    expect(r.data.positionDetails).toEqual({ tokenId: "123", tickLower: -100, tickUpper: 100, liquidity: "999" });
    expect(r.data.gas).toBe("21000");
    expect(r.data.gasUsd).toBe("1.50");
    expect(r.requestId).toBe("req-1");
  });

  it("defaults every OTHER field when only route/routerAddress are provided", () => {
    const r = validateZapRouteResponse({ data: withRoute({}) });
    expect(r.code).toBe(0); // missing code → 0
    expect(r.message).toBeUndefined();
    expect(r.data.routeSummary).toBeUndefined();
    expect(r.data.zapDetails).toBeUndefined();
    expect(r.data.route).toBe("encoded_route");
    expect(r.data.routerAddress).toBe(ROUTER);
    expect(r.data.poolDetails).toBeUndefined();
    expect(r.data.positionDetails).toBeUndefined();
    expect(r.data.gas).toBeUndefined();
    expect(r.data.gasUsd).toBeUndefined();
    expect(r.requestId).toBeUndefined();
  });

  // Etap 4: non-record `data` → {} → the strict route check fails closed.
  it("non-record data collapses to {} → strict route check throws", () => {
    try {
      validateZapRouteResponse({ code: 1, data: "not-a-record" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(VexError);
      expect((err as VexError).code).toBe(ErrorCodes.KYBER_API_ERROR);
      expect((err as VexError).message).toBe("Invalid KyberSwap ZaaS response: missing data.route");
    }
  });

  // Etap 4: route/routerAddress are STRICT required non-empty strings.
  it("missing data.route → VexError(KYBER_API_ERROR) with exact field-path message", () => {
    try {
      validateZapRouteResponse({ data: { routerAddress: ROUTER } });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(VexError);
      expect((err as VexError).code).toBe(ErrorCodes.KYBER_API_ERROR);
      expect((err as VexError).message).toBe("Invalid KyberSwap ZaaS response: missing data.route");
    }
  });

  it("missing data.routerAddress → VexError(KYBER_API_ERROR) with exact field-path message", () => {
    try {
      validateZapRouteResponse({ data: { route: "encoded_route" } });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(VexError);
      expect((err as VexError).code).toBe(ErrorCodes.KYBER_API_ERROR);
      expect((err as VexError).message).toBe("Invalid KyberSwap ZaaS response: missing data.routerAddress");
    }
  });

  it("empty-string route throws (strict, not lenient); non-string routerAddress throws", () => {
    expect(() => validateZapRouteResponse({ data: { route: "", routerAddress: ROUTER } })).toThrow(VexError);
    expect(() => validateZapRouteResponse({ data: { route: "r", routerAddress: 5 } })).toThrow(VexError);
  });

  it("route checked BEFORE routerAddress (first failure wins)", () => {
    try {
      validateZapRouteResponse({ data: {} });
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as VexError).message).toBe("Invalid KyberSwap ZaaS response: missing data.route");
    }
  });

  it("code accepts ±Infinity (proves NOT z.number())", () => {
    expect(validateZapRouteResponse({ code: Infinity, data: withRoute({}) }).code).toBe(Infinity);
    expect(validateZapRouteResponse({ code: -Infinity, data: withRoute({}) }).code).toBe(-Infinity);
  });

  it("code accepts NaN (proves NOT zNumberField — original had no NaN check)", () => {
    expect(Number.isNaN(validateZapRouteResponse({ code: NaN, data: withRoute({}) }).code)).toBe(true);
  });

  it("non-number code (string) falls back to 0", () => {
    expect(validateZapRouteResponse({ code: "5", data: withRoute({}) }).code).toBe(0);
  });

  it("empty-string gas/gasUsd PASS (bare typeof string, not asOptionalString)", () => {
    const r = validateZapRouteResponse({ data: withRoute({ gas: "", gasUsd: "" }) });
    expect(r.data.gas).toBe("");
    expect(r.data.gasUsd).toBe("");
  });

  it("empty-string message/requestId become undefined (asOptionalString drops '')", () => {
    const r = validateZapRouteResponse({ message: "", requestId: "", data: withRoute({}) });
    expect(r.message).toBeUndefined();
    expect(r.requestId).toBeUndefined();
  });

  it("routeSummary preserves any non-nullish value; null/undefined → undefined", () => {
    expect(validateZapRouteResponse({ data: withRoute({ routeSummary: 0 }) }).data.routeSummary).toBe(0);
    expect(validateZapRouteResponse({ data: withRoute({ routeSummary: [1, 2] }) }).data.routeSummary).toEqual([1, 2]);
    expect(validateZapRouteResponse({ data: withRoute({ routeSummary: null }) }).data.routeSummary).toBeUndefined();
    expect(validateZapRouteResponse({ data: withRoute({ routeSummary: "s" }) }).data.routeSummary).toBe("s");
  });

  it("zapDetails preserved only when record, else undefined", () => {
    expect(validateZapRouteResponse({ data: withRoute({ zapDetails: { a: 1 } }) }).data.zapDetails).toEqual({ a: 1 });
    expect(validateZapRouteResponse({ data: withRoute({ zapDetails: "x" }) }).data.zapDetails).toBeUndefined();
    expect(validateZapRouteResponse({ data: withRoute({ zapDetails: [1] }) }).data.zapDetails).toBeUndefined();
  });

  it("poolDetails: built record but per-field type mismatches → undefined fields", () => {
    const r = validateZapRouteResponse({
      data: withRoute({ poolDetails: { category: 123, token0: "0xa", fee: "nope", address: 5 } }),
    });
    expect(r.data.poolDetails).toEqual({
      category: undefined,
      token0: "0xa",
      token1: undefined,
      fee: undefined,
      address: undefined,
    });
  });

  it("positionDetails: number fields accept NaN/Infinity (bare typeof number)", () => {
    const r = validateZapRouteResponse({
      data: withRoute({ positionDetails: { tokenId: "1", tickLower: NaN, tickUpper: Infinity, liquidity: "9" } }),
    });
    expect(r.data.positionDetails?.tokenId).toBe("1");
    expect(Number.isNaN(r.data.positionDetails?.tickLower)).toBe(true);
    expect(r.data.positionDetails?.tickUpper).toBe(Infinity);
  });

  it("non-record poolDetails/positionDetails → whole sub-object undefined", () => {
    const r = validateZapRouteResponse({ data: withRoute({ poolDetails: "x", positionDetails: [1] }) });
    expect(r.data.poolDetails).toBeUndefined();
    expect(r.data.positionDetails).toBeUndefined();
  });
});

describe("validateZapBuildResponse — equivalence", () => {
  it("non-record root throws plain Error (not VexError) with exact message", () => {
    for (const bad of [null, undefined, 1, "x", [1]]) {
      try {
        validateZapBuildResponse(bad);
        throw new Error("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        expect(err).not.toBeInstanceOf(VexError);
        expect((err as Error).message).toBe("Expected ZaaS build response object");
      }
    }
  });

  it("parses a full valid response", () => {
    const r = validateZapBuildResponse({
      code: 0,
      message: "ok",
      data: { callData: "0xabcdef", routerAddress: ROUTER, value: "1000" },
      requestId: "req-2",
    });
    expect(r.code).toBe(0);
    expect(r.message).toBe("ok");
    expect(r.data.callData).toBe("0xabcdef");
    expect(r.data.routerAddress).toBe(ROUTER);
    expect(r.data.value).toBe("1000");
    expect(r.requestId).toBe("req-2");
  });

  it("callData falls back to data.data via nullish coalescing", () => {
    const r = validateZapBuildResponse({ data: { data: "0x123456", routerAddress: ROUTER } });
    expect(r.data.callData).toBe("0x123456");
  });

  it("missing callData AND data.data → VexError(KYBER_API_ERROR) with exact field-path message", () => {
    try {
      validateZapBuildResponse({ data: { routerAddress: ROUTER } });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(VexError);
      expect((err as VexError).code).toBe(ErrorCodes.KYBER_API_ERROR);
      expect((err as VexError).message).toBe("Invalid KyberSwap ZaaS response: missing data.callData");
    }
  });

  it("empty-string callData does NOT fall through to data.data (??) → throws on empty callData", () => {
    // `"" ?? data.data` keeps "" (?? is nullish), then asString("") throws.
    try {
      validateZapBuildResponse({ data: { callData: "", data: "0xfallback", routerAddress: ROUTER } });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(VexError);
      expect((err as VexError).code).toBe(ErrorCodes.KYBER_API_ERROR);
      expect((err as VexError).message).toBe("Invalid KyberSwap ZaaS response: missing data.callData");
    }
  });

  it("missing routerAddress → VexError(KYBER_API_ERROR) with exact field-path message", () => {
    try {
      validateZapBuildResponse({ data: { callData: "0xabc" } });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(VexError);
      expect((err as VexError).code).toBe(ErrorCodes.KYBER_API_ERROR);
      expect((err as VexError).message).toBe("Invalid KyberSwap ZaaS response: missing data.routerAddress");
    }
  });

  it("callData checked BEFORE routerAddress (first failure wins, matching original order)", () => {
    try {
      validateZapBuildResponse({ data: {} });
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as VexError).message).toBe("Invalid KyberSwap ZaaS response: missing data.callData");
    }
  });

  it("non-record data → {} → strict callData throws (data fields all missing)", () => {
    try {
      validateZapBuildResponse({ data: "not-a-record" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(VexError);
      expect((err as VexError).message).toBe("Invalid KyberSwap ZaaS response: missing data.callData");
    }
  });

  it("value defaults to '0' when missing or non-string", () => {
    expect(validateZapBuildResponse({ data: { callData: "0xabc", routerAddress: ROUTER } }).data.value).toBe("0");
    expect(validateZapBuildResponse({ data: { callData: "0xabc", routerAddress: ROUTER, value: 5 } }).data.value).toBe("0");
  });

  it("empty-string value PASSES (bare typeof string, not asOptionalString)", () => {
    expect(validateZapBuildResponse({ data: { callData: "0xabc", routerAddress: ROUTER, value: "" } }).data.value).toBe("");
  });

  it("code accepts ±Infinity and NaN; non-number → 0", () => {
    expect(validateZapBuildResponse({ code: Infinity, data: { callData: "0xa", routerAddress: ROUTER } }).code).toBe(Infinity);
    expect(Number.isNaN(validateZapBuildResponse({ code: NaN, data: { callData: "0xa", routerAddress: ROUTER } }).code)).toBe(true);
    expect(validateZapBuildResponse({ code: "x", data: { callData: "0xa", routerAddress: ROUTER } }).code).toBe(0);
  });

  it("empty-string message/requestId become undefined", () => {
    const r = validateZapBuildResponse({ message: "", requestId: "", data: { callData: "0xa", routerAddress: ROUTER } });
    expect(r.message).toBeUndefined();
    expect(r.requestId).toBeUndefined();
  });
});
