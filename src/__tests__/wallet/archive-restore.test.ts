/**
 * Archive-restore primitive tests (crypto-sensitive). Real temp CONFIG_DIR +
 * real AES-GCM/scrypt crypto via the wallet inventory create/import helpers.
 * Forged-manifest cases craft `manifest.json` by hand to exercise the
 * fail-closed validation BEFORE any write.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

// Crypto-heavy suite: each test does vi.resetModules() + re-imports the wallet
// graph (viem/solana) AND runs real scrypt at N=131072 (2^17). Under load a single
// setup/test can exceed vitest's 10s default, so raise the ceiling for this file.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const { testDir, testConfigFile, testKeystoreFile, testSolanaKeystoreFile, testBackupsDir, testEnvFile, testVaultFile } =
  vi.hoisted(() => {
    const { join } = require("node:path");
    const { tmpdir } = require("node:os");
    const _dir = join(tmpdir(), `vex-restore-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

const TEST_PASSWORD = "test-password-restore";

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

const { ErrorCodes } = await import("../../errors.js");

type InvCreate = typeof import("@tools/wallet/inventory-create.js");
type BackupMod = typeof import("@tools/wallet/backup.js");
type RestoreMod = typeof import("@tools/wallet/backup-restore.js");
type StoreMod = typeof import("@config/store.js");
type InvMod = typeof import("@tools/wallet/inventory.js");

let invCreate: InvCreate;
let backupMod: BackupMod;
let restoreMod: RestoreMod;
let store: StoreMod;
let inv: InvMod;

async function loadModules(): Promise<void> {
  invCreate = await import("@tools/wallet/inventory-create.js");
  backupMod = await import("@tools/wallet/backup.js");
  restoreMod = await import("@tools/wallet/backup-restore.js");
  store = await import("@config/store.js");
  inv = await import("@tools/wallet/inventory.js");
}

function reset(): void {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  mkdirSync(testDir, { recursive: true });
}

async function codeOf(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
  } catch (err: unknown) {
    return (err as { code?: string }).code;
  }
  return undefined;
}

/** Wait for any fire-and-forget post-add backups to settle, then clear them. */
async function settleAndClearBackups(): Promise<void> {
  await new Promise((r) => setTimeout(r, 25));
  if (existsSync(testBackupsDir)) rmSync(testBackupsDir, { recursive: true });
}

beforeEach(async () => {
  vi.resetModules();
  reset();
  await loadModules();
});

afterEach(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  vi.restoreAllMocks();
});

