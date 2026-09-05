/**
 * Execute-side reader: turn an untrusted durable `route_ref` back into the
 * authority the execute may build from, or a TYPED refusal that names the state
 * and the way out of it.
 *
 * Every refusal here is RECOVERABLE by design (owner constraint 2026-08-28):
 * "safe, and it has to keep working". There is no zero-tolerance comparison in
 * this module - market movement within the approved slippage passes by
 * construction, because the floor is derived once at quote time and the chain
 * enforces it. What is refused is a snapshot that is not the one the human
 * approved: consumed, superseded, expired, or byte-different.
 */

import { z } from "zod";

import { boundDebitPlanSchema } from "./debit-plan.js";
import {
  ROUTE_SNAPSHOT_VERSION,
  digestRouteSnapshot,
  type RouteSnapshot,
} from "./snapshot.js";
import { snapshotRefusal as buildSnapshotRefusal } from "./refusal.js";
import type { SnapshotRefusal } from "./refusal.js";
import {
  UNISWAP_QUOTE_BINDING_CARD_VERSION,
  isUniswapRouteRef,
  restoreUniswapSnapshot,
} from "./uniswap.js";
import {
  VIRTUALS_QUOTE_BINDING_CARD_VERSION,
  isVirtualsRouteRef,
  restoreVirtualsSnapshot,
  virtualsCardFacts,
} from "./virtuals.js";

export { snapshotRefusal } from "./refusal.js";
export type { SnapshotRefusal, SnapshotRefusalKind } from "./refusal.js";

const RouteSnapshotSchema = z.object({
  v: z.literal(ROUTE_SNAPSHOT_VERSION),
  provider: z.literal("kyberswap"),
  raw: z.string().min(1),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  approvedAmountOutRaw: z.string().regex(/^\d+$/),
  approvedMinOutRaw: z.string().regex(/^\d+$/),
  approvedAmountOutHuman: z.string().min(1),
  approvedMinOutHuman: z.string().min(1),
  tokenOutSymbol: z.string().min(1),
  effectiveSlippageBps: z.number().int().min(0).max(10_000),
  expiresAt: z.string().min(1),
  eligibility: z.object({ kind: z.string() }).passthrough(),
  debitPlan: boundDebitPlanSchema,
});

/**
 * The eligibility a restored snapshot must carry to be executable at all.
 *
 * Parsed STRICTLY rather than cast: the outer schema only proves the blob has a
 * `kind`, and this lane's whole promise is that what comes back out of durable
 * storage is what the quote put in. A row whose executable verdict lost its
 * measured impact is a row this build cannot vouch for, so it is refused rather
 * than narrowed by assertion (rule 04: no cast where a check belongs).
 */
const ExecutableEligibilitySchema = z.object({
  kind: z.literal("executable"),
  priceImpactFraction: z.number(),
  adverse: z.boolean(),
});

/**
 * The version tag alone, read before the full shape.
 *
 * A row written by an older build fails the strict schema for a reason that has
 * a NAME - it is a snapshot from a format that bound less - and the agent is
 * told to re-quote rather than handed the generic "not a shape this build can
 * read". Everything else about the row is still untrusted, so this parse asks
 * for nothing but the tag.
 */
const SnapshotVersionSchema = z.object({ v: z.number().int() });

/**
 * The fields the execute actually consumes off a restored summary.
 *
 * Checked structurally on the way out of durable storage. The digest already
 * proves the BYTES are the ones the quote handler stored, and those bytes were
 * validated by the provider's own response validator when they were fetched -
 * but the data has crossed persistence since, and a floor and a build body are
 * derived from it, so the shape is re-asserted rather than assumed (rule 04).
 *
 * Deliberately a CHECK, never a normalization: the object handed to
 * `/route/build` stays the untouched parse of the digested string. Re-projecting
 * it would drop the per-step `poolExtra`/`extra` blobs the provider round-trips,
 * and the POSTed bytes would no longer be the bytes the digest covers.
 */
const RestoredRouteSummaryShape = z.object({
  amountOut: z.string().regex(/^\d+$/),
  amountIn: z.string(),
  tokenIn: z.string(),
  tokenOut: z.string(),
  routeID: z.string(),
  checksum: z.string(),
}).passthrough();

export type RestoredSnapshot =
  | { readonly ok: true; readonly snapshot: RouteSnapshot; readonly routeSummary: unknown }
  | { readonly ok: false; readonly refusal: SnapshotRefusal };

