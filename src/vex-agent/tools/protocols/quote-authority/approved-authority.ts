/**
 * WHICH quote an approval authorized, carried from the approval envelope to the
 * execute-time claim.
 *
 * WHY IT EXISTS. The approval card names one quote (`readQuoteBindingPreview`),
 * but the claim used to select the NEWEST executable row for the trade identity.
 * Those are the same row only when nothing happened in between - and an approval
 * card is precisely a pause during which something can. A quote Q2 recorded
 * after the human approved Q1 became the row the resumed execute claimed, so the
 * consent shown for one price authorized a fill at another. Binding the id, the
 * digest, the floor and the expiry into the stored envelope, and claiming THAT
 * row at dispatch, is what closes that window: a newer quote makes the bound row
 * non-current and the claim refuses with `superseded` instead of executing it.
 *
 * The block is HOST-SIDE evidence. It is derived from the gate's own matched row
 * (`ToolResult.prequote.quoteBinding`), never from tool arguments, and it never
 * becomes model-visible: it rides beside the call in `approval_queue.tool_call`
 * and is threaded onto the tool context, not into the dispatched args.
 */

import { z } from "zod";

/**
 * Preimage version of the bound-authority block.
 *
 * It is part of the stored value and therefore of the approval's request digest,
 * so an approval recorded under a different field set cannot be re-read as this
 * one: an unparseable block is absent, and an absent block on a claim lane means
 * the pre-binding behaviour (newest-executable), which is what historical rows
 * legitimately need.
 */
export const APPROVED_QUOTE_AUTHORITY_VERSION = "quote-authority-v1";

/** The four facts the dispatch must be able to prove about the quote it claims. */
export interface ApprovedQuoteAuthority {
  readonly v: string;
  /** `swap_prequotes.prequote_id` of the row the card named. */
  readonly snapshotId: string;
  /** Digest of the stored route snapshot, as the card stated it. */
  readonly digest: string;
  /** The floor the human consented to, in raw output units. */
  readonly approvedMinOutRaw: string;
  /** The row's own expiry, as the card stated it. */
  readonly expiresAt: string;
}

const approvedQuoteAuthoritySchema = z.object({
  v: z.literal(APPROVED_QUOTE_AUTHORITY_VERSION),
  snapshotId: z.string().min(1),
  digest: z.string().min(1),
  approvedMinOutRaw: z.string().regex(/^\d+$/),
  expiresAt: z.string().min(1),
});

/** The facts an approval binds, read off the card binding the gate produced. */
export function approvedQuoteAuthorityFrom(binding: {
  readonly snapshotId: string;
  readonly digest: string;
  readonly approvedMinOutRaw: string;
  readonly expiresAt: string;
}): ApprovedQuoteAuthority {
  return {
    v: APPROVED_QUOTE_AUTHORITY_VERSION,
    snapshotId: binding.snapshotId,
    digest: binding.digest,
    approvedMinOutRaw: binding.approvedMinOutRaw,
    expiresAt: binding.expiresAt,
  };
}

/**
 * Read a stored block back. A malformed or older-version block reads as `null`
 * rather than throwing, exactly like the proposal binding beside it: the caller's
 * own contract decides what an absent binding means.
 */
export function readApprovedQuoteAuthority(value: unknown): ApprovedQuoteAuthority | null {
  const parsed = approvedQuoteAuthoritySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
