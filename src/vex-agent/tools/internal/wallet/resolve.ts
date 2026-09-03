/**
 * Engine wallet resolution (puzzle 5 phase 5B). Bridges the per-session
 * `WalletResolution` + `WalletPolicy` (threaded via context) to the shared
 * inventory resolvers, and enforces mission scope.
 *
 * Two entry points, deliberately split (Codex stage-5B review):
 *   - `resolveSelectedAddress` - address-only, NEVER decrypts a key. For
 *     WalletBalances / send prepare / balance display.
 *   - `resolveSigningWallet` - decrypts the key. ONLY after the approval gate
 *     and immediately before broadcast (WalletSendConfirm executors).
 *
 * Both validate the session selection (id + address snapshot, via
 * `resolveSelectedEntry`) AND the mission wallet policy. Mission policy is NOT
 * gated on `sessionKind` - it rides the explicit `WalletPolicy` value.
 */

import { VexError, ErrorCodes } from "../../../../errors.js";
import type { ChainFamily } from "@tools/khalani/types.js";
import {
  loadWalletFromEntry,
  resolveSelectedEntry,
  type ChainWallet,
  type WalletResolution,
} from "@tools/wallet/multi-auth.js";
import { familyToInventory, walletAddressesEqual } from "@tools/wallet/inventory.js";
import type { WalletPolicy } from "@vex-agent/engine/types.js";

import type { ToolResult } from "../../types.js";

function assertWalletPolicy(
  policy: WalletPolicy,
  family: ChainFamily,
  address: string,
  allowSetupRead = false,
): void {
  if (policy.kind === "none") return;
  if (policy.kind === "invalid") {
    // Least-privilege setup exception (read-only callers only): during a
    // mission's SETUP phase - a mission exists but has NO active run, so the
    // policy is invalid with reason "mission_without_active_run" - read-only
    // resolvers opt in to let the session read its OWN selected wallet so setup
    // can be a research+planning phase. ALL other invalid reasons (active-run
    // contract drift: missing_or_malformed_snapshot / empty_allowed_wallets)
    // STILL fail closed even for reads. Signing/credential/intent paths never
    // pass allowSetupRead, so they stay fully fail-closed in setup.
    if (allowSetupRead && policy.reason === "mission_without_active_run") return;
    throw new VexError(
      ErrorCodes.WALLET_SCOPE_MISMATCH,
      "Mission wallet policy is invalid (contract drift - no accepted allowed wallets).",
      "Re-accept the mission contract and start a fresh run.",
    );
  }
  const inv = familyToInventory(family);
  if (!policy.allowedWallets.some((allowed) => walletAddressesEqual(inv, allowed, address))) {
    throw new VexError(
      ErrorCodes.WALLET_SCOPE_MISMATCH,
      "The selected wallet is not in the mission's allowed wallet set.",
    );
  }
}

/**
 * Resolve the selected wallet ADDRESS for a family - no key decrypt. Throws a
 * typed VexError on missing selection, removed wallet, address drift, or
 * mission-policy violation. Callers convert with `walletScopeErrorToResult`.
 */
export function resolveSelectedAddress(
  resolution: WalletResolution,
  policy: WalletPolicy,
  family: ChainFamily,
): string {
  const { entry } = resolveSelectedEntry(family, resolution);
  assertWalletPolicy(policy, family, entry.address);
  return entry.address;
}

/**
 * Read-only variant of `resolveSelectedAddress` that opts in to the mission
 * SETUP exception. Identical to `resolveSelectedAddress` EXCEPT it allows an
 * invalid policy with reason "mission_without_active_run" (mission exists, no
 * active run yet) so the session can READ its own selected wallet during setup.
 * Every other invalid reason still fails closed. Use ONLY for genuine reads
 * (balances, portfolio, prompt wallet banner); signing/credential/intent paths
 * must keep using `resolveSelectedAddress` (default fail-closed).
 */
export function resolveSelectedAddressForRead(
  resolution: WalletResolution,
  policy: WalletPolicy,
  family: ChainFamily,
): string {
  const { entry } = resolveSelectedEntry(family, resolution);
  assertWalletPolicy(policy, family, entry.address, true);
  return entry.address;
}

/**
 * The session's selected wallet addresses for READ scoping (puzzle 5 phase
 * 5E-2). `all` is the non-null set used as a `wallet_address = ANY(...)` filter.
 */
export interface SelectedWalletAddresses {
  evm: string | null;
  solana: string | null;
  all: string[];
}

