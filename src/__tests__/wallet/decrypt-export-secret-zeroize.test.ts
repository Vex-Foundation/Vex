/**
 * Focused unit test for `decryptExportSecret`'s Solana plaintext-buffer
 * zeroization. The decrypted secret-key bytes are an internal, mutable buffer
 * that never leaves the function, so the only way to assert it is wiped is to
 * mock the keystore layer and hand the helper a buffer we keep a reference to.
 *
 * The real-crypto decrypt / verify / missing-file behaviour lives in
 * `inventory.test.ts` (real temp-dir keystores); this file deliberately mocks
 * the keystore + solana-keystore modules so it can inspect the buffer state
 * before and after the call.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const RECORDED_ADDRESS = "So11111111111111111111111111111111111111112";

// The buffer handed back by the mocked decrypt — we keep the reference so we
// can assert it is zeroed in place after the call.
const SECRET_BYTES = new Uint8Array(64).fill(7);
// Snapshot of the bytes as they looked when `encodeSolanaSecretKey` ran, to
// prove encoding happened BEFORE the zeroize (not on an already-wiped buffer).
let bytesAtEncode: number[] | null = null;

const mockDeriveSolanaAddress = vi.fn<(b: Uint8Array) => string>(
  () => RECORDED_ADDRESS,
);

vi.mock("@tools/wallet/keystore.js", () => ({
  // Truthy stub so `decryptExportSecret` does not short-circuit to
  // KEYSTORE_NOT_FOUND. The EVM branch is not exercised here.
  loadKeystoreFile: () => ({ version: 1 }),
  decryptPrivateKey: vi.fn(),
}));

vi.mock("@tools/wallet/solana-keystore.js", () => ({
  decryptSolanaSecretKey: async () => SECRET_BYTES,
  deriveSolanaAddress: (b: Uint8Array) => mockDeriveSolanaAddress(b),
  encodeSolanaSecretKey: (b: Uint8Array) => {
    bytesAtEncode = Array.from(b);
    return "base58-encoded-secret";
  },
}));

const { decryptExportSecret } = await import("@tools/wallet/inventory.js");

const SOLANA_ENTRY = {
  id: "sol_11111111-1111-1111-1111-111111111111",
  address: RECORDED_ADDRESS,
  label: "Solana",
  createdAt: "2026-01-01T00:00:00.000Z",
};

afterEach(() => {
  SECRET_BYTES.fill(7);
  bytesAtEncode = null;
  mockDeriveSolanaAddress.mockReset();
});

describe("decryptExportSecret — Solana buffer zeroization", () => {
  it("zeroizes the decrypted secret-key buffer after a successful encode", async () => {
    mockDeriveSolanaAddress.mockReturnValue(RECORDED_ADDRESS);

    const out = await decryptExportSecret({
      family: "solana",
      entry: SOLANA_ENTRY,
      password: "pw",
    });

    expect(out.format).toBe("base58");
    // The encoder saw the LIVE (non-zero) bytes…
    expect(bytesAtEncode).not.toBeNull();
    expect(bytesAtEncode?.every((b) => b === 7)).toBe(true);
    // …and the buffer is wiped in place afterwards.
    expect(Array.from(SECRET_BYTES).every((b) => b === 0)).toBe(true);
  });

  it("zeroizes the decrypted secret-key buffer even when the verify fails", async () => {
    mockDeriveSolanaAddress.mockReturnValue(
      "DifferentAddr1111111111111111111111111111111",
    );

    await expect(
      decryptExportSecret({
        family: "solana",
        entry: SOLANA_ENTRY,
        password: "pw",
      }),
    ).rejects.toThrow();

    // Verify threw before encoding, but the `finally` still wiped the buffer.
    expect(bytesAtEncode).toBeNull();
    expect(Array.from(SECRET_BYTES).every((b) => b === 0)).toBe(true);
  });
});
