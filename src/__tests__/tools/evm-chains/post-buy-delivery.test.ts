/**
 * Post-buy delivery verification (Phase A1).
 *
 * Live incident 2026-08-10 (Robinhood Chain 4663): a confirmed
 * `kyberswap.swap.execute` buy of 43,932 TOM emitted a Transfer log to the
 * wallet, the settlement decoder read it, and `balanceOf(wallet)` was ZERO.
 * The agent spent ~15 tool calls and five minutes retrying the exit, blaming
 * "indexer lag", because nothing on the buy path ever asked the token what the
 * wallet actually held.
 *
 * The contract pinned here is deliberately narrow: ONE `balanceOf` read, and a
 * claim only when it returns exactly zero. A non-zero balance says nothing new,
 * and a failed read says nothing at all - neither may produce agent-facing text.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { createPublicClient, http, type Address, type Chain, type PublicClient, type Transport } from "viem";
import { mainnet } from "viem/chains";

const warn = vi.fn();
vi.mock("@utils/logger.js", () => ({
  default: { warn: (...args: unknown[]) => warn(...args), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const { verifyPostBuyDelivery } = await import("@tools/evm-chains/post-buy-delivery.js");

const TOKEN = "0x8BA2546F49799782bC799055c268d3c0C63699b8" as Address;
const OWNER = "0x1111111111111111111111111111111111111111" as Address;

/**
 * A real viem public client with only `readContract` replaced, so the fake
 * still satisfies the client contract the primitive is typed against (same
 * pattern as `local-chain-balance-sync.test.ts`).
 */
const baseClient: PublicClient<Transport, Chain> = createPublicClient({
  chain: mainnet,
  transport: http("http://127.0.0.1:1"),
});

function request(readContract: ReturnType<typeof vi.fn>) {
  return {
    client: Object.assign(baseClient, { readContract }),
    tokenAddress: TOKEN,
    owner: OWNER,
    chainLabel: "robinhood",
    txHash: "0xabc",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("verifyPostBuyDelivery", () => {
  it("returns the observation verdict when balanceOf is exactly zero", async () => {
    const verdict = await verifyPostBuyDelivery(request(vi.fn().mockResolvedValue(0n)));

    expect(verdict).not.toBeNull();
    expect(verdict).toContain("balanceOf returned zero immediately after the confirmed buy");
    expect(verdict).toContain("fake-transfer/honeypot delivery failure");
    expect(verdict).toContain("do not retry the sale on this evidence");
  });

  it("claims nothing when the wallet holds any of the token", async () => {
    expect(await verifyPostBuyDelivery(request(vi.fn().mockResolvedValue(1n)))).toBeNull();
    expect(await verifyPostBuyDelivery(request(vi.fn().mockResolvedValue(43_932n * 10n ** 18n)))).toBeNull();
  });

  it("makes NO agent-facing claim when the read fails, and warns once", async () => {
    const verdict = await verifyPostBuyDelivery(request(vi.fn().mockRejectedValue(new Error("https://rpc.internal.example/secret-key timed out"))));

    expect(verdict).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    const [event, fields] = warn.mock.calls[0] ?? [];
    expect(event).toBe("evm_chains.post_buy_delivery.read_failed");
    expect(JSON.stringify(fields)).not.toContain("rpc.internal.example");
  });

  it("does not use an em dash in agent-facing text (owner decree 2026-08-05)", async () => {
    const verdict = await verifyPostBuyDelivery(request(vi.fn().mockResolvedValue(0n)));

    expect(verdict).not.toContain("—");
  });
});
