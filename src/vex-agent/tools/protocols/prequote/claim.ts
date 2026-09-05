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
 * and the expiry the card stated. See `readPrequoteRow`.
 *
 * ## READ, COMPARE, THEN CLAIM (review finding, 2026-09-04)
 *
 * The claim used to run FIRST, before the executor had re-derived anything, so a
 * fee statement or a router input that had moved refused correctly and burnt the
 * approved quote on the way out: the retry the refusal told the agent to make got
 * `already_claimed`. The fixed product decision is that the executor never
 * consumes the bound block on divergence, so this module is now TWO steps:
 *
 *   `read*ExecutionSnapshot` - non-destructive. Picks the authoritative row
 *      exactly as the claim used to, restores and digest-checks its snapshot,
 *      and hands back the row's fee statement plus a `claim` ticket. Writes
 *      nothing.
 *   `commitPrequoteClaim`     - atomic. Consumes THAT row, asserting its id,
 *      session, trade identity, claimability and disclosure block in one
 *      statement. A divergence refused before this call leaves `claimed_at` and
 *      `claimed_by` null and the quote reusable.
 *
 * What this deliberately gives up: two concurrent executes of one quote now both
 * price a route before one of them wins the claim. Nothing is signed, reserved or
 * recorded before the commit on either, so the loser is a typed `already_claimed`
 * refusal exactly as before - it just wasted a quote request rather than a quote.
 * MetaMask makes the same trade (`TransactionController.#approveTransaction`
 * holds its per-transaction reservation and its nonce lock across signing only,
 * and a failed attempt releases both and leaves the transaction reusable).
 */

import * as prequoteRepo from "@vex-agent/db/repos/swap-prequotes.js";
import type { PrequoteKind, SwapPrequote } from "@vex-agent/db/repos/swap-prequotes.js";

import type { ProtocolExecutionContext } from "../types.js";
import {
  restoreRouteSnapshot,
  snapshotRefusal,
  type SnapshotRefusal,
} from "../quote-authority/restore.js";
import { UNISWAP_FRESH_QUOTE_TOOL, VIRTUALS_FRESH_QUOTE_TOOL } from "../quote-authority/refusal.js";
import {
  restoreUniswapSnapshot,
  type UniswapExecutionSnapshot,
} from "../quote-authority/uniswap.js";
import {
  restoreVirtualsSnapshot,
  type VirtualsExecutionSnapshot,
} from "../quote-authority/virtuals.js";
import type { RouteSnapshot } from "../quote-authority/snapshot.js";
import { EXECUTE_GATE_TOOLS } from "./registry.js";
import { vexFeeFromSafetyDetail, type VexFeePreview } from "./fee-disclosure.js";
import { computeGateMatch } from "./gate/identity.js";

/**
 * The ticket a reader hands to `commitPrequoteClaim`: everything the atomic
 * claim asserts about the row that was read, and nothing the caller could
 * substitute. It carries the row's own disclosure block, so the commit is
 * conditional on that block still being what the comparison was made against.
 */
export interface PrequoteClaimTicket {
  readonly sessionId: string;
  readonly prequoteId: string;
  readonly matchHash: string;
  readonly kind: PrequoteKind;
  readonly expectedDisclosure: Record<string, unknown>;
  /** The venue's own quote tool, so a refused commit points at the right one. */
  readonly freshQuoteTool: string | undefined;
}

export type ReadSwapSnapshot =
  | {
      readonly ok: true;
      readonly prequoteId: string;
      readonly snapshot: RouteSnapshot;
      /** The provider route summary parsed back from the digest-verified string. */
      readonly routeSummary: unknown;
      /**
       * The Vex fee statement the CLAIMED row carries - the same block the
       * approval card stated, read back off the row this execute just consumed.
       * The executor re-derives its own disposition and holds it to this one
       * before signing (round 2): a fee that no longer matches the statement a
       * person read is a fee nobody consented to.
       *
       * `undefined` for a venue that carries no Vex fee on this channel; a
       * fee-bearing execute cannot reach here without one, because the gate
       * refuses that row first.
       */
      readonly vexFee: VexFeePreview | undefined;
      /** Hand this to `commitPrequoteClaim` once every comparison has passed. */
      readonly claim: PrequoteClaimTicket;
    }
  | { readonly ok: false; readonly refusal: SnapshotRefusal };

/**
 * Read the approved quote for this execute and verify its snapshot, WITHOUT
 * consuming it.
 *
 * The caller re-derives its own fee statement, router input and floor against
 * what this returns and refuses on any divergence; only then does it call
 * `commitPrequoteClaim` with the returned ticket. A refusal in between leaves
 * the row unclaimed and the quote reusable, which is the whole point of the
 * split.
 */
export async function readSwapExecutionSnapshot(
  toolId: string,
  sessionId: string,
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<ReadSwapSnapshot> {
  const claimed = await readPrequoteRow(toolId, sessionId, params, context);
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
    vexFee: claimed.vexFee,
    claim: claimed.ticket,
  };
}

