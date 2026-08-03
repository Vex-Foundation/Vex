/**
 * Solana wallet scoping for the Jupiter handlers — who owns the address, and
 * whose key signs.
 *
 * Extracted verbatim from `../core.ts` as part of a façade-preserving
 * structural split. Both functions stay re-exported from `../core.ts`, which
 * is the import every predict/lend/borrow caller already uses.
 */

import { walletAddressesEqual } from "@tools/wallet/inventory.js";
import { resolveSelectedAddress, resolveSigningWallet } from "@vex-agent/tools/internal/wallet/resolve.js";

import { VexError, ErrorCodes } from "../../../../../../errors.js";
import type { ProtocolExecutionContext } from "../../../types.js";
import { str } from "../../../handler-helpers.js";

export function walletAddress(p: Record<string, unknown>, ctx: ProtocolExecutionContext): string {
  const explicit = str(p, "walletAddress");
  if (ctx.walletResolution.source === "session") {
    // Session authority: the selected Solana wallet is the only valid owner.
    // An explicit (renderer/LLM-supplied) address that differs is rejected — it
    // must never override session scope.
    const selected = resolveSelectedAddress(ctx.walletResolution, ctx.walletPolicy, "solana");
    if (explicit && !walletAddressesEqual("solana", explicit, selected)) {
      throw new VexError(
        ErrorCodes.WALLET_SCOPE_MISMATCH,
        "The provided walletAddress does not match the session's selected Solana wallet.",
      );
    }
    return selected;
  }
  // source:"default" — explicit override preserved; else the primary.
  return explicit || resolveSelectedAddress(ctx.walletResolution, ctx.walletPolicy, "solana");
}

export function walletSecret(ctx: ProtocolExecutionContext): Uint8Array {
  const signer = resolveSigningWallet(ctx.walletResolution, ctx.walletPolicy, "solana");
  if (signer.family !== "solana") {
    throw new VexError(ErrorCodes.WALLET_SCOPE_MISMATCH, "Resolved wallet family mismatch (expected solana).");
  }
  return signer.secretKey;
}
