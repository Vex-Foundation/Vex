/**
 * The Vex Cloud withdrawal CANCEL owner: stop a cooling withdrawal and return
 * its VEX to the balance (owner decision 2026-10-21, `POST
 * /v1/withdrawals/:id/cancel`).
 *
 * A cancel MOVES NO FUNDS OUT: it can only put VEX back into the account it
 * left, so it is not behind the execution gate and needs no REAL FUNDS card,
 * only a plain confirmation in the renderer. The agent has no cancel tool.
 *
 * ONE IDEMPOTENCY KEY PER CANCEL INTENT. The first cancel of a withdrawal on
 * an account mints a key and holds it BEFORE the request leaves; a cancel of
 * the same withdrawal while that key is held ("Check status") REPLAYS it.
 * The key is retired only by an answer about the withdrawal
 * ({@link CANCEL_ANSWERS}); an answer that proves nothing keeps it.
 *
 * BOUND TO THE ACCOUNT. The account is read with the same bearer the cancel
 * is sent with, and the held key is keyed by that account, so a key is never
 * replayed under another account.
 *
 * PROCESS MEMORY, bounded: at most {@link MAX_HELD_CANCELS} held keys for
 * {@link HELD_CANCEL_RETENTION_MS}. Losing one is safe: a cancel is
 * idempotent on the withdrawal's state, so a fresh key for the same
 * withdrawal can only cancel it once, or learn it is no longer cooling.
 *
 * AUDIT: one `asked` and one `decided` line per cancel, correlated.
 */

import { randomUUID } from "node:crypto";
import type { VexCloudCancelWithdrawalResult } from "@shared/schemas/vex-cloud-funding.js";
import { log } from "../../logger/index.js";
import type { VexCloudApi, VexCloudCallFailure, WithdrawalResponse } from "../api-client.js";
import { refused, type VexCloudOutcome } from "../outcome.js";
import { backendRefusal, replaySignedOut, requireBearer, type SessionPort } from "./backend-call.js";
import { toWithdrawal } from "./withdraw.js";

export const MAX_HELD_CANCELS = 32;
export const HELD_CANCEL_RETENTION_MS = 24 * 60 * 60 * 1_000;

export interface CancelDeps extends SessionPort {
  readonly api: Pick<VexCloudApi, "readAccount" | "cancelWithdrawal" | "readWithdrawal">;
  readonly now: () => Date;
  /** Injected for tests; a fresh random key per cancel intent in production. */
  readonly mintIdempotencyKey?: () => string;
}

interface HeldCancel {
  readonly key: string;
  readonly heldUntilMs: number;
}

/** `${accountId}:${withdrawalId}` -> the key of the cancel already sent for it. */
let held = new Map<string, HeldCancel>();
let running = new Set<string>();

/** Test-only reset. */
export function __resetCancelStateForTests(): void {
  held = new Map();
  running = new Set();
}

function defaultKey(): string {
  return `vxc_${randomUUID().replace(/-/g, "")}`;
}

function holdKey(id: string, key: string, nowMs: number): void {
  for (const [entry, value] of held) if (value.heldUntilMs <= nowMs) held.delete(entry);
  while (held.size >= MAX_HELD_CANCELS) {
    const oldest = held.keys().next();
    if (oldest.done === true) break;
    held.delete(oldest.value);
  }
  held.set(id, { key, heldUntilMs: nowMs + HELD_CANCEL_RETENTION_MS });
}

export const IN_FLIGHT_DETAIL = "This withdrawal is already being sent; it can no longer be cancelled.";
const FINAL_DETAIL = "This withdrawal already finished, so it can no longer be cancelled.";
const NOT_FOUND_DETAIL = "Vex Inference has no such withdrawal on this account, so nothing was cancelled.";
const UNSUPPORTED_DETAIL = "This Vex Inference does not offer cancelling withdrawals yet. Nothing was cancelled.";

/**
 * What one answer to a cancel proves, the ONE place this is decided:
 *
 *  - `cancelled`: a 200 whose withdrawal reads `cancelled`.
 *  - `not_cancelled`: an answer about the WITHDRAWAL that rules a cancel out:
 *    409 `withdrawal_in_flight` (it is being sent; a cancelled withdrawal is
 *    final, never in flight) and 404 `withdrawal_not_found` (none on this
 *    account; the account is bound before the send).
 *  - `settle_by_read`: 409 `withdrawal_final`. It is final, but `cancelled`
 *    is final too, so it may be final BECAUSE an earlier send of this key
 *    cancelled it; the withdrawal is read to say which.
 *  - `refused`: the request was refused before it could act, and this is
 *    its FIRST send, so no earlier request with the key exists: a 401, a
 *    route without the cancel (404 with no reason), a field this app sent
 *    off contract (400 `invalid_idempotency_key`, `invalid_field`,
 *    `forbidden_field`), 503 `withdrawals_unavailable`.
 *  - `unknown`: everything else, and every pre-handler refusal on a REPLAY
 *    (it says nothing about the first send): a timeout, a network error, a
 *    5xx, a throttle, an unreadable body, a cancel of this call in flight,
 *    a 200 that does not read `cancelled`, an unknown reason.
 */
export type CancelAnswer = "cancelled" | "not_cancelled" | "settle_by_read" | "refused" | "unknown";

const CANCEL_ANSWERS: Readonly<Record<string, { readonly status: number; readonly answer: CancelAnswer }>> = {
  withdrawal_in_flight: { status: 409, answer: "not_cancelled" },
  withdrawal_not_found: { status: 404, answer: "not_cancelled" },
  withdrawal_final: { status: 409, answer: "settle_by_read" },
};