/**
 * Validate a stored `route_ref`, re-check its digest, and re-parse `raw` into
 * the object the build is POSTed with.
 *
 * The digest is recomputed over the STORED STRING, so this proves the snapshot
 * is byte-identical to the one recorded at quote time. `routeSummary` is the
 * parse of that same proven string - the object POSTed to `/route/build` is
 * therefore derived from verified bytes and from nothing else.
 */
export function restoreRouteSnapshot(routeRef: unknown): RestoredSnapshot {
  if (routeRef === null || routeRef === undefined) {
    return { ok: false, refusal: buildSnapshotRefusal("missing_snapshot") };
  }
  const version = SnapshotVersionSchema.safeParse(routeRef);
  if (version.success && version.data.v !== ROUTE_SNAPSHOT_VERSION) {
    return { ok: false, refusal: buildSnapshotRefusal("snapshot_version_unsupported") };
  }
  const parsed = RouteSnapshotSchema.safeParse(routeRef);
  if (!parsed.success) {
    return { ok: false, refusal: buildSnapshotRefusal("snapshot_unreadable") };
  }
  if (parsed.data.eligibility.kind !== "executable") {
    return { ok: false, refusal: buildSnapshotRefusal("not_executable") };
  }
  const eligibility = ExecutableEligibilitySchema.safeParse(parsed.data.eligibility);
  if (!eligibility.success) {
    return { ok: false, refusal: buildSnapshotRefusal("snapshot_unreadable") };
  }
  // Covers the stored string AND the bound debit plan: a tampered leg set or a
  // lifted fee ceiling fails here exactly like a tampered route summary.
  if (digestRouteSnapshot(parsed.data) !== parsed.data.digest) {
    return { ok: false, refusal: buildSnapshotRefusal("digest_mismatch") };
  }
  let routeSummary: unknown;
  try {
    routeSummary = JSON.parse(parsed.data.raw);
  } catch {
    return { ok: false, refusal: buildSnapshotRefusal("snapshot_unreadable") };
  }
  if (!RestoredRouteSummaryShape.safeParse(routeSummary).success) {
    return { ok: false, refusal: buildSnapshotRefusal("snapshot_unreadable") };
  }
  // The summary the caller POSTs is the UNTOUCHED parse, not the validator's
  // projection - see `RestoredRouteSummaryShape`.
  const snapshot: RouteSnapshot = { ...parsed.data, eligibility: eligibility.data };
  return { ok: true, snapshot, routeSummary };
}

// ── Approval-card binding ───────────────────────────────────────────────

/**
 * The version tag of the quote-binding line on an approval card.
 *
 * It rides INSIDE the rendered card value, so a card written by an older build
 * and a card written by this one are textually different and the whole-card
 * comparison at confirm time refuses the mismatch. That is the clean expiry the
 * approval lane already provides for in-flight proposals: an old-version card
 * cannot be confirmed by a new build, and the human is told to request a fresh
 * quote rather than shown a line whose meaning has changed underneath them.
 */
export const QUOTE_BINDING_CARD_VERSION = "kyber-quote-v1";

/** What the approval card states about the quote this proposal is bound to. */
export interface QuoteBindingPreview {
  /**
   * The venue's own card-line version tag, rendered first on the line.
   *
   * Carried on the preview rather than read from a module constant because the
   * two venues version their card lines independently: a KyberSwap card and a
   * Uniswap card bind different facts, and a single shared tag would make a
   * change to one silently expire in-flight proposals of the other.
   */
  readonly cardVersion: string;
  readonly snapshotId: string;
  readonly digest: string;
  readonly approvedAmountOutHuman: string;
  readonly approvedMinOutHuman: string;
  readonly approvedMinOutRaw: string;
  readonly tokenOutSymbol: string;
  readonly effectiveSlippageBps: number;
  readonly expiresAt: string;
  /**
   * Venue facts a person must read to consent, beyond the two figures every
   * venue states.
   *
   * It exists because one venue's approval genuinely binds more than a price and
   * a floor. A Virtuals curve trade binds the proxy IMPLEMENTATION behind
   * BondingV5, the curve's own tax, and the anti-sniper bound the caller
   * accepted - each of which can change what the wallet receives, and none of
   * which fits `approvedAmountOut`/`approvedMinOut`. They are sentences rather
   * than fields because the card is text and because a venue that has nothing to
   * add contributes nothing (rule 03: no ceremony where there is one owner and
   * no boundary).
   *
   * SOURCED FROM THE SEALED SNAPSHOT ONLY, never from raw args, exactly like
   * every other field on this preview.
   */
  readonly extraFacts?: readonly string[];
}

