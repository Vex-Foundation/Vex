/**
 * Execute-time snapshot CLAIM - the seam between the prequote store and the
 * venue executor.
 *
 * The Stage-7 gate already proved a fresh matching prequote exists and is not a
 * confirmed scam. This module answers the different question the 2026-08-27
 * incident exposed: WHICH quote is the authority for the fill, and has it
 * already been spent.
 *
 * Identity is computed with `computeGateMatch`, the gate's own function, so the
 * row claimed here is the row the gate matched - no second hash implementation
 * can drift from it.
 *
 * When an APPROVAL authorized this execute, identity alone is not enough: the
 * card named ONE quote, and between the card and the click another quote can be
 * recorded for the same identity. The claim therefore binds to the approved
 * `prequote_id` (`ProtocolExecutionContext.approvedQuoteAuthority`, host-side
 * evidence read from the approval envelope) and re-checks the digest, the floor
 * and the expiry the card stated. See `claimPrequoteRow`.
 */

import * as prequoteRepo from "@vex-agent/db/repos/swap-prequotes.js";

import type { ProtocolExecutionContext } from "../types.js";
import {
  restoreRouteSnapshot,
  snapshotRefusal,
  type SnapshotRefusal,
} from "../quote-authority/restore.js";
import { UNISWAP_FRESH_QUOTE_TOOL } from "../quote-authority/refusal.js";
import {
  restoreUniswapSnapshot,
  type UniswapExecutionSnapshot,
} from "../quote-authority/uniswap.js";
import type { RouteSnapshot } from "../quote-authority/snapshot.js";
import { EXECUTE_GATE_TOOLS } from "./registry.js";
import { computeGateMatch } from "./gate/identity.js";

export type ClaimedSwapSnapshot =
  | {
      readonly ok: true;
      readonly prequoteId: string;
      readonly snapshot: RouteSnapshot;
      /** The provider route summary parsed back from the digest-verified string. */
      readonly routeSummary: unknown;
    }
  | { readonly ok: false; readonly refusal: SnapshotRefusal };

/**
 * Claim the approved quote for exactly one execute, then verify its snapshot.
 *
 * Order matters and is deliberate: the CLAIM runs first, so two concurrent
 * executes for one quote resolve to exactly one winner before either touches a
 * key. The digest check runs on the claimed row, so a snapshot that fails it
 * has already consumed its own quote and cannot be retried into a race.
 *
 * `claimedBy` is the caller's correlation for the audit trail; it is stored on
 * the row and never used to decide anything.
 */
export async function claimSwapExecutionSnapshot(
  toolId: string,
  sessionId: string,
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
  claimedBy: string,
): Promise<ClaimedSwapSnapshot> {
  const claimed = await claimPrequoteRow(toolId, sessionId, params, context, claimedBy);
  if (!claimed.ok) return { ok: false, refusal: claimed.refusal };

  const restored = restoreRouteSnapshot(claimed.routeRef);
  if (!restored.ok) return { ok: false, refusal: restored.refusal };
  const bound = boundSnapshotRefusal(context, {
    digest: restored.snapshot.digest,
    approvedMinOutRaw: restored.snapshot.approvedMinOutRaw,
    expiresAt: claimed.expiresAt,
  });
  if (bound !== null) return { ok: false, refusal: bound };
  return {
    ok: true,
    prequoteId: claimed.prequoteId,
    snapshot: restored.snapshot,
    routeSummary: restored.routeSummary,
  };
}

export type ClaimedUniswapSnapshot =
  | {
      readonly ok: true;
      readonly prequoteId: string;
      readonly snapshot: UniswapExecutionSnapshot;
    }
  | { readonly ok: false; readonly refusal: SnapshotRefusal };

