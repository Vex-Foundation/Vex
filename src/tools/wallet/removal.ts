import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { BACKUPS_DIR, CONFIG_DIR, CONFIG_FILE } from "../../config/paths.js";
import { isValidWalletId, walletInventoryEntrySchema, type WalletInventoryEntry } from "../../config/store.js";
import { assertCanAddWallet, derivePath, generateWalletId, walletAddressesEqual, type InventoryFamily } from "./inventory.js";
import { decryptSecretBytes, encryptSecretBytes, validateKeystoreShape } from "./keystore.js";
import { deriveAddressFromKeystore } from "./restore/verify.js";
import { assertPrivateDirectory, durablePrivateWrite, listWalletRemovalRecords, readPrivateFile, syncPrivateDirectory, walletIdIsRetired, WalletLifecycleError, writeWalletRemovalRecord, type WalletRemovalRecord } from "./lifecycle.js";

export type RemovalStep = "backup" | "disabled" | "keystore" | "config" | "completed";
const hash = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
export const recoveryDirectory = (record: WalletRemovalRecord): string => join(BACKUPS_DIR, `wallet-recovery-${record.backupId}`);

const removalConfigSchema = z.object({
  version: z.literal(1),
  wallet: z.object({
    evm: z.array(walletInventoryEntrySchema.passthrough()),
    solana: z.array(walletInventoryEntrySchema.passthrough()),
  }).passthrough(),
}).passthrough();

/** Inventory mutations must preserve every row and unrelated config field. */
function readRemovalConfig() {
  try {
    assertPrivateDirectory(CONFIG_DIR);
    const cfg = removalConfigSchema.parse(JSON.parse(readPrivateFile(CONFIG_FILE, 1024 * 1024).toString("utf8")));
    for (const family of ["evm", "solana"] as const) {
      const ids = new Set<string>();
      const addresses = new Set<string>();
      for (const entry of cfg.wallet[family]) {
        const address = family === "evm" ? entry.address.toLowerCase() : entry.address;
        if (!isValidWalletId(family, entry.id, entry.legacy === true) || ids.has(entry.id) || addresses.has(address)) {
          throw new WalletLifecycleError();
        }
        ids.add(entry.id);
        addresses.add(address);
      }
    }
    return cfg;
  } catch {
    throw new WalletLifecycleError("The wallet configuration could not be verified. No inventory changes were made.");
  }
}

export function secondaryWallet(family: InventoryFamily, id: string): WalletInventoryEntry {
  const cfg = readRemovalConfig();
  const entry = cfg.wallet[family].find((value) => value.id === id);
  if (!entry || entry.legacy || cfg.wallet[family][0]?.id === id || walletIdIsRetired(id)) {
    throw new WalletLifecycleError("Only available secondary wallets can be removed. Primary wallets are protected.");
  }
  return entry;
}

/** No active-state mutation occurs until an archived key has been read back and verified. */
export async function prepareWalletRemoval(family: InventoryFamily, id: string, password: string): Promise<WalletRemovalRecord> {
  const entry = secondaryWallet(family, id);
  const bytes = readPrivateFile(derivePath(family, entry));
  const record: WalletRemovalRecord = {
    version: 1, family, entry: { id: entry.id, address: entry.address, label: entry.label, createdAt: entry.createdAt },
    state: "removing", backupId: randomUUID(), keyHash: hash(bytes), requestedAt: new Date().toISOString(),
  };
  mkdirSync(BACKUPS_DIR, { recursive: true, mode: 0o700 });
  assertPrivateDirectory(CONFIG_DIR);
  assertPrivateDirectory(BACKUPS_DIR);
  const dir = recoveryDirectory(record);
  mkdirSync(dir, { mode: 0o700 });
  durablePrivateWrite(join(dir, "wallet.json"), bytes, dir);
  durablePrivateWrite(join(dir, "recovery.json"), JSON.stringify(record), dir);
  syncPrivateDirectory(BACKUPS_DIR);
  const archived = readRecoveryKeystore(record);
  const address = await deriveAddressFromKeystore(family, archived, password);
  if (!walletAddressesEqual(family, address, entry.address)) throw new WalletLifecycleError("The recovery key does not match this wallet. Nothing was removed.");
  // An async KDF must not allow a changed inventory or key to be committed.
  const current = secondaryWallet(family, id);
  if (JSON.stringify(current) !== JSON.stringify(entry) || hash(readPrivateFile(derivePath(family, entry))) !== record.keyHash) throw new WalletLifecycleError();
  return record;
}

