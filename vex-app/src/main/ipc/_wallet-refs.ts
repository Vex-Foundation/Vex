/**
 * Server-side wallet-id → {id,address} resolution for per-session wallet
 * selection (puzzle 5 phase 5C). The renderer sends only inventory IDs; main
 * resolves the on-chain address from the engine config inventory (no DB, no
 * keys) so a renderer-supplied address is never trusted.
 */

import { getPrimaryEvmEntry, getWalletById } from "@vex-lib/wallet.js";
import type { VexError } from "@shared/ipc/result.js";

export type WalletRef = { id: string; address: string };

/**
 * Resolve a wallet ID for a family.
 *   - null/empty id → null (unselected);
 *   - known id → { id, address };
 *   - unknown id → "invalid" (caller fails closed, writes nothing).
 */
export function resolveWalletRef(
  family: "evm" | "solana",
  walletId: string | null | undefined,
): WalletRef | null | "invalid" {
  if (!walletId) return null;
  const entry = getWalletById(family, walletId);
  return entry ? { id: entry.id, address: entry.address } : "invalid";
}

/**
 * The wallet a Lighter desk session trades from.
 *
 * The desk is not the session-create form: it mints its session itself, as a
 * side effect of a trader opening setup, and there is nowhere in that flow to
 * choose a wallet. It used to mint one with NO selection, which left every
 * desk session unable to answer the first question its own setup modal asks -
 * "what is this wallet's Lighter account?" - and the read failed for want of
 * an address that was never going to arrive.
 *
 * Bound here rather than in the renderer so it holds for every route that
 * creates a desk session, present or future. An explicit selection is always
 * honoured; only the absence is filled, and only for this workspace, so an
 * ordinary chat-only session still means exactly what it says.
 */
export function deskWalletRef(
  workspace: string | null | undefined,
  selected: WalletRef | null,
): WalletRef | null {
  if (workspace !== "lighter" || selected !== null) return selected;
  const primary = getPrimaryEvmEntry();
  return primary === null ? null : { id: primary.id, address: primary.address };
}

export function invalidWalletSelectionError(correlationId: string): VexError {
  return {
    code: "wallets.invalid_selection",
    domain: "wallets",
    message: "Selected wallet is not in the inventory.",
    retryable: false,
    userActionable: true,
    redacted: true,
    correlationId,
  };
}
