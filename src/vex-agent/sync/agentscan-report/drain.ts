/**
 * The outbox drain, split out of `../agentscan-report.ts` (the 550-line file
 * limit). A different reason to change from the facade: the facade owns the
 * lane's state machine (register, backfill, when to drain); this file owns how
 * claimed outbox rows become HTTP batches and how every server verdict maps
 * back onto row state. Shared verbatim by the periodic lane and the push
 * lane's `runAgentscanIncremental`, so there is exactly one drain.
 */

import * as reportingRepo from "@vex-agent/db/repos/agentscan-reporting.js";
import type { ClaimedOutboxEvent } from "@vex-agent/db/repos/agentscan-reporting.js";
import { mapActivityToEvent } from "../../agentscan/mapper.js";
import type { AgentscanClient, SendOutcome } from "../../agentscan/client.js";
import logger from "@utils/logger.js";
import type { AgentscanReportResult } from "../agentscan-report.js";
import { tryConsumeAgentscanSendSlot } from "./rate-limit.js";

/** Contract batch ceiling (server rejects larger batches with 413). */
export const AGENTSCAN_BATCH_LIMIT = 500;

/**
 * Bounded batches per run: the lane does serial HTTP inside the shared sync
 * worker, and an unbounded backlog (a first backfill can be the whole
 * history) would starve the balance and activity sync sharing the drain.
 * 6 × 500 events/tick clears even a large backfill in a few minutes while
 * staying far under the server's 60 req/min per-token limit.
 */
export const AGENTSCAN_MAX_BATCHES_PER_TICK = 6;

/** An envelope-level 400 is a client bug, not weather — hold the rows a full hour and say so loudly. */
const INVALID_BATCH_HOLD_SECONDS = 3600;

/**
 * 403-quarantined is a server accusation, not a user decision. The server can
 * be wrong (and has been), and an install that has stopped calling cannot be
 * told the accusation was withdrawn. Hold the owed rows a full hour and ask
 * again — never latch a permanent skip.
 */
const QUARANTINE_HOLD_SECONDS = 3600;

/**
 * The incremental scan-then-drain step: shared verbatim by the periodic
 * lane's non-backfill tick and the push lane's `runAgentscanIncremental`, so
 * there is exactly one place that enqueues an incremental diff and drains it.
 */
export async function drainIncremental(
  client: AgentscanClient,
  agentHash: string,
  ingestToken: string,
): Promise<Pick<AgentscanReportResult, "enqueued" | "sent" | "rejected" | "deferred">> {
  const enqueued = await reportingRepo.enqueueEligibleActivity(false);
  const drain = await drainOutbox(client, agentHash, ingestToken);
  return { enqueued, ...drain };
}

export async function drainOutbox(
  client: AgentscanClient,
  agentHash: string,
  ingestToken: string,
): Promise<{ sent: number; rejected: number; deferred: number }> {
  let sent = 0;
  let rejected = 0;
  let deferred = 0;

  for (let batch = 0; batch < AGENTSCAN_MAX_BATCHES_PER_TICK; batch++) {
    const claimed = await reportingRepo.claimDueOutbox(AGENTSCAN_BATCH_LIMIT);
    if (claimed.length === 0) break;

    // One envelope carries one backfill flag — a mixed claim is split.
    const groups = [claimed.filter((c) => c.backfill), claimed.filter((c) => !c.backfill)]
      .filter((group) => group.length > 0);

    let stop = false;
    for (const group of groups) {
      if (!tryConsumeAgentscanSendSlot()) {
        // The lane's minute budget is spent. The rows are already claimed and
        // still owed, so the next tick resumes here — see `./rate-limit.ts` for
        // why this refuses instead of sleeping.
        logger.info("agentscan.report.rate_budget_exhausted", { rows: group.length });
        deferred += group.length;
        stop = true;
        break;
      }
      const outcome = await sendGroup(client, agentHash, ingestToken, group);
      sent += outcome.sent;
      rejected += outcome.rejected;
      deferred += outcome.deferred;
      if (outcome.stop) {
        stop = true;
        break;
      }
    }
    if (stop) break;
  }

  return { sent, rejected, deferred };
}