export function readRecoveryKeystore(record: WalletRemovalRecord) {
  assertPrivateDirectory(BACKUPS_DIR);
  const dir = recoveryDirectory(record);
  assertPrivateDirectory(dir);
  const file = join(dir, "wallet.json");
  const bytes = readPrivateFile(file);
  if (hash(bytes) !== record.keyHash) throw new WalletLifecycleError("The wallet recovery copy could not be verified.");
  return validateKeystoreShape(JSON.parse(bytes.toString("utf8")), file);
}

export function disableWalletForRemoval(record: WalletRemovalRecord): void {
  const current = secondaryWallet(record.family, record.entry.id);
  if (!walletAddressesEqual(record.family, current.address, record.entry.address)) throw new WalletLifecycleError();
  readRecoveryKeystore(record);
  writeWalletRemovalRecord(record);
}

/** Called only after dependency retirement has committed. Idempotent after process termination. */
export function finishWalletRemoval(record: WalletRemovalRecord, afterStep?: (step: RemovalStep) => void): void {
  const durable = listWalletRemovalRecords().find((value) => value.entry.id === record.entry.id);
  if (!durable || JSON.stringify({ ...durable, state: "removing" }) !== JSON.stringify({ ...record, state: "removing" })) throw new WalletLifecycleError();
  readRecoveryKeystore(record);
  const cfg = readRemovalConfig();
  const current = cfg.wallet[record.family].find((entry) => entry.id === record.entry.id);
  if (current && !walletAddressesEqual(record.family, current.address, record.entry.address)) throw new WalletLifecycleError();
  const file = derivePath(record.family, record.entry);
  if (existsSync(file)) {
    if (hash(readPrivateFile(file)) !== record.keyHash) throw new WalletLifecycleError();
    unlinkSync(file);
    syncPrivateDirectory(CONFIG_DIR);
  }
  afterStep?.("keystore");
  cfg.wallet[record.family] = cfg.wallet[record.family].filter((entry) => entry.id !== record.entry.id);
  durablePrivateWrite(CONFIG_FILE, JSON.stringify(cfg, null, 2), CONFIG_DIR);
  afterStep?.("config");
  writeWalletRemovalRecord({ ...record, state: "removed" });
  afterStep?.("completed");
}

/** Recovery creates a new identity. Old sessions and approvals retain the retired identity. */
export async function restoreRemovedWallet(record: WalletRemovalRecord, password: string, authorized: () => boolean = () => true, recoveryPassword = password): Promise<WalletInventoryEntry> {
  if (record.state !== "removed") throw new WalletLifecycleError("Finish the interrupted removal before restoring this wallet.");
  const keystore = readRecoveryKeystore(record);
  const address = await deriveAddressFromKeystore(record.family, keystore, recoveryPassword);
  if (!walletAddressesEqual(record.family, address, record.entry.address)) throw new WalletLifecycleError();
  let encrypted = JSON.stringify(keystore);
  if (password !== recoveryPassword) {
    const secret = await decryptSecretBytes(keystore, recoveryPassword);
    try { encrypted = JSON.stringify(await encryptSecretBytes(secret, password)); }
    finally { secret.fill(0); }
  }
  if (!authorized()) throw new WalletLifecycleError("Wallet recovery confirmation expired.");
  const cfg = readRemovalConfig();
  assertCanAddWallet(record.family, address, cfg);
  const entry = { ...record.entry, id: generateWalletId(record.family), createdAt: new Date().toISOString() } satisfies WalletInventoryEntry;
  durablePrivateWrite(derivePath(record.family, entry), encrypted, CONFIG_DIR);
  cfg.wallet[record.family].push(entry);
  durablePrivateWrite(CONFIG_FILE, JSON.stringify(cfg, null, 2), CONFIG_DIR);
  return entry;
}