/**
 * Read the approval-card binding out of a matched prequote row. Returns
 * `undefined` when the row carries no readable executable snapshot - a card
 * must never state a floor it cannot prove.
 *
 * Dispatches on the snapshot's own `provider` tag, so a row written by one
 * venue is never read through the other's codec. The Uniswap snapshot binds
 * more than the card shows (the router input and the fee disposition); the CARD
 * states the two figures a person consents to - the output they were quoted and
 * the floor below which the swap must not fill.
 */
export function readQuoteBindingPreview(
  prequoteId: string,
  routeRef: unknown,
  expiresAt: string,
): QuoteBindingPreview | undefined {
  if (isVirtualsRouteRef(routeRef)) {
    const restored = restoreVirtualsSnapshot(routeRef);
    if (!restored.ok) return undefined;
    const facts = virtualsCardFacts(restored.snapshot);
    return {
      cardVersion: VIRTUALS_QUOTE_BINDING_CARD_VERSION,
      snapshotId: prequoteId,
      digest: restored.snapshot.digest,
      approvedAmountOutHuman: facts.quotedOutHuman,
      approvedMinOutHuman: facts.contractFloorHuman,
      approvedMinOutRaw: restored.snapshot.contractFloorRaw,
      tokenOutSymbol: facts.outSymbol,
      effectiveSlippageBps: restored.snapshot.slippageBps,
      expiresAt,
      extraFacts: facts.lines,
    };
  }
  if (isUniswapRouteRef(routeRef)) {
    const uni = restoreUniswapSnapshot(routeRef);
    if (!uni.ok) return undefined;
    const u = uni.snapshot;
    return {
      cardVersion: UNISWAP_QUOTE_BINDING_CARD_VERSION,
      snapshotId: prequoteId,
      digest: u.digest,
      approvedAmountOutHuman: u.approvedAmountOutHuman,
      approvedMinOutHuman: u.approvedMinOutHuman,
      approvedMinOutRaw: u.approvedMinOutRaw,
      tokenOutSymbol: u.tokenOut.symbol,
      effectiveSlippageBps: u.slippageBps,
      expiresAt,
    };
  }
  const restored = restoreRouteSnapshot(routeRef);
  if (!restored.ok) return undefined;
  const s = restored.snapshot;
  return {
    cardVersion: QUOTE_BINDING_CARD_VERSION,
    snapshotId: prequoteId,
    digest: s.digest,
    approvedAmountOutHuman: s.approvedAmountOutHuman,
    approvedMinOutHuman: s.approvedMinOutHuman,
    approvedMinOutRaw: s.approvedMinOutRaw,
    tokenOutSymbol: s.tokenOutSymbol,
    effectiveSlippageBps: s.effectiveSlippageBps,
    // The ROW's expiry, not the snapshot's display copy: the claim reads this
    // one, so the card must state the same deadline the dispatch enforces.
    expiresAt,
  };
}

/**
 * The one card line. Names the quote, what it promised, the floor the fill may
 * not go below, and when the authority lapses - in the output token's human
 * units, because that is what the person is consenting to.
 */
export function renderQuoteBinding(binding: QuoteBindingPreview): string {
  return `${binding.cardVersion} | quoted ${binding.approvedAmountOutHuman} ${binding.tokenOutSymbol}`
    + ` | will not fill below ${binding.approvedMinOutHuman} ${binding.tokenOutSymbol}`
    + ` (${binding.effectiveSlippageBps} bps of the quote)`
    // The WHOLE digest. It is what the card claims to be bound to, so a
    // shortened one would ask a person to consent to a fingerprint they cannot
    // check against the row.
    + ` | quote ${binding.snapshotId} digest ${binding.digest}`
    + ` | expires ${binding.expiresAt}`
    // Venue-specific bound facts, whole and never abbreviated: each is something
    // the wallet's outcome depends on, and a card that showed only the price and
    // the floor would ask a person to consent to the rest unseen.
    + (binding.extraFacts === undefined || binding.extraFacts.length === 0
      ? ""
      : ` | ${binding.extraFacts.join(" | ")}`);
}
