import { type Address, type Hex } from "viem";
import { VexError, ErrorCodes } from "../../errors.js";
import type { WalletInventoryEntry } from "../../config/store.js";
import { requireWalletAndKeystore } from "./auth.js";
import { deriveSolanaAddress } from "./solana-keystore.js";
import {
  familyToInventory,
  getPrimaryEvmEntry,
  getPrimarySolanaEntry,
  getWalletById,
  loadEvmKey,
  loadSolanaSecret,
  walletAddressesEqual,
  type InventoryFamily,
} from "./inventory.js";
import type { ChainFamily } from "../khalani/types.js";

export interface EvmWallet {
  family: "eip155";
  address: Address;
  privateKey: Hex;
}

export interface SolanaWallet {
  family: "solana";
  address: string;
  secretKey: Uint8Array;
}

export type ChainWallet = EvmWallet | SolanaWallet;

// ── Entry → wallet loaders (engine/main only) ──────────────────────────────

function loadEvmWalletFromEntry(entry: WalletInventoryEntry): EvmWallet {
  return { family: "eip155", ...loadEvmKey(entry) };
}

function loadSolanaWalletFromEntry(entry: WalletInventoryEntry): SolanaWallet {
  const secretKey = loadSolanaSecret(entry);
  const derivedAddress = deriveSolanaAddress(secretKey);
  if (derivedAddress !== entry.address) {
    throw new VexError(
      ErrorCodes.KHALANI_ADDRESS_MISMATCH,
      "Configured Solana address does not match the keystore.",
      "Run: vex wallet ensure to refresh saved addresses.",
    );
  }
  return { family: "solana", address: derivedAddress, secretKey };
}

// ── Primary resolution (no session-scoped wallet selection) ────────────────

export function requireEvmWallet(): EvmWallet {
  const { address, privateKey } = requireWalletAndKeystore();
  return { family: "eip155", address, privateKey };
}

export function requireSolanaWallet(): SolanaWallet {
  const entry = getPrimarySolanaEntry();
  if (!entry) {
    throw new VexError(
      ErrorCodes.WALLET_NOT_CONFIGURED,
      "No Solana wallet configured.",
      "Configure a Solana wallet in Vex setup.",
    );
  }
  return loadSolanaWalletFromEntry(entry);
}

export function requireWalletForChain(family: ChainFamily): ChainWallet {
  return family === "solana" ? requireSolanaWallet() : requireEvmWallet();
}

// ── Session-scoped resolution (stage 2 wires this into the engine) ─────────

/**
 * How a wallet is chosen for the current execution. Engine sessions MUST use
 * `source: "session"` so a missing/unselected family fails CLOSED — there is
 * deliberately no fall-through to the primary wallet. `source: "default"` is
 * reserved for trusted maintenance paths that do not have per-session scope.
 */
export type WalletResolution =
  | {
      source: "session";
      evm: { id: string; address: string } | null;
      solana: { id: string; address: string } | null;
    }
  | { source: "default" };

/**
 * Resolve the wallet for a family under a resolution policy.
 *   - default → primary wallet.
 *   - session → the selected entry, validated by id AND address snapshot. A
 *     missing selection, deleted wallet, or address drift (e.g. a force
 *     re-import under the same id) throws a typed VexError so the caller can
 *     surface a fail-closed tool result rather than sign with the wrong key.
 */
/**
 * Validate + return the inventory entry for a family under a resolution policy,
 * WITHOUT decrypting any key. Address-only callers (`WalletBalances`, send prepare,
 * balance display) use this; signing callers add `loadWalletFromEntry`.
 *   - default → primary entry.
 *   - session → selected entry, validated by id AND address snapshot. Missing
 *     selection / removed wallet / address drift throw typed VexErrors.
 */
export function resolveSelectedEntry(
  family: ChainFamily,
  resolution: WalletResolution,
): { family: InventoryFamily; entry: WalletInventoryEntry } {
  const inv = familyToInventory(family);

  if (resolution.source === "default") {
    const entry = inv === "solana" ? getPrimarySolanaEntry() : getPrimaryEvmEntry();
    if (!entry) {
      throw new VexError(
        ErrorCodes.WALLET_NOT_CONFIGURED,
        `No ${inv} wallet is configured.`,
        inv === "solana" ? "Run: vex wallet create --chain solana" : "Run: vex wallet create",
      );
    }
    return { family: inv, entry };
  }

  const selected = inv === "solana" ? resolution.solana : resolution.evm;
  if (!selected) {
    throw new VexError(
      ErrorCodes.WALLET_NOT_SELECTED,
      `No ${inv} wallet is selected for this session.`,
      "Select a wallet for this session before using wallet tools.",
    );
  }
  const entry = getWalletById(inv, selected.id);
  if (!entry) {
    throw new VexError(
      ErrorCodes.WALLET_SCOPE_MISMATCH,
      "The wallet selected for this session is no longer available.",
      "Re-select a wallet for this session.",
    );
  }
  if (!walletAddressesEqual(inv, entry.address, selected.address)) {
    throw new VexError(
      ErrorCodes.WALLET_SCOPE_MISMATCH,
      "The selected wallet's address changed since it was chosen for this session.",
      "Re-select a wallet for this session.",
    );
  }
  return { family: inv, entry };
}

/** Decrypt + build a ChainWallet from an already-resolved inventory entry. */
export function loadWalletFromEntry(
  family: InventoryFamily,
  entry: WalletInventoryEntry,
): ChainWallet {
  return family === "solana" ? loadSolanaWalletFromEntry(entry) : loadEvmWalletFromEntry(entry);
}

/**
 * Resolve + decrypt the signing wallet for a family (address-snapshot pinned).
 * Composition of `resolveSelectedEntry` + `loadWalletFromEntry`. Kept for the
 * engine signing path and trusted maintenance callers.
 */
export function resolveWalletForFamily(
  family: ChainFamily,
  resolution: WalletResolution,
): ChainWallet {
  const { family: inv, entry } = resolveSelectedEntry(family, resolution);
  return loadWalletFromEntry(inv, entry);
}
