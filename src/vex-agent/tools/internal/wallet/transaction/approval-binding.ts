/**
 * `PreparedApprovalBinding` - the typed contract that binds an approval to the
 * PROPOSAL rather than to a pair of identifiers.
 *
 * ## The problem it solves
 *
 * Without it, an approval for a generic signing call is bound to
 * `{ walletFamily, intentId }` and carries the enqueue path's default TTL. Both
 * are wrong on the money path: the identifiers describe WHICH row, not WHAT it
 * does, and the default TTL outlives a Solana blockhash by an order of
 * magnitude. A binding carries the decoded preview the user actually read, the
 * intent's OWN expiry, and the versioned proposal digest, so the approved
 * resume can compare against what was approved instead of against whatever
 * currently sits beside the row.
 *
 * ## Rebuilt from the DURABLE row, never from a prepare result
 *
 * A confirm can arrive from a manual agent call or an MCP client that never saw
 * the prepare return value, and after a process restart there is no in-memory
 * result at all. So the binding is REBUILT from the strictly parsed durable row
 * (`parseDurableIntentRow`), which makes the row the single source of truth for
 * what the approval means. Passing a caller-supplied binding into the enqueue
 * seam would let the caller choose the sentence the user approves.
 *
 * Pass 2 wires this into the confirm handler and both enqueue paths, where the
 * binding is incorporated into the canonical approval request digest.
 */

import type { WalletIntentPreview } from "@vex-agent/db/repos/wallet-intents.js";
import type { WalletTransactionIntent } from "@vex-agent/db/repos/wallet-transaction-intents.js";
import { PROPOSAL_DIGEST_VERSION } from "@vex-agent/db/contracts/wallet-transaction-intent.js";

import { WALLET_TRANSACTION_INTENTS_RESOURCE } from "./proposal-digest.js";
import { accept, refuse, type TransactionOutcome } from "./refusal.js";

/**
 * What an approval for a prepared proposal is bound to.
 *
 * `resource` names the TABLE as well as the id: two intent tables now exist and
 * a confirm must not be able to consume the other one's row, so the table
 * travels with the binding rather than being inferred from the tool that
 * happens to be resuming.
 */
export interface PreparedApprovalBinding {
  /** The decoded preview the approval card shows. Same shape as the transfer path's. */
  readonly preview: WalletIntentPreview;
  /** The INTENT's own expiry, not the enqueue path's default TTL. */
  readonly intentExpiresAt: string;
  readonly proposalDigest: string;
  readonly proposalDigestVersion: string;
  readonly resource: {
    readonly table: typeof WALLET_TRANSACTION_INTENTS_RESOURCE;
    readonly intentId: string;
  };
}

/**
 * Build the binding from a durable intent row.
 *
 * Refuses an unknown digest version BY NAME. A row written by a future build
 * under a different serialization cannot be compared against this build's
 * digest, and reporting that as "the proposal changed" would send an operator
 * looking for an attack that did not happen.
 */
export function bindingFromDurableIntent(
  intent: WalletTransactionIntent,
): TransactionOutcome<PreparedApprovalBinding> {
  if (intent.proposalDigestVersion !== PROPOSAL_DIGEST_VERSION) {
    return refuse(
      "invalid_input",
      `Refusing to bind an approval: intent ${intent.intentId} carries proposal digest version `
      + `"${intent.proposalDigestVersion}", and this build computes "${PROPOSAL_DIGEST_VERSION}". A `
      + "digest from a different serialization cannot be compared, so this is refused rather than "
      + "reported as proposal drift. Prepare the transaction again on this build.",
      {
        intentId: intent.intentId,
        storedVersion: intent.proposalDigestVersion,
        supportedVersion: PROPOSAL_DIGEST_VERSION,
      },
    );
  }
  return accept<PreparedApprovalBinding>({
    preview: {
      label: intent.preview.label,
      criticalArgs: { ...intent.preview.criticalArgs },
    },
    intentExpiresAt: intent.expiresAt,
    proposalDigest: intent.proposalDigest,
    proposalDigestVersion: intent.proposalDigestVersion,
    resource: {
      table: WALLET_TRANSACTION_INTENTS_RESOURCE,
      intentId: intent.intentId,
    },
  });
}
