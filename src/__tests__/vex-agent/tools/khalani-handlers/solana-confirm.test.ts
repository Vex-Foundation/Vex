/**
 * Phase-2 FIX-ROUND-1 blocker 2 — `confirmSolanaSignature` must INSPECT the RPC
 * confirmation result. `Connection.confirmTransaction` RESOLVES (does not reject)
 * for a transaction that landed on-chain but FAILED — the failure is carried in
 * `value.err`. Treating any resolved response as success would confirm a reverted
 * Solana deposit and submit it to Khalani.
 *
 * This pins the real function (the executor suite mocks it away) against a mocked
 * `@solana/web3.js` Connection: `value.err === null` → confirmed; a non-null
 * `value.err` → reverted (never confirmed); an RPC/network error → throws (the
 * staged caller maps that to an ambiguous outcome, never a false success).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockConfirmTransaction = vi.fn();

vi.mock("@solana/web3.js", () => ({
  Connection: class {
    constructor(_rpcUrl: string, _commitment: string) {}
    confirmTransaction(...args: unknown[]) {
      return mockConfirmTransaction(...args);
    }
  },
  // Imported at module load by the signing helpers — unused by confirmSolanaSignature.
  Keypair: { fromSecretKey: () => ({}) },
  VersionedTransaction: class {
    static deserialize() {
      return { sign() {}, serialize: () => new Uint8Array(), signatures: [] };
    }
  },
}));

import { confirmSolanaSignature } from "@tools/khalani/solana-signer.js";

describe("confirmSolanaSignature — inspects the RPC confirmation result (blocker 2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("a resolved confirmation with value.err === null is confirmed", async () => {
    mockConfirmTransaction.mockResolvedValue({ context: { slot: 1 }, value: { err: null } });
    await expect(confirmSolanaSignature("https://rpc.example", "SIG")).resolves.toEqual({ status: "confirmed" });
  });

  it("a resolved confirmation with a non-null object value.err is REVERTED, never confirmed", async () => {
    mockConfirmTransaction.mockResolvedValue({ context: { slot: 1 }, value: { err: { InstructionError: [0, { Custom: 1 }] } } });
    const result = await confirmSolanaSignature("https://rpc.example", "SIG");
    expect(result.status).toBe("reverted");
  });

  it("a string value.err is surfaced verbatim as the revert error", async () => {
    mockConfirmTransaction.mockResolvedValue({ context: { slot: 1 }, value: { err: "AccountInUse" } });
    const result = await confirmSolanaSignature("https://rpc.example", "SIG");
    expect(result).toEqual({ status: "reverted", error: "AccountInUse" });
  });

  it("an RPC error THROWS (mapped to ambiguous by the caller), never a false success", async () => {
    mockConfirmTransaction.mockRejectedValue(new Error("rpc down"));
    await expect(confirmSolanaSignature("https://rpc.example", "SIG")).rejects.toThrow("rpc down");
  });
});
