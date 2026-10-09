/**
 * Wallet inventory — per-family registry over the config arrays
 * (`VexConfig.wallet.evm` / `.solana`). Puzzle 5 stage 1 (multi-wallet).
 *
 * Source of truth:
 *   - config (id / address / label / createdAt / legacy) — NO key material;
 *   - keystore FILES hold the encrypted keys; their path is DERIVED from the
 *     entry id (or the fixed legacy file), never stored in config.
 *
 * `requireEvmWallet()` / `requireSolanaWallet()` resolve the PRIMARY entry
 * (index 0) for trusted callers without session-scoped wallet selection.
 * Per-session selection resolves a specific entry by id+address.
 */

import { assertWalletActive, walletIdIsRetired } from "./lifecycle.js";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { getAddress, type Address, type Hex } from "viem";
import { privateKeyToAddress } from "viem/accounts";

import { CONFIG_DIR, KEYSTORE_FILE, SOLANA_KEYSTORE_FILE } from "../../config/paths.js";
import {
  isValidWalletId,
  loadConfig,
  saveConfig,
  type VexConfig,
  type WalletInventoryEntry,
} from "../../config/store.js";
import { VexError, ErrorCodes } from "../../errors.js";
import { requireKeystorePassword } from "../../utils/env.js";
import type { ChainFamily } from "../khalani/types.js";
import { decryptPrivateKey, loadKeystoreFile } from "./keystore.js";
import {
  decryptSolanaSecretKey,
  deriveSolanaAddress,
  encodeSolanaSecretKey,
} from "./solana-keystore.js";

/** Config-side family key. Distinct from `ChainFamily` ("eip155"|"solana"). */
export type InventoryFamily = "evm" | "solana";

/** Product cap: at most 3 wallets per family (puzzle 5). */
export const MAX_WALLETS_PER_FAMILY = 3;

export function familyToInventory(family: ChainFamily): InventoryFamily {
  return family === "solana" ? "solana" : "evm";
}

/** EVM addresses compare case-insensitively; Solana base58 is case-sensitive. */
function normalizeForCompare(family: InventoryFamily, address: string): string {
  return family === "evm" ? address.toLowerCase() : address;
}

/** Family-aware address equality (EVM case-insensitive, Solana exact). */
export function walletAddressesEqual(family: InventoryFamily, a: string, b: string): boolean {
  return normalizeForCompare(family, a) === normalizeForCompare(family, b);
}

// ── Reads ────────────────────────────────────────────────────────────────

export function listWallets(
  family: InventoryFamily,
  cfg: VexConfig = loadConfig(),
): WalletInventoryEntry[] {
  return cfg.wallet[family].filter((entry) => !walletIdIsRetired(entry.id));
}

export function getWalletById(
  family: InventoryFamily,
  id: string,
  cfg: VexConfig = loadConfig(),
): WalletInventoryEntry | null {
  return walletIdIsRetired(id) ? null : cfg.wallet[family].find((entry) => entry.id === id) ?? null;
}

export function getPrimaryEvmEntry(cfg: VexConfig = loadConfig()): WalletInventoryEntry | null {
  return cfg.wallet.evm[0] ?? null;
}

export function getPrimarySolanaEntry(cfg: VexConfig = loadConfig()): WalletInventoryEntry | null {
  return cfg.wallet.solana[0] ?? null;
}

/** Primary (index 0) EVM address as a checksummed viem `Address`, or null. */
export function getPrimaryEvmAddress(cfg: VexConfig = loadConfig()): Address | null {
  const entry = cfg.wallet.evm[0];
  return entry ? getAddress(entry.address) : null;
}

export function getPrimarySolanaAddress(cfg: VexConfig = loadConfig()): string | null {
  return cfg.wallet.solana[0]?.address ?? null;
}

// ── Path derivation (traversal-guarded) ────────────────────────────────────

