/**
 * WHICH PREQUOTE ROW, and WHICH DISCLOSURE ON IT, an approval authorized.
 *
 * WHY IT EXISTS. `quote-authority/approved-authority.ts` binds the SNAPSHOT a
 * card named, and the atomic claim enforces it - but only for the venues that
 * seal a route snapshot. Two things sit outside that binding and both decide
 * money:
 *
 *   1. The prequote GATE itself. On an approval resume the approval gate is
 *      skipped (`context.approved` is true) while the prequote gate reruns, and
 *      `selectAuthorizedRow` deliberately takes the LATEST executable row. A
 *      quote Q2 recorded while the card was waiting therefore became the row the
 *      resumed dispatch was gated on, even though the human read Q1.
 *   2. Jupiter, which seals no snapshot and has no claim lane. Its execute
 *      derives BOTH its fee policy and the approved native-cost ceiling from the
 *      matched row, so a Q2 substitution silently replaces the fee preview and
 *      the ceiling the person actually saw.
 *
 * THE BLOCK. Two facts, and they answer two different questions. `prequoteId`
 * answers WHICH ROW; `disclosureDigest` answers WHAT THAT ROW SAID. The id
 * alone is not the consent: a row can keep its id while its bounded
 * `safety_detail` states a different fee preview, a different native ceiling or
 * a different spendability plan, and an execute held only to the id would then
 * be held to nothing a person read.
 *
 * The block is HOST-SIDE evidence throughout. It is derived from the gate's own
 * matched row, never from tool arguments or model output; it rides in
 * `approval_queue.tool_call` (so the request digest covers it) and is threaded
 * onto the execution context, never into the dispatched args.
 *
 * It is deliberately SEPARATE from `ApprovedQuoteAuthority` rather than an
 * extension of it. That block is the SNAPSHOT's identity and is consumed by the
 * claim; this one is the ROW's identity and its disclosure, and is consumed by
 * the gate. A venue can produce one, the other, or both, and collapsing them
 * would force a venue with no snapshot to have no binding at all.
 */

import { createHash } from "node:crypto";

import { z } from "zod";

/**
 * Preimage version of the bound-row block.
 *
 * Part of the stored value, therefore part of the approval's request digest: an
 * approval recorded under a different field set cannot be re-read as this one.
 * An unparseable or older-version block reads as ABSENT, and what an absent
 * block means is the consumer's contract, not this module's.
 */
export const APPROVED_PREQUOTE_AUTHORITY_VERSION = "prequote-authority-v1";

/** The two facts a resumed dispatch must be able to prove about its quote row. */
export interface ApprovedPrequoteAuthority {
  readonly v: string;
  /** `swap_prequotes.prequote_id` of the row the gate matched when the card was built. */
  readonly prequoteId: string;
  /** Digest of the disclosure that row carried into the card. */
  readonly disclosureDigest: string;
}

/**
 * The disclosure a matched row contributes to the approval card.
 *
 * Structurally the typed channels the gate reads off the row - the safety
 * verdict, the fee-on-transfer tax, the Pendle term lock, the Jupiter fee
 * preview, the quote binding, and the quote-time spendability statement (whose
 * canonical form carries both balance legs AND the bound debit plan). Typed
 * with `unknown` rather than by importing six venue vocabularies: this module
 * digests values, it does not interpret them, and the producing site is
 * type-checked at the call.
 */
export interface PrequoteDisclosure {
  readonly verdict: string;
  readonly fotTax?: unknown;
  readonly termLock?: unknown;
  readonly feePreview?: unknown;
  readonly quoteBinding?: unknown;
  readonly spendability?: unknown;
}

const approvedPrequoteAuthoritySchema = z.object({
  v: z.literal(APPROVED_PREQUOTE_AUTHORITY_VERSION),
  prequoteId: z.string().min(1),
  disclosureDigest: z.string().regex(/^[0-9a-f]{64}$/),
});

/**
 * SHA-256 over the key-sorted canonical form of the disclosure.
 *
 * Deterministic across the enqueue-time computation and the resume-time
 * recomputation because both sides derive their input from the SAME readers
 * over the same row (`gate/safety-detail.ts` + `readQuoteBindingPreview`), and
 * because the serialization sorts keys at every depth. An absent optional field
 * and a field explicitly set to `undefined` therefore produce the same digest,
 * which is correct: neither states anything on the card.
 */
export function digestPrequoteDisclosure(disclosure: PrequoteDisclosure): string {
  return createHash("sha256")
    .update(canonicalize(disclosure), "utf8")
    .digest("hex");
}

/** The block an enqueue stores, built from the gate's own matched row. */
export function approvedPrequoteAuthorityFrom(
  prequoteId: string,
  disclosure: PrequoteDisclosure,
): ApprovedPrequoteAuthority {
  return {
    v: APPROVED_PREQUOTE_AUTHORITY_VERSION,
    prequoteId,
    disclosureDigest: digestPrequoteDisclosure(disclosure),
  };
}

/**
 * Read a stored block back. A malformed or older-version block reads as `null`
 * rather than throwing, exactly like the snapshot binding beside it.
 */
export function readApprovedPrequoteAuthority(
  value: unknown,
): ApprovedPrequoteAuthority | null {
  const parsed = approvedPrequoteAuthoritySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Deterministic serialization: object keys sorted at every depth, arrays in
 * their given order, `undefined` members omitted exactly as `JSON.stringify`
 * omits them. Mirrors `approval-runtime/tool-call-envelope.ts`'s canonical
 * projection; it is re-stated here rather than imported because the tool layer
 * must not depend on the engine's approval runtime.
 */
function canonicalize(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const source = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(source).sort()) {
    const member = source[key];
    if (member === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${canonicalize(member)}`);
  }
  return `{${parts.join(",")}}`;
}
