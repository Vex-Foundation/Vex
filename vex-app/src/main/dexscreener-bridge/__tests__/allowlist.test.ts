/**
 * The bridge's allowlist is the boundary between "a tool asked for a URL" and
 * "Chromium opened it with the site's own Origin". These are the cases that
 * must never pass.
 */

import { describe, expect, it } from "vitest";
import {
  checkHttpUrl,
  checkWsUrl,
  DEXSCREENER_ORIGIN,
  ORIGIN_INJECTION_HOST,
  ORIGIN_INJECTION_URL_PATTERNS,
} from "../allowlist.js";

describe("checkHttpUrl", () => {
  it("allows the measured API endpoints", () => {
    for (const url of [
      "https://io.dexscreener.com/dex/search/v12/pairs?q=CAT",
      "https://io.dexscreener.com/dex/pair-details/v4/solana/abc",
      "https://io.dexscreener.com/metas/v1/all",
      "https://io.dexscreener.com/feed/rpc/dex_feed.PublicService/GetTransactions",
      "https://dd.dexscreener.com/ds-data/dexes",
    ]) {
      expect(checkHttpUrl(url).allowed, url).toBe(true);
    }
  });

  it("refuses another host, a lookalike host, and a subdomain", () => {
    for (const url of [
      "https://dexscreener.com/solana",
      "https://io.dexscreener.com.evil.example/dex/search",
      "https://evil.io.dexscreener.com/dex/search",
      "https://example.com/dex/search",
    ]) {
      const decision = checkHttpUrl(url);
      expect(decision.allowed, url).toBe(false);
      if (!decision.allowed) expect(decision.reason).toContain("host");
    }
  });

  it("refuses an allowed host on a path outside the allowlist", () => {
    const decision = checkHttpUrl("https://io.dexscreener.com/internal/admin");
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toContain("/internal/admin");
  });

  it("refuses non-https schemes and embedded credentials", () => {
    expect(checkHttpUrl("http://io.dexscreener.com/dex/search").allowed).toBe(false);
    expect(checkHttpUrl("file:///etc/passwd").allowed).toBe(false);
    expect(checkHttpUrl("wss://io.dexscreener.com/dex/screener/v7/pairs/h24/1").allowed).toBe(
      false
    );
    expect(
      checkHttpUrl("https://user:pass@io.dexscreener.com/dex/search").allowed
    ).toBe(false);
  });

  it("refuses a path that only looks like an allowed prefix after a traversal", () => {
    // WHATWG URL normalizes `..`, so this resolves to /admin and must fail on
    // the path check rather than pass on the literal string.
    const decision = checkHttpUrl("https://io.dexscreener.com/dex/../admin");
    expect(decision.allowed).toBe(false);
  });
});

describe("checkWsUrl", () => {
  it("allows the measured channels", () => {
    for (const url of [
      "wss://io.dexscreener.com/dex/screener/v7/pairs/h24/1?rankBy[key]=volume",
      "wss://io.dexscreener.com/dex/screener/v7/pair/solana/abc",
      "wss://io.dexscreener.com/dex/screener/v2/tokens/h24/1",
      "wss://io.dexscreener.com/dex/screener/v8/pairs-search",
      "wss://io.dexscreener.com/feed/ws",
    ]) {
      expect(checkWsUrl(url).allowed, url).toBe(true);
    }
  });

  it("refuses ws:, another host, and an unlisted channel", () => {
    expect(checkWsUrl("ws://io.dexscreener.com/feed/ws").allowed).toBe(false);
    expect(checkWsUrl("wss://evil.example/feed/ws").allowed).toBe(false);
    expect(checkWsUrl("wss://io.dexscreener.com/dex/other").allowed).toBe(false);
    expect(checkWsUrl("https://io.dexscreener.com/feed/ws").allowed).toBe(false);
  });
});

describe("origin injection scope", () => {
  it("targets exactly one host on two schemes", () => {
    expect(ORIGIN_INJECTION_HOST).toBe("io.dexscreener.com");
    expect([...ORIGIN_INJECTION_URL_PATTERNS]).toStrictEqual([
      "https://io.dexscreener.com/*",
      "wss://io.dexscreener.com/*",
    ]);
    expect(DEXSCREENER_ORIGIN).toBe("https://dexscreener.com");
  });
});
