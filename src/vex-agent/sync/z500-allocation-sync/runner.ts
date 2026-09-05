/**
 * Z500 allocation-sync runner — one window, evaluated once, fail-closed
 * everywhere (indexiy-ansem.md).
 *
 * ORDER OF OPERATIONS is the safety design:
 *
 *   claim → snapshot → rank/select → read current → compare
 *        → persist desired + mutationRequested → edit_allocation
 *        → read back allocation + version → confirm → terminal write
 *
 * Everything BEFORE `mutationRequested` is persisted can fail with zero side
 * effects on the venue — those branches complete as `failed` with the stack
 * untouched. Everything AFTER it is governed by the reconciliation rules: an
 * uncertain outcome is never blindly retried; the read-back evidence decides
 * (already applied → success; provably not applied → exactly ONE retry;
 * still uncertain → failed, no further mutation).
 *
 * A TAKEN-OVER window (worker died mid-run) is reconciled READ-ONLY: if its
 * persisted record shows a mutation was requested, the same evidence rules
 * mark it succeeded or unresolved; if no mutation was ever requested, it is
 * failed as crashed-before-mutation. A takeover never re-evaluates and never
 * mutates — the strictest reading of "prevent duplicate evaluation or
 * mutation for the same schedule window".
 *
 * The deps surface is the structural non-goals proof: it contains reads, ONE
 * mutation (`editAllocation`), the ledger, and a clock. No trade, no
 * rebalance, no stack creation is CALLABLE from this module.
 */

import { VexError, ErrorCodes } from "../../../errors.js";
import { scrubProviderText } from "@utils/error-summary.js";
import logger from "@utils/logger.js";
import type { AnsemSnapshot } from "@tools/ansem/types.js";
import type {
  IndexifyEditAllocationResult,
  IndexifyTokenRegistration,
  IndexifyTradability,
  IndexifyVersionHistory,
} from "@tools/indexify/types.js";
import { allocationsEqual } from "./compare.js";
import {
  Z500_CREATOR_NOTE,
  Z500_STACK_ID,
  Z500_STACK_SLUG,
  Z500_TARGET_TOKEN_COUNT,
} from "./config.js";
import { selectTopEligible } from "./selection.js";
import { computeWindow } from "./window.js";
import type { ClaimResult, Z500RunOutcome, Z500RunRepo } from "./repo.js";

// ── Deps (the ONLY reachable surface — see module doc) ─────────────

export interface CurrentStackState {
  /** Mint → integer weight, from the live stack row. */
  readonly allocation: Readonly<Record<string, number>>;
  readonly allocationVersion: number | null;
  readonly isClosed: boolean;
}

export interface Z500SyncDeps {
  fetchSnapshot(): Promise<AnsemSnapshot>;
  readStack(stackId: number): Promise<CurrentStackState | null>;
  readVersionHistory(stackId: number): Promise<IndexifyVersionHistory>;
  checkTradability(mintAddress: string): Promise<IndexifyTradability>;
  /** Venue-side catalogue registration (token_info action=new); the venue
   * enforces its own $10k floor, so refusals are verdicts, not errors. */
  registerToken(mintAddress: string): Promise<IndexifyTokenRegistration>;
  editAllocation(
    stackId: number,
    allocation: Readonly<Record<string, number>>,
    creatorNote: string,
  ): Promise<IndexifyEditAllocationResult>;
  repo: Z500RunRepo;
  hasIndexifyApiKey(): boolean;
  now(): Date;
}

export interface Z500TickResult {
  readonly evaluated: boolean;
  readonly windowId: string | null;
  readonly detail: string;
}

// ── Sanitization ───────────────────────────────────────────────────

/**
 * Every string persisted to the ledger or logged passes through here: the
 * shared provider-text scrubber first, then an explicit belt-and-braces
 * redaction of anything shaped like an Indexify key. The spec's flat rule —
 * the key never appears in logs, run records, or errors — is enforced at the
 * one funnel every error string exits through.
 */
export function sanitizeForRecord(text: string): string {
  const scrubbed = scrubProviderText(text, 400) ?? "";
  return scrubbed.replace(/ix_[0-9a-f]{8,}/gi, "ix_[REDACTED]");
}

function describeError(err: unknown): string {
  const raw = err instanceof VexError
    ? `${err.code}: ${err.message}`
    : err instanceof Error
      ? `${err.constructor.name}: ${err.message}`
      : String(err);
  return sanitizeForRecord(raw);
}

