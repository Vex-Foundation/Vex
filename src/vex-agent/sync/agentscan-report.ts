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
 * verdicts are honored exactly: 410 / 403-quarantined stop the lane
 * permanently; a 401 on the EVENTS endpoint re-handshakes the SAME identity
 * AND resends the full eligible history (a server-side reset means the
 * server has nothing, so every already-sent row comes back owed, flagged
 * `backfill`); only 429/5xx/network are retried. A 401 from
 * session/complete is a DIFFERENT recovery — see "Binding" below.
 *
 * ── Binding: a signed handshake, not a v1 register call ────────────────────
 *
 * `handshakeOnce` below replaces v1's `/v1/agents/register` with the v2
 * wallet-binding handshake (`session/start` → sign → `session/complete`, see
 * `agentscan/session-client.ts`): the trading key proves ownership of the
 * install's wallet addresses by signing a server-issued challenge, never a
 * blind message — the server's returned `domain` is checked against the
 * configured `agentscanApiUrl`'s hostname, case-insensitively (the server's
 * JSON is untrusted casing), before anything is ever signed. A handshake
 * fires when never yet handshaken, when the bound wallet set changed (a
 * sha256 fingerprint over the sorted inventory), or after `registered_at`
 * clears via either recovery path below. `wallet_conflict` (a
 * session/complete 409) is kept as a DEFENSIVE permanent stop —
 * transfer-on-proof means the current server no longer emits it in ordinary
 * operation (a valid proof for a wallet bound to a different agent now
 * transfers the binding instead of refusing).
 *
 * session/complete's OWN 401 is NOT the events endpoint's recovery: it means
 * the server holds SOME current token for this `agent_hash` that this
 * install does not know — the canonical cause is a crash between the server
 * committing session/complete's token rotation and this install persisting
 * it via `markHandshakeComplete`. Retrying with the SAME identity would just
 * keep presenting the same now-stale bearer forever (an infinite 401 loop),
 * so `resetIdentityForRecovery` abandons the identity entirely (agent_hash,
 * ingest_token, name, fingerprint, every stamp, one transaction with a full
 * outbox resend). The next run's `ensureIdentity` mints a fresh identity, and
 * the server's transfer-on-proof re-binds the same proven wallets to it —
 * that IS the designed recovery, not a data-loss path.
 */

import { randomBytes, createHash } from "node:crypto";

import { loadConfig } from "../../config/store.js";
import * as reportingRepo from "@vex-agent/db/repos/agentscan-reporting.js";
import { mapActivityToEvent } from "../agentscan/mapper.js";
import {
  buildAgentscanClient,
  type AgentscanClient,
  type SendOutcome,
} from "../agentscan/client.js";
import {
  buildAgentscanSessionClient,
  type AgentscanSessionClient,
} from "../agentscan/session-client.js";
import {
  signAgentscanChallenge,
  type SignAgentscanChallengeInput,
  type HandshakeSigningResult,
} from "../agentscan/handshake.js";
import type { ClaimedOutboxEvent } from "@vex-agent/db/repos/agentscan-reporting.js";
import { listWallets } from "@tools/wallet/inventory.js";
import { getKeystorePassword } from "@utils/env.js";
import type { ChainFamily } from "@tools/khalani/types.js";
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

/** Handshake attempt backoff: 5 min · 2^n capped at 1 h — reuses the same counters the old register flow did. */
const REGISTER_BACKOFF_BASE_SECONDS = 300;
const REGISTER_BACKOFF_MAX_SECONDS = 3600;

/** An envelope-level 400 is a client bug, not weather — hold the rows a full hour and say so loudly. */
const INVALID_BATCH_HOLD_SECONDS = 3600;

/** session/complete's invalid_signature/validation_failed is a client bug — same long-hold discipline as INVALID_BATCH_HOLD_SECONDS. */
const HANDSHAKE_INVALID_HOLD_SECONDS = 3600;

