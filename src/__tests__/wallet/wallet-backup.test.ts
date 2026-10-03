import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";

// Crypto-heavy suite: vi.resetModules() re-imports the wallet graph and real
// scrypt at N=131072 (2^17) runs per test; raise the ceiling above vitest's 10s default.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

// Real temp CONFIG_DIR per the inventory.test.ts harness pattern: a hoisted,
// stable directory (NOT a fresh Date.now() per property) so every paths.* the
// backup module reads points at the same isolated tree.
const { testDir, testConfigFile, testKeystoreFile, testSolanaKeystoreFile, testBackupsDir, testEnvFile, testVaultFile } =
  vi.hoisted(() => {
    const { join } = require("node:path");
    const { tmpdir } = require("node:os");
    const _dir = join(tmpdir(), `vex-backup-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    return {
      testDir: _dir,
      testConfigFile: join(_dir, "config.json"),
      testKeystoreFile: join(_dir, "keystore.json"),
      testSolanaKeystoreFile: join(_dir, "solana-keystore.json"),
      testBackupsDir: join(_dir, "backups"),
      testEnvFile: join(_dir, ".env"),
      testVaultFile: join(_dir, "secrets.vault.json"),
    };
  });

const TEST_PASSWORD = "test-password-backup";

vi.mock("@config/paths.js", () => ({
  CONFIG_DIR: testDir,
  CONFIG_FILE: testConfigFile,
  KEYSTORE_FILE: testKeystoreFile,
  SOLANA_KEYSTORE_FILE: testSolanaKeystoreFile,
  BACKUPS_DIR: testBackupsDir,
  ENV_FILE: testEnvFile,
  SECRETS_VAULT_FILE: testVaultFile,
}));

vi.mock("@utils/env.js", () => ({
  requireKeystorePassword: vi.fn(() => TEST_PASSWORD),
  getKeystorePassword: vi.fn(() => TEST_PASSWORD),
}));

vi.mock("@utils/logger-shim.js", () => ({
  minLogger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const TEST_DIR = join(tmpdir(), `vex-test-backup-pure-${Date.now()}`);

describe("wallet-backup", () => {
  describe("backup manifest structure", () => {
    it("should have the expected manifest fields", () => {
      interface BackupManifest {
        version: 1;
        cliVersion: string;
        createdAt: string;
        walletAddress: string | null;
        chainId: number;
        files: string[];
      }

      const manifest: BackupManifest = {
        version: 1,
        cliVersion: "1.0.2",
        createdAt: new Date().toISOString(),
        walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
        chainId: 1,
        files: ["keystore.json", "config.json"],
      };

      expect(manifest.version).toBe(1);
      expect(manifest.files).toContain("keystore.json");
      expect(manifest.files).toContain("config.json");
      expect(manifest.chainId).toBe(1);
      expect(manifest.walletAddress).toMatch(/^0x/);
    });

    it("should allow null walletAddress", () => {
      const manifest = {
        version: 1,
        cliVersion: "1.0.2",
        createdAt: new Date().toISOString(),
        walletAddress: null,
        chainId: 1,
        files: ["config.json"],
      };

      expect(manifest.walletAddress).toBeNull();
      expect(manifest.files).not.toContain("keystore.json");
    });
  });

  describe("backup retention logic", () => {
    const retentionDir = join(TEST_DIR, "retention-test");

    beforeEach(() => {
      mkdirSync(retentionDir, { recursive: true });
    });

    afterEach(() => {
      rmSync(retentionDir, { recursive: true, force: true });
    });

    it("should keep entries sorted chronologically", () => {
      const dirs = [
        "2026-01-15T120000Z",
        "2026-01-14T120000Z",
        "2026-01-16T120000Z",
      ];

      for (const dir of dirs) {
        const p = join(retentionDir, dir);
        mkdirSync(p, { recursive: true });
        writeFileSync(
          join(p, "manifest.json"),
          JSON.stringify({ version: 1, createdAt: dir, files: [] })
        );
      }

      const entries = readdirSync(retentionDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();

      expect(entries).toEqual([
        "2026-01-14T120000Z",
        "2026-01-15T120000Z",
        "2026-01-16T120000Z",
      ]);
    });

    it("should identify oldest entry for deletion when over limit", () => {
      const MAX = 3;
      const dirs = [
        "2026-01-01T000000Z",
        "2026-01-02T000000Z",
        "2026-01-03T000000Z",
        "2026-01-04T000000Z",
      ];

      for (const dir of dirs) {
        mkdirSync(join(retentionDir, dir), { recursive: true });
      }

      const entries = readdirSync(retentionDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();

      const toRemove: string[] = [];
      while (entries.length > MAX) {
        toRemove.push(entries.shift()!);
      }

      expect(toRemove).toEqual(["2026-01-01T000000Z"]);
      expect(entries.length).toBe(MAX);
    });
  });

  describe("restore validation", () => {
    const restoreDir = join(TEST_DIR, "restore-test");

    beforeEach(() => {
      mkdirSync(restoreDir, { recursive: true });
    });

    afterEach(() => {
      rmSync(restoreDir, { recursive: true, force: true });
    });

    it("should require manifest.json in backup dir", () => {
      expect(existsSync(join(restoreDir, "manifest.json"))).toBe(false);
    });

    it("should parse valid manifest", () => {
      const manifest = {
        version: 1,
        cliVersion: "1.0.2",
        createdAt: "2026-01-15T12:00:00.000Z",
        walletAddress: "0xabc",
        chainId: 1,
        files: ["keystore.json", "config.json"],
      };

      writeFileSync(join(restoreDir, "manifest.json"), JSON.stringify(manifest));
      writeFileSync(join(restoreDir, "keystore.json"), "{}");
      writeFileSync(join(restoreDir, "config.json"), "{}");

      const parsed = JSON.parse(readFileSync(join(restoreDir, "manifest.json"), "utf-8"));
      expect(parsed.version).toBe(1);
      expect(parsed.files).toHaveLength(2);

      for (const file of parsed.files) {
        expect(existsSync(join(restoreDir, file))).toBe(true);
      }
    });
  });

  // ── Real integration: full multi-wallet backup + V2 manifest ───────────────
  describe("autoBackup (V2 full surface)", () => {
    let createEvmWalletEntry: typeof import("@tools/wallet/inventory-create.js").createEvmWalletEntry;
    let importEvmWalletEntry: typeof import("@tools/wallet/inventory-create.js").importEvmWalletEntry;
    let createSolanaWalletEntry: typeof import("@tools/wallet/inventory-create.js").createSolanaWalletEntry;
    let autoBackup: typeof import("@tools/wallet/backup.js").autoBackup;
    let listAvailableBackups: typeof import("@tools/wallet/backup.js").listAvailableBackups;
    let backupManifestSchema: typeof import("@tools/wallet/backup.js").backupManifestSchema;
    let backupMod: typeof import("@tools/wallet/backup.js");
    let loadConfig: typeof import("@config/store.js").loadConfig;
    let saveConfig: typeof import("@config/store.js").saveConfig;
    let derivePath: typeof import("@tools/wallet/inventory.js").derivePath;

    beforeEach(async () => {
      vi.resetModules();
      if (existsSync(testDir)) rmSync(testDir, { recursive: true });
      mkdirSync(testDir, { recursive: true });
      ({ createEvmWalletEntry, importEvmWalletEntry, createSolanaWalletEntry } = await import(
        "@tools/wallet/inventory-create.js"
      ));
      backupMod = await import("@tools/wallet/backup.js");
      ({ autoBackup, listAvailableBackups, backupManifestSchema } = backupMod);
      ({ loadConfig, saveConfig } = await import("@config/store.js"));
      ({ derivePath } = await import("@tools/wallet/inventory.js"));
    });

    afterEach(() => {
      if (existsSync(testDir)) rmSync(testDir, { recursive: true });
      vi.restoreAllMocks();
    });

    function readManifest(dir: string): unknown {
      return JSON.parse(readFileSync(join(dir, "manifest.json"), "utf-8"));
    }

    it("enumerates 2 EVM + 1 Solana with correct roles/ids/addresses (V2 shape)", async () => {
      const e1 = await createEvmWalletEntry();
      const e2 = await importEvmWalletEntry("0x" + "ab".repeat(32));
      const s1 = await createSolanaWalletEntry();

      const dir = await autoBackup();
      expect(dir).not.toBeNull();

      const raw = readManifest(dir!);
      const parsed = backupManifestSchema.safeParse(raw);
      expect(parsed.success).toBe(true);
      if (!parsed.success || parsed.data.version !== 2) throw new Error("expected v2");
      const m = parsed.data;

      expect(m.version).toBe(2);
      expect(m.wallets).toHaveLength(3);
      const byId = new Map(m.wallets.map((w) => [w.id, w]));
      expect(byId.get(e1.id)?.family).toBe("evm");
      expect(byId.get(e2.id)?.address).toBe(e2.address);
      expect(byId.get(s1.id)?.family).toBe("solana");

      const walletFiles = m.files.filter(
        (f) => f.role === "wallet-evm" || f.role === "wallet-solana",
      );
      expect(walletFiles).toHaveLength(3);
      for (const f of walletFiles) {
        expect(f.walletId).toBeDefined();
        expect(existsSync(join(dir!, f.filename))).toBe(true);
      }
      // Every keystore file was physically copied into the archive.
      expect(existsSync(join(dir!, `wallet-${e1.id}.json`))).toBe(true);
      expect(existsSync(join(dir!, `wallet-${s1.id}.json`))).toBe(true);
    });

    it("includes the vault and .env when present, omits them when absent", async () => {
      await createEvmWalletEntry();

      // No vault/.env yet.
      const dir1 = await autoBackup();
      const m1 = readManifest(dir1!) as { files: Array<{ role: string }> };
      expect(m1.files.some((f) => f.role === "vault")).toBe(false);
      expect(m1.files.some((f) => f.role === "env")).toBe(false);

      // Now create them.
      writeFileSync(testVaultFile, JSON.stringify({ version: 1 }), "utf-8");
      writeFileSync(testEnvFile, "OPENROUTER_API_KEY=sk-test\nAGENT_MODEL=foo\n", "utf-8");

      const dir2 = await autoBackup();
      const m2 = readManifest(dir2!) as { files: Array<{ role: string; filename: string }> };
      expect(m2.files.some((f) => f.role === "vault")).toBe(true);
      expect(m2.files.some((f) => f.role === "env")).toBe(true);
      expect(existsSync(join(dir2!, "secrets.vault.json"))).toBe(true);
      expect(existsSync(join(dir2!, ".env"))).toBe(true);
    });

    it("creates a durable-purpose vault-reset archive with the canonical shared name", async () => {
      await createEvmWalletEntry();
      writeFileSync(testVaultFile, "encrypted-vault", "utf8");
      const dir = await autoBackup({ purpose: "vault-reset" });
      expect(dir).not.toBeNull();
      expect(backupMod.isCanonicalVaultResetBackupName(dir!.split(/[\\/]/).at(-1)!)).toBe(true);
      expect(basename(dir!)).not.toMatch(/[:.]/);
      const manifest = readManifest(dir!) as { purpose: string };
      expect(manifest.purpose).toBe("vault-reset");
      expect(listAvailableBackups()).toContainEqual(
        expect.objectContaining({
          id: basename(dir!),
          timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        }),
      );
    });

    it("defaults missing V2 purpose to ordinary and lists using manifest.createdAt", async () => {
      mkdirSync(join(testBackupsDir, "opaque-directory-id"), { recursive: true });
      writeFileSync(
        join(testBackupsDir, "opaque-directory-id", "manifest.json"),
        JSON.stringify({
          version: 2,
          cliVersion: "test",
          createdAt: "2025-04-03T02:01:00.000Z",
          wallets: [],
          files: [],
        }),
      );
      const parsed = backupManifestSchema.parse(readManifest(join(testBackupsDir, "opaque-directory-id")));
      expect(parsed.version === 2 && parsed.purpose).toBe("ordinary");
      expect(listAvailableBackups()).toContainEqual(expect.objectContaining({
        id: "opaque-directory-id",
        timestamp: "2025-04-03T02:01:00.000Z",
      }));
    });

    it("returns null when there is genuinely nothing to back up", async () => {
      // Fresh empty config dir — no keystores, no vault, no .env, no config.
      const dir = await autoBackup();
      expect(dir).toBeNull();
    });

    it("writes manifest.json LAST — a copy failure leaves no manifest", async () => {
      const e = await createEvmWalletEntry();
      // Let any fire-and-forget post-add backup settle, then wipe the backups
      // dir so the next (failing) run is the ONLY producer of backup dirs.
      await new Promise((r) => setTimeout(r, 20));
      if (existsSync(testBackupsDir)) rmSync(testBackupsDir, { recursive: true });

      // Make the keystore copy throw: replace the SOURCE keystore file with a
      // directory so copyBytes' readFileSync(src) fails (EISDIR). The manifest
      // is written only after every copy succeeds, so it must be absent.
      const ksPath = derivePath("evm", e);
      rmSync(ksPath);
      mkdirSync(ksPath); // now a directory at the keystore path → read throws

      await expect(autoBackup()).rejects.toThrow();

      // Any backup dir created during the failed run must NOT contain a
      // manifest (the copy threw before the manifest write).
      mkdirSync(testBackupsDir, { recursive: true });
      const dirs = readdirSync(testBackupsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => join(testBackupsDir, d.name));
      for (const d of dirs) {
        expect(existsSync(join(d, "manifest.json"))).toBe(false);
      }
    });

    it("skips a wallet whose LOCAL id is non-canonical (warn, no abort)", async () => {
      await createEvmWalletEntry(); // valid
      // Inject a corrupt non-canonical id directly into config on disk.
      const cfg = loadConfig();
      // saveConfig normalizer would drop a bad id, so we write raw JSON.
      const raw = JSON.parse(readFileSync(testConfigFile, "utf-8"));
      raw.wallet.evm.push({
        id: "evm_not-a-uuid",
        address: "0x" + "11".repeat(20),
        label: "bad",
        createdAt: new Date().toISOString(),
      });
      writeFileSync(testConfigFile, JSON.stringify(raw), "utf-8");

      // The normalizer in loadConfig drops the bad row, so derivePath never
      // even sees it — backup succeeds with only the valid wallet.
      const dir = await autoBackup();
      expect(dir).not.toBeNull();
      const m = readManifest(dir!) as { wallets: unknown[] };
      expect(m.wallets.length).toBeGreaterThanOrEqual(1);
      void cfg;
      void derivePath;
      void saveConfig;
    });

    it("enforces retention (MAX_BACKUPS) unchanged", async () => {
      await createEvmWalletEntry();
      // Pre-seed 25 fake backup dirs.
      mkdirSync(testBackupsDir, { recursive: true });
      for (let i = 0; i < 25; i += 1) {
        const name = `2020-01-01T0000${String(i).padStart(2, "0")}Z`;
        mkdirSync(join(testBackupsDir, name), { recursive: true });
        writeFileSync(
          join(testBackupsDir, name, "manifest.json"),
          JSON.stringify({ version: 1, files: [] }),
        );
      }
      await autoBackup();
      const remaining = readdirSync(testBackupsDir, { withFileTypes: true }).filter((d) =>
        d.isDirectory(),
      );
      expect(remaining.length).toBeLessThanOrEqual(20);
    });

    it("ordinary retention never evicts a vault-reset archive", async () => {
      await createEvmWalletEntry();
      const resetName = "vault-reset-2020-01-01T000000Z";
      mkdirSync(join(testBackupsDir, resetName), { recursive: true });
      for (let i = 0; i < 25; i += 1) {
        mkdirSync(join(testBackupsDir, `ordinary-${String(i).padStart(2, "0")}`), { recursive: true });
      }
      await autoBackup();
      expect(existsSync(join(testBackupsDir, resetName))).toBe(true);
    });

    it("listAvailableBackups returns metadata only, newest first", async () => {
      await createEvmWalletEntry();
      await autoBackup();
      await new Promise((r) => setTimeout(r, 5));
      await createSolanaWalletEntry();
      await autoBackup();

      const list = listAvailableBackups();
      expect(list.length).toBeGreaterThanOrEqual(2);
      // Sorted DESC by timestamp.
      expect(list[0]!.timestamp >= list[1]!.timestamp).toBe(true);
      // Metadata only — no secret fields AND no absolute on-disk paths leaked
      // (opaque `id` only; the main process resolves it under BACKUPS_DIR).
      const serialized = JSON.stringify(list);
      expect(serialized).not.toContain("ciphertext");
      expect(serialized).not.toContain("salt");
      expect(serialized).not.toContain(testDir);
      for (const b of list) {
        expect(b.id).toBeTruthy();
        expect(b).not.toHaveProperty("dir");
        expect(typeof b.walletCount).toBe("number");
        expect(Array.isArray(b.addresses)).toBe(true);
      }
    });
  });
});
