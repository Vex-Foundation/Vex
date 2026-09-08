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
import type { AgentscanEvent } from "../../agentscan/mapper.js";
import type { AgentscanClient, SendOutcome } from "../../agentscan/client.js";
import logger from "@utils/logger.js";
import type { AgentscanReportResult } from "../agentscan-report.js";
import { tryConsumeAgentscanSendSlot } from "./rate-limit.js";
import {
  AGENTSCAN_ROLE_RECHECK_MS,
  isRoleWithheld,
  noteRoleAcceptedByServer,
  noteRoleRefusedByServer,
} from "../../agentscan/server-capability.js";
import {
  LIGHTER_CAPABILITY_HOLD_REASON,
  LIGHTER_CAPABILITY_HOLD_SECONDS,
  noteLighterCapabilityRefused,
  readLighterCapability,
  refreshLighterCapabilityIfDue,
} from "./lighter-capability.js";
import {
  isLighterFillMappingFailure,
  mapLighterFillEnrichmentToEvent,
  mapLighterFillToEvent,
  type LighterFillEnrichmentEvent,
  type LighterFillEvent,
} from "./lighter-fill-event.js";

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

/** An envelope-level 400 is a client bug, not weather - hold the rows a full hour and say so loudly. */
const INVALID_BATCH_HOLD_SECONDS = 3600;

/** How long a row waits when the deployed server does not carry its role yet. */
const ROLE_WITHHELD_HOLD_SECONDS = AGENTSCAN_ROLE_RECHECK_MS / 1000;

/**
 * The reason written to `agentscan_outbox.last_error` for a withheld row. Code
 * words only, and the role is the whole diagnosis: it names both what is owed
 * and which server deployment would clear it.
 */
const roleNotDeployedReason = (eventRole: string): string => `role_not_deployed ${eventRole}`;

/**
 * The row's role, or null when the activity row vanished or carries no role this
 * code can read. A null is never treated as provisional: an unreadable role
 * cannot be evidence about the server's vocabulary.
 */
function eventRoleOf(claimed: ClaimedOutboxEvent): string | null {
  const role = claimed.activity?.["event_role"];
  return typeof role === "string" ? role : null;
}

/** How long a row whose local payload could not be built waits before another look. */
const UNMAPPABLE_ROW_HOLD_SECONDS = 3600;

/**
 * The activity roles the Lighter vocabulary introduced. Their events reach the
 * server through the ordinary activity path (they are settlement-chain
 * transactions with real receipts), but the server has to CARRY the vocabulary
 * before they may be sent, exactly as a fill does.
 */
const LIGHTER_ACTIVITY_ROLES: ReadonlySet<string> = new Set([
  "exchange_deposit",
  "exchange_withdrawal",
]);

/**
 * Does this row need the server to advertise `lighter_v1` before it may go on
 * the wire? Every fill does by construction, and so do the exchange funding
 * legs.
 */
function needsLighterCapability(claimed: ClaimedOutboxEvent): boolean {
  if (claimed.sourceKind !== "agent_activity") return true;
  const role = eventRoleOf(claimed);
  return role !== null && LIGHTER_ACTIVITY_ROLES.has(role);
}

/**
 * Hold one row with its reason, reporting whether the fence refused the write.
 * Every hold in this file goes through here so a held row can never be counted
 * as sent, rejected, or silently forgotten.
 */
async function holdRow(
  outboxId: number,
  delaySeconds: number,
  atGeneration: number,
  reason: string,
): Promise<void> {
  const held = await reportingRepo.rescheduleOutbox([outboxId], delaySeconds, atGeneration, reason);
  if (held.kind === "stale_generation") {
    logger.warn("agentscan.report.hold_stale_generation", {
      rows: 1,
      claimedAtGeneration: atGeneration,
    });
  }
}

