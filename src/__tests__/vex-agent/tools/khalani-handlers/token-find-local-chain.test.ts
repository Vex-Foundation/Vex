/**
 * `TokenFind` on a LOCAL chain (Robinhood, 4663).
 *
 * Robinhood Chain is a chain Vex fully supports — it just is not in Khalani's
 * token registry. Asking `TokenFind chainIds:"robinhood"` used to return the
 * strict resolver's bare "Unsupported chain: robinhood", which reads as a
 * spelling mistake and sends the agent hunting for a better spelling of
 * something no spelling reaches through this tool.
 *
 * The capability boundary itself does NOT move (`tools/khalani/chains.ts` stays
 * Khalani-only, per `registry.ts:11-16`): the chain is still not resolved here.
 * Only the ANSWER changes — it names the real situation and the tools that can
 * actually answer the question.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@tools/khalani/client.js", () => ({
  getKhalaniClient: () => ({
    searchTokens: async () => ({ data: [] }),
    getTopTokens: async () => [],
  }),
}));

vi.mock("@tools/khalani/chains.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tools/khalani/chains.js")>();
  return {
    ...actual,
    // A registry that genuinely does NOT cover Robinhood.
    getCachedKhalaniChains: async () => [
      { id: 8453, name: "Base", type: "eip155" },
      { id: 42161, name: "Arbitrum", type: "eip155" },
    ],
  };
});

const { parseChainIds } = await import(
  "@vex-agent/tools/protocols/khalani/handlers/read.js"
);
const { VexError, ErrorCodes } = await import("../../../../errors.js");

describe("parseChainIds — a local-only chain gets an agent-actionable refusal", () => {
  it.each(["robinhood", "4663"])("names the chain and the tools that CAN answer (%s)", async (input) => {
    let thrown: unknown;
    try {
      await parseChainIds(input);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(VexError);
    if (!(thrown instanceof VexError)) return;
    expect(thrown.code).toBe(ErrorCodes.KHALANI_UNSUPPORTED_CHAIN);
    expect(thrown.message).toContain("4663");
    expect(thrown.message).toContain("Khalani's registry");
    // The three routes that actually work for a local chain.
    expect(thrown.hint).toContain("dexscreener__pairs_search");
    expect(thrown.hint).toContain("WalletTrackToken");
    expect(thrown.hint).toContain("WalletBalances");
  });

  it("still resolves a Khalani chain normally", async () => {
    await expect(parseChainIds("8453")).resolves.toEqual([8453]);
  });

  it("flags the local chain even when mixed into a list", async () => {
    await expect(parseChainIds("8453,robinhood")).rejects.toThrow(/4663/);
  });

  it("returns undefined for an absent filter", async () => {
    await expect(parseChainIds(undefined)).resolves.toBeUndefined();
  });
});
