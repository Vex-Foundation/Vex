/**
 * Prologue play policy — the decision table and its storage adapter.
 *
 * These call the REAL exported functions (no re-implementation of the rule
 * in the assertions); the storage cases drive the real localStorage that
 * jsdom provides, plus a throwing stub for the disabled-storage path.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PROLOGUE_VERSION_KEY,
  readLastPlayedVersion,
  resolveProloguePlay,
  writeLastPlayedVersion,
} from "../prologue-policy.js";

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

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

describe("version persistence", () => {
  it("round-trips a written version", () => {
    writeLastPlayedVersion("1.2.3");
    expect(readLastPlayedVersion()).toBe("1.2.3");
  });

  it("reads null when nothing was ever recorded", () => {
    expect(readLastPlayedVersion()).toBeNull();
  });

  it("rejects a hand-edited empty or oversized value (storage is user-writable)", () => {
    window.localStorage.setItem(PROLOGUE_VERSION_KEY, "");
    expect(readLastPlayedVersion()).toBeNull();

    window.localStorage.setItem(PROLOGUE_VERSION_KEY, "x".repeat(65));
    expect(readLastPlayedVersion()).toBeNull();
  });

  it("degrades to FULL (null) when storage throws instead of crashing boot", () => {
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });
    expect(readLastPlayedVersion()).toBeNull();
  });

  it("swallows a throwing write — a launch that cannot persist just replays", () => {
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    expect(() => writeLastPlayedVersion("1.2.3")).not.toThrow();
  });

  it("a rejected stored value resolves to a FULL play end-to-end", () => {
    window.localStorage.setItem(PROLOGUE_VERSION_KEY, "");
    expect(
      resolveProloguePlay({
        appVersion: "0.1.4",
        lastPlayedVersion: readLastPlayedVersion(),
        reducedMotion: false,
      }),
    ).toBe("full");
  });
});