export interface AgentscanReporterDeps {
  /** Resolved ingest base URL, or null when reporting is disabled/misconfigured. */
  readonly baseUrl: () => string | null;
  readonly buildClient: (baseUrl: string) => AgentscanClient;
  /** The v2 wallet-binding handshake's HTTP boundary (session/start + session/complete). */
  readonly buildSessionClient: (baseUrl: string) => AgentscanSessionClient;
  /** The vault-gated signer for a handshake challenge — production wires T10's `signAgentscanChallenge`. */
  readonly signChallenge: (input: SignAgentscanChallengeInput) => Promise<HandshakeSigningResult>;
  /** App version for the handshake record, when the host process knows it. */
  readonly appVersion: () => string | null;
}

export interface AgentscanReportResult {
  readonly skipped: "disabled" | "stopped" | "unregistered" | "vault_locked" | "no_wallets" | null;
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
  let ingestToken = state.ingestToken;
  if (agentHash === null || ingestToken === null) {
    // Unreachable after ensureIdentity; named so a future regression is loud.
    logger.error("agentscan.report.identity_missing_after_ensure");
    return { skipped: "unregistered", ...NOTHING };
  }

  const fingerprint = computeWalletsFingerprint();
  const handshakeNeeded = state.registeredAt === null || fingerprint !== state.boundWalletsFingerprint;
  if (handshakeNeeded) {
    const attempt = await handshakeOnce(deps, baseUrl, state, agentHash, ingestToken, fingerprint);
    if (attempt.kind !== "handshaken") return { skipped: attempt.reason, ...NOTHING };
    ingestToken = attempt.ingestToken;
  }

  const client = deps.buildClient(baseUrl);

  // The one-time backfill (AC2): first enqueue after a successful registration
  // carries the whole eligible history; every later scan is incremental.
  if (state.backfillEnqueuedAt === null) {
    const enqueued = await reportingRepo.enqueueEligibleActivity(true);
    await reportingRepo.markBackfillEnqueued();
    if (enqueued > 0) logger.info("agentscan.report.backfill_enqueued", { rows: enqueued });
    const drain = await drainOutbox(client, agentHash, ingestToken);
    return { skipped: null, enqueued, backfillEnqueued: true, ...drain };
  }

  const incremental = await drainIncremental(client, agentHash, ingestToken);
  return { skipped: null, backfillEnqueued: false, ...incremental };
}

/**
 * Drain-only entry for the seconds-level PUSH lane (`agentscan-push.ts`).
 * Precondition misses (base URL unset, identity missing, never registered,
 * server-stopped) all report `"unregistered"` — the push lane has nothing
 * useful to distinguish between them, and the periodic lane above is what
 * gets the state past any of them. No register, no backfill, no
 * register-backoff interaction: those stay the periodic lane's job. The
 * function itself never registers/backfills/writes state proactively, but the
 * drain it shares with the periodic lane honors server verdicts via
 * `sendGroup` (`resetForReRegistration()` on auth_lost, `markStopped()` on
 * 410/quarantine), so a push-lane fire CAN reset or stop the lane's state.
 * State is read fresh on every call, never cached across invocations.
 *
 * The `backfillEnqueuedAt === null` guard below is load-bearing: between the
 * periodic lane's `markHandshakeComplete()` commit and its later
 * `enqueueEligibleActivity(true)` + `markBackfillEnqueued()` commit — a
 * window that is wide on first GA registration with months of history, and
 * re-opens after every `resetForReRegistration` — a push-lane fire must not
 * run `enqueueEligibleActivity(false)`, or it permanently mislabels the whole
 * eligible history as live activity (backfill=false) and the periodic
 * backfill that follows inserts zero rows and stamps the flag anyway.
 */
export async function runAgentscanIncremental(
  deps: AgentscanReporterDeps,
): Promise<AgentscanReportResult> {
  const baseUrl = deps.baseUrl();
  if (baseUrl === null) return { skipped: "unregistered", ...NOTHING };

  const state = await reportingRepo.getReportingState();
  if (state.stoppedReason !== null) return { skipped: "unregistered", ...NOTHING };
  if (state.agentHash === null || state.ingestToken === null) {
    return { skipped: "unregistered", ...NOTHING };
  }
  if (state.registeredAt === null) return { skipped: "unregistered", ...NOTHING };
  if (state.backfillEnqueuedAt === null) return { skipped: "unregistered", ...NOTHING };

  const client = deps.buildClient(baseUrl);
  const incremental = await drainIncremental(client, state.agentHash, state.ingestToken);
  return { skipped: null, backfillEnqueued: false, ...incremental };
}

