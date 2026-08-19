/**
 * CHAIN COVERAGE prompt section - pinned render.
 *
 * The section's whole value is that it is STATIC: a live number entering it
 * would invalidate the prompt-prefix KV cache on every turn. So the render is
 * pinned byte-for-byte here, and a registry change that moves it fails this
 * test rather than quietly costing a cache hit on every request.
 */

import { describe, expect, it } from "vitest";
import { buildChainCoveragePrompt } from "@vex-agent/engine/prompts/chain-coverage.js";

const EXPECTED = [
  "## Chain Coverage",
  "Before planning an action on a chain, confirm you can REACH it and LEAVE it: the venues per chain are listed below and do not change within a session, while live bridge reach is in the turn state. A chain you can swap on but cannot bridge off is a position you can enter and not exit, so check the bridge column before committing funds, not after.",
  "Bridge column: `khalani+relay` means both bridges are expected to serve the chain and the router picks one automatically; `RELAY ONLY` means Khalani does not serve it and every bridge goes through Relay. The column is a pinned snapshot, so confirm a route by quoting before relying on it.",
  "- Ethereum (1): swap, lend, fixed yield | bridge khalani+relay",
  "- Optimism (10): swap, lend, fixed yield | bridge khalani+relay",
  "- BSC (56): swap, fixed yield | bridge khalani+relay",
  "- Unichain (130): swap, lend | bridge khalani+relay",
  "- Polygon (137): swap, lend | bridge khalani+relay",
  "- Monad (143): swap, lend, fixed yield | bridge khalani+relay",
  "- Sonic (146): swap, fixed yield | bridge RELAY ONLY",
  "- HyperEVM (999): swap, lend, fixed yield | bridge RELAY ONLY",
  "- Ronin (2020): swap | bridge RELAY ONLY",
  "- MegaETH (4326): swap | bridge RELAY ONLY",
  "- Robinhood Chain (4663): swap, lend, launch | bridge RELAY ONLY",
  "- Mantle (5000): swap, fixed yield | bridge khalani+relay",
  "- Base (8453): swap, lend, fixed yield | bridge khalani+relay",
  "- Plasma (9745): swap, fixed yield | bridge RELAY ONLY",
  "- Arbitrum (42161): swap, lend, fixed yield | bridge khalani+relay",
  "- Avalanche (43114): swap | bridge khalani+relay",
  "- Linea (59144): swap | bridge khalani+relay",
  "- Berachain (80094): swap, fixed yield | bridge khalani+relay",
  "- Solana: swap, lend via `solana.*` (Jupiter). Not an EVM chain and not in the table above; its bridge reach is in the turn state.",
].join("\n");

describe("buildChainCoveragePrompt", () => {
  it("renders the pinned coverage section", () => {
    expect(buildChainCoveragePrompt()).toBe(EXPECTED);
  });

  it("is stable across calls and carries no live value", () => {
    expect(buildChainCoveragePrompt()).toBe(buildChainCoveragePrompt());
  });

  it("does not list Etherlink, removed on 2026-08-17", () => {
    expect(buildChainCoveragePrompt()).not.toContain("Etherlink");
    expect(buildChainCoveragePrompt()).not.toContain("42793");
  });
});
