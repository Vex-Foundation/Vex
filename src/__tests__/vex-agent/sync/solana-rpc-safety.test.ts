/**
 * `solana-rpc-safety` — `confirmSolanaMainnetGenesis` (W5 design §4/R3, K3).
 * The SSRF classifier / `selectVerificationRpcUrls` / `solanaRpcCall` pure
 * helpers in this module are MOVED, byte-identical, from
 * `bridge-activity-repair.ts` — already covered by that file's own
 * `bridge-activity-repair-verification.test.ts` (re-export, same import
 * path). This file pins ONLY the new genesis-verification helper this card
 * adds.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

import { confirmSolanaMainnetGenesis, SOLANA_MAINNET_GENESIS } from "@vex-agent/sync/solana-rpc-safety.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function mockRpcResponse(result: unknown, ok = true): void {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: async () => ({ result }),
  }) as unknown as typeof fetch;
}

describe("confirmSolanaMainnetGenesis", () => {
  it("returns true when the endpoint echoes the mainnet-beta genesis hash", async () => {
    mockRpcResponse(SOLANA_MAINNET_GENESIS);
    await expect(confirmSolanaMainnetGenesis("https://example-rpc.test")).resolves.toBe(true);
  });

  it("returns false on a genesis-hash mismatch (wrong/devnet cluster)", async () => {
    mockRpcResponse("SomeOtherGenesisHash1111111111111111111111");
    await expect(confirmSolanaMainnetGenesis("https://example-rpc.test")).resolves.toBe(false);
  });

  it("returns false (never throws) when the RPC call fails", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;
    await expect(confirmSolanaMainnetGenesis("https://example-rpc.test")).resolves.toBe(false);
  });

  it("returns false when the response body is malformed", async () => {
    mockRpcResponse(12345); // not a string
    await expect(confirmSolanaMainnetGenesis("https://example-rpc.test")).resolves.toBe(false);
  });
});
