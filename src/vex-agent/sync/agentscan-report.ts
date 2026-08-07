/**
 * AgentScan REPORTING lane — register once, backfill once, then drain the
 * outbox every tick.
 *
 * ── What this is not ───────────────────────────────────────────────────────
 *
 * NOT ON THE MONEY PATH. No handler waits for this lane; it reads committed
 * `agent_activity` history through the diff scan and posts it to a
 * receive-only telemetry server. A dead or slow AgentScan accumulates outbox
 * rows and nothing else happens. NEVER SIGNS, never holds a wallet, never
 * touches the vault — the only secret in play is the lane's own ingest token,
 * whose leak could at most fake THIS install's telemetry.
 *
 * SAFE TO RE-RUN. Registration is idempotent server-side; event batches are
 * deduplicated by (agentHash, sourceRowId, status) with monotonic status
 * precedence, so a crash between send and mark just resends a batch the
 * server counts as duplicates. The claim stamps its own backoff BEFORE the
 * send (launch-attribution pattern), so nothing hot-loops.
 *
 * ── Consent & privacy ──────────────────────────────────────────────────────
 *
 * The lane is DARK until `services.agentscanApiUrl` is configured (per the
 * approved MVP: using the app is consent, and the URL default ships empty
 * until the public rollout). The identity is CSPRNG-random, never derived
 * from key material. Payloads go through the mapper's structural allowlist —
 * the banned columns are unreadable from its output by construction. Server
 * verdicts are honored exactly: 410 / 403-quarantined / register-409 stop the
 * lane permanently; a 401 re-registers the SAME identity AND resends the full
 * eligible history (a server-side reset means the server has nothing, so
 * every already-sent row comes back owed, flagged `backfill`); only
 * 429/5xx/network are retried.
 */

import { randomBytes } from "node:crypto";

import { loadConfig } from "../../config/store.js";
import * as reportingRepo from "@vex-agent/db/repos/agentscan-reporting.js";
import { mapActivityToEvent } from "../agentscan/mapper.js";
import {
  buildAgentscanClient,
  type AgentscanClient,
  type SendOutcome,
} from "../agentscan/client.js";
import type { ClaimedOutboxEvent } from "@vex-agent/db/repos/agentscan-reporting.js";
import logger from "@utils/logger.js";

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

/** Register backoff: 5 min · 2^n capped at 1 h — the register endpoint allows only 10/h per IP. */
const REGISTER_BACKOFF_BASE_SECONDS = 300;
const REGISTER_BACKOFF_MAX_SECONDS = 3600;

/** An envelope-level 400 is a client bug, not weather — hold the rows a full hour and say so loudly. */
const INVALID_BATCH_HOLD_SECONDS = 3600;

export interface AgentscanReporterDeps {
  /** Resolved ingest base URL, or null when reporting is disabled/misconfigured. */
  readonly baseUrl: () => string | null;
  readonly buildClient: (baseUrl: string) => AgentscanClient;
  /** App version for the register record, when the host process knows it. */
  readonly appVersion: () => string | null;
}

export interface AgentscanReportResult {
  readonly skipped: "disabled" | "stopped" | "unregistered" | null;
  /** Outbox rows enqueued by this run's diff scan. */
  readonly enqueued: number;
  /** Whether THIS run performed the one-time backfill enqueue. */
  readonly backfillEnqueued: boolean;
  /** Events the server took (accepted or deduplicated) this run. */
  readonly sent: number;
  /** Per-item permanent validation rejections this run. */
  readonly rejected: number;
  /** Claimed rows left for retry after a batch-level failure. */
  readonly deferred: number;
}

const NOTHING: Omit<AgentscanReportResult, "skipped"> = {
  enqueued: 0,
  backfillEnqueued: false,
  sent: 0,
  rejected: 0,
  deferred: 0,
};

/** CSPRNG identity — 32 bytes hex (public hash) + 32 bytes base64url (secret token). */
export function generateAgentscanIdentity(): { agentHash: string; ingestToken: string } {
  return {
    agentHash: randomBytes(32).toString("hex"),
    ingestToken: randomBytes(32).toString("base64url"),
  };
}

