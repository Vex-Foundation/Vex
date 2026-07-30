/**
 * `requestApply` — the ONE surface that queues a cutover.
 *
 * The UI button, the agent's `compact_apply` tool and the Full-Autonomous
 * auto-apply policy all land here and nowhere else. None of them performs a
 * cutover: this function only moves the FSM `summary_ready → apply_requested`.
 * The runner consumes it at its next iteration boundary
 * (`consume-at-boundary.ts`), which is the only place that holds the lease, the
 * lock order and the money gate together.
 *
 * ## The CAS comes FIRST, the lease check second
 *
 * This is the correction that matters, and it inverts the obvious order. An
 * earlier design checked for a live runner lease first and wrote nothing when
 * there was none, so a user pressing Apply on an idle session got an error and
 * their intent evaporated. The queued request is DURABLE by design: it is
 * written regardless, and the absence of a lease is reported honestly as
 * `queued_no_live_runner` so the UI can say "queued — it will apply when the
 * agent next runs" instead of pretending the click failed.
 *
 * The lease read therefore describes the world AFTER the write, and a lease
 * appearing a microsecond later is harmless: the request is already on the row
 * for that runner to find.
 *
 * ## `no_preparation` / `not_ready` write nothing
 *
 * Both are honest refusals, not failures. There is no live preparation, or the
 * one that exists is still `preparing`, already `apply_requested`, already
 * `applying`, or `failed`. `casRequestApply`'s own `status = 'summary_ready'`
 * predicate is what makes the second case impossible to force.
 */

import * as preparationsRepo from "@vex-agent/db/repos/compaction-preparations/index.js";
import type { ApplySource } from "@vex-agent/db/repos/compaction-preparations/index.js";
import type { PreparationStatus } from "@vex-agent/db/repos/compaction-preparations/index.js";
import * as runnerLeasesRepo from "@vex-agent/db/repos/runner-leases.js";
import { withSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status.js";
import logger from "@utils/logger.js";

import { emitApplyTransition } from "./emit-transition.js";

/**
 * Who asked. `forced_critical` is deliberately absent: the critical path does
 * not go through `requestApply` — it forces execution directly, because a
 * request that still had to be consumed at a later boundary would not help a
 * session that is already out of context.
 */
export type RequestApplySource = Exclude<ApplySource, "forced_critical">;

export type RequestApplyOutcome =
  /** Queued AND a live runner exists to consume it at its next boundary. */
  | { kind: "queued"; preparationId: number }
  /** Queued and durable, but nothing is running right now. */
  | { kind: "queued_no_live_runner"; preparationId: number }
  /** A request was already standing — this call added nothing. */
  | { kind: "already_requested"; preparationId: number }
  | { kind: "not_ready"; preparationId: number; status: PreparationStatus }
  | { kind: "no_preparation" };

export interface RequestApplyInput {
  readonly sessionId: string;
  readonly source: RequestApplySource;
}

export async function requestApply(
  input: RequestApplyInput,
): Promise<RequestApplyOutcome> {
  // Under the session control lock: the CAS competes with the runner consuming
  // a request and with capture superseding this very preparation.
  const outcome = await withSessionControlLock(input.sessionId, async (client) => {
    const live = await preparationsRepo.getLivePreparationForSession(
      input.sessionId,
    );
    if (live === null) return { kind: "no_preparation" } as const;

    if (live.status === "apply_requested") {
      return { kind: "already_requested", preparationId: live.id } as const;
    }
    if (live.status !== "summary_ready") {
      return {
        kind: "not_ready",
        preparationId: live.id,
        status: live.status,
      } as const;
    }

    const cas = await preparationsRepo.casRequestApply(
      live.id,
      input.source,
      client,
    );
    if (!cas.ok) {
      // Lost the race to a concurrent writer between the read and the CAS.
      return {
        kind: "not_ready",
        preparationId: live.id,
        status: live.status,
      } as const;
    }

    // AFTER the write, on the same client — see the header.
    const lease = await runnerLeasesRepo.getLease(input.sessionId, client);
    const liveRunner = lease !== null && lease.expiresAt >= new Date();
    return {
      kind: liveRunner ? "queued" : "queued_no_live_runner",
      preparationId: live.id,
    } as const;
  });

  // AFTER `withSessionControlLock` returned — i.e. after its COMMIT. Only the
  // two outcomes whose CAS actually landed announce anything; `already_requested`
  // changed no row, and the refusals wrote nothing at all.
  //
  // The IPC handler deliberately does NOT emit: the queueing CAS is engine
  // surface, so the emit belongs here, once, for every caller of it.
  if (outcome.kind === "queued" || outcome.kind === "queued_no_live_runner") {
    emitApplyTransition(input.sessionId, "apply_requested");
  }

  logger.info("compaction.apply.requested", {
    sessionId: input.sessionId,
    source: input.source,
    outcome: outcome.kind,
    preparationId: "preparationId" in outcome ? outcome.preparationId : null,
  });
  return outcome;
}
