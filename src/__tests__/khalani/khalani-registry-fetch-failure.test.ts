/**
 * The ONE Khalani chain-registry condition that is genuinely transient, and
 * therefore the only one allowed to tell the agent to retry (owner decision
 * 2026-08-17). Its counterpart - a chain the registry was read and does not
 * serve - is asserted in `khalani-chains.test.ts` to carry NO retry framing.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

const khalaniClient = vi.hoisted(() => ({ getChains: vi.fn() }));
vi.mock("@tools/khalani/client.js", () => ({ getKhalaniClient: () => khalaniClient }));

import { getCachedKhalaniChains, clearKhalaniChainsCache } from "@tools/khalani/chains.js";
import { ErrorCodes } from "../../errors.js";

beforeEach(() => {
  clearKhalaniChainsCache();
  khalaniClient.getChains.mockReset();
});

describe("getCachedKhalaniChains", () => {
  it("keeps the retry wording when the registry FETCH fails, and preserves the cause", async () => {
    const cause = new Error("upstream 503");
    khalaniClient.getChains.mockRejectedValue(cause);

    await expect(getCachedKhalaniChains()).rejects.toMatchObject({
      code: ErrorCodes.KHALANI_UNSUPPORTED_CHAIN,
      hint: expect.stringContaining("retry this tool later"),
      retryable: true,
      cause,
    });
  });

  it("does not cache a failure - the next call retries the fetch", async () => {
    khalaniClient.getChains.mockRejectedValueOnce(new Error("upstream 503"));
    await expect(getCachedKhalaniChains()).rejects.toThrow();

    khalaniClient.getChains.mockResolvedValueOnce([
      { type: "eip155", id: 1, name: "Ethereum", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 } },
    ]);
    await expect(getCachedKhalaniChains()).resolves.toHaveLength(1);
  });
});