/**
 * The same claim, restored through the Uniswap codec.
 *
 * The row lifecycle is identical - one quote, one execute, newest-wins - and is
 * shared below. What differs is only what a restored snapshot MEANS: KyberSwap
 * restores provider bytes to POST, Uniswap restores the router input, the fee
 * disposition and the floor that the locally built calldata must carry.
 */
export async function claimUniswapExecutionSnapshot(
  toolId: string,
  sessionId: string,
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
  claimedBy: string,
): Promise<ClaimedUniswapSnapshot> {
  const claimed = await claimPrequoteRow(
    toolId, sessionId, params, context, claimedBy, UNISWAP_FRESH_QUOTE_TOOL,
  );
  if (!claimed.ok) return { ok: false, refusal: claimed.refusal };

  const restored = restoreUniswapSnapshot(claimed.routeRef);
  if (!restored.ok) return { ok: false, refusal: restored.refusal };
  const bound = boundSnapshotRefusal(
    context,
    {
      digest: restored.snapshot.digest,
      approvedMinOutRaw: restored.snapshot.approvedMinOutRaw,
      expiresAt: claimed.expiresAt,
    },
    UNISWAP_FRESH_QUOTE_TOOL,
  );
  if (bound !== null) return { ok: false, refusal: bound };
  return { ok: true, prequoteId: claimed.prequoteId, snapshot: restored.snapshot };
}

type ClaimedRow =
  | {
      readonly ok: true;
      readonly prequoteId: string;
      readonly routeRef: unknown;
      /** The ROW's expiry - the deadline the card stated and the claim enforced. */
      readonly expiresAt: string;
    }
  | { readonly ok: false; readonly refusal: SnapshotRefusal };

/**
 * The venue-independent half: identify the trade, decide WHICH row is the
 * authority, and consume that row atomically. Every refusal names the venue's
 * own quote tool, because a prequote is bound to the provider that answered it.
 *
 * TWO WAYS TO PICK THE ROW, and the difference is the money-path property:
 *
 *   BOUND (`context.approvedQuoteAuthority` present) - a human approved a card
 *   naming one quote, so the claim binds to THAT `prequote_id` and no other. The
 *   repo's claim still requires it to be the current executable row, so a quote
 *   recorded while the card was waiting refuses as `superseded` rather than
 *   becoming the fill. Selecting the newest row here instead is exactly the
 *   substitution the 2026-08-28 review found: approve Q1, execute Q2.
 *
 *   UNBOUND, no approval in play (a full-permission or autonomous session) - the
 *   newest executable row, exactly as before. There is no card here, so there is
 *   no consent to contradict.
 *
 *   UNBOUND, but an approval authorized this dispatch - REFUSED. See the
 *   fail-closed note below.
 */