/**
 * Resolve the on-disk keystore path for an entry.
 *   - `legacy` → the fixed file constant for the family. The id is IGNORED, so
 *     a crafted "legacy" entry can never point anywhere else.
 *   - otherwise → `CONFIG_DIR/wallet-<id>.json`, with the id re-validated
 *     against `WALLET_ID_PATTERN` so no `/`, `\` or `.` can escape CONFIG_DIR.
 */
export function derivePath(family: InventoryFamily, entry: WalletInventoryEntry): string {
  const legacy = entry.legacy === true;
  // Bind id ↔ family ↔ legacy-flag. Rejects reserved sentinels used as
  // non-legacy ids, cross-family ids (e.g. a `sol_*` id in the EVM family),
  // and any traversal attempt (Codex stage-1 review P1).
  if (!isValidWalletId(family, entry.id, legacy)) {
    throw new VexError(
      ErrorCodes.WALLET_ID_INVALID,
      "Refusing to derive a keystore path for a non-canonical wallet id.",
      "Wallet inventory may be corrupted; re-import the wallet.",
    );
  }
  if (legacy) {
    return family === "solana" ? SOLANA_KEYSTORE_FILE : KEYSTORE_FILE;
  }
  return join(CONFIG_DIR, `wallet-${entry.id}.json`);
}

export function generateWalletId(family: InventoryFamily): string {
  const prefix = family === "solana" ? "sol" : "evm";
  return `${prefix}_${randomUUID()}`;
}

// ── Secret loading (engine/main only — never returned to renderer) ─────────

export async function loadEvmSecret(entry: WalletInventoryEntry): Promise<Hex> {
  assertWalletActive(entry.id);
  const keystore = loadKeystoreFile(derivePath("evm", entry));
  if (!keystore) {
    throw new VexError(
      ErrorCodes.KEYSTORE_NOT_FOUND,
      "Keystore not found for the selected EVM wallet.",
      "Re-import the wallet or restore from backup.",
    );
  }
  const key = await decryptPrivateKey(keystore, requireKeystorePassword());
  assertWalletActive(entry.id);
  return key;
}

export async function loadSolanaSecret(entry: WalletInventoryEntry): Promise<Uint8Array> {
  assertWalletActive(entry.id);
  const keystore = loadKeystoreFile(derivePath("solana", entry));
  if (!keystore) {
    throw new VexError(
      ErrorCodes.KHALANI_SOLANA_KEYSTORE_NOT_FOUND,
      "Keystore not found for the selected Solana wallet.",
      "Re-import the wallet or restore from backup.",
    );
  }
  const key = await decryptSolanaSecretKey(keystore, requireKeystorePassword());
  try { assertWalletActive(entry.id); return key; } catch (cause) { key.fill(0); throw cause; }
}

/**
 * Decrypt an EVM entry's key and assert it derives the recorded address. Fails
 * CLOSED on mismatch so we never sign with a key that doesn't belong to the
 * wallet the user/session authorized (Codex stage-1 review P1). Shared by the
 * primary (auth) and session (resolveWalletForFamily) paths.
 */
export async function loadEvmKey(
  entry: WalletInventoryEntry,
): Promise<{ address: Address; privateKey: Hex }> {
  const privateKey = await loadEvmSecret(entry);
  const recorded = getAddress(entry.address);
  if (privateKeyToAddress(privateKey) !== recorded) {
    throw new VexError(
      ErrorCodes.SIGNER_MISMATCH,
      "EVM keystore does not match the recorded wallet address.",
      "Re-import the wallet or restore from backup.",
    );
  }
  return { address: recorded, privateKey };
}

/**
 * Sudo-export decrypt path: decrypt a SPECIFIC inventory entry's key with a
 * CALLER-SUPPLIED password (NOT the session secret), verify the decrypted key
 * derives the recorded `entry.address` (fail-CLOSED on mismatch), and return
 * the clipboard-ready secret + format. The app's wallet-export IPC handler is
 * the only caller; it owns throttle / vault re-auth / clipboard lease / audit.
 * Solana plaintext bytes are zeroized after encoding (and on the mismatch
 * throw) so the raw key buffer does not linger.
 */
