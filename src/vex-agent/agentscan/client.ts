/**
 * AgentScan ingest HTTP client — events, contract v1.
 *
 * Registration (v1 `/v1/agents/register`) is dead client-side: the
 * wallet-binding handshake (`agentscan/session-client.js`, v2
 * `session/start` + `session/complete`) replaces it. This module keeps only
 * `sendEvents` — the OUTBOX drain endpoint, untouched by the handshake work
 * and still v1 on the wire.
 *
 * NOTHING THROWS. Reporting is telemetry: every expected failure — a refusal,
 * a rate limit, an unreachable host — comes back as a named outcome for the
 * reporter lane to act on, exactly like the attribution clients. A
 * throw escaping this module would be contained by the lane anyway, but the
 * outcome unions ARE the retry policy, so they carry everything the lane
 * needs: the contract says only 429/5xx/network are retryable, 401 and
 * 403-`not_registered` are recoverable auth loss (re-handshake the same
 * identity), 410 / 403-`quarantined` are permanent stops, and any other 4xx
 * is a client bug that must never be hot-retried.
 *
 * TOKEN HYGIENE. The ingest token travels ONLY in the `Authorization: Bearer`
 * header — never in a URL, never in a detail string (details are sanitized
 * and length-capped before they can reach a log).
 */

import { fetchWithTimeout, readJson } from "@utils/http.js";
import { readRetryAfterSeconds } from "@utils/http/retry-after.js";
import type { AgentscanEvent } from "./mapper.js";
import type { ServerCapabilityAnswer } from "../sync/agentscan-report/lighter-capability.js";
import logger from "@utils/logger.js";

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_DETAIL_LEN = 120;
/**
 * Wire version. The server accepts 1|2|3 and does not branch on it — it only
 * records the value. 2 declares, at the server side's request (2026-08-12),
 * that this build sends `confirmedAt` as the settling block time (or null),
 * never the local observation time: that lets the server later relax its
 * time-tolerance rule for version-1 clients only, without weakening the
 * trust model for current ones.
 */
const SCHEMA_VERSION = 2;

/**
 * Additive `agent` field of the ingest response (server 2026-08-12): the
 * install's strike count and standing, so the client can warn BEFORE a
 * quarantine turns into a hard 403. Tolerant reader — absent on older
 * servers, and any unreadable shape reads as "not reported".
 */
export interface AgentHealth {
  readonly strikeCount: number;
  readonly status: string;
}

export type SendOutcome =
  | {
      readonly kind: "ok";
      readonly accepted: number;
      readonly duplicates: number;
      readonly rejectedIndexes: number[];
      readonly agentHealth: AgentHealth | null;
    }
  /**
   * A 200 whose body does not ACCOUNT FOR the batch: an unreadable body, a
   * missing or non-integer count, a rejection naming an index outside the
   * batch or naming one twice, or counts that do not add up to what was sent.
   * It is not a delivery and it is not a refusal - it is the absence of an
   * answer, and the lane must mark nothing and ask again. See the note on
   * {@link readBatchAcknowledgement} for why this is a named outcome rather
   * than a tolerant zero.
   */
  | { readonly kind: "unknown_acknowledgement"; readonly detail: string }
  | { readonly kind: "auth_lost" }
  | { readonly kind: "stopped"; readonly reason: "consent_revoked" | "quarantined" }
  | { readonly kind: "invalid"; readonly detail: string }
  | {
      readonly kind: "retryable";
      readonly status: number | null;
      readonly retryAfterSeconds: number | null;
      readonly detail: string;
    };

export interface SendEventsInput {
  readonly agentHash: string;
  readonly ingestToken: string;
  readonly backfill: boolean;
  readonly events: AgentscanEvent[];
}

/**
 * One position observation exactly as `POST /v1/lighter/positions` accepts it.
 *
 * A NAMED shape, never a passthrough of anything the sweep stored: the
 * observation is account-wide and the payload allowlist is what keeps
 * counterparty and credential material out of it by construction.
 */
export interface LighterPositionObservationPayload {
  readonly environment: "core" | "rhc";
  /** Decimal digits: the account index is a venue identity, not a number to round. */
  readonly accountIndex: string;
  readonly observationId: string;
  readonly observedAt: string;
  readonly source: "account_endpoint";
  readonly coverage: {
    readonly markets: "all" | readonly number[];
    readonly complete: boolean;
  };
  readonly positions: ReadonlyArray<{
    readonly marketIndex: number;
    readonly marketSymbol: string;
    readonly sizeDecimals: number;
    readonly size: string;
    readonly entryPrice: string | null;
    readonly unrealizedPnl: string | null;
    readonly realizedPnl: string | null;
    readonly liquidationPrice: string | null;
  }>;
}

