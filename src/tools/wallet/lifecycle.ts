import { randomUUID } from "node:crypto";
import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CONFIG_DIR } from "../../config/paths.js";
import { isValidWalletId } from "../../config/store.js";

const entrySchema = z.object({
  id: z.string(), address: z.string().min(1).max(128), label: z.string().max(120), createdAt: z.string(),
}).strict();
export const removalRecordSchema = z.object({
  version: z.literal(1), family: z.enum(["evm", "solana"]), entry: entrySchema,
  state: z.enum(["removing", "removed"]), backupId: z.string().uuid(),
  keyHash: z.string().regex(/^[a-f0-9]{64}$/), requestedAt: z.string().datetime(),
}).strict().refine((value) => isValidWalletId(value.family, value.entry.id, false));
export type WalletRemovalRecord = z.infer<typeof removalRecordSchema>;
export const WALLET_REMOVALS_DIR = join(CONFIG_DIR, "wallet-removals");

export class WalletLifecycleError extends Error {
  constructor(message = "Wallet access is disabled pending removal recovery.") {
    super(message);
    this.name = "WalletLifecycleError";
  }
}

/** Reject links and unexpected file types before reading privileged state. */
export function readPrivateFile(file: string, maxBytes = 64 * 1024): Buffer {
  const before = lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) throw new WalletLifecycleError();
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new WalletLifecycleError();
    const bytes = readFileSync(fd);
    const after = lstatSync(file);
    if (before.dev !== after.dev || before.ino !== after.ino || bytes.length > maxBytes) throw new WalletLifecycleError();
    return bytes;
  } finally { closeSync(fd); }
}

export function assertPrivateDirectory(dir: string): void {
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new WalletLifecycleError();
}

/** Flush file contents before rename and the parent directory before proceeding. */
export function durablePrivateWrite(file: string, bytes: Buffer | string, directory: string): void {
  assertPrivateDirectory(directory);
  const tmp = join(directory, `.${randomUUID()}.tmp`);
  const fd = openSync(tmp, "wx", 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  try {
    renameSync(tmp, file);
    syncPrivateDirectory(directory);
  } finally { if (existsSync(tmp)) unlinkSync(tmp); }
}

export function syncPrivateDirectory(directory: string): void {
  // Windows FlushFileBuffers does not accept directory handles. File contents
  // still flush before rename; startup always rechecks the durable record.
  if (process.platform === "win32") return;
  const fd = openSync(directory, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function listWalletRemovalRecords(directory = WALLET_REMOVALS_DIR): WalletRemovalRecord[] {
  try { assertPrivateDirectory(directory); } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return [];
    throw new WalletLifecycleError();
  }
  const records: WalletRemovalRecord[] = [];
  for (const name of readdirSync(directory)) {
    if (name.startsWith(".") && name.endsWith(".tmp")) continue;
    const parsed = removalRecordSchema.safeParse(JSON.parse(readPrivateFile(join(directory, name)).toString("utf8")));
    if (!parsed.success || name !== `${parsed.data.entry.id}.json`) throw new WalletLifecycleError();
    records.push(parsed.data);
  }
  return records;
}

export function writeWalletRemovalRecord(record: WalletRemovalRecord, directory = WALLET_REMOVALS_DIR): void {
  const value = removalRecordSchema.parse(record);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertPrivateDirectory(CONFIG_DIR);
  durablePrivateWrite(join(directory, `${value.entry.id}.json`), JSON.stringify(value), directory);
  syncPrivateDirectory(CONFIG_DIR);
}

/** Tombstones are intentionally outside config and backup archives, and never cleared by restore. */
export function walletIdIsRetired(id: string): boolean {
  const family = id.startsWith("sol_") ? "solana" : "evm";
  if (!isValidWalletId(family, id, id.endsWith("_legacy"))) return false;
  try {
    assertPrivateDirectory(WALLET_REMOVALS_DIR);
    const record = removalRecordSchema.parse(JSON.parse(readPrivateFile(join(WALLET_REMOVALS_DIR, `${id}.json`)).toString("utf8")));
    if (record.entry.id !== id || record.family !== family) throw new WalletLifecycleError();
    return true;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return false;
    throw new WalletLifecycleError();
  }
}

export function assertWalletActive(id: string): void {
  if (walletIdIsRetired(id)) throw new WalletLifecycleError("This wallet was removed from Vex. Select a wallet in a new chat.");
}
