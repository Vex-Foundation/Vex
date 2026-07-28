/**
 * Session wallet-state banner (puzzle 5 follow-up — agent address awareness).
 *
 * Injects the session's ACTIVE wallet addresses into the system prompt so the
 * agent knows exactly which EVM / Solana addresses its wallet + protocol tools
 * sign and operate with. Resolution mirrors the tool path EXACTLY — the same
 * buildSessionWalletResolution + the read-side resolver — so the banner can
 * never advertise an address the tools would reject:
 *   - a family with no selected wallet → "none selected" (those tools fail closed);
 *   - active-run contract drift / address drift → a fail-soft notice
 *     (prompt building must never crash the turn; the real fail-closed happens at
 *     the tool call via the same resolver).
 *
 * Addresses are public — safe in the system prompt. User-controlled wallet
 * labels are deliberately NOT included (no unsanitized text in instructions).
 */

import type { EngineContext } from "../types.js";
import { buildSessionWalletResolution } from "../core/hydrate.js";
import { resolveSelectedAddressSetForRead } from "@vex-agent/tools/internal/wallet/resolve.js";
import { VexError, ErrorCodes } from "../../../errors.js";

export function buildWalletStateBanner(context: EngineContext): string {
  let evm: string | null;
  let solana: string | null;
  try {
    const set = resolveSelectedAddressSetForRead(
      buildSessionWalletResolution(context),
      context.walletPolicy,
    );
    evm = set.evm;
    solana = set.solana;
  } catch (err) {
    // Fail-soft: prompt building must never crash the turn. The only throw from
    // resolveSelectedAddressSetForRead is WALLET_SCOPE_MISMATCH (active-run
    // contract drift / address drift — mission setup is allowed to read); the
    // real fail-closed happens at the tool call. Re-throw anything unexpected so
    // a genuine bug still surfaces.
    if (err instanceof VexError && err.code === ErrorCodes.WALLET_SCOPE_MISMATCH) {
      // The recovery differs per session kind: an AGENT session has no mission
      // contract to re-accept, so naming one there points the user at a step
      // that does not exist for them.
      return context.sessionKind === "mission"
        ? [
            "# Session wallets",
            "Wallet scope is unavailable for this session (mission contract drift or a removed wallet).",
            "Wallet and protocol trading tools will fail closed until the mission contract is re-accepted with a valid wallet selection.",
          ].join("\n")
        : [
            "# Session wallets",
            "Wallet scope is unavailable for this session (the selected wallet was removed or changed).",
            "Wallet and protocol trading tools will fail closed. Tell the user to select a wallet for this session in the app; there is nothing you can do from here.",
          ].join("\n");
    }
    throw err;
  }

  return [
    "# Session wallets",
    "Your wallet and protocol tools operate ONLY with these session-selected addresses:",
    `- EVM: ${evm ?? "none selected for this session (EVM wallet tools will fail closed)"}`,
    `- Solana: ${solana ?? "none selected for this session (Solana wallet tools will fail closed)"}`,
  ].join("\n");
}