/** Map a thrown source/venue error onto the run-outcome vocabulary. */
function outcomeForError(err: unknown, phase: "source" | "indexify"): Z500RunOutcome {
  if (err instanceof VexError) {
    if (err.code === ErrorCodes.ANSEM_STALE) return "source_stale";
    if (err.code === ErrorCodes.ANSEM_INVALID_RESPONSE) return "source_invalid";
    if (err.code === ErrorCodes.ANSEM_UNAVAILABLE || err.code === ErrorCodes.ANSEM_TIMEOUT) {
      return "source_unavailable";
    }
  }
  return phase === "source" ? "source_unavailable" : "indexify_unavailable";
}

/** True iff the venue DEFINITIVELY refused (nothing was applied). */
function isDefinitiveRefusal(err: unknown): boolean {
  if (!(err instanceof VexError)) return false;
  if (err.code === ErrorCodes.INDEXIFY_TIMEOUT) return false;
  if (err.httpStatus !== undefined && err.httpStatus >= 400 && err.httpStatus < 500) {
    // 429 is the venue saying "later", not "no" — its outcome is unknown-free
    // (nothing ran), so it is a refusal for our purposes too.
    return true;
  }
  return err.code === ErrorCodes.INDEXIFY_INVALID_REQUEST
    || err.code === ErrorCodes.INDEXIFY_AUTH_REQUIRED
    || err.code === ErrorCodes.INDEXIFY_NOT_FOUND;
}

// ── Read-back confirmation ─────────────────────────────────────────

interface ReadBack {
  readonly applied: boolean;
  /** Proof that the mutation did NOT land: allocation and version both unmoved. */
  readonly provablyNotApplied: boolean;
  readonly currentVersion: number | null;
}

async function readBack(
  deps: Z500SyncDeps,
  desired: Readonly<Record<string, number>>,
  previousAllocation: Readonly<Record<string, number>>,
  previousVersion: number | null,
): Promise<ReadBack> {
  const [stack, history] = await Promise.all([
    deps.readStack(Z500_STACK_ID),
    deps.readVersionHistory(Z500_STACK_ID),
  ]);
  if (stack === null) {
    return { applied: false, provablyNotApplied: false, currentVersion: null };
  }
  const currentVersion = history.current_version ?? stack.allocationVersion;
  const applied = allocationsEqual(stack.allocation, desired);
  const provablyNotApplied =
    !applied
    && allocationsEqual(stack.allocation, previousAllocation)
    && previousVersion !== null
    && currentVersion === previousVersion;
  return { applied, provablyNotApplied, currentVersion };
}

// ── The evaluation ─────────────────────────────────────────────────