describe("restoreFromBackupArchive", () => {
  it("happy-path round-trip: 2 EVM + 1 Solana + vault + .env", async () => {
    const e1 = await invCreate.createEvmWalletEntry();
    const e2 = await invCreate.importEvmWalletEntry("0x" + "ab".repeat(32));
    const s1 = await invCreate.createSolanaWalletEntry();
    writeFileSync(testVaultFile, JSON.stringify({ version: 1 }), "utf-8");
    writeFileSync(testEnvFile, "AGENT_MODEL=foo\n", "utf-8");

    await settleAndClearBackups();
    const archive = await backupMod.autoBackup();
    expect(archive).not.toBeNull();

    // Capture original keystore bytes, then wipe the LIVE keystores.
    const ks1 = readFileSync(inv.derivePath("evm", e1), "utf-8");
    const ksS = readFileSync(inv.derivePath("solana", s1), "utf-8");
    rmSync(inv.derivePath("evm", e1));
    rmSync(inv.derivePath("evm", e2));
    rmSync(inv.derivePath("solana", s1));

    const result = await restoreMod.restoreFromBackupArchive({
      archiveDir: archive!,
      password: TEST_PASSWORD,
    });

    // Keystores present again + byte-identical + inventory rebuilt.
    expect(existsSync(inv.derivePath("evm", e1))).toBe(true);
    expect(readFileSync(inv.derivePath("evm", e1), "utf-8")).toBe(ks1);
    expect(readFileSync(inv.derivePath("solana", s1), "utf-8")).toBe(ksS);

    const cfg = store.loadConfig();
    expect(cfg.wallet.evm).toHaveLength(2);
    expect(cfg.wallet.solana).toHaveLength(1);
    expect(result.walletsRestored).toHaveLength(3);
    expect(result.backupDir).not.toBeNull();

    // Decrypts to the recorded addresses (key material round-tripped).
    const out1 = await inv.decryptExportSecret({
      family: "evm",
      entry: cfg.wallet.evm.find((w) => w.id === e1.id)!,
      password: TEST_PASSWORD,
    });
    expect(typeof out1.secret).toBe("string");
  });

  it("Class-A signer mismatch → SIGNER_MISMATCH (confirmReplace NOT called)", async () => {
    const e1 = await invCreate.createEvmWalletEntry();
    await settleAndClearBackups();
    const archive = await backupMod.autoBackup();

    // Tamper the manifest: claim a DIFFERENT address for the same keystore.
    const manifestPath = join(archive!, "manifest.json");
    const m = JSON.parse(readFileSync(manifestPath, "utf-8"));
    const bogus = "0x" + "99".repeat(20);
    for (const w of m.wallets) if (w.id === e1.id) w.address = bogus;
    for (const f of m.files) if (f.walletId === e1.id) f.address = bogus;
    writeFileSync(manifestPath, JSON.stringify(m), "utf-8");

    const confirmReplace = vi.fn(async () => true);
    const code = await codeOf(() =>
      restoreMod.restoreFromBackupArchive({
        archiveDir: archive!,
        password: TEST_PASSWORD,
        confirmReplace,
      }),
    );
    expect(code).toBe(ErrorCodes.SIGNER_MISMATCH);
    expect(confirmReplace).not.toHaveBeenCalled();
  });

  it("rejects bad JSON manifest before any write", async () => {
    mkdirSync(testBackupsDir, { recursive: true });
    const dir = join(testBackupsDir, "forged");
    mkdirSync(dir);
    writeFileSync(join(dir, "manifest.json"), "{ not json", "utf-8");
    const code = await codeOf(() =>
      restoreMod.restoreFromBackupArchive({ archiveDir: dir, password: TEST_PASSWORD }),
    );
    expect(code).toBe(ErrorCodes.ARCHIVE_MANIFEST_MALFORMED);
  });

  it("rejects version > 2 manifest", async () => {
    mkdirSync(testBackupsDir, { recursive: true });
    const dir = join(testBackupsDir, "v3");
    mkdirSync(dir);
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({ version: 3, wallets: [], files: [] }),
      "utf-8",
    );
    const code = await codeOf(() =>
      restoreMod.restoreFromBackupArchive({ archiveDir: dir, password: TEST_PASSWORD }),
    );
    expect(code).toBe(ErrorCodes.ARCHIVE_MANIFEST_MALFORMED);
  });

  it("rejects a traversal filename in the manifest", async () => {
    mkdirSync(testBackupsDir, { recursive: true });
    const dir = join(testBackupsDir, "traversal");
    mkdirSync(dir);
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({
        version: 2,
        cliVersion: "x",
        createdAt: new Date().toISOString(),
        wallets: [],
        files: [{ filename: "../../etc/passwd", role: "config" }],
      }),
      "utf-8",
    );
    const code = await codeOf(() =>
      restoreMod.restoreFromBackupArchive({ archiveDir: dir, password: TEST_PASSWORD }),
    );
    expect(code).toBe(ErrorCodes.ARCHIVE_MANIFEST_MALFORMED);
  });

  it("rejects an orphan wallets[] entry with no keystore file (1:1 reconciliation)", async () => {
    mkdirSync(testBackupsDir, { recursive: true });
    const dir = join(testBackupsDir, "orphan-wallet");
    mkdirSync(dir);
    const evmId = "evm_11111111-1111-1111-1111-111111111111";
    // A wallets[] entry that no files[] entry references → must fail-closed.
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({
        version: 2,
        cliVersion: "x",
        createdAt: new Date().toISOString(),
        wallets: [
          { id: evmId, family: "evm", address: "0x" + "ab".repeat(20), label: "Orphan", createdAt: new Date().toISOString(), legacy: false },
        ],
        files: [],
      }),
      "utf-8",
    );
    const code = await codeOf(() =>
      restoreMod.restoreFromBackupArchive({ archiveDir: dir, password: TEST_PASSWORD }),
    );
    expect(code).toBe(ErrorCodes.ARCHIVE_MANIFEST_MALFORMED);
  });

  it("rejects duplicate legacy keystore roles for one family", async () => {
    mkdirSync(testBackupsDir, { recursive: true });
    const dir = join(testBackupsDir, "dup-legacy");
    mkdirSync(dir);
    writeFileSync(join(dir, "keystore.json"), "{}", "utf-8");
    writeFileSync(join(dir, "keystore2.json"), "{}", "utf-8");
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({
        version: 2,
        cliVersion: "x",
        createdAt: new Date().toISOString(),
        wallets: [
          { id: "evm_legacy", family: "evm", address: "0x" + "cd".repeat(20), label: "Primary", createdAt: new Date().toISOString(), legacy: true },
        ],
        files: [
          { filename: "keystore.json", role: "legacy-evm" },
          { filename: "keystore2.json", role: "legacy-evm" },
        ],
      }),
      "utf-8",
    );
    const code = await codeOf(() =>
      restoreMod.restoreFromBackupArchive({ archiveDir: dir, password: TEST_PASSWORD }),
    );
    expect(code).toBe(ErrorCodes.ARCHIVE_MANIFEST_MALFORMED);
  });

  it("rejects two wallets sharing the same address in one family (dup-address invariant)", async () => {
    mkdirSync(testBackupsDir, { recursive: true });
    const dir = join(testBackupsDir, "dup-address");
    mkdirSync(dir);
    const idA = "evm_11111111-1111-1111-1111-111111111111";
    const idB = "evm_22222222-2222-2222-2222-222222222222";
    const sharedAddr = "0x" + "ab".repeat(20);
    writeFileSync(join(dir, "wallet-a.json"), "{}", "utf-8");
    writeFileSync(join(dir, "wallet-b.json"), "{}", "utf-8");
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({
        version: 2,
        cliVersion: "x",
        createdAt: new Date().toISOString(),
        wallets: [
          { id: idA, family: "evm", address: sharedAddr, label: "A", createdAt: new Date().toISOString(), legacy: false },
          { id: idB, family: "evm", address: sharedAddr, label: "B", createdAt: new Date().toISOString(), legacy: false },
        ],
        files: [
          { filename: "wallet-a.json", role: "wallet-evm", walletId: idA, walletFamily: "evm", address: sharedAddr },
          { filename: "wallet-b.json", role: "wallet-evm", walletId: idB, walletFamily: "evm", address: sharedAddr },
        ],
      }),
      "utf-8",
    );
    const code = await codeOf(() =>
      restoreMod.restoreFromBackupArchive({ archiveDir: dir, password: TEST_PASSWORD }),
    );
    expect(code).toBe(ErrorCodes.ARCHIVE_MANIFEST_MALFORMED);
  });

  it("rejects a vault-role file with a non-canonical filename", async () => {
    mkdirSync(testBackupsDir, { recursive: true });
    const dir = join(testBackupsDir, "renamed-vault");
    mkdirSync(dir);
    // role:"vault" but filename != secrets.vault.json — an untrusted archive
    // must not swap the live vault under a disguised name.
    writeFileSync(join(dir, "vault.json"), "{}", "utf-8");
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({
        version: 2,
        cliVersion: "x",
        createdAt: new Date().toISOString(),
        wallets: [],
        files: [{ filename: "vault.json", role: "vault" }],
      }),
      "utf-8",
    );
    const code = await codeOf(() =>
      restoreMod.restoreFromBackupArchive({ archiveDir: dir, password: TEST_PASSWORD }),
    );
    expect(code).toBe(ErrorCodes.ARCHIVE_MANIFEST_MALFORMED);
  });

  it("rejects a symlinked file entry", async () => {
    mkdirSync(testBackupsDir, { recursive: true });
    const dir = join(testBackupsDir, "symlink");
    mkdirSync(dir);
    // A real secret somewhere else the symlink would point at.
    const outside = join(testDir, "outside-secret.json");
    writeFileSync(outside, "{}", "utf-8");
    try {
      symlinkSync(outside, join(dir, "config.json"));
    } catch {
      // Some sandboxes forbid symlinks; skip gracefully.
      return;
    }
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({
        version: 2,
        cliVersion: "x",
        createdAt: new Date().toISOString(),
        wallets: [],
        files: [{ filename: "config.json", role: "config" }],
      }),
      "utf-8",
    );
    const code = await codeOf(() =>
      restoreMod.restoreFromBackupArchive({ archiveDir: dir, password: TEST_PASSWORD }),
    );
    expect(code).toBe(ErrorCodes.ARCHIVE_MANIFEST_MALFORMED);
  });

  it("rejects a cross-family wallet id", async () => {
    mkdirSync(testBackupsDir, { recursive: true });
    const dir = join(testBackupsDir, "crossfam");
    mkdirSync(dir);
    // A sol_* id declared as an evm wallet file.
    const solId = "sol_11111111-1111-1111-1111-111111111111";
    writeFileSync(join(dir, "wallet-x.json"), "{}", "utf-8");
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({
        version: 2,
        cliVersion: "x",
        createdAt: new Date().toISOString(),
        wallets: [
          { id: solId, family: "evm", address: "0xabc", label: "x", createdAt: "", legacy: false },
        ],
        files: [
          { filename: "wallet-x.json", role: "wallet-evm", walletId: solId, walletFamily: "evm", address: "0xabc" },
        ],
      }),
      "utf-8",
    );
    const code = await codeOf(() =>
      restoreMod.restoreFromBackupArchive({ archiveDir: dir, password: TEST_PASSWORD }),
    );
    expect(code).toBe(ErrorCodes.ARCHIVE_MANIFEST_MALFORMED);
  });

  it("missing referenced file → ARCHIVE_INCOMPLETE", async () => {
    await invCreate.createEvmWalletEntry();
    await settleAndClearBackups();
    const archive = await backupMod.autoBackup();
    // Delete a referenced keystore from the archive.
    const m = JSON.parse(readFileSync(join(archive!, "manifest.json"), "utf-8"));
    const walletFile = m.files.find((f: { role: string }) => f.role === "wallet-evm");
    rmSync(join(archive!, walletFile.filename));
    const code = await codeOf(() =>
      restoreMod.restoreFromBackupArchive({ archiveDir: archive!, password: TEST_PASSWORD }),
    );
    expect(code).toBe(ErrorCodes.ARCHIVE_INCOMPLETE);
  });

  it("wrong password → KEYSTORE_DECRYPT_FAILED, NO backup, NO writes", async () => {
    const { readdirSync } = await import("node:fs");
    const e1 = await invCreate.createEvmWalletEntry();
    await settleAndClearBackups();
    const archive = await backupMod.autoBackup();
    const liveKsBefore = readFileSync(inv.derivePath("evm", e1), "utf-8");
    // Snapshot backup dirs (the archive itself lives here) so we can prove no
    // NEW pre-restore backup is created when decrypt fails in Phase 1.
    const dirsBefore = readdirSync(testBackupsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();

    const code = await codeOf(() =>
      restoreMod.restoreFromBackupArchive({ archiveDir: archive!, password: "wrong-pass-xx" }),
    );
    expect(code).toBe(ErrorCodes.KEYSTORE_DECRYPT_FAILED);
    // No pre-restore backup was taken (decrypt fails in Phase 1, before Phase 3).
    const dirsAfter = readdirSync(testBackupsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    expect(dirsAfter).toEqual(dirsBefore);
    // Live keystore untouched.
    expect(readFileSync(inv.derivePath("evm", e1), "utf-8")).toBe(liveKsBefore);
  });

  it("cap overflow (4 EVM in archive) → WALLET_INVENTORY_FULL before writes", async () => {
    // Build an archive manifest with 4 EVM wallets backed by real keystores.
    mkdirSync(testBackupsDir, { recursive: true });
    const dir = join(testBackupsDir, "overflow");
    mkdirSync(dir);
    const ks = await import("@tools/wallet/keystore.js");
    const { privateKeyToAddress } = await import("viem/accounts");
    const wallets = [];
    const files = [];
    for (let i = 0; i < 4; i += 1) {
      const pk = ("0x" + String(i + 1).padStart(2, "0").repeat(32)) as `0x${string}`;
      const addr = privateKeyToAddress(pk);
      const id = `evm_1111111${i}-1111-1111-1111-111111111111`;
      const fn = `wallet-${id}.json`;
      writeFileSync(join(dir, fn), JSON.stringify(await ks.encryptPrivateKey(pk, TEST_PASSWORD)), "utf-8");
      wallets.push({ id, family: "evm", address: addr, label: `W${i}`, createdAt: "", legacy: false });
      files.push({ filename: fn, role: "wallet-evm", walletId: id, walletFamily: "evm", address: addr });
    }
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({ version: 2, cliVersion: "x", createdAt: new Date().toISOString(), wallets, files }),
      "utf-8",
    );
    const code = await codeOf(() =>
      restoreMod.restoreFromBackupArchive({ archiveDir: dir, password: TEST_PASSWORD }),
    );
    expect(code).toBe(ErrorCodes.WALLET_INVENTORY_FULL);
    // No writes happened: no config wallet inventory.
    expect(store.loadConfig().wallet.evm).toHaveLength(0);
  });

  it("Class-B legacy replace: confirmReplace true overwrites, false → WALLET_USER_REJECTED", async () => {
    const ks = await import("@tools/wallet/keystore.js");
    const { privateKeyToAddress } = await import("viem/accounts");

    // Current live legacy EVM wallet = KEY_A.
    const KEY_A = ("0x" + "aa".repeat(32)) as `0x${string}`;
    const addrA = privateKeyToAddress(KEY_A);
    inv.registerPrimaryLegacyWallet("evm", addrA);
    ks.saveKeystore(await ks.encryptPrivateKey(KEY_A, TEST_PASSWORD));

    // Build an archive whose legacy EVM wallet = KEY_B (a real replacement).
    await settleAndClearBackups();
    mkdirSync(testBackupsDir, { recursive: true });
    const dir = join(testBackupsDir, "legacy-replace");
    mkdirSync(dir);
    const KEY_B = ("0x" + "bb".repeat(32)) as `0x${string}`;
    const addrB = privateKeyToAddress(KEY_B);
    writeFileSync(join(dir, "keystore.json"), JSON.stringify(await ks.encryptPrivateKey(KEY_B, TEST_PASSWORD)), "utf-8");
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({
        version: 2,
        cliVersion: "x",
        createdAt: new Date().toISOString(),
        wallets: [{ id: "evm_legacy", family: "evm", address: addrB, label: "Primary", createdAt: "", legacy: true }],
        files: [{ filename: "keystore.json", role: "legacy-evm" }],
      }),
      "utf-8",
    );

    // false → rejected, no overwrite.
    const rejectCode = await codeOf(() =>
      restoreMod.restoreFromBackupArchive({
        archiveDir: dir,
        password: TEST_PASSWORD,
        confirmReplace: async () => false,
      }),
    );
    expect(rejectCode).toBe(ErrorCodes.WALLET_USER_REJECTED);
    expect(store.loadConfig().wallet.evm[0]!.address.toLowerCase()).toBe(addrA.toLowerCase());

    // true → overwrite to KEY_B.
    const result = await restoreMod.restoreFromBackupArchive({
      archiveDir: dir,
      password: TEST_PASSWORD,
      confirmReplace: async () => true,
    });
    expect(result.walletsRestored.some((w) => w.address.toLowerCase() === addrB.toLowerCase())).toBe(true);
    expect(store.loadConfig().wallet.evm[0]!.address.toLowerCase()).toBe(addrB.toLowerCase());
  });

  it("forged .env: managed secrets are stripped from the written .env", async () => {
    const ks = await import("@tools/wallet/keystore.js");
    const { privateKeyToAddress } = await import("viem/accounts");
    const KEY = ("0x" + "cc".repeat(32)) as `0x${string}`;
    const addr = privateKeyToAddress(KEY);
    const id = "evm_22222222-2222-2222-2222-222222222222";

    mkdirSync(testBackupsDir, { recursive: true });
    const dir = join(testBackupsDir, "forged-env");
    mkdirSync(dir);
    writeFileSync(join(dir, `wallet-${id}.json`), JSON.stringify(await ks.encryptPrivateKey(KEY, TEST_PASSWORD)), "utf-8");
    writeFileSync(
      join(dir, ".env"),
      [
        "# header comment",
        "VEX_KEYSTORE_PASSWORD=should-be-stripped",
        "OPENROUTER_API_KEY=sk-secret",
        "AGENT_MODEL=keep-me",
        "",
      ].join("\n"),
      "utf-8",
    );
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({
        version: 2,
        cliVersion: "x",
        createdAt: new Date().toISOString(),
        wallets: [{ id, family: "evm", address: addr, label: "W", createdAt: "", legacy: false }],
        files: [
          { filename: `wallet-${id}.json`, role: "wallet-evm", walletId: id, walletFamily: "evm", address: addr },
          { filename: ".env", role: "env" },
        ],
      }),
      "utf-8",
    );

    await restoreMod.restoreFromBackupArchive({ archiveDir: dir, password: TEST_PASSWORD });

    const written = readFileSync(testEnvFile, "utf-8");
    expect(written).not.toContain("VEX_KEYSTORE_PASSWORD");
    expect(written).not.toContain("OPENROUTER_API_KEY");
    expect(written).not.toContain("sk-secret");
    expect(written).toContain("AGENT_MODEL=keep-me");
    expect(written).toContain("# header comment");
  });

  it("retention trap: restoring the OLDEST archive still works (staged before backup)", async () => {
    const e1 = await invCreate.createEvmWalletEntry();
    await settleAndClearBackups();
    const oldest = await backupMod.autoBackup();
    expect(oldest).not.toBeNull();

    // Fill backups past MAX so a fresh autoBackup would evict the oldest.
    for (let i = 0; i < 20; i += 1) {
      const name = `2099-12-31T2359${String(i).padStart(2, "0")}Z`;
      mkdirSync(join(testBackupsDir, name), { recursive: true });
      writeFileSync(join(testBackupsDir, name, "manifest.json"), JSON.stringify({ version: 1, files: [] }));
    }

    // Wipe the live keystore so we genuinely depend on the archive contents.
    rmSync(inv.derivePath("evm", e1));

    const result = await restoreMod.restoreFromBackupArchive({
      archiveDir: oldest!,
      password: TEST_PASSWORD,
    });
    expect(existsSync(inv.derivePath("evm", e1))).toBe(true);
    expect(result.walletsRestored.length).toBeGreaterThanOrEqual(1);
  });

  it("pre-backup fails → aborts with AUTO_BACKUP_FAILED, no live writes", async () => {
    const e1 = await invCreate.createEvmWalletEntry();
    await settleAndClearBackups();
    const archive = await backupMod.autoBackup();
    const liveBefore = readFileSync(inv.derivePath("evm", e1), "utf-8");

    // Mock autoBackup (the module the restore primitive imports) to throw.
    const spy = vi.spyOn(backupMod, "autoBackup").mockRejectedValue(new Error("boom"));

    const code = await codeOf(() =>
      restoreMod.restoreFromBackupArchive({ archiveDir: archive!, password: TEST_PASSWORD }),
    );
    expect(code).toBe(ErrorCodes.AUTO_BACKUP_FAILED);
    spy.mockRestore();

    // Live keystore intact (Phase 3 hard gate fired before Phase 4 writes).
    expect(readFileSync(inv.derivePath("evm", e1), "utf-8")).toBe(liveBefore);
  });

  it("commit failure rolls back live files to preimage", async () => {
    const e1 = await invCreate.createEvmWalletEntry();
    const s1 = await invCreate.createSolanaWalletEntry();
    await settleAndClearBackups();
    const archive = await backupMod.autoBackup();

    const evmLive = inv.derivePath("evm", e1);
    const solLive = inv.derivePath("solana", s1);
    const evmPre = readFileSync(evmLive, "utf-8");
    const solPre = readFileSync(solLive, "utf-8");

    // Force a Phase-4 failure: make saveConfig throw AFTER keystores are
    // written, so rollback must restore the keystore preimages.
    const spy = vi.spyOn(store, "saveConfig").mockImplementation(() => {
      throw new Error("simulated config write failure");
    });

    const code = await codeOf(() =>
      restoreMod.restoreFromBackupArchive({ archiveDir: archive!, password: TEST_PASSWORD }),
    );
    // Original error propagates (not a VexError code we special-case here).
    expect(code).toBeUndefined();
    spy.mockRestore();

    // Rolled back to preimage (identical bytes).
    expect(readFileSync(evmLive, "utf-8")).toBe(evmPre);
    expect(readFileSync(solLive, "utf-8")).toBe(solPre);
  });

  it("memory hygiene: thrown errors never embed plaintext key material", async () => {
    const e1 = await invCreate.createEvmWalletEntry();
    await settleAndClearBackups();
    const archive = await backupMod.autoBackup();
    // Tamper to force SIGNER_MISMATCH and capture the message.
    const manifestPath = join(archive!, "manifest.json");
    const m = JSON.parse(readFileSync(manifestPath, "utf-8"));
    for (const w of m.wallets) if (w.id === e1.id) w.address = "0x" + "99".repeat(20);
    for (const f of m.files) if (f.walletId === e1.id) f.address = "0x" + "99".repeat(20);
    writeFileSync(manifestPath, JSON.stringify(m), "utf-8");

    // Decrypt the real key so we know what must NOT appear in the message.
    const secret = (await inv.decryptExportSecret({ family: "evm", entry: e1, password: TEST_PASSWORD })).secret;

    let message = "";
    try {
      await restoreMod.restoreFromBackupArchive({ archiveDir: archive!, password: TEST_PASSWORD });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).not.toContain(secret);
    expect(message).not.toContain(secret.slice(2));
  });
});
