/**
 * The three CLOSED vocabularies of migration 067's provenance columns, and
 * their one owner.
 *
 * Deliberately a SIBLING of `./types.js` rather than a block inside it: the
 * `last_verification_reason` vocabulary (`VerificationReason`, the 065 column)
 * lives there and belongs to the pending-fallback workstream, and two owners
 * editing one file is how a vocabulary ends up with two half-closed sets. The
 * split is by COLUMN, which is also the one-writer-per-column rule:
 *
 *   065 `last_verification_reason` → `VerificationReason`   (`./types.js`)
 *   067 `confirmation_source`      → `ConfirmationSource`   (here)
 *   067 `settlement_source`        → `SettlementSource`     (here)
 *   067 `pending_reason`           → `PendingReason`        (here)
 *
 * Bounding these by NAME is what keeps an unbounded string of someone else's
 * making out of a user-visible field, and what makes the value ACTIONABLE: the
 * agent can tell `settlement_undecodable` ("we saw a successful receipt and
 * could not read the amounts") from `broadcast_ambiguous_confirm` ("we never saw
 * the receipt at all") — two different jobs for the fallback that produced an
 * identical final row before 067.
 *
 * NARROW ON WRITE, TOLERATE ON READ. These unions bound what this repository may
 * WRITE. The read types stay `string | null`, because rows written before 067
 * carry nothing and rows written by a future version may carry codes this build
 * has never heard of.
 */

/**
 * How a row's TERMINAL STATUS was established. Never says anything about the
 * amounts — that is `SettlementSource`, a separate column, because a status-only
 * sweep and a late decode answer different questions and neither may overwrite
 * the other's answer.
 *
 * `receipt_status_only_*` is split by chain family on purpose: the Solana sweep
 * reads a SIGNATURE STATUS and never a receipt, so a shared
 * `receipt_status_only` would be factually wrong on every Solana row.
 */
export const CONFIRMATION_SOURCES = [
  /** The venue handler decoded its OWN receipt at tool-return time. */
  "tool_response",
  /** An EVM repair sweep proved inclusion from a receipt status, and nothing else. */
  "receipt_status_only_evm",
  /** The Solana repair sweep proved inclusion from a signature status, and nothing else. */
  "receipt_status_only_solana",
  /** A bridge fill proven independently of the provider's own word. */
  "provider_fill_verified",
] as const;

export type ConfirmationSource = (typeof CONFIRMATION_SOURCES)[number];

/**
 * How a row's EXECUTED AMOUNTS were established — or, for the last three, why
 * they are absent. Written on a row that is ALREADY terminal; it never moves
 * `status`, and `conflict_quarantined` in particular does NOT mark a transaction
 * failed: the transaction succeeded, it is our reading of the amounts that is
 * disputed.
 */
export const SETTLEMENT_SOURCES = [
  /** Decoded by the venue handler from its own receipt, at return time. */
  "tool_response",
  /** Decoded later, by the pending fallback, from the same receipt. */
  "receipt_decoded_late",
  /** Proven by an independent observation of the destination fill. */
  "provider_verified",
  /**
   * Two decoders disagreed about money. NO amount was written, and the row is
   * DURABLY excluded from the fallback so it cannot re-conflict forever. A log
   * line does not survive a restart; this does.
   */
  "conflict_quarantined",
  /** A decode succeeded but could not produce every leg this row's role requires. */
  "amounts_incomplete",
  /** No decoder could read this transaction's amounts at all. */
  "amounts_undecodable",
] as const;

export type SettlementSource = (typeof SETTLEMENT_SOURCES)[number];

/**
 * The ONLY settlement sources a DECLINE may record. Narrower than
 * `SettlementSource` on purpose: that union also carries POSITIVE provenance
 * (`tool_response`, `receipt_decoded_late`, `provider_verified`), and a decline
 * path must be structurally unable to stamp a success.
 */
export const SETTLEMENT_DECLINE_REASONS = [
  "amounts_incomplete",
  "amounts_undecodable",
] as const;

export type SettlementDeclineReason = (typeof SETTLEMENT_DECLINE_REASONS)[number];

/**
 * Why a row that the tool return could NOT terminalize is still pending.
 *
 * The distinction this vocabulary exists for, concretely:
 * `broadcast_ambiguous_confirm` means "we never saw the receipt";
 * `settlement_undecodable` means "we saw a SUCCESSFUL receipt and could not read
 * the amounts". Those are two different jobs for the fallback, and before 067
 * they produced an identical final row — so the fallback had to guess.
 */
export const PENDING_REASONS = [
  /** The submit itself returned ambiguously — we do not know the tx was accepted. */
  "broadcast_ambiguous_send",
  /** Submitted, but the receipt wait never concluded — inclusion unknown. */
  "broadcast_ambiguous_confirm",
  /** A successful receipt, whose transfer amounts no decoder could read. */
  "settlement_undecodable",
  /** A launch mined, but its prebuy leg could not be decoded from the receipt. */
  "launch_prebuy_undecodable",
  /** The separate Vex-fee transfer's own broadcast ended ambiguously. */
  "fee_broadcast_ambiguous",
  /** A Solana signature was submitted; no commitment has been observed yet. */
  "solana_awaiting_confirmation",
  /** The provider reported a fill we have not independently proven. */
  "provider_fill_unverified",
  // ── Written by the pending-fallback lane's CHAIN OBSERVATIONS (R2) ──
  //
  // These two are CONCLUSIVE observations — we looked and learned something
  // definite — which is exactly why they live here and not in
  // `last_verification_reason`: that column means "why the last CHECK could not
  // conclude", and storing a successful observation there would make a
  // conclusion look like a failure. Same column, same writer
  // (`notePendingReason`), one vocabulary.
  /**
   * The transaction is IN THE MEMPOOL of the node we asked: known, not yet
   * mined. The row is healthy and waiting — the copy must say "do not
   * re-broadcast", never "stalled".
   */
  "in_mempool",
  /**
   * ANOTHER transaction from this wallet has already used this one's nonce, and
   * this hash has no receipt. It does NOT establish that nothing was spent or
   * that a retry is safe: a replacement reusing the nonce may have carried the
   * same calldata and done the same thing. Correlating the replacement is
   * strictly more work than the lane does, so no surface may claim more.
   */
  "nonce_superseded",
] as const;

export type PendingReason = (typeof PENDING_REASONS)[number];