export interface SendPositionObservationsInput {
  readonly agentHash: string;
  readonly ingestToken: string;
  readonly observations: readonly LighterPositionObservationPayload[];
}

/**
 * What the positions endpoint said, in the SAME outcome vocabulary ingest uses.
 *
 * `ok` splits three ways because the three mean different things to the lane:
 * `accepted` landed, `ignoredStale` arrived after a newer reading and is
 * settled (never an error the client can fix), and a rejected index is a
 * payload this install cannot express. There is no `receivedAt` on the wire:
 * the server assigns one and does not return it, so nothing here can claim to
 * know it.
 */
export type SendPositionsOutcome =
  | {
      readonly kind: "ok";
      readonly accepted: number;
      readonly ignoredStale: number;
      readonly rejectedIndexes: number[];
    }
  /** See {@link SendOutcome}: a 200 that does not account for the batch settles nothing. */
  | { readonly kind: "unknown_acknowledgement"; readonly detail: string }
  | { readonly kind: "auth_lost" }
  | { readonly kind: "stopped"; readonly reason: "consent_revoked" | "quarantined" }
  | { readonly kind: "invalid"; readonly detail: string }
  | {
      readonly kind: "retryable";
      readonly status: number | null;
      readonly retryAfterSeconds: number | null;
      readonly detail: string;
    };

export interface AgentscanClient {
  sendEvents(input: SendEventsInput): Promise<SendOutcome>;
  /**
   * What this deployment advertises, read from `GET /capabilities`.
   *
   * The three answers are not interchangeable. A 200 is the LIST, whatever it
   * contains. A 404 is `absent`: the route does not exist, which is exactly
   * what an old server should say and a real, negative answer. Everything else
   * - transport failure, 401, 403, 410, 5xx - is `unreachable`, because none of
   * them is the server telling us what it carries: a 401 says this install's
   * token is not accepted, not that the deployment lacks the capability, and
   * recording it as `absent` would turn an auth problem into a capability
   * rollback. The reason is logged so an operator can tell them apart.
   */
  fetchCapabilities(input: FetchCapabilitiesInput): Promise<ServerCapabilityAnswer>;
  postLighterPositionObservations(
    input: SendPositionObservationsInput,
  ): Promise<SendPositionsOutcome>;
}

export interface FetchCapabilitiesInput {
  /** The stored ingest token, or null when this install has none yet. */
  readonly ingestToken: string | null;
}

export function buildAgentscanClient(baseUrl: string): AgentscanClient {
  return {
    sendEvents: (input) => sendEvents(baseUrl, input),
    fetchCapabilities: (input) => fetchCapabilities(baseUrl, input),
    postLighterPositionObservations: (input) => postLighterPositionObservations(baseUrl, input),
  };
}

/** Wire version of the positions batch. The server accepts exactly 1 today. */
const POSITIONS_SCHEMA_VERSION = 1;

async function fetchCapabilities(
  baseUrl: string,
  input: FetchCapabilitiesInput,
): Promise<ServerCapabilityAnswer> {
  // NO TOKEN IS NOT AN ANSWER EITHER. The endpoint authenticates like ingest,
  // so an install that has not handshaken yet would earn a 401 - asking would
  // teach us nothing and spend a request saying so.
  if (input.ingestToken === null) {
    logger.info("agentscan.capabilities.unreachable", { reason: "no_ingest_token" });
    return { kind: "unreachable", reason: "no_ingest_token" };
  }
  let response: Response;
  try {
    response = await fetchWithTimeout(joinUrl(baseUrl, "capabilities"), {
      method: "GET",
      timeoutMs: REQUEST_TIMEOUT_MS,
      headers: { Authorization: `Bearer ${input.ingestToken}` },
    });
  } catch (err) {
    logger.info("agentscan.capabilities.unreachable", { reason: "transport", detail: safeDetail(err) });
    return { kind: "unreachable", reason: "transport" };
  }

  const body = await readJson(response).catch(() => null);
  if (response.ok) {
    const record = isRecord(body) ? body : {};
    const capabilities = Array.isArray(record.capabilities)
      ? record.capabilities.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
      : [];
    return { kind: "list", capabilities };
  }
  // AN OLD SERVER, and the only status that is a real negative answer: the
  // route does not exist, so this deployment has no capabilities to declare.
  if (response.status === 404) return { kind: "absent" };
  logger.info("agentscan.capabilities.unreachable", {
    reason: "refused",
    detail: describeError(response.status, body),
  });
  return { kind: "unreachable", reason: "refused" };
}

