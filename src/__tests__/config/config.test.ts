import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock the paths module before importing store
const testDir = join(tmpdir(), `vex-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const testConfigFile = join(testDir, "config.json");
const testKeystoreFile = join(testDir, "keystore.json");

vi.mock("@config/paths.js", () => ({
  CONFIG_DIR: testDir,
  CONFIG_FILE: testConfigFile,
  KEYSTORE_FILE: testKeystoreFile,
}));

// Import after mocking
const { loadConfig, saveConfig, saveConfigPatch, getDefaultConfig, configExists, ensureConfigDir } = await import(
  "@config/store.js"
);

describe("config store", () => {
  beforeEach(() => {
    // Clean up test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
  });

  afterEach(() => {
    // Clean up test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
  });

  describe("getDefaultConfig", () => {
    it("should return valid default config", () => {
      const config = getDefaultConfig();

      expect(config.version).toBe(1);
      expect(config.chain.chainId).toBe(1);
      expect(config.chain.rpcUrl).toBe("https://ethereum-rpc.publicnode.com");
      expect(config.chain.nativeCurrency.symbol).toBe("ETH");
      expect(config.wallet.evm).toEqual([]);
      expect(config.wallet.solana).toEqual([]);
    });
  });

  describe("ensureConfigDir", () => {
    it("should create config directory if not exists", () => {
      expect(existsSync(testDir)).toBe(false);

      ensureConfigDir();

      expect(existsSync(testDir)).toBe(true);
    });

    it("should not fail if directory already exists", () => {
      mkdirSync(testDir, { recursive: true });
      expect(existsSync(testDir)).toBe(true);

      // Should not throw
      ensureConfigDir();

      expect(existsSync(testDir)).toBe(true);
    });
  });

  describe("loadConfig", () => {
    it("should return defaults when config file does not exist", () => {
      const config = loadConfig();

      expect(config.version).toBe(1);
      expect(config.chain.chainId).toBe(1);
    });

    it("should load existing config file", () => {
      mkdirSync(testDir, { recursive: true });

      const customConfig = {
        version: 1,
        chain: {
          chainId: 1,
          rpcUrl: "https://custom-rpc.example.com",
          explorerUrl: "https://explorer.example.com",
        },
        wallet: {
          address: "0x1234567890123456789012345678901234567890",
        },
        watchlist: {
          tokens: ["0xaabbccdd00112233445566778899aabbccdd0011"],
        },
      };

      writeFileSync(testConfigFile, JSON.stringify(customConfig), "utf-8");

      const loaded = loadConfig();

      expect(loaded.chain.rpcUrl).toBe("https://custom-rpc.example.com");
      // Legacy single-wallet config normalizes into the inventory array
      // (read-once; old `address` field is not persisted as authoritative).
      expect(loaded.wallet.evm).toHaveLength(1);
      expect(loaded.wallet.evm[0]?.address).toBe("0x1234567890123456789012345678901234567890");
      expect(loaded.wallet.evm[0]?.id).toBe("evm_legacy");
      expect(loaded.wallet.evm[0]?.legacy).toBe(true);
      expect("watchlist" in loaded).toBe(false);
      expect("address" in loaded.wallet).toBe(false);
    });

    it("should return defaults for invalid JSON", () => {
      mkdirSync(testDir, { recursive: true });
      writeFileSync(testConfigFile, "not valid json {{{", "utf-8");

      const config = loadConfig();

      expect(config.version).toBe(1);
      expect(config.chain.chainId).toBe(1);
    });

    it("should return defaults for unknown version", () => {
      mkdirSync(testDir, { recursive: true });

      const futureConfig = {
        version: 999,
        someNewField: "value",
      };

      writeFileSync(testConfigFile, JSON.stringify(futureConfig), "utf-8");

      const config = loadConfig();

      expect(config.version).toBe(1);
    });
  });

  describe("saveConfig", () => {
    it("should save config to file", () => {
      const config = getDefaultConfig();
      config.chain.rpcUrl = "https://new-rpc.example.com";

      saveConfig(config);

      expect(existsSync(testConfigFile)).toBe(true);

      const raw = readFileSync(testConfigFile, "utf-8");
      const loaded = JSON.parse(raw);

      expect(loaded.chain.rpcUrl).toBe("https://new-rpc.example.com");
    });

    it("should create directory if not exists", () => {
      expect(existsSync(testDir)).toBe(false);

      saveConfig(getDefaultConfig());

      expect(existsSync(testDir)).toBe(true);
      expect(existsSync(testConfigFile)).toBe(true);
    });

    it("should overwrite existing config", () => {
      mkdirSync(testDir, { recursive: true });

      const config1 = getDefaultConfig();
      config1.chain.rpcUrl = "https://first.example.com";
      saveConfig(config1);

      const config2 = getDefaultConfig();
      config2.chain.rpcUrl = "https://second.example.com";
      saveConfig(config2);

      const loaded = loadConfig();
      expect(loaded.chain.rpcUrl).toBe("https://second.example.com");
    });
  });

  describe("configExists", () => {
    it("should return false when config does not exist", () => {
      expect(configExists()).toBe(false);
    });

    it("should return true when config exists", () => {
      mkdirSync(testDir, { recursive: true });
      writeFileSync(testConfigFile, "{}", "utf-8");

      expect(configExists()).toBe(true);
    });
  });

  describe("saveConfigPatch", () => {
    it("creates config with patched fields merged onto defaults", () => {
      const result = saveConfigPatch({ chain: { rpcUrl: "https://custom.rpc.example" } });

      const defaults = getDefaultConfig();
      expect(result.chain.rpcUrl).toBe("https://custom.rpc.example");
      // Other chain fields preserved from defaults
      expect(result.chain.chainId).toBe(defaults.chain.chainId);
      expect(result.chain.explorerUrl).toBe(defaults.chain.explorerUrl);

      // Persisted
      const loaded = loadConfig();
      expect(loaded.chain.rpcUrl).toBe("https://custom.rpc.example");
    });

    it("preserves untouched sections", () => {
      saveConfigPatch({ services: { dexScreenerApiUrl: "https://dex-override.test" } });
      const loaded = loadConfig();

      expect(loaded.services.dexScreenerApiUrl).toBe("https://dex-override.test");
      // chain section unchanged
      const defaults = getDefaultConfig();
      expect(loaded.chain.rpcUrl).toBe(defaults.chain.rpcUrl);
      // other services unchanged
      expect(loaded.services.khalaniApiUrl).toBe(defaults.services.khalaniApiUrl);
    });

    it("applies wallet inventory patch without touching solana settings", () => {
      const entry = {
        id: "evm_legacy",
        address: "0x1234567890123456789012345678901234567890",
        label: "Primary",
        createdAt: new Date(0).toISOString(),
        legacy: true,
      };
      const result = saveConfigPatch({ wallet: { evm: [entry] } });

      expect(result.wallet.evm[0]?.address).toBe("0x1234567890123456789012345678901234567890");
      expect(result.solana.cluster).toBe(getDefaultConfig().solana.cluster);
    });
  });
});