export async function decryptExportSecret(args: {
  readonly family: InventoryFamily;
  readonly entry: WalletInventoryEntry;
  readonly password: string;
}): Promise<{ readonly secret: string; readonly format: "hex" | "base58" }> {
  const { family, entry, password } = args;
  assertWalletActive(entry.id);
  const keystore = loadKeystoreFile(derivePath(family, entry));
  if (!keystore) {
    throw new VexError(
      family === "solana"
        ? ErrorCodes.KHALANI_SOLANA_KEYSTORE_NOT_FOUND
        : ErrorCodes.KEYSTORE_NOT_FOUND,
      "Keystore not found for the selected wallet.",
      "Re-import the wallet or restore from backup.",
    );
  }
  if (family === "evm") {
    const privateKey = await decryptPrivateKey(keystore, password);
    if (
      !walletAddressesEqual("evm", privateKeyToAddress(privateKey), entry.address)
    ) {
      throw new VexError(
        ErrorCodes.SIGNER_MISMATCH,
        "Decrypted EVM key does not match the recorded wallet address.",
        "Re-import the wallet or restore from backup.",
      );
    }
    assertWalletActive(entry.id);
    return { secret: privateKey, format: "hex" };
  }
  const secretKey = await decryptSolanaSecretKey(keystore, password);
  try {
    if (
      !walletAddressesEqual("solana", deriveSolanaAddress(secretKey), entry.address)
    ) {
      throw new VexError(
        ErrorCodes.SIGNER_MISMATCH,
        "Decrypted Solana key does not match the recorded wallet address.",
        "Re-import the wallet or restore from backup.",
      );
    }
    assertWalletActive(entry.id);
    return { secret: encodeSolanaSecretKey(secretKey), format: "base58" };
  } finally {
    secretKey.fill(0);
  }
}

// ── Writes ─────────────────────────────────────────────────────────────────

/**
 * Guard before adding a new (non-legacy) wallet. Enforces the per-family cap
 * and rejects duplicate addresses (case-insensitive for EVM).
 */
export function assertCanAddWallet(
  family: InventoryFamily,
  address: string,
  cfg: Pick<VexConfig, "wallet">,
): void {
  const arr = cfg.wallet[family];
  if (arr.length >= MAX_WALLETS_PER_FAMILY) {
    throw new VexError(
      ErrorCodes.WALLET_INVENTORY_FULL,
      `Wallet limit reached: at most ${MAX_WALLETS_PER_FAMILY} ${family} wallets.`,
      "Remove an existing wallet before adding another.",
    );
  }
  const norm = normalizeForCompare(family, address);
  if (arr.some((entry) => normalizeForCompare(family, entry.address) === norm)) {
    throw new VexError(
      ErrorCodes.WALLET_DUPLICATE_ADDRESS,
      "This wallet address is already in the inventory.",
    );
  }
}

/**
 * Upsert the single legacy (fixed-keystore) entry for a family and make it the
 * primary (index 0). Used by legacy write paths that still write the fixed
 * keystore file. Exactly one legacy entry can exist per family.
 */
export function registerPrimaryLegacyWallet(family: InventoryFamily, address: string): void {
  const cfg = loadConfig();
  const legacyId = family === "solana" ? "sol_legacy" : "evm_legacy";
  const rest = cfg.wallet[family].filter((entry) => entry.id !== legacyId);
  const entry: WalletInventoryEntry = {
    id: legacyId,
    address,
    label: "Primary",
    createdAt: new Date().toISOString(),
    legacy: true,
  };
  cfg.wallet[family] = [entry, ...rest];
  saveConfig(cfg);
}
