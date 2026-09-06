/**
 * The refusal vocabulary shared by every venue that binds an execute to an
 * approved quote.
 *
 * It lives apart from the per-provider snapshot codecs because BOTH of them
 * produce it and the card reader dispatches between them: a single module
 * owning the words keeps the two venues saying the same thing about the same
 * state, and keeps the import direction one-way (codec -> vocabulary).
 *
 * Every kind here is RECOVERABLE by design (owner constraint 2026-08-28):
 * "safe, and it has to keep working". None of them is a price comparison -
 * market movement inside the approved slippage passes by construction, because
 * the floor was derived once at quote time. What is refused is a snapshot that
 * is not the one the human approved: consumed, superseded, expired, or
 * byte-different.
 */

/** Why an execute may not proceed against a stored snapshot. */
export type SnapshotRefusalKind =
  | "missing_snapshot"
  | "snapshot_unreadable"
  | "snapshot_version_unsupported"
  | "not_executable"
  | "already_claimed"
  | "superseded"
  | "expired"
  | "digest_mismatch"
  | "disclosure_changed"
  | "unbound_approval";

export interface SnapshotRefusal {
  readonly kind: SnapshotRefusalKind;
  /** Agent-facing sentence: the real state, then the way forward. Never a dead end. */
  readonly message: string;
}

const REFUSAL_CAUSE: Record<SnapshotRefusalKind, string> = {
  missing_snapshot:
    "the matched quote carries no stored route snapshot, so there is nothing to execute against",
  snapshot_unreadable:
    "the stored route snapshot is not in a shape this build can read",
  // NOT folded into `snapshot_unreadable`. A quote recorded before the debit
  // plan was bound authorized a PRICE and nothing about the transactions the
  // swap would send, so this build cannot prove which set of transactions the
  // human agreed to. Self-clearing: the prequote TTL is 15 minutes.
  snapshot_version_unsupported:
    "the stored route snapshot is from an older quote format that did not bind the transactions this swap would send",
  not_executable:
    "the matched quote was recorded as not executable, so it never authorized a swap",
  already_claimed:
    "this quote has already been claimed by an execute; a quote authorizes exactly one attempt",
  superseded:
    "a newer quote for the same trade has replaced this one, and the newer quote is the authority",
  expired: "this quote has expired",
  digest_mismatch:
    "the stored route snapshot no longer matches its own digest, so it cannot be proven to be the route that was approved",
  // The claim's DISCLOSURE FENCE fired: the executor compared its fee statement
  // and its route against the block this row carried, and by the time the claim
  // ran that block was no longer the same. Distinct from `digest_mismatch`
  // (which is about the route snapshot's own integrity) and from `superseded`
  // (which is about a newer row), because what moved here is the disclosure a
  // person read on the row that is still current.
  disclosure_changed:
    "the disclosure on the quote authorizing this execute changed between the check and the claim, so what would be signed is no longer what was compared",
  // FAIL-CLOSED, not a fallback. An approval that names no quote cannot say
  // WHICH quote it authorized, and the alternative - executing whichever quote
  // is newest at resume time - is exactly the substitution the binding exists to
  // prevent. Recoverable like every other kind here: the way out is a fresh
  // quote and a fresh approval, which this build does bind.
  unbound_approval:
    "this approval predates quote binding, so Vex cannot prove which quote it authorized",
};

/** The quote tool a refusal points the agent back at, per venue. */
export const KYBER_FRESH_QUOTE_TOOL = "kyberswap__swap_quote";
export const UNISWAP_FRESH_QUOTE_TOOL = "uniswap__swap_quote";
export const VIRTUALS_FRESH_QUOTE_TOOL = "virtuals__agent_trade_quote";

/**
 * Build the typed refusal. One sentence shape: what happened, then what to do.
 *
 * `freshQuoteTool` names the venue's OWN quote tool. A refusal that sends the
 * agent to the wrong venue's quote would produce a prequote the execute cannot
 * match (the provider is part of the match identity), so the caller states its
 * own tool rather than inheriting a default it did not choose.
 */
export function snapshotRefusal(
  kind: SnapshotRefusalKind,
  freshQuoteTool: string = KYBER_FRESH_QUOTE_TOOL,
): SnapshotRefusal {
  return {
    kind,
    message: `Refused before signing: ${REFUSAL_CAUSE[kind]}. Nothing was signed. Request a fresh ${freshQuoteTool} and execute against that.`,
  };
}
