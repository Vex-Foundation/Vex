import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { Keypair } from "@solana/web3.js";
import { privateKeyToAddress } from "viem/accounts";
import { ErrorCodes } from "../../errors.js";

const { testDir, testConfigFile, testKeystoreFile, testSolanaKeystoreFile } = vi.hoisted(() => {
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");
  const _testDir = join(tmpdir(), `vex-auth-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return {
    testDir: _testDir,
    testConfigFile: join(_testDir, "config.json"),
    testKeystoreFile: join(_testDir, "keystore.json"),
    testSolanaKeystoreFile: join(_testDir, "solana-keystore.json"),
  };
});

const TEST_PASSWORD = "test-password-multi-auth";

vi.mock("@config/paths.js", () => {
  const { join } = require("node:path");
  return {
    CONFIG_DIR: testDir,
    CONFIG_FILE: testConfigFile,
    KEYSTORE_FILE: testKeystoreFile,
    SOLANA_KEYSTORE_FILE: testSolanaKeystoreFile,
    ENV_FILE: join(testDir, ".env"),
    BACKUPS_DIR: join(testDir, "backups"),
  };
});

vi.mock("@utils/env.js", () => ({
  requireKeystorePassword: vi.fn(() => TEST_PASSWORD),
  getKeystorePassword: vi.fn(() => TEST_PASSWORD),
}));

vi.mock("@utils/logger.js", () => ({
  default: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const { loadConfig, saveConfig, getDefaultConfig } = await import("@config/store.js");
const { encryptPrivateKey, saveKeystore } = await import("@tools/wallet/keystore.js");
const { encryptSolanaSecretKey, saveSolanaKeystore, deriveSolanaAddress } = await import("@tools/wallet/solana-keystore.js");
const { requireEvmWallet, requireSolanaWallet, requireWalletForChain } = await import("@tools/wallet/multi-auth.js");
const { registerPrimaryLegacyWallet } = await import("@tools/wallet/inventory.js");

const TEST_EVM_PRIVATE_KEY = "0x" + "ab".repeat(32);
const TEST_EVM_ADDRESS = privateKeyToAddress(TEST_EVM_PRIVATE_KEY as `0x${string}`);

describe("multi-auth", () => {
  beforeEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
  });

  describe("requireEvmWallet", () => {
    it("returns EVM wallet when config and keystore are present", () => {
      saveKeystore(encryptPrivateKey(TEST_EVM_PRIVATE_KEY, TEST_PASSWORD));
      registerPrimaryLegacyWallet("evm", TEST_EVM_ADDRESS);

      const wallet = requireEvmWallet();

      expect(wallet.family).toBe("eip155");
      expect(wallet.address).toBe(TEST_EVM_ADDRESS);
      expect(wallet.privateKey).toBe(TEST_EVM_PRIVATE_KEY.toLowerCase());
    });

    it("throws WALLET_NOT_CONFIGURED when no EVM address in config", () => {
      const cfg = getDefaultConfig();
      saveConfig(cfg);

      expect(() => requireEvmWallet()).toThrow();
      try {
        requireEvmWallet();
      } catch (err: unknown) {
        expect((err as { code: string }).code).toBe(ErrorCodes.WALLET_NOT_CONFIGURED);
      }
    });

    it("throws KEYSTORE_NOT_FOUND when no keystore file exists", () => {
      registerPrimaryLegacyWallet("evm", TEST_EVM_ADDRESS);

      expect(() => requireEvmWallet()).toThrow();
      try {
        requireEvmWallet();
      } catch (err: unknown) {
        expect((err as { code: string }).code).toBe(ErrorCodes.KEYSTORE_NOT_FOUND);
      }
    });
  });

  describe("requireSolanaWallet", () => {
    it("returns Solana wallet when config and keystore are present", () => {
      const keypair = Keypair.generate();
      const address = deriveSolanaAddress(keypair.secretKey);

      saveSolanaKeystore(encryptSolanaSecretKey(keypair.secretKey, TEST_PASSWORD));
      registerPrimaryLegacyWallet("solana", address);

      const wallet = requireSolanaWallet();

      expect(wallet.family).toBe("solana");
      expect(wallet.address).toBe(address);
      expect(wallet.secretKey).toBeInstanceOf(Uint8Array);
      expect(wallet.secretKey.length).toBe(64);
    });

    it("throws WALLET_NOT_CONFIGURED when no Solana address in config", () => {
      const cfg = getDefaultConfig();
      saveConfig(cfg);

      expect(() => requireSolanaWallet()).toThrow();
      try {
        requireSolanaWallet();
      } catch (err: unknown) {
        expect((err as { code: string }).code).toBe(ErrorCodes.WALLET_NOT_CONFIGURED);
      }
    });

    it("throws KHALANI_SOLANA_KEYSTORE_NOT_FOUND when no Solana keystore file", () => {
      registerPrimaryLegacyWallet("solana", "11111111111111111111111111111111");

      expect(() => requireSolanaWallet()).toThrow();
      try {
        requireSolanaWallet();
      } catch (err: unknown) {
        expect((err as { code: string }).code).toBe(ErrorCodes.KHALANI_SOLANA_KEYSTORE_NOT_FOUND);
      }
    });

    it("throws KHALANI_ADDRESS_MISMATCH when keystore address differs from config", () => {
      const keypair = Keypair.generate();

      saveSolanaKeystore(encryptSolanaSecretKey(keypair.secretKey, TEST_PASSWORD));
      registerPrimaryLegacyWallet("solana", "FakeSolanaAddressDoesNotMatchKeystore111111111");

      expect(() => requireSolanaWallet()).toThrow();
      try {
        requireSolanaWallet();
      } catch (err: unknown) {
        expect((err as { code: string }).code).toBe(ErrorCodes.KHALANI_ADDRESS_MISMATCH);
      }
    });
  });

  describe("requireWalletForChain", () => {
    it("routes eip155 to requireEvmWallet", () => {
      saveKeystore(encryptPrivateKey(TEST_EVM_PRIVATE_KEY, TEST_PASSWORD));
      registerPrimaryLegacyWallet("evm", TEST_EVM_ADDRESS);

      const wallet = requireWalletForChain("eip155");

      expect(wallet.family).toBe("eip155");
    });

    it("routes solana to requireSolanaWallet", () => {
      const keypair = Keypair.generate();
      const address = deriveSolanaAddress(keypair.secretKey);

      saveSolanaKeystore(encryptSolanaSecretKey(keypair.secretKey, TEST_PASSWORD));
      registerPrimaryLegacyWallet("solana", address);

      const wallet = requireWalletForChain("solana");

      expect(wallet.family).toBe("solana");
    });
  });
});