/**
 * The incremental scan-then-drain step: shared verbatim by the periodic
 * lane's non-backfill tick and the push lane's `runAgentscanIncremental`, so
 * there is exactly one place that enqueues an incremental diff and drains it.
 *
 * `atGeneration` is read in the SAME `getReportingState()` as `agentHash` and
 * `ingestToken` - it is the generation those credentials belong to, and the
 * enqueue is fenced on it. Without that fence a lane that passed its guards at
 * generation G could insert a brand-new `backfill = FALSE` row AFTER a 401 reset
 * committed G+1, and no reset can relabel a row that did not exist when it ran;
 * that row is then permanently live activity. A stale enqueue therefore inserts
 * nothing, drains nothing and ends the tick. It refuses ONCE, never forever:
 * the next tick calls `getReportingState()` again and runs at the current
 * generation with the credentials that belong to it.
 */
export async function drainIncremental(
  client: AgentscanClient,
  agentHash: string,
  ingestToken: string,
  atGeneration: number,
): Promise<Pick<AgentscanReportResult, "enqueued" | "sent" | "rejected" | "deferred" | "owed">> {
  const enqueued = await reportingRepo.enqueueEligibleActivity(false, atGeneration);
  if (enqueued.kind === "stale_generation") {
    logger.warn("agentscan.report.enqueue_stale_generation", {
      reason: "registration_reset_since_state_read",
      atGeneration,
    });
    return { enqueued: 0, sent: 0, rejected: 0, deferred: 0, owed: 0 };
  }
  // THE SECOND LEDGER, SAME TICK, SAME FENCE. A fill has no `agent_activity`
  // row, so the activity diff above cannot see it; its own diff runs under the
  // same generation and stops for the same reason. A stale answer here is not
  // fatal to the tick that already enqueued activity rows - it simply enqueued
  // no fills, and the next tick runs both at the current generation.
  const fills = await reportingRepo.enqueueEligibleLighterFills(false, atGeneration);
  if (fills.kind === "stale_generation") {
    logger.warn("agentscan.report.lighter_fill_enqueue_stale_generation", {
      reason: "registration_reset_since_state_read",
      atGeneration,
    });
  }
  const drain = await drainOutbox(client, agentHash, ingestToken, atGeneration);
  return { enqueued: enqueued.rows + (fills.kind === "applied" ? fills.rows : 0), ...drain };
}

export async function drainOutbox(
  client: AgentscanClient,
  agentHash: string,
  ingestToken: string,
  atGeneration: number,
): Promise<{ sent: number; rejected: number; deferred: number; owed: number }> {
  let sent = 0;
  let rejected = 0;
  let deferred = 0;
  let owed = 0;

  // ASK THE SERVER WHAT IT CARRIES BEFORE DECIDING WHAT TO SEND, at most once
  // per cadence window. The Lighter vocabulary must never be probed by sending
  // (see `./lighter-capability.ts`), so the only way a held row is ever
  // released is a refresh that happens on the lane's own schedule rather than
  // as a side effect of a send.
  await refreshLighterCapabilityIfDue(atGeneration, Date.now());

  for (let batch = 0; batch < AGENTSCAN_MAX_BATCHES_PER_TICK; batch++) {
    // The lane's credential generation travels from the caller into the claim
    // and on to every terminal write below: a registration reset that lands
    // while this batch is in flight must make those writes apply to nothing, or
    // a row the reset re-owed is marked sent behind its back and dropped from
    // the full resend. A claim at any other generation would be a batch sent
    // under credentials the reset replaced, so it claims nothing and the tick
    // ends here; the next tick re-reads state.
    const claim = await reportingRepo.claimDueOutbox(AGENTSCAN_BATCH_LIMIT, atGeneration);
    if (claim.kind === "stale_generation") {
      logger.warn("agentscan.report.claim_stale_generation", {
        reason: "registration_reset_since_state_read",
        atGeneration,
      });
      break;
    }
    const claimed = claim.events;
    if (claimed.length === 0) break;

    // One envelope carries one backfill flag - a mixed claim is split.
    const groups = [claimed.filter((c) => c.backfill), claimed.filter((c) => !c.backfill)]
      .filter((group) => group.length > 0);

    let stop = false;
    for (const group of groups) {
      if (!tryConsumeAgentscanSendSlot()) {
        // The lane's minute budget is spent. The rows are already claimed and
        // still owed, so the next tick resumes here - see `./rate-limit.ts` for
        // why this refuses instead of sleeping.
        logger.info("agentscan.report.rate_budget_exhausted", { rows: group.length });
        deferred += group.length;
        stop = true;
        break;
      }
      const outcome = await sendGroup(client, agentHash, ingestToken, group, atGeneration);
      sent += outcome.sent;
      rejected += outcome.rejected;
      deferred += outcome.deferred;
      owed += outcome.owed;
      if (outcome.stop) {
        stop = true;
        break;
      }
    }
    if (stop) break;
  }

  return { sent, rejected, deferred, owed };
}

