/**
 * THE LIGHTER CAPABILITY GATE - may a Lighter row go on the wire at all?
 *
 * ## Why the existing capability record cannot answer this
 *
 * `../../agentscan/server-capability.ts` learns what the deployment accepts
 * from ingest REFUSALS: it sends one row of a provisional role, reads the
 * per-item verdict, and withholds the role for six hours when the answer is a
 * refusal. That mechanism is right for a role the server has probably carried
 * for months, and it is exactly wrong here. The Lighter contract's first
 * clause is that NOTHING is sent before the server advertises `lighter_v1`
 * (H0 revision 2, R2.1), so the probing send is the one thing that must not
 * happen. A capability that can only be measured by sending cannot gate
 * sending.
 *
 * So this gate learns from what the server SAYS rather than from what it
 * refuses: the capability list on the handshake response, and the capabilities
 * endpoint that carries the same list. Both are lane I's additions to the
 * server; until they exist, every answer is "not advertised" and every Lighter
 * row stays OWED. That is the designed steady state before the server deploys,
 * not a failure mode.
 *
 * ## Held, never rejected
 *
 * A row this gate holds is left `sent_at IS NULL AND rejected_at IS NULL` with
 * its reason in `last_error`, and its `next_attempt_at` pushed by one recheck
 * window. It is skipped BY CAPABILITY, never by position: the claim orders by
 * id and the held rows simply take their hold and let the batch continue, so
 * older activity queued behind a Lighter row is never starved. When the
 * capability later disappears (a rollback, or two deployments behind one load
 * balancer) the rows return to owed. Nothing is ever marked rejected because of
 * a capability mismatch - a rejection is terminal, and a deployment state is
 * not a verdict about a payload.
 *
 * The posture is `agents-colab/metamask-core/packages/transaction-controller/
 * src/helpers/PendingTransactionTracker.ts`, the same one the existing
 * capability record adopted: a LOOKUP FAILURE IS NEVER A VERDICT. What differs
 * is where the lookup lives - there it is the receipt, here it is the server's
 * own statement about itself.
 *
 * ## Freshness
 *
 * A POSITIVE observation expires: a deployment can be rolled back, and a
 * yes from yesterday is not a yes now. An expired positive is `unknown`, which
 * holds rows exactly as `absent` does, so expiry can only ever be conservative.
 * A NEGATIVE observation does not expire, because it is refreshed on its own
 * cadence anyway and holding is what it already causes.
 *
 * An observation made under a DIFFERENT registration generation is not
 * evidence about this one: a re-registration can move the install to a
 * different agent, and the row it would license is a row for a different
 * identity.
 */

import { createHash } from "node:crypto";

import * as reportingRepo from "@vex-agent/db/repos/agentscan-reporting.js";
import logger from "@utils/logger.js";

/**
 * The capability string the deployed AgentScan server must advertise before a
 * Lighter row may go on the wire.
 *
 * It lives HERE, with the gate that measures it, rather than beside the
 * vocabulary constants in the reporting repo: the local vocabulary version and
 * the server capability answer different questions (what this database can
 * store, versus what that deployment accepts), and keeping the second one out
 * of the repo is what stops them being read as one fact.
 */
export const LIGHTER_SERVER_CAPABILITY = "lighter_v1";

/**
 * How often the gate asks the server again. Ten minutes is the cadence H0
 * fixes: short enough that a deployment is noticed within one coffee break,
 * long enough that a dark lane costs six requests an hour.
 */
export const LIGHTER_CAPABILITY_REFRESH_MS = 10 * 60 * 1000;

/** How long a POSITIVE observation stands before it must be re-established. */
export const LIGHTER_CAPABILITY_POSITIVE_TTL_MS = 6 * 60 * 60 * 1000;

/** How long a held row waits before the lane looks at it again. */
export const LIGHTER_CAPABILITY_HOLD_SECONDS = LIGHTER_CAPABILITY_REFRESH_MS / 1000;

/**
 * The reason written to `agentscan_outbox.last_error` for a held Lighter row.
 * Code words only, and it names both what is owed and what would clear it -
 * the same contract `role_not_deployed` keeps.
 */
export const LIGHTER_CAPABILITY_HOLD_REASON = `capability_not_advertised ${LIGHTER_SERVER_CAPABILITY}`;

/**
 * What the server answered when asked for its capabilities.
 *
 * `list` is the advertised set (possibly empty - an answering server that
 * advertises nothing is a real, negative answer). `absent` is an old server:
 * a 404 on the endpoint, or a handshake response with no capability field at
 * all, both of which say "this deployment has no capabilities to declare".
 * `unreachable` is a failed lookup, which says nothing and must not be
 * recorded as either answer; it names WHY so an operator can tell a token the
 * server rejected from a host that never answered.
 */
export type ServerCapabilityAnswer =
  | { readonly kind: "list"; readonly capabilities: readonly string[] }
  | { readonly kind: "absent" }
  | { readonly kind: "unreachable"; readonly reason: ServerCapabilityUnreachableReason };

/**
 * `no_ingest_token`: this install has not handshaken, so nothing was asked.
 * `transport`: the request never produced a response. `refused`: the server
 * answered with a status that is not a capability statement (401, 403, 410,
 * 5xx).
 */
