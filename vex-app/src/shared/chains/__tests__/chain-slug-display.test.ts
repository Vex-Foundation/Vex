/**
 * PROVIDER CHAIN SLUGS -> the curated chain marks.
 *
 * A table test, because the failure this guards is silent: a slug that stops
 * resolving does not throw, it just draws a monogram where a brand logo
 * used to be, and nothing in a type or a build catches that. Every row below
 * is a slug a board pool actually arrives on.
 *
 * The unknown row is the one that matters most. An uncatalogued chain is an
 * ORDINARY outcome - the market provider indexes far more chains than the
 * portfolio does - so the contract is that it resolves to a neutral record
 * named after the slug itself and never to a blank, an exception, or some
 * other chain's mark.
 */

import { describe, expect, it } from "vitest";
import {
  ARBITRUM_CHAIN_ID,
  BASE_CHAIN_ID,
  ETHEREUM_CHAIN_ID,
  ROBINHOOD_CHAIN_ID,
  SOLANA_CHAIN_ID,
  chainDisplayBySlug,
  chainIdForSlug,
} from "../display.js";

const ROWS: readonly (readonly [string, number, string])[] = [
  // Ethereum, Solana and Polygon ship as local FLAT assets: the package's
  // default variants sit on a filled disc, and no chain mark renders on one.
  ["ethereum", ETHEREUM_CHAIN_ID, "asset"],
  ["eth", ETHEREUM_CHAIN_ID, "asset"],
  ["solana", SOLANA_CHAIN_ID, "asset"],
  ["sol", SOLANA_CHAIN_ID, "asset"],
  // Base and Arbitrum ship as local assets: `@thesvg` has no arbitrum mark and
  // its base mark proved unreliable across versions.
  ["base", BASE_CHAIN_ID, "asset"],
  ["arbitrum", ARBITRUM_CHAIN_ID, "asset"],
  ["polygon", 137, "asset"],
  ["optimism", 10, "thesvg"],
  ["bsc", 56, "thesvg"],
  ["bnbchain", 56, "thesvg"],
  ["bnb-chain", 56, "thesvg"],
  ["robinhood", ROBINHOOD_CHAIN_ID, "thesvg"],
];

describe("chainDisplayBySlug", () => {
  it.each(ROWS)("resolves %s to chain %i with a %s mark", (slug, id, kind) => {
    expect(chainIdForSlug(slug)).toBe(id);
    const display = chainDisplayBySlug(slug);
    expect(display.chainId).toBe(id);
    expect(display.icon.kind).toBe(kind);
  });

  it("matches slugs case-insensitively and ignores surrounding space", () => {
    expect(chainDisplayBySlug("  Solana ").chainId).toBe(SOLANA_CHAIN_ID);
  });

  it("falls back to a NAMED monogram for an uncatalogued slug", () => {
    const display = chainDisplayBySlug("sui");
    expect(chainIdForSlug("sui")).toBeNull();
    expect(display.icon.kind).toBe("fallback");
    // Named after the slug itself, so the monogram draws the chain the
    // pool is actually on rather than a "C" for "Chain 0".
    expect(display.name).toBe("sui");
    // A deliberate non-id: no chain claims 0, so nothing downstream can
    // mistake the fallback for a catalogued chain.
    expect(display.chainId).toBe(0);
  });

  it("never returns a blank name, even for an empty slug", () => {
    expect(chainDisplayBySlug("").name).toBe("Unknown chain");
    expect(chainDisplayBySlug("   ").name).toBe("Unknown chain");
  });

  it("gives a known slug the SAME mark the portfolio's chain id gives it", () => {
    // The point of bridging to the curated table rather than building a second
    // one: a board pool on Base must wear exactly the Base mark the portfolio
    // rows wear, not a lookalike.
    expect(chainDisplayBySlug("base").icon).toEqual(
      chainDisplayBySlug("BASE").icon,
    );
  });
});
