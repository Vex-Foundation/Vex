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
import { canonicalTransactionPreview } from "./preview.js";
import { accept, refuse, type TransactionOutcome } from "./refusal.js";

/**
 * The canonical card for a durable row: rendered from the row's OWN bound
 * fields, by the same function the digest preimage and the prepare path use.
 *
 * The stored `preview_json` is never read to produce it. That is the point: the
 * stored value is a CACHE of this computation, and the only useful thing to do
 * with a cache on the money path is to check it.
 */
export function canonicalPreviewOfIntent(
  intent: WalletTransactionIntent,
): WalletIntentPreview {
  const preview = canonicalTransactionPreview({
    family: intent.family,
    chainAlias: intent.chainAlias,
    decoded: intent.decoded,
    feeBounds: intent.feeBounds,
    evmValueWei: intent.payload.family === "eip155" ? intent.payload.evm.valueWei : null,
  });
  return { label: preview.label, criticalArgs: { ...preview.criticalArgs } };
}

/**
 * Whole-card equality: the sentence AND every argument, with no key allowed to
 * appear or vanish on either side.
 *
 * A subset comparison would let an added key through, and an added key is
 * exactly the shape a misleading card takes - the true facts still present,
 * with one more line the user reads as authoritative.
 */
export function approvalPreviewsEqual(
  a: WalletIntentPreview,
  b: WalletIntentPreview,
): boolean {
  if (a.label !== b.label) return false;
  const aKeys = Object.keys(a.criticalArgs).sort();
  const bKeys = Object.keys(b.criticalArgs).sort();
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(
    (key, index) => key === bKeys[index] && a.criticalArgs[key] === b.criticalArgs[key],
  );
}

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
  // THE CARD IS RE-DERIVED, and the stored one is checked against it. The
  // digest covers the canonical preview, so a row whose `preview_json` was
  // edited still recomputes its digest correctly - what changed is the sentence
  // a human would be shown, and only this comparison sees it. Refusing here
  // means the edit is caught BEFORE the approval is enqueued, so no card
  // describing a transaction incorrectly ever reaches a person.
  const canonicalPreview = canonicalPreviewOfIntent(intent);
  const storedPreview: WalletIntentPreview = {
    label: intent.preview.label,
    criticalArgs: { ...intent.preview.criticalArgs },
  };
  if (!approvalPreviewsEqual(storedPreview, canonicalPreview)) {
    return refuse(
      "invalid_input",
      `Refusing to bind an approval: the stored preview on intent ${intent.intentId} is not the `
      + "preview its own decoded effects, fee bounds and chain produce, so the description a user "
      + "would read was changed after the transaction was prepared. Nothing was signed and no funds "
      + "moved. Prepare the transaction again.",
      { intentId: intent.intentId },
    );
  }

  return accept<PreparedApprovalBinding>({
    preview: canonicalPreview,
    intentExpiresAt: intent.expiresAt,
    proposalDigest: intent.proposalDigest,
    proposalDigestVersion: intent.proposalDigestVersion,
    resource: {
      table: WALLET_TRANSACTION_INTENTS_RESOURCE,
      intentId: intent.intentId,
    },
  });
}