export type ServerCapabilityUnreachableReason = "no_ingest_token" | "transport" | "refused";

/**
 * Where the capability list comes from. Injected rather than imported so this
 * module owns the POLICY (when to ask, how long an answer stands, what a
 * missing answer means) while the transport stays with the AgentScan client.
 */
export interface LighterCapabilitySource {
  /** The configured AgentScan base URL. Only its fingerprint is ever stored. */
  readonly baseUrl: string;
  fetchCapabilities(): Promise<ServerCapabilityAnswer>;
}

let source: LighterCapabilitySource | null = null;
let lastRefreshAtMs: number | null = null;

/**
 * Wire the lane's capability source. Called once by the reporting lane with
 * the configured base URL; `null` clears it (the lane is dark, or a test is
 * cleaning up).
 */
export function configureLighterCapabilitySource(next: LighterCapabilitySource | null): void {
  source = next;
  lastRefreshAtMs = null;
}

/** sha256 of the base URL. The URL itself is never stored - the fingerprint is all the gate needs to notice the server changed. */
export function agentscanServerFingerprint(baseUrl: string): string {
  return createHash("sha256").update(baseUrl).digest("hex");
}

/**
 * The gate's three answers.
 *
 * `unknown` and `absent` both HOLD. They are kept apart because they mean
 * different things to an operator reading the log: nobody has asked yet, versus
 * the server answered and does not carry it.
 */
export type LighterCapabilityState = "present" | "absent" | "unknown";

/** The gate's reading, and what it was read from. */
export interface LighterCapabilityReading {
  readonly state: LighterCapabilityState;
  /** When the stored observation was made, `null` when there is none. */
  readonly observedAt: string | null;
}

/**
 * Read the durable observation for the configured server, at this registration
 * generation and this instant.
 *
 * Four ways to be anything other than `present`, and each is a deliberate
 * conservative reading rather than an error: no source configured (the lane is
 * dark), no observation stored (never asked), an observation from another
 * registration (about another identity), or a positive observation that has
 * expired (a yes old enough to have been rolled back).
 */
export async function readLighterCapability(
  registrationGeneration: number,
  nowMs: number,
): Promise<LighterCapabilityReading> {
  if (source === null) return { state: "unknown", observedAt: null };
  const record = await reportingRepo.getServerCapabilityObservation(
    agentscanServerFingerprint(source.baseUrl),
    LIGHTER_SERVER_CAPABILITY,
  );
  if (record === null) return { state: "unknown", observedAt: null };
  if (record.registrationGeneration !== registrationGeneration) {
    return { state: "unknown", observedAt: record.observedAt };
  }
  if (!record.present) return { state: "absent", observedAt: record.observedAt };
  const age = nowMs - new Date(record.observedAt).getTime();
  if (!Number.isFinite(age) || age > LIGHTER_CAPABILITY_POSITIVE_TTL_MS) {
    return { state: "unknown", observedAt: record.observedAt };
  }
  return { state: "present", observedAt: record.observedAt };
}

/**
 * Ask the server again if the cadence allows it, and record what it said.
 *
 * Returns whether a request was actually made, so the caller's log can tell a
 * skipped cadence from a real refresh. A transport failure records NOTHING: an
 * unreachable server has not told us its capabilities changed, and writing
 * `absent` on a timeout would turn every network blip into a capability
 * rollback.
 */
export async function refreshLighterCapabilityIfDue(
  registrationGeneration: number,
  nowMs: number,
): Promise<boolean> {
  if (source === null) return false;
  if (lastRefreshAtMs !== null && nowMs - lastRefreshAtMs < LIGHTER_CAPABILITY_REFRESH_MS) return false;
  lastRefreshAtMs = nowMs;
  const answer = await source.fetchCapabilities();
  if (answer.kind === "unreachable") {
    logger.info("agentscan.report.lighter_capability_unreachable", { reason: answer.reason });
    return true;
  }
  const present = answer.kind === "list" && answer.capabilities.includes(LIGHTER_SERVER_CAPABILITY);
  await reportingRepo.recordServerCapabilityObservation({
    serverFingerprint: agentscanServerFingerprint(source.baseUrl),
    capability: LIGHTER_SERVER_CAPABILITY,
    present,
    registrationGeneration,
  });
  logger.info("agentscan.report.lighter_capability_observed", { present });
  return true;
}

/**
 * The server refused a Lighter row it had advertised.
 *
 * A refusal is the one signal that can contradict a positive observation
 * without a fresh capability read, and the contract's rule for a deployment
 * disagreement is to HOLD while the capability is resolved, never to reject.
 * So the observation goes negative immediately and the next cadence window
 * re-establishes the truth.
 */
export async function noteLighterCapabilityRefused(registrationGeneration: number): Promise<void> {
  if (source === null) return;
  await reportingRepo.recordServerCapabilityObservation({
    serverFingerprint: agentscanServerFingerprint(source.baseUrl),
    capability: LIGHTER_SERVER_CAPABILITY,
    present: false,
    registrationGeneration,
  });
  logger.warn("agentscan.report.lighter_capability_refused_after_advertised");
}

/** Test seam: forget the configured source and the cadence stamp. */
export function resetLighterCapabilityGate(): void {
  source = null;
  lastRefreshAtMs = null;
}
