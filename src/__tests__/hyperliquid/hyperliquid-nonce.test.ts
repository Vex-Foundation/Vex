import { afterEach, describe, expect, it, vi } from "vitest";
import { HyperliquidNonceAllocator } from "@tools/hyperliquid/nonce.js";
import { HyperliquidSigner } from "@tools/hyperliquid/signer.js";

describe("HyperliquidNonceAllocator", () => {
  it("issues strictly monotonic values for a synchronous burst per wallet", () => {
    const allocator = new HyperliquidNonceAllocator();
    const issued = Array.from({ length: 1_000 }, () => allocator.next("0xABC", 1_700_000_000_000));
    expect(issued[0]).toBe(1_700_000_000_000);
    expect(new Set(issued).size).toBe(issued.length);
    for (let index = 1; index < issued.length; index += 1) {
      expect(issued[index]).toBe(issued[index - 1]! + 1);
    }
  });

  it("keeps nonce streams independent by address", () => {
    const allocator = new HyperliquidNonceAllocator();
    expect(allocator.next("0xa", 100)).toBe(100);
    expect(allocator.next("0xb", 100)).toBe(100);
  });

  it("shares the runtime allocator between independently-created signers for the same wallet", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const wallet = {
      address: "0x5e9ee1089755c3435139848e47e6635505d5a13a" as const,
      privateKey: "0x0123456789012345678901234567890123456789012345678901234567890123" as const,
    };
    const first = new HyperliquidSigner({ network: "mainnet", resolveWallet: () => wallet });
    const second = new HyperliquidSigner({ network: "mainnet", resolveWallet: () => wallet });

    const firstNonce = first.nextNonce();
    const secondNonce = second.nextNonce();
    expect(secondNonce).toBe(firstNonce + 1);
  });
});

afterEach(() => vi.restoreAllMocks());
