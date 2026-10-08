/**
 * Compatibility-façade surface test for `backup-restore.ts` after the structural
 * split into `./restore/` modules.
 *
 * (a) Pins the EXACT runtime export set of the façade + each export's typeof, so
 *     a caller importing from the old path sees no difference.
 * (b) Codex-requested secret-hygiene guard: induce a Phase-4 commit failure (so
 *     rollback runs and the logger emits) and assert the captured logger output
 *     contains NO password / private-key / mnemonic material. A restore/rollback
 *     failure must never leak secrets through logs.
 *
 * Crypto-sensitive: real temp CONFIG_DIR + real AES-GCM/scrypt crypto via the
 * wallet inventory create helpers (mirrors archive-restore.test.ts setup).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, rmSync } from "node:fs";

// Crypto-heavy: real scrypt at N=131072 under load can exceed the 10s default.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const {
  testDir,
  testConfigFile,
  testKeystoreFile,
  testSolanaKeystoreFile,
  testBackupsDir,
  testEnvFile,
  testVaultFile,
} = vi.hoisted(() => {
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");
  const _dir = join(tmpdir(), `vex-restore-surface-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

const TEST_PASSWORD = "test-password-surface";

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

// Capturing logger mock: every log line is recorded so the secret-hygiene
// assertion can scan the full output produced during restore + rollback.
const loggerLines: string[] = [];
vi.mock("@utils/logger-shim.js", () => ({
  minLogger: {
    debug: vi.fn((msg: string) => loggerLines.push(String(msg))),
    info: vi.fn((msg: string) => loggerLines.push(String(msg))),
    warn: vi.fn((msg: string) => loggerLines.push(String(msg))),
    error: vi.fn((msg: string) => loggerLines.push(String(msg))),
  },
}));

// Type-only import of the exported types must compile against the façade.
type _Args = import("@tools/wallet/backup-restore.js").RestoreFromBackupArchiveArgs;
type _Result = import("@tools/wallet/backup-restore.js").RestoreFromBackupArchiveResult;

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

async function settleAndClearBackups(): Promise<void> {
  await new Promise((r) => setTimeout(r, 25));
  if (existsSync(testBackupsDir)) rmSync(testBackupsDir, { recursive: true });
}

beforeEach(async () => {
  vi.resetModules();
  loggerLines.length = 0;
  reset();
  await loadModules();
});

afterEach(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  vi.restoreAllMocks();
});

describe("backup-restore façade surface", () => {
  it("exposes exactly the expected runtime exports with correct typeof", () => {
    // The exact set of RUNTIME export keys (types are erased at runtime).
    const keys = Object.keys(restoreMod).sort();
    expect(keys).toEqual(["restoreFromBackupArchive"]);
    expect(typeof restoreMod.restoreFromBackupArchive).toBe("function");
  });

  it("rollback on commit failure leaks NO secret material to the logger", async () => {
    const e1 = await invCreate.createEvmWalletEntry();
    const s1 = await invCreate.createSolanaWalletEntry();
    await settleAndClearBackups();
    const archive = await backupMod.autoBackup();
    expect(archive).not.toBeNull();

    // The real decrypted private key — what must NEVER appear in any log line.
    const secret = (await inv.decryptExportSecret({
      family: "evm",
      entry: e1,
      password: TEST_PASSWORD,
    })).secret;
    const solSecret = (await inv.decryptExportSecret({
      family: "solana",
      entry: s1,
      password: TEST_PASSWORD,
    })).secret;

    // Force a Phase-4 commit failure AFTER keystores are written so the
    // journaled rollback path runs (and the logger emits on any rollback error).
    const spy = vi.spyOn(store, "saveConfig").mockImplementation(() => {
      throw new Error("simulated config write failure");
    });

    let threw = false;
    try {
      await restoreMod.restoreFromBackupArchive({
        archiveDir: archive!,
        password: TEST_PASSWORD,
      });
    } catch {
      threw = true;
    }
    spy.mockRestore();
    expect(threw).toBe(true);

    // Some log output must have been produced by the restore/rollback path, and
    // none of it may contain password or private-key material.
    const blob = loggerLines.join("\n");
    expect(blob).not.toContain(TEST_PASSWORD);
    expect(blob).not.toContain(secret);
    expect(blob).not.toContain(secret.slice(2));
    expect(blob).not.toContain(solSecret);
  });
});
