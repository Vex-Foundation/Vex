import { describe, expect, it } from "vitest";
import {
  ENGINE_ERROR_DETAIL_MAX_LENGTH,
  sanitizeEngineErrorDetail,
} from "../../../vex-agent/engine/runtime/error-detail-sanitizer.js";

/**
 * Boundary cases for the emit-side sanitizer. INVARIANT twin: the same
 * table protects `vex-app/src/shared/engine-error-sanitizer.ts` - the two
 * implementations cannot import each other across the package boundary, so
 * identical cases pin identical behavior on both sides.
 */
describe("engine-error detail sanitizer (emit side)", () => {
  it("a 15-hex-digit blob stays data while 16 digits become [hex]", () => {
    expect(sanitizeEngineErrorDetail("id abc123abc123abc")).toBe(
      "id abc123abc123abc",
    );
    expect(sanitizeEngineErrorDetail("id abc123abc123abc1")).toBe("id [hex]");
    expect(sanitizeEngineErrorDetail("tx 0xabc123abc123abc1")).toBe("tx [hex]");
  });

  it("an sk- provider key never passes, bare or embedded in prose", () => {
    expect(sanitizeEngineErrorDetail("call failed for sk-live-SECRET1")).toBe(
      "call failed for [key]",
    );
  });

  it("a bearer token collapses to [token]", () => {
    expect(sanitizeEngineErrorDetail("auth Bearer abc.def.ghi rejected")).toBe(
      "auth [token] rejected",
    );
  });

  it("a URL dies before narrower patterns so an embedded key cannot survive", () => {
    expect(
      sanitizeEngineErrorDetail("GET https://api.x.io/v1?key=sk-embedded123 504"),
    ).toBe("GET [url] 504");
  });

  it("output is capped at the max length; the cap-exact string passes whole", () => {
    // "z" deliberately: a long run of hex letters would itself be a blob.
    const exact = "z".repeat(ENGINE_ERROR_DETAIL_MAX_LENGTH);
    expect(sanitizeEngineErrorDetail(exact)).toBe(exact);
    expect(sanitizeEngineErrorDetail(exact + "y")?.length).toBe(
      ENGINE_ERROR_DETAIL_MAX_LENGTH,
    );
  });

  it("non-strings and whitespace-only input yield null, never an empty string", () => {
    expect(sanitizeEngineErrorDetail(undefined)).toBeNull();
    expect(sanitizeEngineErrorDetail(42)).toBeNull();
    expect(sanitizeEngineErrorDetail("   ")).toBeNull();
  });
});