async function postLighterPositionObservations(
  baseUrl: string,
  input: SendPositionObservationsInput,
): Promise<SendPositionsOutcome> {
  let response: Response;
  try {
    response = await fetchWithTimeout(joinUrl(baseUrl, "v1/lighter/positions"), {
      method: "POST",
      timeoutMs: REQUEST_TIMEOUT_MS,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${input.ingestToken}`,
      },
      body: JSON.stringify({
        schemaVersion: POSITIONS_SCHEMA_VERSION,
        agentHash: input.agentHash,
        observations: input.observations,
      }),
    });
  } catch (err) {
    return { kind: "retryable", status: null, retryAfterSeconds: null, detail: safeDetail(err) };
  }

  const body = await readJson(response).catch(() => null);

  if (response.ok) {
    const reading = readBatchAcknowledgement(body, "ignoredStale", input.observations.length);
    if (!reading.ok) {
      logger.warn("agentscan.positions.unknown_acknowledgement", { detail: reading.detail });
      return { kind: "unknown_acknowledgement", detail: reading.detail };
    }
    return {
      kind: "ok",
      accepted: reading.accepted,
      ignoredStale: reading.settled,
      rejectedIndexes: reading.rejectedIndexes,
    };
  }

  const code = errorCode(body);
  if (response.status === 401) return { kind: "auth_lost" };
  if (response.status === 403) {
    return code === "quarantined" ? { kind: "stopped", reason: "quarantined" } : { kind: "auth_lost" };
  }
  if (response.status === 410) return { kind: "stopped", reason: "consent_revoked" };
  if (response.status === 429 || response.status >= 500) return retryableFrom(response, body);
  return { kind: "invalid", detail: describeError(response.status, body) };
}

async function sendEvents(baseUrl: string, input: SendEventsInput): Promise<SendOutcome> {
  let response: Response;
  try {
    response = await fetchWithTimeout(joinUrl(baseUrl, "v1/events"), {
      method: "POST",
      timeoutMs: REQUEST_TIMEOUT_MS,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${input.ingestToken}`,
      },
      body: JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        agentHash: input.agentHash,
        backfill: input.backfill,
        events: input.events,
      }),
    });
  } catch (err) {
    return { kind: "retryable", status: null, retryAfterSeconds: null, detail: safeDetail(err) };
  }

  const body = await readJson(response).catch(() => null);

  if (response.ok) {
    // TOLERANT ABOUT WHAT IT DOES NOT KNOW, STRICT ABOUT THE VERDICT. Extra
    // fields the server sends are still ignored rather than allowed to fail
    // the parse; the disposition of every event in the batch is not extra.
    const reading = readBatchAcknowledgement(body, "duplicates", input.events.length);
    if (!reading.ok) {
      logger.warn("agentscan.events.unknown_acknowledgement", { detail: reading.detail });
      return { kind: "unknown_acknowledgement", detail: reading.detail };
    }
    return {
      kind: "ok",
      accepted: reading.accepted,
      duplicates: reading.settled,
      rejectedIndexes: reading.rejectedIndexes,
      agentHealth: readAgentHealth(isRecord(body) ? body.agent : null),
    };
  }

  const code = errorCode(body);
  if (response.status === 401) return { kind: "auth_lost" };
  if (response.status === 403) {
    return code === "quarantined" ? { kind: "stopped", reason: "quarantined" } : { kind: "auth_lost" };
  }
  if (response.status === 410) return { kind: "stopped", reason: "consent_revoked" };
  if (response.status === 429 || response.status >= 500) {
    return retryableFrom(response, body);
  }
  // Any other 4xx (400 envelope, 413 oversize) is a client bug — never hot-retried.
  return { kind: "invalid", detail: describeError(response.status, body) };
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** Path-preserving join: a base of `https://host/sub` keeps its subpath. */
function joinUrl(baseUrl: string, path: string): string {
  return new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

function retryableFrom(
  response: Response,
  body: unknown,
): { kind: "retryable"; status: number; retryAfterSeconds: number | null; detail: string } {
  return {
    kind: "retryable",
    status: response.status,
    retryAfterSeconds: readRetryAfterSeconds(response.headers, response.status) ?? null,
    detail: describeError(response.status, body),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * What a batch acknowledgement was read as, or why it could not be read.
 *
 * `settled` is whichever terminal-but-not-accepted count this endpoint uses:
 * `duplicates` on ingest, `ignoredStale` on positions. Both mean the same
 * thing to the caller - the item is finished and will never be finished
 * differently by sending it again.
 */
type BatchAcknowledgementReading =
  | {
      readonly ok: true;
      readonly accepted: number;
      readonly settled: number;
      readonly rejectedIndexes: number[];
    }
  | { readonly ok: false; readonly detail: string };

/**
 * READ THE SERVER'S VERDICT, OR DECLARE THAT THERE IS NONE.
 *
 * A 200 whose body is `{}` used to read as "accepted 0, duplicates 0, nothing
 * rejected", and the drain settles everything a batch did not reject: an empty
 * body therefore RETIRED an undelivered batch. A malformed answer is not a
 * verdict - the same posture MetaMask's `PendingTransactionTracker` takes when
 * a receipt lookup comes back without a status: it leaves the transaction
 * pending rather than deciding for the chain.
 *
 * So every disposition is required to be exact and to add up. Both routes
 * place each item in exactly one bucket (`accepted`, the settled count, or one
 * `rejected` entry), so `accepted + settled + rejected === sent` is the
 * server's own invariant and anything else means the body did not come from a
 * server that processed this batch.
 *
 * `expected` is the number of items THIS request sent, which is why an index
 * outside it is refused rather than clamped: it names an item this batch does
 * not contain.
 */
function readBatchAcknowledgement(
  body: unknown,
  settledField: "duplicates" | "ignoredStale",
  expected: number,
): BatchAcknowledgementReading {
  if (!isRecord(body)) return { ok: false, detail: "the acknowledgement body is not an object" };
  const accepted = exactCount(body.accepted);
  const settled = exactCount(body[settledField]);
  if (accepted === null) return { ok: false, detail: "the acknowledgement carries no exact accepted count" };
  if (settled === null) return { ok: false, detail: `the acknowledgement carries no exact ${settledField} count` };
  if (!Array.isArray(body.rejected)) return { ok: false, detail: "the acknowledgement carries no rejected list" };
  const rejectedIndexes = new Set<number>();
  for (const entry of body.rejected) {
    if (!isRecord(entry)) return { ok: false, detail: "a rejection entry is not an object" };
    const index = entry.index;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= expected) {
      return { ok: false, detail: "a rejection names an index outside the batch" };
    }
    if (typeof entry.code !== "string" || entry.code.trim().length === 0) {
      return { ok: false, detail: "a rejection carries no reason code" };
    }
    if (rejectedIndexes.has(index)) return { ok: false, detail: "a rejection names the same index twice" };
    rejectedIndexes.add(index);
  }
  const accounted = accepted + settled + rejectedIndexes.size;
  if (accounted !== expected) {
    return { ok: false, detail: `the acknowledgement accounts for ${accounted} of ${expected} items` };
  }
  return { ok: true, accepted, settled, rejectedIndexes: [...rejectedIndexes] };
}

/**
 * A count the server actually stated. NO COERCION, for the reason
 * `readAgentHealth` gives: `Number(null)` is 0 and `Number(true)` is 1, so
 * coercing would read a missing field as a real zero - which is precisely the
 * defect this parser exists to close.
 */
function exactCount(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * The additive `agent` response field, or null when absent or unreadable.
 * No coercion: `strikeCount` must BE a number (Number(null) is 0 and
 * Number(true) is 1, so coercing would read garbage as a valid count).
 */
function readAgentHealth(value: unknown): AgentHealth | null {
  if (!isRecord(value)) return null;
  const strikeCount = value.strikeCount;
  if (typeof strikeCount !== "number" || !Number.isInteger(strikeCount) || strikeCount < 0) return null;
  if (typeof value.status !== "string" || value.status.trim().length === 0) return null;
  return { strikeCount, status: value.status };
}

function errorCode(body: unknown): string | null {
  if (!isRecord(body) || !isRecord(body.error)) return null;
  return typeof body.error.code === "string" ? body.error.code : null;
}

/** Status + the server's error CODE only — codes are a closed vocabulary, messages are not logged verbatim. */
function describeError(status: number, body: unknown): string {
  const code = errorCode(body);
  return sanitize(code === null ? `HTTP ${status}` : `HTTP ${status} ${code}`);
}

function safeDetail(err: unknown): string {
  return sanitize(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
}

/**
 * Bound and scrub an untrusted string before it can reach a log line: URLs,
 * long hex and base64url runs (token-shaped) are removed, whitespace is
 * collapsed, and the result is length-capped.
 */
function sanitize(text: string): string {
  const scrubbed = text
    .replace(/\bhttps?:\/\/\S+/gi, "<url>")
    .replace(/\b0x[0-9a-fA-F]{16,}\b/g, "<hex>")
    .replace(/[A-Za-z0-9_-]{40,}/g, "<blob>")
    .replace(/\s+/g, " ")
    .trim();
  if (scrubbed.length === 0) return "no detail";
  return scrubbed.length > MAX_DETAIL_LEN ? `${scrubbed.slice(0, MAX_DETAIL_LEN)}…` : scrubbed;
}