// ── handshake ───────────────────────────────────────────────────────────────

/** sha256 over the sorted `chainFamily:address` inventory list — changes whenever a wallet is added or removed. */
function computeWalletsFingerprint(): string {
  const evm = listWallets("evm").map((entry) => `eip155:${entry.address.toLowerCase()}`);
  const solana = listWallets("solana").map((entry) => `solana:${entry.address}`);
  const sorted = [...evm, ...solana].sort();
  return createHash("sha256").update(sorted.join("\n")).digest("hex");
}

/**
 * Localhost stacks answer with a literal `localhost` domain too, so one
 * hostname comparison covers both cases. Both sides are lowercased before
 * comparing: `URL#hostname` is already normalized, but `serverDomain` is raw
 * untrusted JSON text and must not be compared case-sensitively against it —
 * a legitimately-matching domain answered as e.g. `AgentScan.Example` must
 * not be refused as a mismatch.
 */
function domainMatches(baseUrl: string, serverDomain: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === serverDomain.toLowerCase();
  } catch {
    return false;
  }
}

type HandshakeAttemptOutcome =
  | { readonly kind: "handshaken"; readonly ingestToken: string }
  | { readonly kind: "skip"; readonly reason: "unregistered" | "vault_locked" | "no_wallets" | "stopped" };

/**
 * One handshake attempt: session/start → domain check → sign → session/complete
 * → `markHandshakeComplete`. The wallet-inventory / vault-lock gate runs FIRST,
 * directly (not via `deps.signChallenge`), so a locked vault or an empty
 * inventory costs ZERO session calls and never burns the attempt backoff —
 * `deps.signChallenge` (production: T10's `signAgentscanChallenge`) is reached
 * only once we actually have a real challenge to sign, and still re-checks
 * both as a safety net for a lock that lands mid-flight.
 */