async function evaluateClaimedWindow(deps: Z500SyncDeps, runId: number): Promise<Z500RunOutcome> {
  const repo = deps.repo;

  const fail = async (outcome: Z500RunOutcome, error: string): Promise<Z500RunOutcome> => {
    await repo.complete(runId, "failed", outcome, sanitizeForRecord(error));
    return outcome;
  };

  // 1 ── Source snapshot (fail-closed on every unusable shape).
  let snapshot: AnsemSnapshot;
  try {
    snapshot = await deps.fetchSnapshot();
  } catch (err) {
    return fail(outcomeForError(err, "source"), describeError(err));
  }
  await repo.mergeRecord(runId, {
    source: {
      fetchedAt: snapshot.fetchedAtIso,
      feedTimestamp: snapshot.feedTimestampIso,
      totalRows: snapshot.totalRows,
      curatedCoins: snapshot.coins.length,
      rowsWithoutMint: snapshot.rowsWithoutMint,
      validation: "passed",
    },
  });

  // 2 ── Rank, verify eligibility, select. A verification error fails the
  // run — the spec refuses to act when tradability cannot be established.
  let selection;
  try {
    selection = await selectTopEligible(snapshot.coins, {
      checkTradability: deps.checkTradability,
      registerToken: deps.registerToken,
    });
  } catch (err) {
    return fail("indexify_unavailable", `eligibility scan failed: ${describeError(err)}`);
  }
  // The persisted ranking IS the run's immutable source reference: every
  // candidate the walk consulted, in rank order, with the market cap that
  // ranked it — enough to re-derive the decision without refetching a feed
  // that has since moved.
  const coinByMint = new Map(snapshot.coins.map((coin) => [coin.mintAddress, coin]));
  await repo.mergeRecord(runId, {
    rankedCandidateMints: selection.ranked,
    rankedCandidateDetails: selection.ranked.map((mintAddress) => ({
      mint: mintAddress,
      marketCapUsd: coinByMint.get(mintAddress)?.marketCapUsd ?? null,
      symbol: coinByMint.get(mintAddress)?.symbol ?? null,
    })),
    selectedMints: selection.selected.map((coin) => coin.mintAddress),
    registeredMints: selection.registered,
    excluded: selection.excluded,
  });
  if (!selection.complete || selection.desiredAllocation === null) {
    return fail(
      "insufficient_eligible_tokens",
      `only ${selection.selected.length} of ${Z500_TARGET_TOKEN_COUNT} eligible tokens found — stack left unchanged`,
    );
  }
  const desired = selection.desiredAllocation;

  // 3 ── Current allocation.
  let current: CurrentStackState | null;
  try {
    current = await deps.readStack(Z500_STACK_ID);
  } catch (err) {
    return fail("indexify_unavailable", describeError(err));
  }
  if (current === null) {
    return fail("indexify_unavailable", `stack ${Z500_STACK_ID} (${Z500_STACK_SLUG}) not found on the venue`);
  }
  if (current.isClosed) {
    return fail("mutation_rejected", `stack ${Z500_STACK_ID} is closed; a closed stack cannot be edited`);
  }
  await repo.mergeRecord(runId, {
    previousAllocation: current.allocation,
    previousAllocationVersion: current.allocationVersion,
    desiredAllocation: desired,
  });

  // 4 ── Compare (mint+weight identity only). Identical → success, no request.
  if (allocationsEqual(current.allocation, desired)) {
    await repo.mergeRecord(runId, { mutationRequested: false });
    await repo.complete(runId, "succeeded", "no_change_needed");
    return "no_change_needed";
  }

  // 5 ── Mutation. `mutationRequested` is persisted BEFORE the send so a
  // crash inside the send window is reconcilable by a takeover.
  await repo.mergeRecord(runId, { mutationRequested: true, mutationSentAt: deps.now().toISOString() });
  let editResult: IndexifyEditAllocationResult | null = null;
  let uncertain: unknown = null;
  try {
    editResult = await deps.editAllocation(Z500_STACK_ID, desired, Z500_CREATOR_NOTE);
  } catch (err) {
    if (isDefinitiveRefusal(err)) {
      await repo.mergeRecord(runId, { mutation: { refused: true } });
      return fail("mutation_rejected", describeError(err));
    }
    uncertain = err;
  }

  // 6 ── Confirmation / reconciliation. One read-back decides everything.
  const confirm = async (label: string): Promise<ReadBack | null> => {
    try {
      return await readBack(deps, desired, current.allocation, current.allocationVersion);
    } catch (err) {
      await repo.mergeRecord(runId, { reconciliation: { [label]: `read-back failed: ${describeError(err)}` } });
      return null;
    }
  };

  if (uncertain === null && editResult !== null) {
    const check = await confirm("postMutation");
    if (check?.applied) {
      await repo.mergeRecord(runId, {
        mutation: { accepted: true, reportedVersion: editResult.version },
        resultingAllocationVersion: check.currentVersion,
      });
      await repo.complete(runId, "succeeded", "allocation_updated");
      return "allocation_updated";
    }
    // The venue said success but the read-back cannot confirm it — honest
    // unresolved, never a retry on top of a claimed success.
    return fail(
      "mutation_unresolved",
      "edit_allocation reported success but the read-back could not confirm the desired allocation",
    );
  }

  // Uncertain send: reconcile per the spec's numbered rules.
  await repo.mergeRecord(runId, { mutation: { uncertain: true, error: describeError(uncertain) } });
  const evidence = await confirm("afterUncertainSend");
  if (evidence === null) {
    return fail("mutation_unresolved", "uncertain mutation and the reconciliation reads failed — no retry sent");
  }
  if (evidence.applied) {
    await repo.mergeRecord(runId, { resultingAllocationVersion: evidence.currentVersion, reconciliation: { verdict: "already_applied" } });
    await repo.complete(runId, "succeeded", "reconciled_already_applied");
    return "reconciled_already_applied";
  }
  if (!evidence.provablyNotApplied) {
    return fail("mutation_unresolved", "uncertain mutation and the read-back is inconclusive — no retry sent");
  }

  // Proven not applied → exactly ONE retry.
  await repo.mergeRecord(runId, { reconciliation: { verdict: "provably_not_applied", retrySentAt: deps.now().toISOString() } });
  try {
    const retryResult = await deps.editAllocation(Z500_STACK_ID, desired, Z500_CREATOR_NOTE);
    const check = await confirm("postRetry");
    if (check?.applied) {
      await repo.mergeRecord(runId, {
        mutation: { retried: true, reportedVersion: retryResult.version },
        resultingAllocationVersion: check.currentVersion,
      });
      await repo.complete(runId, "succeeded", "allocation_updated");
      return "allocation_updated";
    }
    return fail("mutation_unresolved", "retry sent but the read-back could not confirm it — no further mutation");
  } catch (err) {
    if (isDefinitiveRefusal(err)) {
      return fail("mutation_rejected", `retry refused: ${describeError(err)}`);
    }
    return fail("mutation_unresolved", `retry outcome uncertain: ${describeError(err)} — no further mutation`);
  }
}