/**
 * Resolve BOTH families' selected addresses for read-side wallet scoping.
 *
 *  - Invalid mission policy fails closed FIRST (contract drift must never
 *    degrade to an empty/global read - Codex 5E-2 review).
 *  - A family with no wallet (`WALLET_NOT_SELECTED` for a session, or
 *    `WALLET_NOT_CONFIGURED` for default resolution) is a VALID empty → null; the
 *    read simply shows nothing for that family.
 *  - Address drift / removed wallet / policy violation (`WALLET_SCOPE_MISMATCH`)
 *    re-throws so the read fails closed.
 *
 * `all` may be empty (a valid session with neither family selected) - callers
 * MUST treat an empty set as "no rows", never as a global query.
 */
export function resolveSelectedAddressSet(
  resolution: WalletResolution,
  policy: WalletPolicy,
): SelectedWalletAddresses {
  if (policy.kind === "invalid") {
    throw new VexError(
      ErrorCodes.WALLET_SCOPE_MISMATCH,
      "Mission wallet policy is invalid (contract drift - no accepted allowed wallets).",
      "Re-accept the mission contract and start a fresh run.",
    );
  }
  const evm = tryResolveSelectedAddress(resolution, policy, "eip155");
  const solana = tryResolveSelectedAddress(resolution, policy, "solana");
  const all = [evm, solana].filter((a): a is string => a !== null);
  return { evm, solana, all };
}

/** Per-family resolve that maps "validly absent" to null and re-throws drift. */
function tryResolveSelectedAddress(
  resolution: WalletResolution,
  policy: WalletPolicy,
  family: ChainFamily,
): string | null {
  try {
    return resolveSelectedAddress(resolution, policy, family);
  } catch (err) {
    if (
      err instanceof VexError &&
      (err.code === ErrorCodes.WALLET_NOT_SELECTED ||
        err.code === ErrorCodes.WALLET_NOT_CONFIGURED)
    ) {
      return null;
    }
    throw err;
  }
}

/**
 * Read-only variant of `resolveSelectedAddressSet` for the mission SETUP phase.
 * Identical to `resolveSelectedAddressSet` EXCEPT:
 *  - the top-level invalid guard allows reason "mission_without_active_run"
 *    (setup) to fall through to per-family resolution; genuine active-run drift
 *    (missing_or_malformed_snapshot / empty_allowed_wallets) STILL fails closed;
 *  - each family resolves via the read variant (setup exception opted in).
 * Use ONLY for genuine reads (portfolio scoping, prompt wallet banner). Signing
 * /credential/intent paths must keep using `resolveSelectedAddressSet`.
 */
export function resolveSelectedAddressSetForRead(
  resolution: WalletResolution,
  policy: WalletPolicy,
): SelectedWalletAddresses {
  if (policy.kind === "invalid" && policy.reason !== "mission_without_active_run") {
    throw new VexError(
      ErrorCodes.WALLET_SCOPE_MISMATCH,
      "Mission wallet policy is invalid (contract drift - no accepted allowed wallets).",
      "Re-accept the mission contract and start a fresh run.",
    );
  }
  const evm = tryResolveSelectedAddressForRead(resolution, policy, "eip155");
  const solana = tryResolveSelectedAddressForRead(resolution, policy, "solana");
  const all = [evm, solana].filter((a): a is string => a !== null);
  return { evm, solana, all };
}

/**
 * Read variant of `tryResolveSelectedAddress` - maps "validly absent" to null
 * and re-throws drift, resolving through `resolveSelectedAddressForRead` so the
 * setup exception applies. Mirrors `tryResolveSelectedAddress` exactly.
 */
function tryResolveSelectedAddressForRead(
  resolution: WalletResolution,
  policy: WalletPolicy,
  family: ChainFamily,
): string | null {
  try {
    return resolveSelectedAddressForRead(resolution, policy, family);
  } catch (err) {
    if (
      err instanceof VexError &&
      (err.code === ErrorCodes.WALLET_NOT_SELECTED ||
        err.code === ErrorCodes.WALLET_NOT_CONFIGURED)
    ) {
      return null;
    }
    throw err;
  }
}

/**
 * Resolve AND decrypt the signing wallet for a family. Same validation as
 * `resolveSelectedAddress` plus the key load. Call only after the approval gate
 * and just before broadcast.
 */
export function resolveSigningWallet(
  resolution: WalletResolution,
  policy: WalletPolicy,
  family: ChainFamily,
): ChainWallet {
  const { family: inv, entry } = resolveSelectedEntry(family, resolution);
  assertWalletPolicy(policy, family, entry.address);
  return loadWalletFromEntry(inv, entry);
}

/**
 * Convert a wallet-scope VexError into a fail-closed ToolResult. Re-throws
 * non-VexErrors (unexpected) so they surface as dispatch failures.
 */
export function walletScopeErrorToResult(err: unknown): ToolResult {
  if (err instanceof VexError) {
    return { success: false, output: err.message };
  }
  throw err;
}