/**
 * One HTTP batch and every verdict it can produce.
 *
 * `atGeneration` is the `registration_generation` the lane read its credentials
 * at, and the one the claim required.
 * Every terminal write carries it, and a `stale_generation` answer means a
 * registration reset committed while this request was in flight: the rows are
 * already relabelled as owed history under a different (or abandoned) identity,
 * so the verdict is reported and the rows counted as DEFERRED rather than sent,
 * rejected or held. The drain stops after one, because continuing to send under
 * a token the reset has invalidated can only earn another 401.
 */
async function sendGroup(
  client: AgentscanClient,
  agentHash: string,
  ingestToken: string,
  group: ClaimedOutboxEvent[],
  atGeneration: number,
): Promise<{ sent: number; rejected: number; deferred: number; owed: number; stop: boolean }> {
  // A vanished source row (a cascade already removed its outbox rows) has
  // nothing to send and nothing to mark - checked against the ledger the row
  // actually names, because a fill row legitimately carries no activity.
  const claimable = group.filter((c) =>
    c.sourceKind === "agent_activity" ? c.activity !== null : c.fill !== null,
  );
  if (claimable.length === 0) {
    return { sent: 0, rejected: 0, deferred: 0, owed: 0, stop: false };
  }

  let owed = 0;

  // THE LIGHTER CAPABILITY GATE, BEFORE EVERYTHING ELSE. A row of the Lighter
  // vocabulary may not be sent - not even once as a probe - until the server
  // has said it carries `lighter_v1`. Unknown holds exactly as absent does, so
  // the fail-closed direction is the default and a server that has never been
  // asked never receives a row it might reject.
  //
  // Held BY CAPABILITY, NOT BY POSITION: the rest of this batch proceeds, so
  // ordinary activity queued behind a Lighter row is never starved by it.
  const lighterRows = claimable.filter(needsLighterCapability);
  let admissible = claimable;
  if (lighterRows.length > 0) {
    const capability = await readLighterCapability(atGeneration, Date.now());
    if (capability.state !== "present") {
      const heldIds = new Set(lighterRows.map((row) => row.outboxId));
      for (const row of lighterRows) {
        await holdRow(row.outboxId, LIGHTER_CAPABILITY_HOLD_SECONDS, atGeneration, LIGHTER_CAPABILITY_HOLD_REASON);
        owed += 1;
      }
      admissible = claimable.filter((row) => !heldIds.has(row.outboxId));
      logger.info("agentscan.report.lighter_capability_held", {
        rows: lighterRows.length,
        state: capability.state,
        observedAt: capability.observedAt,
      });
    }
  }
  if (admissible.length === 0) return { sent: 0, rejected: 0, deferred: 0, owed, stop: false };

  // THE ROLE GATE, BEFORE THE REQUEST. A role the last probe found the server does not
  // carry is not put on the wire again until the recheck window lapses: sending
  // it could only earn another per-item refusal, and each refusal spends a slot
  // of the lane's minute budget answering a question that was already answered.
  // The rows stay owed with the reason visible.
  const withheld = admissible.filter((c) => {
    const role = eventRoleOf(c);
    return role !== null && isRoleWithheld(role, Date.now());
  });
  const withheldIds = new Set(withheld.map((c) => c.outboxId));
  const admitted = admissible.filter((c) => !withheldIds.has(c.outboxId));
  for (const item of withheld) {
    const role = eventRoleOf(item) ?? "unknown";
    await holdRow(item.outboxId, ROLE_WITHHELD_HOLD_SECONDS, atGeneration, roleNotDeployedReason(role));
    owed += 1;
  }
  if (withheld.length > 0) {
    logger.info("agentscan.report.role_withheld", {
      rows: withheld.length,
      roles: [...new Set(withheld.map((c) => eventRoleOf(c) ?? "unknown"))].sort(),
    });
  }
  if (admitted.length === 0) return { sent: 0, rejected: 0, deferred: 0, owed, stop: false };

  // BUILD EVERY PAYLOAD BEFORE SENDING ANY OF THEM, and drop a row this
  // install cannot express rather than putting a half-event on the wire. A
  // ledger row whose payload cannot be built is OUR bug, so it holds long and
  // loud like an envelope-level 400 - never terminal, because a later fee
  // enrichment or repair can still make it reportable.
  const mappable: ClaimedOutboxEvent[] = [];
  // A fill event is an `AgentscanEvent` plus its typed `lighterFill` object,
  // which is why the array is typed by the union rather than by the base:
  // the extra field must survive to the wire, and a widened element type
  // would be the one thing that silently drops it.
  const events: Array<AgentscanEvent | LighterFillEvent | LighterFillEnrichmentEvent> = [];
  for (const item of admitted) {
    if (item.sourceKind === "lighter_fill" || item.sourceKind === "lighter_fill_enrichment") {
      if (item.fill === null) continue;
      // AN ENRICHMENT IS AN UPDATE TO THE FILL THIS ROW ALREADY DELIVERED, so
      // it maps through its own projection: the same identity, the newly
      // proven fees, and no economics at all. The revision comes from the
      // outbox row rather than from the ledger, because the ledger row can be
      // enriched again between enqueue and drain and this row delivers the
      // revision it was queued for.
      const mapped = item.sourceKind === "lighter_fill_enrichment"
        ? mapLighterFillEnrichmentToEvent(item.fill, item.enrichmentRevision ?? 0)
        : mapLighterFillToEvent(item.fill);
      if (isLighterFillMappingFailure(mapped)) {
        await holdRow(
          item.outboxId,
          UNMAPPABLE_ROW_HOLD_SECONDS,
          atGeneration,
          `fill_unmappable ${mapped.reason}`,
        );
        owed += 1;
        logger.error("agentscan.report.lighter_fill_unmappable", {
          outboxId: item.outboxId,
          reason: mapped.reason,
        });
        continue;
      }
      mappable.push(item);
      events.push(mapped);
      continue;
    }
    if (item.activity === null) continue;
    mappable.push(item);
    events.push(mapActivityToEvent(item.activity, { status: item.status }));
  }
  if (mappable.length === 0) return { sent: 0, rejected: 0, deferred: 0, owed, stop: false };
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
    const sentWrite = await reportingRepo.markOutboxSent(sentIds, atGeneration);
    let staleSent = 0;
    if (sentWrite.kind === "stale_generation") {
      staleSent = sentIds.length;
      logger.warn("agentscan.report.send_ack_stale_generation", {
        rows: staleSent,
        claimedAtGeneration: atGeneration,
      });
    }

    // The probe's positive half: the server took a row of this role, so nothing
    // about it is withheld any more, whatever an earlier deployment answered.
    for (const item of mappable.filter((_, index) => !rejectedIndexes.has(index))) {
      const role = eventRoleOf(item);
      if (role !== null) noteRoleAcceptedByServer(role);
    }

    let rejected = 0;
    let staleRejected = 0;
    for (const index of outcome.rejectedIndexes) {
      const item = mappable[index];
      if (item === undefined) continue;

      // A LIGHTER ROW REFUSED AFTER THE SERVER ADVERTISED THE CAPABILITY is a
      // deployment disagreement, not a verdict on the payload: two deployments
      // behind one address, or a rollback between the capability read and this
      // send. The contract's rule for that state is to HOLD while the
      // capability is resolved and never to reject, so the observation goes
      // negative immediately and the row stays owed.
      if (needsLighterCapability(item)) {
        await noteLighterCapabilityRefused(atGeneration);
        await holdRow(
          item.outboxId,
          LIGHTER_CAPABILITY_HOLD_SECONDS,
          atGeneration,
          LIGHTER_CAPABILITY_HOLD_REASON,
        );
        owed += 1;
        logger.warn("agentscan.report.lighter_row_refused_while_advertised", {
          outboxId: item.outboxId,
          sourceKind: item.sourceKind,
        });
        continue;
      }

      // The probe's negative half. A refusal of a role the deployment does not
      // carry yet withholds the role and leaves the row OWED with the reason; a
      // refusal of anything else is our payload's fault and stays terminal.
      const role = eventRoleOf(item);
      if (role !== null && noteRoleRefusedByServer(role, Date.now())) {
        const held = await reportingRepo.rescheduleOutbox(
          [item.outboxId],
          ROLE_WITHHELD_HOLD_SECONDS,
          atGeneration,
          roleNotDeployedReason(role),
        );
        if (held.kind === "stale_generation") {
          logger.warn("agentscan.report.hold_stale_generation", {
            rows: 1,
            claimedAtGeneration: atGeneration,
          });
        }
        owed += 1;
        logger.warn("agentscan.report.role_not_deployed", {
          activityId: item.activityId,
          eventRole: role,
          status: item.status,
        });
        continue;
      }

      const rejection = await reportingRepo.markOutboxRejected(
        item.outboxId,
        "validation_failed",
        atGeneration,
      );
      if (rejection.kind === "stale_generation") {
        staleRejected += 1;
        continue;
      }
      rejected += 1;
      logger.warn("agentscan.report.event_rejected", {
        activityId: item.activityId,
        status: item.status,
      });
    }
    if (staleRejected > 0) {
      logger.warn("agentscan.report.rejection_stale_generation", {
        rows: staleRejected,
        claimedAtGeneration: atGeneration,
      });
    }

    const stale = staleSent + staleRejected;
    if (stale > 0) {
      return { sent: sentIds.length - staleSent, rejected, deferred: stale, owed, stop: true };
    }
    return { sent: sentIds.length, rejected, deferred: 0, owed, stop: false };
  }

  const owedIds = mappable.map((c) => c.outboxId);

  if (outcome.kind === "auth_lost") {
    // Server no longer knows the token (server-side reset) or disputes the
    // hash binding. Registration is idempotent: re-register the SAME identity
    // next run - but a server-side reset also means the server has nothing,
    // so the full eligible history must go out again, not just what is still
    // owed; a genuine conflict surfaces at that re-register as a terminal 409.
    await reportingRepo.resetForReRegistration();
    logger.warn("agentscan.report.auth_lost_reregistering");
    return { sent: 0, rejected: 0, deferred: owedIds.length, owed, stop: true };
  }
  if (outcome.kind === "stopped") {
    await reportingRepo.markStopped(outcome.reason);
    logger.warn("agentscan.report.stopped_by_server", { reason: outcome.reason });
    return { sent: 0, rejected: 0, deferred: owedIds.length, owed, stop: true };
  }
  if (outcome.kind === "invalid") {
    // OUR envelope failed the server's schema - a client bug, not weather.
    // Data is never dropped; the rows hold for an hour so the log is seen
    // before the next thundering retry.
    const held = await reportingRepo.rescheduleOutbox(owedIds, INVALID_BATCH_HOLD_SECONDS, atGeneration);
    if (held.kind === "stale_generation") {
      logger.warn("agentscan.report.hold_stale_generation", {
        rows: owedIds.length,
        claimedAtGeneration: atGeneration,
      });
    }
    logger.error("agentscan.report.batch_invalid", { detail: outcome.detail, rows: owedIds.length });
    return { sent: 0, rejected: 0, deferred: owedIds.length, owed, stop: true };
  }
  // retryable - the claim already stamped exponential backoff; the server's
  // own Retry-After overrides it when present.
  if (outcome.retryAfterSeconds !== null) {
    const held = await reportingRepo.rescheduleOutbox(owedIds, outcome.retryAfterSeconds, atGeneration);
    if (held.kind === "stale_generation") {
      logger.warn("agentscan.report.hold_stale_generation", {
        rows: owedIds.length,
        claimedAtGeneration: atGeneration,
      });
    }
  }
  logger.info("agentscan.report.batch_deferred", {
    detail: outcome.detail,
    rows: owedIds.length,
  });
  return { sent: 0, rejected: 0, deferred: owedIds.length, owed, stop: true };
}
