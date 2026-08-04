/**
 * Shared amount-resolution logic for `agent_activity`-sourced legs, used by
 * BOTH `moves-db.ts` and `token-history-db.ts` (Agent Scan plan §4.1/§11.1;
 * Codex final-review round 1 finding 5 / coordinator contract C20; extended
 * to W5 lend/prediction rows — migration 049, design REVISION 1 R3/R5 — by
 * `resolveAmountWithEstimateBasis` below). Kept here — not duplicated —
 * because the business rule (which amount a given lifecycle status may
 * honestly show) is identical across every reader/kind that needs it; only
 * the caller's output SHAPE differs (a plain string for `MoveItem`, an
 * `AmountField`-wrapped value for `TokenHistoryEntry`).
 *
 * THE PLAIN-SWAP RULE (`resolveAgentActivityAmount`): TOKEN HISTORY ONLY as of
 * 2026-07-30 — Agent Scan moved its swap legs onto the estimate-basis rule
 * below (its DTO can say "estimated"; Token History's cannot). A `confirmed` row shows
 * the raw-computed EXECUTED amount ONLY (receipt Transfer-delta truth) —
 * NEVER the quote-time REQUESTED echo, closing the "quote masquerading as
 * settlement" bug the repair-sweep decoders exposed (they intentionally
 * return raw amounts without a human value, so a naive
 * `COALESCE(executed_human, requested_human)` would silently fall through to
 * the wrong value for any row confirmed via repair). A `pending` row shows
 * the REQUESTED echo instead — nothing has settled yet, so the quote is the
 * only honest value available. Anything else (`failed`, or an unrecognized
 * status) shows NOTHING — a failed attempt's legs are moot; showing a
 * near-miss amount would misrepresent it.
 *
 * ITS CONFIRMED-WITHOUT-DECODE CASE IS NOW REACHABLE (owner decree
 * 2026-07-30): the repair sweeps became status-only and migration 061 dropped
 * `agent_activity_confirmed_swap_has_executed_legs`, so a repaired swap row can
 * be `confirmed` with NULL executed legs. This rule then blanks. That is a
 * deliberate, accepted Token-History behavior — its `TokenHistoryEntry` DTO has
 * no provenance field, so it has no way to label a value "estimated", and
 * showing an unlabelled quote as settlement is the one thing this rule exists
 * to prevent.
 *
 * THE ESTIMATE-BASIS RULE (`resolveAmountWithEstimateBasis`): bridges and W5
 * lend/prediction rows — and, since 2026-07-30, EVERY Agent Scan kind
 * including plain swaps — do NOT carry that invariant, so a
 * confirmed-without-decode row falls back to the quoted amount EXPLICITLY
 * labelled `"estimated"` rather than going blank — see that function's own doc for the full rule.
 *
 * Human formatting from raw is BigInt-safe (`viem`'s `formatUnits` — already
 * a `vex-app` dependency, the same audited base-unit-shift primitive wallet
 * code elsewhere in the repo trusts) — `Number`/`parseFloat` is NEVER used
 * on a wei-scale integer string.
 */

import { formatUnits } from "viem";

/**
 * `superseded_unproven` is a member so the "show nothing" decision for it is
 * DELIBERATE rather than an accident of an unrecognized value. Both resolvers
 * below display only for `pending` and `confirmed`, so this row renders no
 * executed and no requested amount — its amounts were never proven, and printing
 * the quote would report a quote as a settlement.
 */
export type AgentActivitySwapStatus =
  | "pending"
  | "confirmed"
  | "failed"
  | "superseded_unproven";

/**
 * `raw` is a base-10 integer string (e.g. "1500000000000000000"); `decimals`
 * is the token's decimal places (SMALLINT). Returns `null` — never throws,
 * never guesses — when either input is absent or `raw` is not a valid
 * integer string (a malformed value must never surface as a fabricated
 * amount). A whole-number result (e.g. "50") is a valid, honest output —
 * callers must not re-impose a decimal-point requirement on it (Codex final
 * review finding 10 / contract C27).
 */
