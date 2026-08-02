/**
 * Protocol-mark resolver — the curated venue→logo matrix behind the small
 * round mark beside every activity row's badge.
 *
 * Pins the same doctrine `token-marks.test.ts` pins for tokens: a bundled
 * asset is granted ONLY to a venue actually present in the curated map, every
 * other value degrades to a monogram, and nothing ever resolves to a remote
 * URL. The venue strings below are the complete vocabulary the tools emit
 * (`khalani`, `kyberswap`, `pendle`, `relay`, `trench`, `uniswap`, `jupiter`,
 * `dexscreener`, `polymarket`, plus the `solana`/`virtuals` toolId
 * namespaces); `polymarket` and `solana` deliberately have no bundled asset
 * and MUST take the monogram rather than borrow another brand's mark —
 * `/protocols/jupiter.jpg` is Jupiter's mark, not Solana's.
 *
 * This map is a LOOK-UP of venue artwork, NOT a list of what a feed can
 * contain — `agent-scan/agent-scan-protocols.ts` owns that, and the two must
 * not be conflated (they were once, and it put two always-empty options in the
 * Agent Scan protocol filter).
 */

import { describe, expect, it } from "vitest";
import { isCuratedProtocol, resolveProtocolMark } from "../protocol-marks.js";

describe("resolveProtocolMark — curated venues", () => {
  it.each([
    ["dexscreener", "/protocols/dexscreener.jpg", "DexScreener"],
    ["jupiter", "/protocols/jupiter.jpg", "Jupiter"],
    ["khalani", "/protocols/khalani.svg", "Khalani"],
    ["kyberswap", "/protocols/kyberswap.svg", "KyberSwap"],
    ["pendle", "/protocols/pendle.jpg", "Pendle"],
    ["relay", "/protocols/relay.png", "Relay"],
    ["trench", "/protocols/trench.jpg", "Trench Express"],
    ["uniswap", "/protocols/uniswap.png", "Uniswap"],
    ["virtuals", "/logo/virtuals.svg", "Virtuals"],
  ])("resolves %s to its bundled asset", (protocol, src, label) => {
    const mark = resolveProtocolMark(protocol);
    expect(mark).toEqual({ kind: "local", src, label });
  });

  it("normalizes casing and surrounding whitespace before matching", () => {
    expect(resolveProtocolMark("  KyberSwap ")).toEqual({
      kind: "local",
      src: "/protocols/kyberswap.svg",
      label: "KyberSwap",
    });
  });
});

describe("resolveProtocolMark — fallbacks", () => {
  it("gives a KNOWN venue with no bundled asset the monogram, never another brand's mark", () => {
    expect(resolveProtocolMark("polymarket")).toEqual({
      kind: "monogram",
      label: "Polymarket",
      initial: "P",
    });
  });

  it("gives solana the monogram — jupiter.jpg is Jupiter's mark, never Solana's", () => {
    const mark = resolveProtocolMark("solana");
    expect(mark).toEqual({
      kind: "monogram",
      label: "Solana",
      initial: "S",
    });
  });

  it("gives an UNKNOWN venue a monogram built from its own sanitized text", () => {
    expect(resolveProtocolMark("someNewDex")).toEqual({
      kind: "monogram",
      label: "someNewDex",
      initial: "S",
    });
  });

  it("returns null when there is no venue at all — the row renders no mark", () => {
    expect(resolveProtocolMark(null)).toBeNull();
    expect(resolveProtocolMark("")).toBeNull();
    expect(resolveProtocolMark("   ")).toBeNull();
  });

  it("bounds a hostile/overlong venue string so it can never stretch a row", () => {
    const mark = resolveProtocolMark("x".repeat(500));
    expect(mark?.kind).toBe("monogram");
    expect(mark?.label.length).toBeLessThanOrEqual(32);
  });

  it("never resolves to a remote URL — every curated src is a bundled same-origin path", () => {
    for (const protocol of [
      "dexscreener",
      "jupiter",
      "khalani",
      "kyberswap",
      "pendle",
      "relay",
      "trench",
      "uniswap",
      "virtuals",
    ]) {
      const mark = resolveProtocolMark(protocol);
      expect(mark?.kind).toBe("local");
      if (mark?.kind === "local") {
        // Same-origin bundled path only — `/protocols/*` (venue artwork) or
        // `/logo/*` (marks the landing surfaces already ship). Never a URL.
        expect(mark.src).toMatch(/^\/(protocols|logo)\//);
      }
    }
  });
});

describe("isCuratedProtocol — the gate for UNTRUSTED venue strings", () => {
  it("recognises a curated venue regardless of case or padding", () => {
    expect(isCuratedProtocol("kyberswap")).toBe(true);
    expect(isCuratedProtocol("  KyberSwap ")).toBe(true);
    expect(isCuratedProtocol("solana")).toBe(true);
  });

  it.each([
    ["a lookalike", "kyberswapp"],
    ["an arbitrary namespace", "totally_new_venue"],
    ["empty", ""],
  ])("rejects %s so it can never earn a venue title", (_label, protocol) => {
    expect(isCuratedProtocol(protocol)).toBe(false);
  });

  it("rejects null", () => {
    expect(isCuratedProtocol(null)).toBe(false);
  });
});
