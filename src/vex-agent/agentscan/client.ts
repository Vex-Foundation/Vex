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

export interface AgentscanClient {
  sendEvents(input: SendEventsInput): Promise<SendOutcome>;
}

export function buildAgentscanClient(baseUrl: string): AgentscanClient {
  return {
    sendEvents: (input) => sendEvents(baseUrl, input),
  };
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
    // TOLERANT READER: only the known result fields are consumed; anything
    // extra the server sends is ignored rather than allowed to fail the parse.
    const record = isRecord(body) ? body : {};
    const rejected = Array.isArray(record.rejected) ? record.rejected : [];
    return {
      kind: "ok",
      accepted: toCount(record.accepted),
      duplicates: toCount(record.duplicates),
      rejectedIndexes: rejected
        .map((item) => (isRecord(item) ? Number(item.index) : Number.NaN))
        .filter((index) => Number.isInteger(index) && index >= 0),
      agentHealth: readAgentHealth(record.agent),
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

function toCount(value: unknown): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : 0;
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
