/**
 * Prologue play policy — the decision table and the rehydration sanitiser.
 *
 * These call the REAL exported functions (no re-implementation of the rule
 * in the assertions). The module is pure: storage itself lives in
 * `stores/uiStore.ts`'s Zustand persist (the sanctioned renderer
 * localStorage path), so what these cases pin is the untrusted-payload
 * boundary and the decision table.
 */

import { describe, expect, it } from "vitest";

import {
  resolveProloguePlay,
  sanitizeStoredPrologueVersion,
} from "../prologue-policy.js";

describe("resolveProloguePlay", () => {
  it("plays FULL on a fresh install (nothing recorded yet)", () => {
    expect(
      resolveProloguePlay({
        appVersion: "0.1.4",
        lastPlayedVersion: null,
        reducedMotion: false,
      }),
    ).toBe("full");
  });

  it("plays FULL again after an app update (recorded version differs)", () => {
    expect(
      resolveProloguePlay({
        appVersion: "0.2.0",
        lastPlayedVersion: "0.1.4",
        reducedMotion: false,
      }),
    ).toBe("full");
  });

  it("CONDENSES on a repeat launch of the same version", () => {
    expect(
      resolveProloguePlay({
        appVersion: "0.1.4",
        lastPlayedVersion: "0.1.4",
        reducedMotion: false,
      }),
    ).toBe("condensed");
  });

  it("plays NOTHING under prefers-reduced-motion, even on a fresh install", () => {
    expect(
      resolveProloguePlay({
        appVersion: "0.1.4",
        lastPlayedVersion: null,
        reducedMotion: true,
      }),
    ).toBe("none");
    // Reduced motion outranks the version bump too.
    expect(
      resolveProloguePlay({
        appVersion: "0.2.0",
        lastPlayedVersion: "0.1.4",
        reducedMotion: true,
      }),
    ).toBe("none");
  });
});

describe("sanitizeStoredPrologueVersion", () => {
  // Storage moved into `uiStore`'s Zustand persist (the sanctioned renderer
  // localStorage path); the payload stays user-writable, so the sanitiser is
  // the boundary these cases pin.
  it("passes a plausible stored version through", () => {
    expect(sanitizeStoredPrologueVersion("1.2.3")).toBe("1.2.3");
  });

  it("answers null for a non-string (never-recorded, hand-edited, corrupt)", () => {
    expect(sanitizeStoredPrologueVersion(null)).toBeNull();
    expect(sanitizeStoredPrologueVersion(undefined)).toBeNull();
    expect(sanitizeStoredPrologueVersion(42)).toBeNull();
    expect(sanitizeStoredPrologueVersion({ v: "1.2.3" })).toBeNull();
  });

  it("rejects a hand-edited empty or oversized value (storage is user-writable)", () => {
    expect(sanitizeStoredPrologueVersion("")).toBeNull();
    expect(sanitizeStoredPrologueVersion("x".repeat(65))).toBeNull();
    expect(sanitizeStoredPrologueVersion("x".repeat(64))).toBe("x".repeat(64));
  });

  it("a rejected stored value resolves to a FULL play end-to-end", () => {
    expect(
      resolveProloguePlay({
        appVersion: "0.1.4",
        lastPlayedVersion: sanitizeStoredPrologueVersion(""),
        reducedMotion: false,
      }),
    ).toBe("full");
  });
});
