/**
 * Tests for wallet-restore — the M8 main-side restore primitive that
 * validates → decrypts → derives → mismatch-confirms → backups →
 * atomic-copies → updates config (codex turn 8 YELLOW #4 ordering).
 *
 * Mocks @vex-lib/wallet so we control engine boundary behavior without
 * touching real keystores. Verifies side-effect ordering via mock call
 * order.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockLoadKeystoreFile = vi.fn();
const mockDecryptPrivateKey = vi.fn();
const mockDecryptSolanaSecretKey = vi.fn();
const mockPrivateKeyToAddress = vi.fn();
const mockGetPrimaryEvmAddress = vi.fn();
const mockGetPrimarySolanaAddress = vi.fn();
const mockRegisterPrimaryLegacyWallet = vi.fn();
const mockSaveKeystoreFile = vi.fn();
const mockAutoBackup = vi.fn();
const mockFsAccess = vi.fn();
const mockKeypairFromSecretKey = vi.fn();

vi.mock("@vex-lib/wallet.js", () => ({
  KEYSTORE_FILE: "/fake/keystore.json",
  SOLANA_KEYSTORE_FILE: "/fake/solana-keystore.json",
  loadKeystoreFile: (path: string) => mockLoadKeystoreFile(path),
  decryptPrivateKey: (ks: unknown, pwd: string) =>
    mockDecryptPrivateKey(ks, pwd),
  decryptSolanaSecretKey: (ks: unknown, pwd: string) =>
    mockDecryptSolanaSecretKey(ks, pwd),
  privateKeyToAddress: (pk: string) => mockPrivateKeyToAddress(pk),
  getPrimaryEvmAddress: () => mockGetPrimaryEvmAddress(),
  getPrimarySolanaAddress: () => mockGetPrimarySolanaAddress(),
  registerPrimaryLegacyWallet: (family: string, address: string) =>
    mockRegisterPrimaryLegacyWallet(family, address),
  saveKeystoreFile: (path: string, ks: unknown) =>
    mockSaveKeystoreFile(path, ks),
  autoBackup: () => mockAutoBackup(),
}));

vi.mock("@solana/web3.js", () => ({
  Keypair: {
    fromSecretKey: (key: Uint8Array) => mockKeypairFromSecretKey(key),
  },
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    promises: {
      ...actual.promises,
      access: (path: string) => mockFsAccess(path),
    },
  };
});

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

class FakeVexError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "VexError";
  }
}

const { restoreWalletFromFile } = await import("../wallet-restore.js");

const fakeKeystore = {
  version: 1 as const,
  ciphertext: "x",
  iv: "y",
  salt: "z",
  tag: "t",
  kdf: { name: "scrypt" as const, N: 16384, r: 8, p: 1, dkLen: 32 },
};

const evmAddress = "0xabcdef0123456789abcdef0123456789abcdef01";
const otherEvmAddress = "0x0000000000000000000000000000000000000001";
const solanaAddress = "DRpbCBMxVnDK7maPM5tGv6MvCsx1WTokJBKVz5Pk5Hxe";

beforeEach(() => {
  mockLoadKeystoreFile.mockReset();
  mockDecryptPrivateKey.mockReset();
  mockDecryptSolanaSecretKey.mockReset();
  mockPrivateKeyToAddress.mockReset();
  mockGetPrimaryEvmAddress.mockReset();
  mockGetPrimarySolanaAddress.mockReset();
  mockRegisterPrimaryLegacyWallet.mockReset();
  mockSaveKeystoreFile.mockReset();
  mockAutoBackup.mockReset();
  mockFsAccess.mockReset();
  mockKeypairFromSecretKey.mockReset();

  // Defaults: file exists, decrypt succeeds, no existing primary wallet.
  mockFsAccess.mockResolvedValue(undefined);
  mockLoadKeystoreFile.mockReturnValue(fakeKeystore);
  mockDecryptPrivateKey.mockReturnValue("0xprivatekey");
  mockPrivateKeyToAddress.mockReturnValue(evmAddress);
  mockGetPrimaryEvmAddress.mockReturnValue(null);
  mockGetPrimarySolanaAddress.mockReturnValue(null);
  mockAutoBackup.mockResolvedValue(null);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("restoreWalletFromFile (EVM happy path)", () => {
  it("restores when no existing wallet - backup is null", async () => {
    const result = await restoreWalletFromFile({
      chain: "evm",
      sourcePath: "/some/keystore.json",
      password: "correct",
      confirmReplace: async () => true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.chain).toBe("evm");
      expect(result.data.address).toBe(evmAddress);
      expect(result.data.replacedAddress).toBeNull();
      expect(result.data.backupDir).toBeNull();
    }
    expect(mockSaveKeystoreFile).toHaveBeenCalledWith(
      "/fake/keystore.json",
      fakeKeystore
    );
    expect(mockRegisterPrimaryLegacyWallet).toHaveBeenCalledWith(
      "evm",
      evmAddress
    );
  });
});

describe("restoreWalletFromFile (validation order)", () => {
  it("returns validation.invalid_input when source file missing (no backup, no decrypt)", async () => {
    mockFsAccess.mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" })
    );
    const result = await restoreWalletFromFile({
      chain: "evm",
      sourcePath: "/nope.json",
      password: "x",
      confirmReplace: async () => true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation.invalid_input");
    expect(mockAutoBackup).not.toHaveBeenCalled();
    expect(mockSaveKeystoreFile).not.toHaveBeenCalled();
    expect(mockDecryptPrivateKey).not.toHaveBeenCalled();
  });

  it("maps wrong-password VexError(KEYSTORE_DECRYPT_FAILED) to wallet.password_invalid (no backup, no copy)", async () => {
    mockDecryptPrivateKey.mockImplementation(() => {
      throw new FakeVexError(
        "KEYSTORE_DECRYPT_FAILED",
        "Decryption failed: wrong password or corrupted keystore"
      );
    });
    const result = await restoreWalletFromFile({
      chain: "evm",
      sourcePath: "/keystore.json",
      password: "wrong",
      confirmReplace: async () => true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("wallet.password_invalid");
    expect(mockAutoBackup).not.toHaveBeenCalled();
    expect(mockSaveKeystoreFile).not.toHaveBeenCalled();
    expect(mockRegisterPrimaryLegacyWallet).not.toHaveBeenCalled();
  });

  it("maps malformed-keystore VexError(KEYSTORE_CORRUPT) to wallet.keystore_corrupt", async () => {
    mockLoadKeystoreFile.mockImplementation(() => {
      throw new FakeVexError("KEYSTORE_CORRUPT", "Bad shape");
    });
    const result = await restoreWalletFromFile({
      chain: "evm",
      sourcePath: "/bad.json",
      password: "x",
      confirmReplace: async () => true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("wallet.keystore_corrupt");
    expect(mockAutoBackup).not.toHaveBeenCalled();
  });
});

describe("restoreWalletFromFile (mismatch confirmation)", () => {
  it("calls confirmReplace when existing address differs; aborts on cancel", async () => {
    mockGetPrimaryEvmAddress.mockReturnValue(otherEvmAddress);
    const confirmReplace = vi.fn().mockResolvedValue(false);
    const result = await restoreWalletFromFile({
      chain: "evm",
      sourcePath: "/keystore.json",
      password: "x",
      confirmReplace,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("wallet.user_rejected");
    expect(confirmReplace).toHaveBeenCalledWith({
      chain: "evm",
      existingAddress: otherEvmAddress,
      incomingAddress: evmAddress,
    });
    expect(mockAutoBackup).not.toHaveBeenCalled();
    expect(mockSaveKeystoreFile).not.toHaveBeenCalled();
  });

  it("proceeds when confirmReplace returns true - backup, copy, config in order", async () => {
    mockGetPrimaryEvmAddress.mockReturnValue(otherEvmAddress);
    mockAutoBackup.mockResolvedValue("/home/user/.config/vex/backups/T123");
    const callLog: string[] = [];
    mockAutoBackup.mockImplementation(async () => {
      callLog.push("autoBackup");
      return "/home/user/.config/vex/backups/T123";
    });
    mockSaveKeystoreFile.mockImplementation(() => {
      callLog.push("saveKeystoreFile");
    });
    mockRegisterPrimaryLegacyWallet.mockImplementation(() => {
      callLog.push("registerPrimaryLegacyWallet");
    });

    const result = await restoreWalletFromFile({
      chain: "evm",
      sourcePath: "/keystore.json",
      password: "x",
      confirmReplace: async () => true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.replacedAddress).toBe(otherEvmAddress);
      expect(result.data.backupDir).toBe(
        "/home/user/.config/vex/backups/T123"
      );
    }
    expect(callLog).toEqual([
      "autoBackup",
      "saveKeystoreFile",
      "registerPrimaryLegacyWallet",
    ]);
  });

  it("does NOT call confirmReplace when existing address matches (idempotent re-restore)", async () => {
    mockGetPrimaryEvmAddress.mockReturnValue(evmAddress);
    const confirmReplace = vi.fn();
    const result = await restoreWalletFromFile({
      chain: "evm",
      sourcePath: "/keystore.json",
      password: "x",
      confirmReplace,
    });
    expect(result.ok).toBe(true);
    expect(confirmReplace).not.toHaveBeenCalled();
  });
});

describe("restoreWalletFromFile (Solana)", () => {
  it("derives Solana address via Keypair.fromSecretKey", async () => {
    mockDecryptSolanaSecretKey.mockReturnValue(new Uint8Array(64));
    mockKeypairFromSecretKey.mockReturnValue({
      publicKey: { toBase58: () => solanaAddress },
    });
    const result = await restoreWalletFromFile({
      chain: "solana",
      sourcePath: "/sol-keystore.json",
      password: "correct",
      confirmReplace: async () => true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.address).toBe(solanaAddress);
    expect(mockSaveKeystoreFile).toHaveBeenCalledWith(
      "/fake/solana-keystore.json",
      fakeKeystore
    );
    expect(mockRegisterPrimaryLegacyWallet).toHaveBeenCalledWith(
      "solana",
      solanaAddress
    );
  });
});
