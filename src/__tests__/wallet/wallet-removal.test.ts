import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import type { WalletInventoryEntry } from "../../config/store.js";

let directory: string;
let previous: string | undefined;
let previousPassword: string | undefined;
let removal: typeof import("@tools/wallet/removal.js");
let lifecycle: typeof import("@tools/wallet/lifecycle.js");
let inventory: typeof import("@tools/wallet/inventory.js");
let store: typeof import("@config/store.js");
let primary: WalletInventoryEntry;
let secondary: WalletInventoryEntry;
const password = "Disposable-wallet-password-2026";

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "vex-wallet-removal-"));
  previous = process.env.VEX_CONFIG_DIR;
  previousPassword = process.env.VEX_KEYSTORE_PASSWORD;
  process.env.VEX_CONFIG_DIR = directory;
  process.env.VEX_KEYSTORE_PASSWORD = password;
  vi.resetModules();
  removal = await import("@tools/wallet/removal.js");
  lifecycle = await import("@tools/wallet/lifecycle.js");
  inventory = await import("@tools/wallet/inventory.js");
  store = await import("@config/store.js");
  const create = await import("@tools/wallet/inventory-create.js");
  primary = await create.createEvmWalletEntry();
  secondary = await create.createEvmWalletEntry();
});
afterEach(() => {
  if (previous === undefined) delete process.env.VEX_CONFIG_DIR; else process.env.VEX_CONFIG_DIR = previous;
  if (previousPassword === undefined) delete process.env.VEX_KEYSTORE_PASSWORD; else process.env.VEX_KEYSTORE_PASSWORD = previousPassword;
  rmSync(directory, { recursive: true, force: true });
});

