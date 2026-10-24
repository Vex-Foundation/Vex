/**
 * Every chain the Watchlist page offers resolves in the engine's own closed
 * set, so the picker never offers a chain the service would refuse.
 */

import { describe, expect, it } from "vitest";
import { resolveWatchChain } from "@vex-agent/engine/wake/watch/token-price/chain-domain.js";
import { WATCHLIST_CHAINS } from "@shared/alerts-chains.js";

describe("WATCHLIST_CHAINS", () => {
  it.each(WATCHLIST_CHAINS.map((chain) => [chain.slug, chain.family] as const))(
    "%s resolves to itself in the engine's set",
    (slug, family) => {
      expect(resolveWatchChain(slug)).toEqual({ slug, family });
    },
  );

  it("has no duplicates", () => {
    const slugs = WATCHLIST_CHAINS.map((chain) => chain.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});
