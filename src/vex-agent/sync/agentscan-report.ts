/**
 * AgentScan REPORTING lane — register once, backfill once, then drain the
 * outbox every tick.
 *
 * This file is the lane's public facade and state machine; the implementation
 * lives in `agentscan-report/` (handshake-lane, drain, production-deps), one
 * responsibility per file, per the 550-line facade decree.
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
 * verdicts are honored exactly: 410 consent_revoked and identity conflicts
 * stop the lane permanently; 403-quarantined is a long outbox pause (the
 * server can be wrong, and an install that has stopped calling cannot be
 * told); a 401 on the EVENTS endpoint re-handshakes the SAME identity
 * AND resends the full eligible history (a server-side reset means the
 * server has nothing, so every already-sent row comes back owed, flagged
 * `backfill`); only 429/5xx/network are retried. A 401 from
 * session/complete is a DIFFERENT recovery — see "Binding" below.
 *
 * ── Binding: a signed handshake, not a v1 register call ────────────────────
 *
 * `handshakeOnce` (in `agentscan-report/handshake-lane.ts`) replaces v1's
 * `/v1/agents/register` with the v2 wallet-binding handshake
 * (`session/start` → sign → `session/complete`, see
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
 * transfers the binding instead of refusing). A THROW out of `signChallenge`
 * itself (a typed signer error — mismatch, corrupt keystore, a rejected
 * template — as opposed to one of its named `HandshakeSigningResult`
 * outcomes) is caught around the call and held the same long
 * `HANDSHAKE_INVALID_HOLD_SECONDS` as an invalid session/complete response,
 * so a signer bug can never bypass the backoff into a hot loop of fresh
 * session/starts.
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

import { randomBytes } from "node:crypto";

import * as reportingRepo from "@vex-agent/db/repos/agentscan-reporting.js";
import type { AgentscanStopReason } from "@vex-agent/db/repos/agentscan-reporting.js";
import type { AgentscanClient } from "../agentscan/client.js";
import type { AgentscanSessionClient } from "../agentscan/session-client.js";
import type {
  SignAgentscanChallengeInput,
  HandshakeSigningResult,
} from "../agentscan/handshake.js";
import logger from "@utils/logger.js";
import { handshakeOnce, computeWalletsFingerprint } from "./agentscan-report/handshake-lane.js";
import { drainIncremental, drainOutbox } from "./agentscan-report/drain.js";

export { AGENTSCAN_BATCH_LIMIT, AGENTSCAN_MAX_BATCHES_PER_TICK } from "./agentscan-report/drain.js";
export {
  resolveAgentscanBaseUrl,
  buildProductionAgentscanReporterDeps,
} from "./agentscan-report/production-deps.js";

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

/**
 * `quarantined` is a leftover latch from older binaries (and must not skip
 * the lane — the server may already have lifted it). User-revoked consent
 * and identity conflicts stay terminal.
 */
function isTerminalStopReason(reason: AgentscanStopReason | null): boolean {
  return reason !== null && reason !== "quarantined";
}

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
  if (isTerminalStopReason(state.stoppedReason)) return { skipped: "stopped", ...NOTHING };

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
 * 410; 403-quarantined is a long outbox pause, not a latch), so a push-lane
 * fire CAN reset or stop the lane's state.
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
  if (isTerminalStopReason(state.stoppedReason)) return { skipped: "unregistered", ...NOTHING };
  if (state.agentHash === null || state.ingestToken === null) {
    return { skipped: "unregistered", ...NOTHING };
  }
  if (state.registeredAt === null) return { skipped: "unregistered", ...NOTHING };
  if (state.backfillEnqueuedAt === null) return { skipped: "unregistered", ...NOTHING };

  const client = deps.buildClient(baseUrl);
  const incremental = await drainIncremental(client, state.agentHash, state.ingestToken);
  return { skipped: null, backfillEnqueued: false, ...incremental };
}