export async function runAgentscanReport(
  deps: AgentscanReporterDeps,
): Promise<AgentscanReportResult> {
  const baseUrl = deps.baseUrl();
  if (baseUrl === null) return { skipped: "disabled", ...NOTHING };

  let state = await reportingRepo.getReportingState();
  if (state.stoppedReason !== null) return { skipped: "stopped", ...NOTHING };

  if (state.agentHash === null || state.ingestToken === null) {
    state = await reportingRepo.ensureIdentity(generateAgentscanIdentity);
  }
  const agentHash = state.agentHash;
  const ingestToken = state.ingestToken;
  if (agentHash === null || ingestToken === null) {
    // Unreachable after ensureIdentity; named so a future regression is loud.
    logger.error("agentscan.report.identity_missing_after_ensure");
    return { skipped: "unregistered", ...NOTHING };
  }

  const client = deps.buildClient(baseUrl);

  if (state.registeredAt === null) {
    const registered = await registerOnce(client, deps, state, agentHash, ingestToken);
    if (registered !== "registered") return { skipped: registered, ...NOTHING };
  }

  // The one-time backfill (AC2): first enqueue after a successful registration
  // carries the whole eligible history; every later scan is incremental.
  let backfillEnqueued = false;
  let enqueued = 0;
  if (state.backfillEnqueuedAt === null) {
    enqueued = await reportingRepo.enqueueEligibleActivity(true);
    await reportingRepo.markBackfillEnqueued();
    backfillEnqueued = true;
    if (enqueued > 0) logger.info("agentscan.report.backfill_enqueued", { rows: enqueued });
  } else {
    enqueued = await reportingRepo.enqueueEligibleActivity(false);
  }

  const drain = await drainOutbox(client, agentHash, ingestToken);
  return { skipped: null, enqueued, backfillEnqueued, ...drain };
}

// ── register ────────────────────────────────────────────────────────────────

async function registerOnce(
  client: AgentscanClient,
  deps: AgentscanReporterDeps,
  state: reportingRepo.AgentscanReportingState,
  agentHash: string,
  ingestToken: string,
): Promise<"registered" | "unregistered" | "stopped"> {
  if (new Date(state.nextRegisterAttemptAt).getTime() > Date.now()) return "unregistered";

  const appVersion = deps.appVersion();
  const outcome = await client.register({
    agentHash,
    ingestToken,
    consentVersion: state.consentVersion,
    acceptedAt: state.acceptedAt ?? new Date().toISOString(),
    ...(appVersion !== null ? { appVersion: appVersion.slice(0, 32) } : {}),
  });

  if (outcome.kind === "registered") {
    await reportingRepo.markRegistered();
    logger.info("agentscan.report.registered");
    return "registered";
  }
  if (outcome.kind === "conflict") {
    // The hash is bound to a different token server-side. This identity can
    // never report again; a silent retry loop would only re-refuse.
    await reportingRepo.markStopped("agent_conflict");
    logger.error("agentscan.report.register_conflict_stopped");
    return "stopped";
  }
  const delay =
    outcome.kind === "retryable" && outcome.retryAfterSeconds !== null
      ? outcome.retryAfterSeconds
      : registerBackoffSeconds(state.registerAttemptCount);
  await reportingRepo.noteRegisterAttemptFailed(delay);
  logger.warn("agentscan.report.register_failed", { detail: outcome.detail, retryInSeconds: delay });
  return "unregistered";
}

function registerBackoffSeconds(attemptCount: number): number {
  return Math.min(
    REGISTER_BACKOFF_BASE_SECONDS * 2 ** Math.min(attemptCount, 20),
    REGISTER_BACKOFF_MAX_SECONDS,
  );
}

// ── drain ───────────────────────────────────────────────────────────────────

async function drainOutbox(
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
    await reportingRepo.markStopped(outcome.reason);
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

// ── production wiring ───────────────────────────────────────────────────────

/** Warn once per process about a refused non-HTTPS URL — the lane ticks every 30 s. */
let warnedInsecureUrl = false;

/**
 * Resolve the configured base URL. HTTPS-only, except localhost for local
 * development against the compose stack — the contract is HTTPS-only and a
 * plaintext ingest URL would leak the token to the network path.
 */
export function resolveAgentscanBaseUrl(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol === "https:") return trimmed;
  const isLocalhost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol === "http:" && isLocalhost) return trimmed;
  if (!warnedInsecureUrl) {
    warnedInsecureUrl = true;
    logger.warn("agentscan.report.insecure_url_refused");
  }
  return null;
}

export function buildProductionAgentscanReporterDeps(): AgentscanReporterDeps {
  return {
    baseUrl: () => resolveAgentscanBaseUrl(loadConfig().services.agentscanApiUrl),
    buildClient: buildAgentscanClient,
    appVersion: () => {
      const version = process.env.VEX_APP_VERSION;
      return typeof version === "string" && version.trim().length > 0 ? version.trim() : null;
    },
  };
}