export function formatExecutedAmountHuman(
  raw: string | null,
  decimals: number | null,
): string | null {
  if (raw === null || decimals === null) return null;
  if (!/^-?[0-9]+$/.test(raw)) return null;
  try {
    return formatUnits(BigInt(raw), decimals);
  } catch {
    return null;
  }
}

/**
 * Resolve the single amount string an `agent_activity`-sourced leg may
 * honestly display for its current status — see module header for the rule.
 */
export function resolveAgentActivityAmount(
  status: AgentActivitySwapStatus | null,
  requestedHuman: string | null,
  executedRaw: string | null,
  decimals: number | null,
): string | null {
  if (status === "confirmed") {
    return formatExecutedAmountHuman(executedRaw, decimals);
  }
  if (status === "pending") {
    return requestedHuman;
  }
  return null;
}

/**
 * An amount + its provenance basis (BINDING Q2, bridges; extended to W5
 * lend/prediction rows — migration 049 — by the same rule; see
 * `resolveAmountWithEstimateBasis`).
 */
export interface AmountEstimateResolution {
  readonly value: string | null;
  readonly basis: "executed" | "estimated" | null;
}

/**
 * Executed-vs-estimated amount rule — DISTINCT from the plain swap rule
 * above (`resolveAgentActivityAmount`), which never labels a fallback value.
 * Originated as the bridge rule (Agent Scan Phase 2, BINDING Q2): a bridge's
 * destination fill is SOLVER-signed and externally observed, so the executed
 * amount is populated ONLY when the sweep decoded transfer/value evidence
 * against the stored token+recipient (migration-045 B4). W5 (migration 049)
 * reuses this SAME rule for `lend`/`prediction` rows — the repair sweep's
 * settlement decoders are NOT guaranteed to prove every confirmed lend/
 * prediction row (design REVISION 1 R3: "for lend/prediction the deltas fill
 * executed_* fields where meaningful, else amounts stay estimated"), unlike a
 * plain swap, whose both-legs-required invariant guarantees a confirmed row
 * always has decoder-proven data (so `resolveAgentActivityAmount`'s
 * confirmed-without-decode case is provably unreachable there and does not
 * need this basis tag). Rule:
 *   - an independently-verified `executed_*` amount is shown as `"executed"`;
 *   - otherwise, while the attempt is still live (`pending`) OR confirmed
 *     without a decodable amount, the QUOTED amount is shown, explicitly
 *     labelled `"estimated"` — never as settlement (unlike a plain swap,
 *     which blanks rather than mislabels: "~X TOKEN est., still settling");
 *   - a `failed`/refunded attempt shows NOTHING (the attempt did not complete;
 *     the requested amount would misrepresent it — a terminal failure code is
 *     carried separately as a status, not as a fake amount).
 *
 * Executed formatting reuses the same BigInt-safe `formatExecutedAmountHuman`
 * as swaps (never `Number`/`parseFloat` on a base-unit integer string).
 */
export function resolveAmountWithEstimateBasis(
  status: AgentActivitySwapStatus | null,
  requestedHuman: string | null,
  executedRaw: string | null,
  decimals: number | null,
): AmountEstimateResolution {
  // STATUS FIRST, ALWAYS. A row can carry residual `executed_*` raws and still
  // be `failed` (a partially-decoded attempt, a later re-classification), and an
  // UNRECOGNIZED status is precisely the case `toAmountStatus` returns `null`
  // for so that we fail CLOSED. Formatting the raw before consulting the status
  // rendered both as settled truth. Only the two states we understand may
  // display anything at all.
  if (status !== "pending" && status !== "confirmed") return { value: null, basis: null };
  const executed = formatExecutedAmountHuman(executedRaw, decimals);
  if (executed !== null) return { value: executed, basis: "executed" };
  return {
    value: requestedHuman,
    basis: requestedHuman !== null ? "estimated" : null,
  };
}
