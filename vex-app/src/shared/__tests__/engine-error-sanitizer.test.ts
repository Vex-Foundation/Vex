/**
 * Behavior of the pure engine-error detail sanitizer. Every test name states
 * the invariant; the seams are exercised exactly on the boundary and one step
 * past it (15 vs 16 hex, cap vs cap+1).
 */

import { describe, expect, it } from "vitest";
import {
  ENGINE_ERROR_DETAIL_MAX_LENGTH,
  sanitizeEngineErrorDetail,
} from "../engine-error-sanitizer.js";

/** Deterministic pseudo-random hex of `length` digits (property-style seeds). */
function hexOf(length: number, seed: number): string {
  const digits = "0123456789abcdef";
  let state = seed;
  let out = "";
  for (let i = 0; i < length; i += 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    out += digits[state % 16];
  }
  return out;
}

describe("sanitizeEngineErrorDetail", () => {
  it("returns null for non-string, empty and whitespace-only input", () => {
    expect(sanitizeEngineErrorDetail(null)).toBeNull();
    expect(sanitizeEngineErrorDetail(undefined)).toBeNull();
    expect(sanitizeEngineErrorDetail(42)).toBeNull();
    expect(sanitizeEngineErrorDetail("")).toBeNull();
    expect(sanitizeEngineErrorDetail("   \n\t ")).toBeNull();
  });

  it("passes ordinary provider prose through unchanged", () => {
    expect(
      sanitizeEngineErrorDetail("Rate limit exceeded: free-models-per-day"),
    ).toBe("Rate limit exceeded: free-models-per-day");
  });

  it("a URL never survives: scheme URLs collapse to [url]", () => {
    expect(
      sanitizeEngineErrorDetail(
        "fetch to https://openrouter.ai/api/v1/chat?key=abc failed",
      ),
    ).toBe("fetch to [url] failed");
    expect(sanitizeEngineErrorDetail("see www.example.com/path for status")).toBe(
      "see [url] for status",
    );
  });

  it("a bearer token never survives, case-insensitively", () => {
    expect(
      sanitizeEngineErrorDetail("401 with header Authorization: Bearer abc.DEF-123"),
    ).toBe("401 with header Authorization: [token]");
    expect(sanitizeEngineErrorDetail("bearer xyz987 rejected")).toBe(
      "[token] rejected",
    );
  });

  it("an sk- style provider key never survives", () => {
    expect(
      sanitizeEngineErrorDetail("invalid key sk-or-v1-0123456789abcdef supplied"),
    ).toBe("invalid key [key] supplied");
  });

  it("hex seam: 15 hex digits stay data, 16 become [hex]", () => {
    // 15 digits: below the blob threshold, legitimate short id.
    const fifteen = hexOf(15, 7);
    expect(sanitizeEngineErrorDetail(`id ${fifteen} failed`)).toBe(
      `id ${fifteen} failed`,
    );
    // 16 digits: exactly at the threshold, could be key material.
    const sixteen = hexOf(16, 7);
    expect(sanitizeEngineErrorDetail(`id ${sixteen} failed`)).toBe(
      "id [hex] failed",
    );
  });

  it("0x seam: sixteen hex digits after 0x redact, fifteen stay", () => {
    const fifteen = `0x${hexOf(15, 11)}`;
    const sixteen = `0x${hexOf(16, 11)}`;
    expect(sanitizeEngineErrorDetail(`tx ${fifteen} reverted`)).toBe(
      `tx ${fifteen} reverted`,
    );
    expect(sanitizeEngineErrorDetail(`tx ${sixteen} reverted`)).toBe(
      "tx [hex] reverted",
    );
  });

  it("a 0x wallet address (40 hex) never survives", () => {
    expect(
      sanitizeEngineErrorDetail(
        "insufficient funds for 0x52908400098527886E0F7030069857D2E4169EE7",
      ),
    ).toBe("insufficient funds for [hex]");
  });

  it("property: no generated secret of any supported shape ever survives", () => {
    for (let seed = 1; seed <= 50; seed += 1) {
      const secrets = [
        `sk-${hexOf(24, seed)}`,
        `Bearer ${hexOf(32, seed)}`,
        `0x${hexOf(64, seed)}`,
        hexOf(16 + (seed % 48), seed),
        `https://example.com/${hexOf(8, seed)}`,
      ];
      for (const secret of secrets) {
        const out = sanitizeEngineErrorDetail(`fail: ${secret} :end`);
        expect(out).not.toBeNull();
        expect(out).not.toContain(secret);
      }
    }
  });

  it("whitespace runs and newlines collapse to single spaces", () => {
    expect(sanitizeEngineErrorDetail("line one\n\n  line   two\t end")).toBe(
      "line one line two end",
    );
  });

  it("cap seam: at the cap the text survives whole, one char past it is cut to the cap", () => {
    // "z" is deliberately non-hex so the cap is the only rule in play.
    const atCap = "z".repeat(ENGINE_ERROR_DETAIL_MAX_LENGTH);
    expect(sanitizeEngineErrorDetail(atCap)).toBe(atCap);
    const pastCap = "z".repeat(ENGINE_ERROR_DETAIL_MAX_LENGTH + 1);
    expect(sanitizeEngineErrorDetail(pastCap)).toBe(atCap);
  });

  it("input that is nothing but redactions still reports the redaction marks, never null prose loss", () => {
    expect(sanitizeEngineErrorDetail(`Bearer ${hexOf(32, 3)}`)).toBe("[token]");
  });
});