/** Raised before the cancel handler acts: proof of refusal on a first send only. */
const PRE_HANDLER_REASONS: ReadonlySet<string> = new Set([
  "invalid_idempotency_key",
  "invalid_field",
  "forbidden_field",
  "invalid_body",
  "withdrawals_unavailable",
]);

export function cancelAnswerOf(
  answer: { readonly ok: true; readonly value: WithdrawalResponse } | { readonly ok: false; readonly failure: VexCloudCallFailure },
  send: "first" | "replay",
): CancelAnswer {
  if (answer.ok) return answer.value.withdrawal.status === "cancelled" ? "cancelled" : "unknown";
  const failure = answer.failure;
  if (failure.kind === "unauthorized") return send === "first" ? "refused" : "unknown";
  if (failure.kind !== "rejected" && failure.kind !== "unavailable") return "unknown";
  const reason = failure.kind === "rejected" ? failure.reason : (failure.reason ?? null);
  if (reason === null) {
    return send === "first" && failure.kind === "rejected" && failure.status === 404 ? "refused" : "unknown";
  }
  const known = Object.hasOwn(CANCEL_ANSWERS, reason) ? CANCEL_ANSWERS[reason] : undefined;
  if (known !== undefined) return known.status === failure.status ? known.answer : "unknown";
  return send === "first" && PRE_HANDLER_REASONS.has(reason) ? "refused" : "unknown";
}

export async function cancelWithdrawal(
  deps: CancelDeps,
  withdrawalId: string,
  signal: AbortSignal,
  correlationId: string,
): Promise<VexCloudOutcome<VexCloudCancelWithdrawalResult>> {
  // Reserved before the first await: two presses on one withdrawal never send in parallel.
  if (running.has(withdrawalId)) {
    return refused("already_running", "This withdrawal is already being cancelled. Wait for the answer.");
  }
  running.add(withdrawalId);
  log.info(`[vex-cloud:withdraw-cancel] asked correlationId=${correlationId}`);
  let decided = "refused";
  try {
    const outcome = await runCancel(deps, withdrawalId, signal);
    decided = outcome.ok ? outcome.value.outcome : `refused:${outcome.refusal.kind}`;
    return outcome;
  } finally {
    running.delete(withdrawalId);
    log.info(`[vex-cloud:withdraw-cancel] decided outcome=${decided} correlationId=${correlationId}`);
  }
}

async function runCancel(
  deps: CancelDeps,
  withdrawalId: string,
  signal: AbortSignal,
): Promise<VexCloudOutcome<VexCloudCancelWithdrawalResult>> {
  const bearer = await requireBearer(deps);
  if (!bearer.ok) return bearer;
  const read = await deps.api.readAccount(bearer.value, signal);
  if (!read.ok) return backendRefusal(deps, read.failure);
  const id = `${read.value.account_id.toLowerCase()}:${withdrawalId}`;
  const nowMs = deps.now().getTime();
  const existing = held.get(id);
  const send: "first" | "replay" = existing !== undefined && existing.heldUntilMs > nowMs ? "replay" : "first";
  if (signal.aborted) return refused("cancelled", "Stopped before the cancel was sent. Nothing changed.");
  const key = send === "replay" && existing !== undefined ? existing.key : (deps.mintIdempotencyKey ?? defaultKey)();
  // Held BEFORE the request leaves: whatever happens next, the key survives
  // until an answer about the withdrawal.
  holdKey(id, key, nowMs);

  const answer = await deps.api.cancelWithdrawal(bearer.value, key, withdrawalId, signal);
  switch (cancelAnswerOf(answer, send)) {
    case "cancelled":
      held.delete(id);
      if (!answer.ok) break;
      return { ok: true, value: { outcome: "cancelled", withdrawal: toWithdrawal(answer.value) } };
    case "not_cancelled": {
      held.delete(id);
      const inFlight = !answer.ok && answer.failure.kind === "rejected" && answer.failure.reason === "withdrawal_in_flight";
      return {
        ok: true,
        value: inFlight
          ? { outcome: "not_cancelled", reason: "in_flight", withdrawal: null, detail: IN_FLIGHT_DETAIL }
          : { outcome: "not_cancelled", reason: "not_found", withdrawal: null, detail: NOT_FOUND_DETAIL },
      };
    }
    case "settle_by_read": {
      const status = await deps.api.readWithdrawal(bearer.value, withdrawalId, signal);
      if (!status.ok) break;
      held.delete(id);
      const withdrawal = toWithdrawal(status.value);
      return withdrawal.status === "cancelled"
        ? { ok: true, value: { outcome: "cancelled", withdrawal } }
        : { ok: true, value: { outcome: "not_cancelled", reason: "final", withdrawal, detail: FINAL_DETAIL } };
    }
    case "refused": {
      held.delete(id);
      if (answer.ok) break;
      if (answer.failure.kind === "rejected" && answer.failure.status === 404 && answer.failure.reason === null) {
        return refused("cancel_unsupported", UNSUPPORTED_DETAIL);
      }
      return backendRefusal(deps, answer.failure);
    }
    case "unknown":
      if (send === "replay" && !answer.ok && answer.failure.kind === "unauthorized") {
        return replaySignedOut(deps, "cancel");
      }
      break;
  }
  return { ok: true, value: { outcome: "unknown", withdrawalId } };
}
