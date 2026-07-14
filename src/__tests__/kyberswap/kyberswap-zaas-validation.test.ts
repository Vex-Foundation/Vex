import { describe, it, expect } from "vitest";
import { validateZapRouteResponse, validateZapBuildResponse } from "@tools/kyberswap/zaas/validation.js";
import { VexError, ErrorCodes } from "../../errors.js";

describe("validateZapRouteResponse", () => {
  it("rejects non-object", () => {
    expect(() => validateZapRouteResponse(null)).toThrow();
  });

  it("parses valid response", () => {
    const raw = { code: 0, data: { route: "encoded_route", routerAddress: "0x0e97c887b61ccd952a53578b04763e7134429e05" } };
    const result = validateZapRouteResponse(raw);
    expect(result.code).toBe(0);
    expect(result.data.route).toBe("encoded_route");
    expect(result.data.routerAddress).toBe("0x0e97c887b61ccd952a53578b04763e7134429e05");
  });

  it("keeps other optional fields lenient when route/routerAddress are present", () => {
    const raw = { code: 0, data: { route: "r", routerAddress: "0x0e97c887b61ccd952a53578b04763e7134429e05" } };
    const result = validateZapRouteResponse(raw);
    expect(result.data.routeSummary).toBeUndefined();
    expect(result.data.zapDetails).toBeUndefined();
    expect(result.data.poolDetails).toBeUndefined();
    expect(result.data.gas).toBeUndefined();
  });

  // Etap 4: route/routerAddress are now STRICT required non-empty strings.
  it("throws VexError(KYBER_API_ERROR) when data.route is missing", () => {
    try {
      validateZapRouteResponse({ code: 0, data: { routerAddress: "0x0e97c887b61ccd952a53578b04763e7134429e05" } });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(VexError);
      expect((err as VexError).code).toBe(ErrorCodes.KYBER_API_ERROR);
      expect((err as VexError).message).toBe("Invalid KyberSwap ZaaS response: missing data.route");
    }
  });

  it("throws VexError(KYBER_API_ERROR) when data.routerAddress is missing", () => {
    try {
      validateZapRouteResponse({ code: 0, data: { route: "encoded_route" } });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(VexError);
      expect((err as VexError).code).toBe(ErrorCodes.KYBER_API_ERROR);
      expect((err as VexError).message).toBe("Invalid KyberSwap ZaaS response: missing data.routerAddress");
    }
  });

  it("throws when data is empty (both strict fields missing; route checked first)", () => {
    try {
      validateZapRouteResponse({ code: 0, data: {} });
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as VexError).message).toBe("Invalid KyberSwap ZaaS response: missing data.route");
    }
  });
});

describe("validateZapBuildResponse", () => {
  it("rejects non-object", () => {
    expect(() => validateZapBuildResponse(null)).toThrow();
  });

  it("parses callData from data.callData", () => {
    const raw = {
      code: 0,
      data: { callData: "0xabcdef", routerAddress: "0x0e97c887b61ccd952a53578b04763e7134429e05", value: "1000" },
    };
    const result = validateZapBuildResponse(raw);
    expect(result.data.callData).toBe("0xabcdef");
    expect(result.data.value).toBe("1000");
  });

  it("falls back to data.data for callData", () => {
    const raw = {
      code: 0,
      data: { data: "0x123456", routerAddress: "0x0e97c887b61ccd952a53578b04763e7134429e05" },
    };
    const result = validateZapBuildResponse(raw);
    expect(result.data.callData).toBe("0x123456");
  });

  it("defaults value to '0' when missing", () => {
    const raw = {
      code: 0,
      data: { callData: "0xabc", routerAddress: "0x0e97c887b61ccd952a53578b04763e7134429e05" },
    };
    const result = validateZapBuildResponse(raw);
    expect(result.data.value).toBe("0");
  });
});
