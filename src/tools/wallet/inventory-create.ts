/**
 * Wallet inventory mutations — create / import / export. Puzzle 5 stage 1.
 *
 * New (non-legacy) wallets get a `wallet-<id>.json` keystore under CONFIG_DIR
 * and append to the per-family inventory after the cap + duplicate checks.
 * These functions hold key material only transiently (encrypt → write file);
 * they never return private keys. The legacy wallet create/import
 * write-paths are separate (fixed keystore + `registerPrimaryLegacyWallet`).
 */

import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { Keypair } from "@solana/web3.js";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import type { KeystoreV1 } from "./keystore.js";

import {
  loadConfig,
  saveConfig,
  type VexConfig,
  type WalletInventoryEntry,
} from "../../config/store.js";
import { VexError, ErrorCodes } from "../../errors.js";
import { minLogger as logger } from "../../utils/logger-shim.js";
import { requireKeystorePassword } from "../../utils/env.js";
import { autoBackup } from "./backup.js";
import { encryptPrivateKey, normalizePrivateKey, saveKeystoreFile } from "./keystore.js";
import {
  deriveSolanaAddress,
  encryptSolanaSecretKey,
  normalizeSolanaSecretKey,
} from "./solana-keystore.js";
import {
  assertCanAddWallet,
  derivePath,
  generateWalletId,
  type InventoryFamily,
} from "./inventory.js";

function defaultLabel(family: InventoryFamily, cfg: VexConfig): string {
  const n = cfg.wallet[family].length + 1;
  return family === "solana" ? `Solana ${n}` : `EVM ${n}`;
}

/**
 * Shared tail: validate cap+duplicate, mint a non-reusable id, write the
 * derived keystore, append, persist. Returns the entry (no key material).
 */
function appendWalletEntry(
  family: InventoryFamily,
  address: string,
  keystore: KeystoreV1,
  label?: string,
): WalletInventoryEntry {
  const cfg = loadConfig();
  assertCanAddWallet(family, address, cfg);
  const trimmedLabel = label?.trim();
  if (trimmedLabel !== undefined && trimmedLabel.length > 120) {
    // Reject BEFORE any keystore/config write — the config normalizer drops
    // entries whose label exceeds 120 chars, so persisting one is silent data
    // loss (Codex 5D review). Boundary IPC schema also caps it.
    throw new VexError(
      ErrorCodes.AGENT_VALIDATION_ERROR,
      "Wallet label must be 120 characters or fewer.",
    );
  }
  const entry: WalletInventoryEntry = {
    id: generateWalletId(family),
    address,
    label: trimmedLabel || defaultLabel(family, cfg),
    createdAt: new Date().toISOString(),
  };
  saveKeystoreFile(derivePath(family, entry), keystore);
  cfg.wallet[family] = [...cfg.wallet[family], entry];
  saveConfig(cfg);

  // Snapshot the full wallet surface AFTER the wallet is persisted. Fire-and-
  // forget so the create/import result never waits on the backup (unchanged
  // behaviour; the keystore derive above is the only awaited step). A backup
  // failure NEVER rolls back the just-saved wallet: the wallet is the source of
  // truth; the backup is best-effort durability.
  void autoBackup().catch((err: unknown) => {
    logger.warn(
      `Post-add wallet backup failed (wallet kept): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  });

  return entry;
}

export async function createEvmWalletEntry(
  opts: { label?: string } = {},
): Promise<WalletInventoryEntry> {
  const password = requireKeystorePassword();
  const privateKey = generatePrivateKey();
  const address = privateKeyToAddress(privateKey);
  return appendWalletEntry("evm", address, await encryptPrivateKey(privateKey, password), opts.label);
}

export async function importEvmWalletEntry(
  rawKey: string,
  opts: { label?: string } = {},
): Promise<WalletInventoryEntry> {
  const password = requireKeystorePassword();
  const normalized = normalizePrivateKey(rawKey);
  const address = privateKeyToAddress(normalized);
  return appendWalletEntry("evm", address, await encryptPrivateKey(normalized, password), opts.label);
}

export async function createSolanaWalletEntry(
  opts: { label?: string } = {},
): Promise<WalletInventoryEntry> {
  const password = requireKeystorePassword();
  const keypair = Keypair.generate();
  const address = deriveSolanaAddress(keypair.secretKey);
  return appendWalletEntry(
    "solana",
    address,
    await encryptSolanaSecretKey(keypair.secretKey, password),
    opts.label,
  );
}

export async function importSolanaWalletEntry(
  rawKey: string,
  opts: { label?: string } = {},
): Promise<WalletInventoryEntry> {
  const password = requireKeystorePassword();
  const secret = normalizeSolanaSecretKey(rawKey);
  const address = deriveSolanaAddress(secret);
  return appendWalletEntry(
    "solana",
    address,
    await encryptSolanaSecretKey(secret, password),
    opts.label,
  );
}

interface ExportManifestWallet {
  id: string;
  family: InventoryFamily;
  address: string;
  label: string;
  createdAt: string;
  legacy: boolean;
}

/**
 * Export a WALLET-ONLY bundle into `destDir`: the encrypted keystore files + a
 * sanitized `manifest.json` carrying inventory metadata only
 * ({id,family,address,label,createdAt,legacy}). It deliberately does NOT copy
 * `config.json` — that holds non-wallet secrets (solana.jupiterApiKey, service
 * / model config). The RETURN value is filenames only; no key material or
 * config secrets cross the return path (Codex 5D review).
 *
 * The manifest is written LAST, after every keystore copy succeeds, so a copy
 * failure throws before a "complete" manifest is produced (no partial success).
 */
export function exportAllWallets(destDir: string): { files: string[] } {
  mkdirSync(destDir, { recursive: true });
  const cfg = loadConfig();
  const files: string[] = [];
  const wallets: ExportManifestWallet[] = [];

  for (const family of ["evm", "solana"] as const) {
    for (const entry of cfg.wallet[family]) {
      const src = derivePath(family, entry);
      if (!existsSync(src)) continue;
      const base = basename(src);
      cpSync(src, join(destDir, base)); // throws on failure → no success returned
      if (!files.includes(base)) files.push(base);
      wallets.push({
        id: entry.id,
        family,
        address: entry.address,
        label: entry.label,
        createdAt: entry.createdAt,
        legacy: entry.legacy ?? false,
      });
    }
  }

  writeFileSync(
    join(destDir, "manifest.json"),
    JSON.stringify({ version: 1, wallets }, null, 2),
    "utf-8",
  );
  files.push("manifest.json");

  return { files };
}