async function sendGroup(
  client: AgentscanClient,
  agentHash: string,
  ingestToken: string,
  group: ClaimedOutboxEvent[],
): Promise<{ sent: number; rejected: number; deferred: number; stop: boolean }> {
  // A vanished activity row (cascade already removed its outbox rows) has
  // nothing to send and nothing to mark.
  const mappable = group.filter((c) => c.activity !== null);
  if (mappable.length === 0) return { sent: 0, rejected: 0, deferred: 0, stop: false };

  const events = mappable.map((c) =>
    mapActivityToEvent(c.activity as Record<string, unknown>, { status: c.status }),
  );
  const outcome: SendOutcome = await client.sendEvents({
    agentHash,
    ingestToken,
    backfill: group[0]?.backfill === true,
    events,
  });

  if (outcome.kind === "ok") {
    // The server's additive health field (2026-08-12): a non-zero strike
    // count means the install is on the road to quarantine (403 at the
    // server's threshold) - surface it BEFORE reporting goes dark, so the
    // operator can act while the identity is still healthy.
    if (outcome.agentHealth !== null && outcome.agentHealth.strikeCount > 0) {
      logger.warn("agentscan.report.agent_strikes", {
        strikeCount: outcome.agentHealth.strikeCount,
        status: outcome.agentHealth.status,
      });
    }
    const rejectedIndexes = new Set(outcome.rejectedIndexes);
    const sentIds = mappable
      .filter((_, index) => !rejectedIndexes.has(index))
      .map((c) => c.outboxId);
    await reportingRepo.markOutboxSent(sentIds);
    for (const index of outcome.rejectedIndexes) {
      const item = mappable[index];
      if (item === undefined) continue;
      await reportingRepo.markOutboxRejected(item.outboxId, "validation_failed");
      logger.warn("agentscan.report.event_rejected", {
        activityId: item.activityId,
        status: item.status,
      });
    }
    return { sent: sentIds.length, rejected: outcome.rejectedIndexes.length, deferred: 0, stop: false };
  }

  const owedIds = mappable.map((c) => c.outboxId);

  if (outcome.kind === "auth_lost") {
    // Server no longer knows the token (server-side reset) or disputes the
    // hash binding. Registration is idempotent: re-register the SAME identity
    // next run — but a server-side reset also means the server has nothing,
    // so the full eligible history must go out again, not just what is still
    // owed; a genuine conflict surfaces at that re-register as a terminal 409.
    await reportingRepo.resetForReRegistration();
    logger.warn("agentscan.report.auth_lost_reregistering");
    return { sent: 0, rejected: 0, deferred: owedIds.length, stop: true };
  }
  if (outcome.kind === "stopped") {
    if (outcome.reason === "quarantined") {
      await reportingRepo.rescheduleOutbox(owedIds, QUARANTINE_HOLD_SECONDS);
    } else {
      await reportingRepo.markStopped(outcome.reason);
    }
    logger.warn("agentscan.report.stopped_by_server", { reason: outcome.reason });
    return { sent: 0, rejected: 0, deferred: owedIds.length, stop: true };
  }
  if (outcome.kind === "invalid") {
    // OUR envelope failed the server's schema — a client bug, not weather.
    // Data is never dropped; the rows hold for an hour so the log is seen
    // before the next thundering retry.
    await reportingRepo.rescheduleOutbox(owedIds, INVALID_BATCH_HOLD_SECONDS);
    logger.error("agentscan.report.batch_invalid", { detail: outcome.detail, rows: owedIds.length });
    return { sent: 0, rejected: 0, deferred: owedIds.length, stop: true };
  }
  // retryable — the claim already stamped exponential backoff; the server's
  // own Retry-After overrides it when present.
  if (outcome.retryAfterSeconds !== null) {
    await reportingRepo.rescheduleOutbox(owedIds, outcome.retryAfterSeconds);
  }
  logger.info("agentscan.report.batch_deferred", {
    detail: outcome.detail,
    rows: owedIds.length,
  });
  return { sent: 0, rejected: 0, deferred: owedIds.length, stop: true };
}