describe("real encrypted wallet removal", () => {
  it("verifies recovery before removing access and restores with a fresh identity", async () => {
    const record = await removal.prepareWalletRemoval("evm", secondary.id, password);
    expect(inventory.getWalletById("evm", secondary.id)?.address).toBe(secondary.address);
    expect(lifecycle.listWalletRemovalRecords()).toEqual([]);
    removal.disableWalletForRemoval(record);
    expect(inventory.getWalletById("evm", secondary.id)).toBeNull();
    await expect(inventory.loadEvmKey(secondary)).rejects.toThrow("removed");
    removal.finishWalletRemoval(record);
    expect(inventory.listWallets("evm").map((entry) => entry.id)).toEqual([primary.id]);
    const finished = lifecycle.listWalletRemovalRecords()[0];
    if (!finished) throw new Error("Missing durable removal record");
    const restored = await removal.restoreRemovedWallet(finished, password);
    expect(restored.id).not.toBe(secondary.id);
    expect(restored.address).toBe(secondary.address);
    expect((await inventory.loadEvmKey(restored)).address).toBe(secondary.address);
    await expect(inventory.loadEvmKey(secondary)).rejects.toThrow("removed");
  });

  it("protects the primary and leaves active wallets intact on wrong backup passwords", async () => {
    await expect(removal.prepareWalletRemoval("evm", primary.id, password)).rejects.toThrow("Primary");
    await expect(removal.prepareWalletRemoval("evm", secondary.id, "wrong-password")).rejects.toThrow();
    expect(lifecycle.listWalletRemovalRecords()).toEqual([]);
    expect(inventory.listWallets("evm")).toHaveLength(2);
    expect((await inventory.loadEvmKey(secondary)).address).toBe(secondary.address);
  });

  it("recovers an older encrypted key under the current password without reviving its identity", async () => {
    const record = await removal.prepareWalletRemoval("evm", secondary.id, password);
    removal.disableWalletForRemoval(record);
    removal.finishWalletRemoval(record);
    const finished = lifecycle.listWalletRemovalRecords()[0];
    if (!finished) throw new Error("Missing recovery record");
    const currentPassword = "Changed-disposable-password-2026";
    await expect(removal.restoreRemovedWallet(finished, currentPassword)).rejects.toThrow();
    const restored = await removal.restoreRemovedWallet(finished, currentPassword, () => true, password);
    process.env.VEX_KEYSTORE_PASSWORD = currentPassword;
    expect((await inventory.loadEvmKey(restored)).address).toBe(secondary.address);
    expect(restored.id).not.toBe(secondary.id);
    expect(lifecycle.listWalletRemovalRecords()[0]?.state).toBe("removed");
  });

  it.each(["keystore", "config"] as const)("recovers after interruption at %s without re-enabling the old wallet", async (step) => {
    const record = await removal.prepareWalletRemoval("evm", secondary.id, password);
    removal.disableWalletForRemoval(record);
    expect(() => removal.finishWalletRemoval(record, (current) => { if (current === step) throw new Error("interrupted"); })).toThrow("interrupted");
    vi.resetModules();
    const restartedInventory = await import("@tools/wallet/inventory.js");
    expect(restartedInventory.getWalletById("evm", secondary.id)).toBeNull();
    const restarted = await import("@tools/wallet/removal.js");
    restarted.finishWalletRemoval(record);
    const restartedLifecycle = await import("@tools/wallet/lifecycle.js");
    expect(restartedLifecycle.listWalletRemovalRecords()[0]?.state).toBe("removed");
    expect(restartedInventory.listWallets("evm").map((entry) => entry.id)).toEqual([primary.id]);
  });

  it.each(["disabled", "keystore", "config"] as const)("survives an actual process kill at %s", async (step) => {
    const record = await removal.prepareWalletRemoval("evm", secondary.id, password);
    removal.disableWalletForRemoval(record);
    const lifecycleUrl = pathToFileURL(join(process.cwd(), "src/tools/wallet/lifecycle.ts")).href;
    const removalUrl = pathToFileURL(join(process.cwd(), "src/tools/wallet/removal.ts")).href;
    const imports = `const {listWalletRemovalRecords} = await import(${JSON.stringify(lifecycleUrl)});
      const {finishWalletRemoval} = await import(${JSON.stringify(removalUrl)});
      const [record] = listWalletRemovalRecords();`;
    const killed = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval",
      `${imports}
       if (${JSON.stringify(step)} === 'disabled') process.kill(process.pid, 'SIGKILL');
       finishWalletRemoval(record, step => { if (step === ${JSON.stringify(step)}) process.kill(process.pid, 'SIGKILL'); });`],
    { env: process.env, timeout: 15_000 });
    expect(killed.signal).toBe("SIGKILL");
    expect(inventory.getWalletById("evm", secondary.id)).toBeNull();
    const restarted = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval",
      `${imports} finishWalletRemoval(record);`], { env: process.env, timeout: 15_000 });
    expect(restarted.status).toBe(0);
    expect(lifecycle.listWalletRemovalRecords()[0]?.state).toBe("removed");
    expect(inventory.listWallets("evm").map((entry) => entry.id)).toEqual([primary.id]);
  });

  it("keeps an interrupted wallet disabled if its backup is tampered with", async () => {
    const record = await removal.prepareWalletRemoval("evm", secondary.id, password);
    removal.disableWalletForRemoval(record);
    writeFileSync(join(removal.recoveryDirectory(record), "wallet.json"), "{}", { mode: 0o600 });
    expect(() => removal.finishWalletRemoval(record)).toThrow("verified");
    expect(lifecycle.listWalletRemovalRecords()[0]?.state).toBe("removing");
    await expect(inventory.loadEvmKey(secondary)).rejects.toThrow("removed");
  });

  it("rejects linked keystores and damaged removal records", async () => {
    const file = inventory.derivePath("evm", secondary);
    const elsewhere = join(directory, "outside.json");
    writeFileSync(elsewhere, readFileSync(file));
    rmSync(file);
    symlinkSync(elsewhere, file);
    await expect(removal.prepareWalletRemoval("evm", secondary.id, password)).rejects.toThrow();
    const fs = await import("node:fs");
    fs.mkdirSync(lifecycle.WALLET_REMOVALS_DIR);
    writeFileSync(join(lifecycle.WALLET_REMOVALS_DIR, `${secondary.id}.json`), "{}");
    expect(() => inventory.getWalletById("evm", secondary.id)).toThrow();
  });

  it("remints a removed ID when restoring a full older archive", async () => {
    const backup = await import("@tools/wallet/backup.js");
    const dir = await backup.autoBackup();
    if (!dir) throw new Error("Missing encrypted archive");
    const record = await removal.prepareWalletRemoval("evm", secondary.id, password);
    removal.disableWalletForRemoval(record);
    removal.finishWalletRemoval(record);
    const restore = await import("@tools/wallet/backup-restore.js");
    const result = await restore.restoreFromBackupArchive({ archiveDir: dir, password });
    const restored = result.walletsRestored.find((entry) => entry.address === secondary.address);
    expect(restored?.id).not.toBe(secondary.id);
    expect(restored?.address).toBe(secondary.address);
    expect(inventory.getWalletById("evm", secondary.id)).toBeNull();
    expect(store.loadConfig().wallet.evm).toHaveLength(2);
  });

  it("supports Solana removal and recovery with exact address identity", async () => {
    const create = await import("@tools/wallet/inventory-create.js");
    await create.createSolanaWalletEntry();
    const wallet = await create.createSolanaWalletEntry();
    const record = await removal.prepareWalletRemoval("solana", wallet.id, password);
    removal.disableWalletForRemoval(record);
    removal.finishWalletRemoval(record);
    const finished = lifecycle.listWalletRemovalRecords()[0];
    if (!finished) throw new Error("Missing Solana removal record");
    const restored = await removal.restoreRemovedWallet(finished, password);
    expect(restored.address).toBe(wallet.address);
    expect(restored.id).not.toBe(wallet.id);
    await expect(inventory.loadSolanaSecret(wallet)).rejects.toThrow("removed");
  });
});