async function handshakeOnce(
  deps: AgentscanReporterDeps,
  baseUrl: string,
  state: reportingRepo.AgentscanReportingState,
  agentHash: string,
  ingestToken: string,
  fingerprint: string,
): Promise<HandshakeAttemptOutcome> {
  if (new Date(state.nextRegisterAttemptAt).getTime() > Date.now()) {
    return { kind: "skip", reason: "unregistered" };
  }

  const evmEntries = listWallets("evm");
  const solanaEntries = listWallets("solana");
  if (evmEntries.length === 0 && solanaEntries.length === 0) {
    return { kind: "skip", reason: "no_wallets" };
  }
  if (getKeystorePassword() === null) {
    return { kind: "skip", reason: "vault_locked" };
  }

  const addresses: ReadonlyArray<{ chainFamily: ChainFamily; address: string }> = [
    ...evmEntries.map((entry) => ({ chainFamily: "eip155" as const, address: entry.address })),
    ...solanaEntries.map((entry) => ({ chainFamily: "solana" as const, address: entry.address })),
  ];

  const session = deps.buildSessionClient(baseUrl);
  const appVersion = deps.appVersion();

  const started = await session.sessionStart({ agentHash, addresses });
  if (started.kind !== "started") {
    const delay =
      started.kind === "retryable" && started.retryAfterSeconds !== null
        ? started.retryAfterSeconds
        : registerBackoffSeconds(state.registerAttemptCount);
    await reportingRepo.noteRegisterAttemptFailed(delay);
    logger.warn("agentscan.report.handshake_start_failed", { detail: started.detail, retryInSeconds: delay });
    return { kind: "skip", reason: "unregistered" };
  }

  if (!domainMatches(baseUrl, started.domain)) {
    // A hostile or misbehaving server answering with a domain that doesn't
    // match what we dialed — treated as a retryable transport anomaly.
    // NEVER signs.
    await reportingRepo.noteRegisterAttemptFailed(registerBackoffSeconds(state.registerAttemptCount));
    logger.warn("agentscan.report.handshake_domain_mismatch");
    return { kind: "skip", reason: "unregistered" };
  }

  const signed = await deps.signChallenge({ domain: started.domain, agentHash, nonce: started.nonce });
  if (signed.kind === "vault_locked") return { kind: "skip", reason: "vault_locked" };
  if (signed.kind === "no_wallets") return { kind: "skip", reason: "no_wallets" };

  const completed = await session.sessionComplete(
    {
      challengeId: started.challengeId,
      agentHash,
      consentVersion: state.consentVersion,
      ...(appVersion !== null ? { appVersion: appVersion.slice(0, 32) } : {}),
      proofs: signed.proofs,
    },
    ingestToken,
  );

  if (completed.kind === "bound") {
    await reportingRepo.markHandshakeComplete({
      agentName: completed.agentName,
      ingestToken: completed.ingestToken,
      serverCursorRowId: completed.lastAcceptedRowId,
      walletsFingerprint: fingerprint,
    });
    logger.info("agentscan.report.handshake_bound");
    return { kind: "handshaken", ingestToken: completed.ingestToken };
  }
  if (completed.kind === "challenge_expired") {
    // Not a failure worth punishing — just restart the flow next run.
    logger.warn("agentscan.report.handshake_challenge_expired");
    return { kind: "skip", reason: "unregistered" };
  }
  if (completed.kind === "auth_lost") {
    // Token mismatch on an EXISTING binding is NOT the events endpoint's
    // recovery: the server holds SOME current token for this agent_hash that
    // we don't know (canonically a crash between the server's rotation and
    // our own markHandshakeComplete persist), so retrying the SAME identity
    // would keep presenting the same stale bearer forever. Abandon the
    // identity; ensureIdentity mints a fresh one next run, and the server's
    // transfer-on-proof re-binds the same proven wallets to it.
    await reportingRepo.resetIdentityForRecovery();
    logger.warn("agentscan.report.handshake_auth_lost_identity_reset");
    return { kind: "skip", reason: "unregistered" };
  }
  if (completed.kind === "wallet_conflict") {
    // Defensive: the current server transfers a proven wallet instead of
    // refusing with 409 in ordinary operation, but the reserved code path
    // stays honored in case a future policy reintroduces the refusal.
    await reportingRepo.markStopped("wallet_conflict");
    logger.error("agentscan.report.handshake_wallet_conflict_stopped");
    return { kind: "skip", reason: "stopped" };
  }
  if (completed.kind === "invalid") {
    // Our own signed envelope failed the server's validation — a client bug,
    // not weather. Held long and logged loud, same discipline as an
    // envelope-level 400 on the events endpoint.
    await reportingRepo.noteRegisterAttemptFailed(HANDSHAKE_INVALID_HOLD_SECONDS);
    logger.error("agentscan.report.handshake_invalid", { detail: completed.detail });
    return { kind: "skip", reason: "unregistered" };
  }
  // retryable — 429/5xx/network.
  const delay = completed.retryAfterSeconds ?? registerBackoffSeconds(state.registerAttemptCount);
  await reportingRepo.noteRegisterAttemptFailed(delay);
  logger.warn("agentscan.report.handshake_complete_failed", { detail: completed.detail, retryInSeconds: delay });
  return { kind: "skip", reason: "unregistered" };
}

function registerBackoffSeconds(attemptCount: number): number {
  return Math.min(
    REGISTER_BACKOFF_BASE_SECONDS * 2 ** Math.min(attemptCount, 20),
    REGISTER_BACKOFF_MAX_SECONDS,
  );
}

// ── drain ───────────────────────────────────────────────────────────────────

/**
 * The incremental scan-then-drain step: shared verbatim by the periodic
 * lane's non-backfill tick and the push lane's `runAgentscanIncremental`, so
 * there is exactly one place that enqueues an incremental diff and drains it.
 */
async function drainIncremental(
  client: AgentscanClient,
  agentHash: string,
  ingestToken: string,
): Promise<Pick<AgentscanReportResult, "enqueued" | "sent" | "rejected" | "deferred">> {
  const enqueued = await reportingRepo.enqueueEligibleActivity(false);
  const drain = await drainOutbox(client, agentHash, ingestToken);
  return { enqueued, ...drain };
}

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
    buildSessionClient: buildAgentscanSessionClient,
    signChallenge: signAgentscanChallenge,
    appVersion: () => {
      const version = process.env.VEX_APP_VERSION;
      return typeof version === "string" && version.trim().length > 0 ? version.trim() : null;
    },
  };
}