export type ReadUniswapSnapshot =
  | {
      readonly ok: true;
      readonly prequoteId: string;
      readonly snapshot: UniswapExecutionSnapshot;
      /**
       * The Vex fee statement the CLAIMED row carries - the same block the
       * approval card stated, read back off the row this execute just consumed.
       * The executor re-derives its own disposition and holds it to this one
       * before signing (round 2): a fee that no longer matches the statement a
       * person read is a fee nobody consented to.
       *
       * `undefined` for a venue that carries no Vex fee on this channel; a
       * fee-bearing execute cannot reach here without one, because the gate
       * refuses that row first.
       */
      readonly vexFee: VexFeePreview | undefined;
      /** Hand this to `commitPrequoteClaim` once every comparison has passed. */
      readonly claim: PrequoteClaimTicket;
    }
  | { readonly ok: false; readonly refusal: SnapshotRefusal };

/**
 * The same read, restored through the Uniswap codec.
 *
 * The row lifecycle is identical - one quote, one execute, newest-wins - and is
 * shared below. What differs is only what a restored snapshot MEANS: KyberSwap
 * restores provider bytes to POST, Uniswap restores the router input, the fee
 * disposition and the floor that the locally built calldata must carry.
 */
export async function readUniswapExecutionSnapshot(
  toolId: string,
  sessionId: string,
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<ReadUniswapSnapshot> {
  const claimed = await readPrequoteRow(
    toolId, sessionId, params, context, UNISWAP_FRESH_QUOTE_TOOL,
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
  return {
    ok: true,
    prequoteId: claimed.prequoteId,
    snapshot: restored.snapshot,
    vexFee: claimed.vexFee,
    claim: claimed.ticket,
  };
}

/**
 * Consume the row a reader already compared against, atomically.
 *
 * Called at the LAST point before anything durable or signable exists, so a
 * refusal above it costs a quote request and nothing else. Every assertion the
 * repository makes is carried by the ticket, so this function cannot be talked
 * into consuming a different row than the one that was read and compared.
 *
 * `claimedBy` is the caller's correlation for the audit trail; it is stored on
 * the row and never used to decide anything.
 */
export async function commitPrequoteClaim(
  ticket: PrequoteClaimTicket,
  claimedBy: string,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly refusal: SnapshotRefusal }> {
  const claimed = await prequoteRepo.claimVerifiedRowForExecute({
    sessionId: ticket.sessionId,
    prequoteId: ticket.prequoteId,
    matchHash: ticket.matchHash,
    kind: ticket.kind,
    expectedDisclosure: ticket.expectedDisclosure,
    claimedBy,
  });
  if (claimed !== null) return { ok: true };
  const reason = await prequoteRepo.diagnoseUnclaimable(
    ticket.sessionId, ticket.prequoteId, ticket.expectedDisclosure,
  );
  return {
    ok: false,
    refusal: snapshotRefusal(
      reason === "missing" ? "missing_snapshot" : reason,
      ticket.freshQuoteTool,
    ),
  };
}

type ReadRow =
  | {
      readonly ok: true;
      readonly prequoteId: string;
      readonly routeRef: unknown;
      /** The ROW's expiry - the deadline the card stated and the claim enforced. */
      readonly expiresAt: string;
      /** The row's Vex fee statement, read through the recorder's schema. */
      readonly vexFee: VexFeePreview | undefined;
      /** What the eventual atomic claim of THIS row will assert. */
      readonly ticket: PrequoteClaimTicket;
    }
  | { readonly ok: false; readonly refusal: SnapshotRefusal };

/**
 * The venue-independent half: identify the trade, decide WHICH row is the
 * authority, and read that row WITHOUT consuming it. Every refusal names the
 * venue's own quote tool, because a prequote is bound to the provider that
 * answered it.
 *
 * TWO WAYS TO PICK THE ROW, and the difference is the money-path property:
 *
 *   BOUND (`context.approvedQuoteAuthority` present) - a human approved a card
 *   naming one quote, so the read binds to THAT `prequote_id` and no other, and
 *   the ticket carries the same identity into the claim. The repo's read and
 *   claim both require it to be the current executable row, so a quote recorded
 *   while the card was waiting refuses as `superseded` rather than becoming the
 *   fill. Selecting the newest row here instead is exactly the substitution the
 *   2026-08-28 review found: approve Q1, execute Q2.
 *
 *   UNBOUND, no approval in play (a full-permission or autonomous session) - the
 *   newest executable row, exactly as before. There is no card here, so there is
 *   no consent to contradict.
 *
 *   UNBOUND, but an approval authorized this dispatch - REFUSED. See the
 *   fail-closed note below.
 */
async function readPrequoteRow(
  toolId: string,
  sessionId: string,
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
  freshQuoteTool?: string,
): Promise<ReadRow> {
  const refuse = (kind: Parameters<typeof snapshotRefusal>[0]): ReadRow =>
    ({ ok: false, refusal: snapshotRefusal(kind, freshQuoteTool) });

  const gated = EXECUTE_GATE_TOOLS[toolId];
  if (!gated || gated.kind !== "swap") return refuse("missing_snapshot");
  const { matchHash } = await computeGateMatch(gated, sessionId, params, context);

  const found = (row: SwapPrequote): ReadRow => ({
    ok: true,
    prequoteId: row.prequoteId,
    routeRef: row.routeRef,
    expiresAt: row.expiresAt,
    vexFee: vexFeeFromSafetyDetail(row.safetyDetail),
    ticket: {
      sessionId,
      prequoteId: row.prequoteId,
      matchHash,
      kind: "swap",
      // The row's OWN block, carried forward untouched: the caller compares
      // against what it discloses, and the claim below is conditional on the
      // very same bytes still being on the row.
      expectedDisclosure: row.safetyDetail,
      freshQuoteTool,
    },
  });

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
    const bound = await prequoteRepo.findClaimableForExecute(
      sessionId, authority.snapshotId, matchHash, "swap",
    );
    if (bound === null) {
      // The bound row is not claimable. Diagnosis reads the row's own state, so
      // it is asked with the row's disclosure rather than an expectation the
      // read never formed - the disclosure fence belongs to the claim, and a
      // read that found nothing must not report `disclosure_changed`.
      const latest = await prequoteRepo.findLatestFreshByMatch(sessionId, matchHash, "swap");
      const reason = await prequoteRepo.diagnoseUnclaimable(
        sessionId, authority.snapshotId, latest?.safetyDetail ?? {},
      );
      return refuse(reason === "missing" || reason === "disclosure_changed" ? "missing_snapshot" : reason);
    }
    return found(bound);
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
  return found(candidate);
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

export type ClaimedVirtualsSnapshot =
  | {
      readonly ok: true;
      readonly prequoteId: string;
      readonly snapshot: VirtualsExecutionSnapshot;
      /**
       * The Vex fee statement the CLAIMED row carries, when the venue puts one
       * on this channel. Virtuals does not: its SELL fee is a rate on proceeds
       * that do not exist until settlement, which the `currency_in` block cannot
       * express, so the fee is bound INSIDE the execution snapshot instead and
       * `compareVirtualsExecutionInputs` is what holds the signature to it.
       */
      readonly vexFee: VexFeePreview | undefined;
    }
  | { readonly ok: false; readonly refusal: SnapshotRefusal };

/**
 * Claim the approved Virtuals curve quote for exactly one execute.
 *
 * The row lifecycle is the shared one - one quote, one execute, newest wins,
 * bound to the approved `prequote_id` whenever a human approved a card. What
 * differs is only what a restored snapshot MEANS here: the contracts and their
 * implementations, the side, the amounts, the fee, the taxes, the accepted
 * anti-sniper bound and the floor the locally built calldata must carry.
 */
export async function claimVirtualsExecutionSnapshot(
  toolId: string,
  sessionId: string,
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
  claimedBy: string,
): Promise<ClaimedVirtualsSnapshot> {
  const claimed = await readPrequoteRow(
    toolId, sessionId, params, context, VIRTUALS_FRESH_QUOTE_TOOL,
  );
  if (!claimed.ok) return { ok: false, refusal: claimed.refusal };
  // MERGE NOTE (PR-C2 onto the read/commit split): the other venues now READ the
  // row here and only `commitPrequoteClaim` it once their own comparisons have
  // passed, so a refusal in between leaves the quote reusable. Virtuals claims
  // at read time, which is this lane's shipped and reviewed behaviour and is the
  // MORE conservative of the two: a mismatch burns the quote and forces a fresh
  // one rather than leaving a row an execute already reasoned about executable.
  // Moving Virtuals onto the split changes when a money-path row is consumed and
  // is a behaviour change for its own reviewed change, not for this merge.
  const committed = await commitPrequoteClaim(claimed.ticket, claimedBy);
  if (!committed.ok) return { ok: false, refusal: committed.refusal };

  const restored = restoreVirtualsSnapshot(claimed.routeRef);
  if (!restored.ok) return { ok: false, refusal: restored.refusal };
  const bound = boundSnapshotRefusal(
    context,
    {
      digest: restored.snapshot.digest,
      // The APPROVED FLOOR on this venue is the contract floor - the
      // `amountOutMin_` the chain enforces - so that is what the card stated and
      // what the binding is re-checked against.
      approvedMinOutRaw: restored.snapshot.contractFloorRaw,
      expiresAt: claimed.expiresAt,
    },
    VIRTUALS_FRESH_QUOTE_TOOL,
  );
  if (bound !== null) return { ok: false, refusal: bound };
  return {
    ok: true,
    prequoteId: claimed.prequoteId,
    snapshot: restored.snapshot,
    vexFee: claimed.vexFee,
  };
}
