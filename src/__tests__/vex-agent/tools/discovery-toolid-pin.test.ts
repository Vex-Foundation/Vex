/**
 * Exact / unique-prefix toolId pin in discovery ranking.
 *
 * A query that IS a toolId names its own answer; dense similarity over
 * capability prose is the wrong instrument for it. Ordinary intent phrases must
 * be completely unaffected.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { discoverProtocolCapabilities } from "../../../vex-agent/tools/protocols/runtime.js";
import { pinExactToolIdMatch } from "../../../vex-agent/tools/protocols/toolid-pin.js";
import { PROTOCOL_TOOLS } from "../../../vex-agent/tools/protocols/catalog.js";
import type { ScoredManifest } from "../../../vex-agent/tools/protocols/lexical-score.js";

function manifest(toolId: string) {
  const found = PROTOCOL_TOOLS.find((m) => m.toolId === toolId);
  if (!found) throw new Error(`fixture drift: ${toolId} is not a catalog manifest`);
  return found;
}

function scoredOf(...toolIds: string[]): ScoredManifest[] {
  return toolIds.map((toolId, index) => ({
    manifest: manifest(toolId),
    score: 1 - index / 10,
    whyMatched: ["dense"],
  }));
}

describe("pinExactToolIdMatch", () => {
  const candidates = [...PROTOCOL_TOOLS];

  it("pins an exact toolId to rank 0 with whyMatched: toolId", () => {
    const scored = scoredOf("dexscreener.trending", "dexscreener.search");
    const pinned = pinExactToolIdMatch("dexscreener.search", candidates, scored);
    expect(pinned[0]!.manifest.toolId).toBe("dexscreener.search");
    expect(pinned[0]!.whyMatched).toEqual(["toolId"]);
  });

  it("is case-insensitive and whitespace-trimmed", () => {
    const pinned = pinExactToolIdMatch("  DexScreener.Search  ", candidates, scoredOf("dexscreener.trending"));
    expect(pinned[0]!.manifest.toolId).toBe("dexscreener.search");
  });

  it("keeps the relative order of the remaining rows and de-duplicates the pin", () => {
    const scored = scoredOf("dexscreener.trending", "dexscreener.search", "dexscreener.boosts");
    const pinned = pinExactToolIdMatch("dexscreener.search", candidates, scored);
    expect(pinned.map((e) => e.manifest.toolId)).toEqual([
      "dexscreener.search",
      "dexscreener.trending",
      "dexscreener.boosts",
    ]);
  });

  it("pins a prefix that uniquely names one candidate", () => {
    const target = "dexscreener.communityTakeovers";
    const prefix = target.slice(0, target.length - 3).toLowerCase();
    const unique = PROTOCOL_TOOLS.filter((m) => m.toolId.toLowerCase().startsWith(prefix));
    expect(unique, "fixture drift: prefix is no longer unique").toHaveLength(1);

    const pinned = pinExactToolIdMatch(prefix, candidates, scoredOf("dexscreener.trending"));
    expect(pinned[0]!.manifest.toolId).toBe(target);
  });

  it("does not pin an ambiguous prefix", () => {
    const scored = scoredOf("dexscreener.trending", "dexscreener.search");
    const pinned = pinExactToolIdMatch("dexscreener.", candidates, scored);
    expect(pinned.map((e) => e.manifest.toolId)).toEqual(["dexscreener.trending", "dexscreener.search"]);
  });

  it("does not treat an intent phrase as a toolId", () => {
    const scored = scoredOf("dexscreener.trending", "dexscreener.search");
    const pinned = pinExactToolIdMatch("trending meme tokens on solana", candidates, scored);
    expect(pinned).toEqual(scored);
  });

  it("does not pin when the toolId is not among the candidates", () => {
    const scored = scoredOf("dexscreener.trending");
    const pinned = pinExactToolIdMatch("dexscreener.search", [manifest("dexscreener.trending")], scored);
    expect(pinned).toEqual(scored);
  });
});

describe("discovery ranking with a toolId query", () => {
  const ENV_KEYS = ["JUPITER_API_KEY", "EMBEDDING_BASE_URL", "EMBEDDING_MODEL", "EMBEDDING_DIM", "EMBEDDING_PROVIDER"] as const;
  const original: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) original[k] = process.env[k];
    process.env.JUPITER_API_KEY = "test-jupiter-key";
    delete process.env.EMBEDDING_BASE_URL;
    delete process.env.EMBEDDING_MODEL;
    delete process.env.EMBEDDING_DIM;
    delete process.env.EMBEDDING_PROVIDER;
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
  });

  it("returns the named tool first, with its param schema", async () => {
    const result = await discoverProtocolCapabilities({ query: "dexscreener.search", limit: 5 });
    const top = result.tools[0]!;
    expect(top.toolId).toBe("dexscreener.search");
    expect(top.whyMatched).toEqual(["toolId"]);
    expect(Array.isArray(top.params)).toBe(true);
  });

  it("does not pin on an ordinary intent query", async () => {
    const result = await discoverProtocolCapabilities({ query: "trending meme tokens", limit: 5 });
    for (const tool of result.tools) expect(tool.whyMatched).not.toEqual(["toolId"]);
  });

  it("does not pin a tool the namespace filter excluded", async () => {
    const result = await discoverProtocolCapabilities({
      query: "dexscreener.search",
      namespace: "khalani",
      limit: 5,
    });
    for (const tool of result.tools) expect(tool.toolId.startsWith("khalani.")).toBe(true);
  });
});