// ── Takeover reconciliation (read-only — see module doc) ───────────

async function reconcileTakenOverWindow(
  deps: Z500SyncDeps,
  runId: number,
  record: Record<string, unknown>,
): Promise<Z500RunOutcome> {
  const repo = deps.repo;
  const desired = record.desiredAllocation as Record<string, number> | undefined;
  const mutationRequested = record.mutationRequested === true;

  if (!mutationRequested || desired === undefined) {
    // The dead worker provably never sent a mutation (it is persisted BEFORE
    // the send) — the stack is untouched; the window simply failed.
    await repo.complete(runId, "failed", "internal_error",
      "previous worker died before any mutation was requested; stack untouched");
    return "internal_error";
  }
  try {
    const previous = (record.previousAllocation ?? {}) as Record<string, number>;
    const previousVersion = typeof record.previousAllocationVersion === "number"
      ? record.previousAllocationVersion : null;
    const evidence = await readBack(deps, desired, previous, previousVersion);
    if (evidence.applied) {
      await repo.mergeRecord(runId, {
        reconciliation: { verdict: "takeover_already_applied" },
        resultingAllocationVersion: evidence.currentVersion,
      });
      await repo.complete(runId, "succeeded", "reconciled_already_applied");
      return "reconciled_already_applied";
    }
    await repo.complete(runId, "failed", "takeover_unresolved",
      "taken-over run's mutation could not be confirmed; no new mutation sent from a takeover");
    return "takeover_unresolved";
  } catch (err) {
    await repo.complete(runId, "failed", "takeover_unresolved",
      sanitizeForRecord(`takeover reconciliation reads failed: ${describeError(err)}`));
    return "takeover_unresolved";
  }
}

// ── The tick entry point (called by the sync executor's branch) ────

export async function runZ500AllocationSyncTick(deps: Z500SyncDeps): Promise<Z500TickResult> {
  if (!deps.hasIndexifyApiKey()) {
    // Without the key nothing can be evaluated OR reconciled. The window is
    // deliberately NOT claimed, so the first keyed tick performs the normal
    // (single) catch-up evaluation.
    return { evaluated: false, windowId: null, detail: "skipped: INDEXIFY_API_KEY not configured" };
  }

  const window = computeWindow(deps.now());
  let claim: ClaimResult;
  try {
    claim = await deps.repo.claimWindow(window.windowId, window.scheduledAt, window.triggerType);
  } catch (err) {
    logger.warn("z500_sync.claim_failed", { windowId: window.windowId, error: describeError(err) });
    return { evaluated: false, windowId: window.windowId, detail: `claim failed: ${describeError(err)}` };
  }

  if (claim.kind === "complete" || claim.kind === "owned") {
    return { evaluated: false, windowId: window.windowId, detail: claim.kind };
  }

  try {
    const outcome = claim.kind === "takeover"
      ? await reconcileTakenOverWindow(deps, claim.runId, claim.record)
      : await evaluateClaimedWindow(deps, claim.runId);
    logger.info("z500_sync.window_completed", {
      windowId: window.windowId, trigger: window.triggerType, outcome,
      takeover: claim.kind === "takeover",
    });
    return { evaluated: true, windowId: window.windowId, detail: outcome };
  } catch (err) {
    // Nothing below evaluate/reconcile should throw — this is the last-resort
    // terminal write so a bug cannot leave the window running forever.
    const detail = describeError(err);
    try {
      await deps.repo.complete(claim.runId, "failed", "internal_error", detail);
    } catch {
      logger.warn("z500_sync.terminal_write_failed", { windowId: window.windowId });
    }
    return { evaluated: true, windowId: window.windowId, detail: `internal_error: ${detail}` };
  }
}