async function claimPrequoteRow(
  toolId: string,
  sessionId: string,
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
  claimedBy: string,
  freshQuoteTool?: string,
): Promise<ClaimedRow> {
  const refuse = (kind: Parameters<typeof snapshotRefusal>[0]): ClaimedRow =>
    ({ ok: false, refusal: snapshotRefusal(kind, freshQuoteTool) });

  const gated = EXECUTE_GATE_TOOLS[toolId];
  if (!gated || gated.kind !== "swap") return refuse("missing_snapshot");
  const { matchHash } = await computeGateMatch(gated, sessionId, params, context);

  const authority = context.approvedQuoteAuthority ?? null;
  // FAIL CLOSED (owner decision 2026-08-28). A resume under an approval that
  // names no quote is the one case where "take the newest executable row" is
  // indefensible: a human authorized ONE fill and this dispatch cannot say
  // which, so whatever row it picked would be a row nobody approved. Every venue
  // that reaches this function records snapshots and therefore binds at enqueue,
  // so the only approvals in this state are ones written before the binding
  // existed - and the refusal is recoverable by requesting a fresh quote, which
  // does bind.
  if (authority === null && isApprovalResume(context)) {
    return refuse("unbound_approval");
  }
  if (authority !== null) {
    const claimed = await prequoteRepo.claimBoundForExecute(
      sessionId, authority.snapshotId, matchHash, "swap", claimedBy,
    );
    if (claimed === null) {
      const reason = await prequoteRepo.diagnoseUnclaimable(sessionId, authority.snapshotId);
      return refuse(reason === "missing" ? "missing_snapshot" : reason);
    }
    return {
      ok: true,
      prequoteId: claimed.prequoteId,
      routeRef: claimed.routeRef,
      expiresAt: claimed.expiresAt,
    };
  }

  const candidate = await prequoteRepo.findLatestExecutableByMatch(sessionId, matchHash, "swap");
  if (candidate === null) {
    // No unclaimed executable row for this identity at all. The most useful
    // truth for the agent is that the newest quote for this trade did not
    // authorize an execute - which is exactly `not_executable` when a quote was
    // recorded ineligible, and indistinguishable from it when none exists.
    const latest = await prequoteRepo.findLatestFreshByMatch(sessionId, matchHash, "swap");
    if (latest === null) return refuse("missing_snapshot");
    if (latest.claimedAt !== null) return refuse("already_claimed");
    return refuse("not_executable");
  }

  const claimed = await prequoteRepo.claimForExecute(sessionId, candidate.prequoteId, claimedBy);
  if (claimed === null) {
    const reason = await prequoteRepo.diagnoseUnclaimable(sessionId, candidate.prequoteId);
    return refuse(reason === "missing" ? "missing_snapshot" : reason);
  }
  return {
    ok: true,
    prequoteId: claimed.prequoteId,
    routeRef: claimed.routeRef,
    expiresAt: claimed.expiresAt,
  };
}

/**
 * Is this dispatch the resume of an approval a human decided?
 *
 * `approvalId` is the one host-side fact that says so: it is set ONLY by the
 * approval runtime's two resume paths (agent and Studio) and can never be
 * derived from model input, so a handler cannot be talked out of the check.
 * `approved` alone is not enough - other host paths set it without a card.
 */
function isApprovalResume(context: ProtocolExecutionContext): boolean {
  return typeof context.approvalId === "string" && context.approvalId.length > 0;
}

/**
 * Does the claimed snapshot still state what the approval card stated?
 *
 * The row id alone is not the whole consent: the card also named a DIGEST, a
 * FLOOR and an EXPIRY, and those are what the person actually read. The claim
 * predicate proves the row is current and unexpired; this proves the row's
 * CONTENT is the content that was approved, so a snapshot rewritten under a
 * kept id cannot be executed against a card describing something else.
 *
 * Returns `null` when there is nothing to check (no binding) or everything
 * agrees. `digest_mismatch` is the right refusal for all three: each means the
 * stored snapshot cannot be proven to be the one that was approved, and the way
 * out of every one of them is a fresh quote.
 */
function boundSnapshotRefusal(
  context: ProtocolExecutionContext,
  claimed: {
    readonly digest: string;
    readonly approvedMinOutRaw: string;
    readonly expiresAt: string;
  },
  freshQuoteTool?: string,
): SnapshotRefusal | null {
  const authority = context.approvedQuoteAuthority ?? null;
  if (authority === null) return null;
  if (
    claimed.digest !== authority.digest
    || claimed.approvedMinOutRaw !== authority.approvedMinOutRaw
    || !sameInstant(claimed.expiresAt, authority.expiresAt)
  ) {
    return snapshotRefusal("digest_mismatch", freshQuoteTool);
  }
  return null;
}

/**
 * Timestamp equality by INSTANT, not by spelling: both values originate from the
 * same column through the same normalisation, but a comparison on the money path
 * must not turn a serialization difference into a refusal.
 */
function sameInstant(a: string, b: string): boolean {
  const left = Date.parse(a);
  const right = Date.parse(b);
  return Number.isFinite(left) && Number.isFinite(right) && left === right;
}
