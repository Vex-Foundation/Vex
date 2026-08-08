/**
 * AgentScan wallet-binding SESSION client v2 — `session/start` +
 * `session/complete`, the handshake that replaces v1 `/v1/agents/register`
 * client-side (the server keeps v1 for old builds; this client always
 * speaks v2).
 *
 * NOTHING THROWS. Every expected outcome — a definitive refusal, a rate
 * limit, an unreachable host — comes back as a named member of
 * `SessionStartOutcome` / `SessionCompleteOutcome` for the handshake lane to
 * act on, exactly like `agentscan/client.ts`: only 429/5xx/network are
 * retryable, session/complete's 401 is recoverable auth loss (treat like the
 * events endpoint's auth_lost — re-handshake), its 409 is a wallet conflict
 * (permanent stop, defensive — transfer-on-proof means the server does not
 * emit this in ordinary operation), and any other 4xx is a client bug that
 * must never be hot-retried. session/complete's 400 splits on the server's
 * own error CODE: `challenge_expired` gets its own outcome (the caller just
 * restarts the flow next run, no punitive hold), anything else
 * (`invalid_signature`, `validation_failed`, …) is `invalid`.
 *
 * TOKEN HYGIENE. The CURRENT ingest token travels ONLY as the
 * `Authorization: Bearer` header on session/complete (never in a URL, never
 * in a body field) — the caller passes it whenever one is already stored;
 * omitted for a brand-new identity that has none yet. The ROTATED token
 * session/complete returns travels only in the parsed outcome. Failure
 * details are sanitized and length-capped before they can reach a log, so a
 * hostile server cannot smuggle the nonce, a token, or a signature out
 * through its own error body.
 */
import { fetchWithTimeout, readJson } from "@utils/http.js";
import { readRetryAfterSeconds } from "@utils/http/retry-after.js";
import type { ChainFamily } from "@tools/khalani/types.js";

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_DETAIL_LEN = 120;

export interface SessionStartAddress {
  readonly chainFamily: ChainFamily;
  readonly address: string;
}

export interface SessionStartInput {
  readonly agentHash: string;
  readonly addresses: readonly SessionStartAddress[];
}

export type SessionStartOutcome =
  | {
      readonly kind: "started";
      readonly challengeId: string;
      readonly nonce: string;
      readonly domain: string;
      readonly expiresAt: string;
    }
  | { readonly kind: "invalid"; readonly detail: string }
  | {
      readonly kind: "retryable";
      readonly status: number | null;
      readonly retryAfterSeconds: number | null;
      readonly detail: string;
    };

export interface SessionCompleteProof {
  readonly chainFamily: ChainFamily;
  readonly address: string;
  readonly signature: string;
  readonly issuedAt: string;
}

export interface SessionCompleteInput {
  readonly challengeId: string;
  readonly agentHash: string;
  readonly consentVersion: number;
  readonly appVersion?: string;
  readonly proofs: readonly SessionCompleteProof[];
}

export type SessionCompleteOutcome =
  | {
      readonly kind: "bound";
      readonly ingestToken: string;
      readonly agentName: string;
      readonly lastAcceptedRowId: number | null;
    }
  | { readonly kind: "challenge_expired" }
  | { readonly kind: "invalid"; readonly detail: string }
  | { readonly kind: "auth_lost" }
  | { readonly kind: "wallet_conflict" }
  | {
      readonly kind: "retryable";
      readonly status: number | null;
      readonly retryAfterSeconds: number | null;
      readonly detail: string;
    };

export interface AgentscanSessionClient {
  sessionStart(input: SessionStartInput): Promise<SessionStartOutcome>;
  /** `bearerToken`: the CURRENT stored ingest token, or null for a brand-new identity that has none yet. */
  sessionComplete(input: SessionCompleteInput, bearerToken: string | null): Promise<SessionCompleteOutcome>;
}

export function buildAgentscanSessionClient(baseUrl: string): AgentscanSessionClient {
  return {
    sessionStart: (input) => sessionStart(baseUrl, input),
    sessionComplete: (input, bearerToken) => sessionComplete(baseUrl, input, bearerToken),
  };
}

async function sessionStart(baseUrl: string, input: SessionStartInput): Promise<SessionStartOutcome> {
  let response: Response;
  try {
    response = await fetchWithTimeout(joinUrl(baseUrl, "v2/agents/session/start"), {
      method: "POST",
      timeoutMs: REQUEST_TIMEOUT_MS,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentHash: input.agentHash,
        addresses: input.addresses.map((a) => ({ chainFamily: a.chainFamily, address: a.address })),
      }),
    });
  } catch (err) {
    return { kind: "retryable", status: null, retryAfterSeconds: null, detail: safeDetail(err) };
  }

  const body = await readJson(response).catch(() => null);

  if (response.ok) {
    const started = parseSessionStartBody(body);
    if (started === null) return { kind: "invalid", detail: "malformed session/start response" };
    return { kind: "started", ...started };
  }
  if (response.status === 429 || response.status >= 500) return retryableFrom(response, body);
  return { kind: "invalid", detail: describeError(response.status, body) };
}

async function sessionComplete(
  baseUrl: string,
  input: SessionCompleteInput,
  bearerToken: string | null,
): Promise<SessionCompleteOutcome> {
  const body: Record<string, unknown> = {
    challengeId: input.challengeId,
    agentHash: input.agentHash,
    consentVersion: input.consentVersion,
    proofs: input.proofs.map((p) => ({
      chainFamily: p.chainFamily,
      address: p.address,
      signature: p.signature,
      issuedAt: p.issuedAt,
    })),
  };
  if (input.appVersion !== undefined) body.appVersion = input.appVersion;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (bearerToken !== null) headers.Authorization = `Bearer ${bearerToken}`;

  let response: Response;
  try {
    response = await fetchWithTimeout(joinUrl(baseUrl, "v2/agents/session/complete"), {
      method: "POST",
      timeoutMs: REQUEST_TIMEOUT_MS,
      headers,
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { kind: "retryable", status: null, retryAfterSeconds: null, detail: safeDetail(err) };
  }

  const responseBody = await readJson(response).catch(() => null);

  if (response.ok) {
    const bound = parseSessionCompleteBody(responseBody);
    if (bound === null) return { kind: "invalid", detail: "malformed session/complete response" };
    return { kind: "bound", ...bound };
  }

  const code = errorCode(responseBody);
  if (response.status === 400 && code === "challenge_expired") return { kind: "challenge_expired" };
  if (response.status === 401) return { kind: "auth_lost" };
  if (response.status === 409) return { kind: "wallet_conflict" };
  if (response.status === 429 || response.status >= 500) return retryableFrom(response, responseBody);
  // Any other 4xx (400 invalid_signature/validation_failed included) is a
  // definitive client bug — never hot-retried.
  return { kind: "invalid", detail: describeError(response.status, responseBody) };
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** Path-preserving join: a base of `https://host/sub` keeps its subpath. */
function joinUrl(baseUrl: string, path: string): string {
  return new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** TOLERANT READER: only the four documented fields are consumed. */
function parseSessionStartBody(
  body: unknown,
): { challengeId: string; nonce: string; domain: string; expiresAt: string } | null {
  if (!isRecord(body)) return null;
  const { challengeId, nonce, domain, expiresAt } = body;
  if (!nonEmptyString(challengeId) || !nonEmptyString(nonce)) return null;
  if (!nonEmptyString(domain) || !nonEmptyString(expiresAt)) return null;
  return { challengeId, nonce, domain, expiresAt };
}

/** TOLERANT READER: `syncState.lastAcceptedRowId` degrades to null rather than failing the parse. */
function parseSessionCompleteBody(
  body: unknown,
): { ingestToken: string; agentName: string; lastAcceptedRowId: number | null } | null {
  if (!isRecord(body)) return null;
  const { ingestToken, agentName } = body;
  if (!nonEmptyString(ingestToken) || typeof agentName !== "string") return null;

  let lastAcceptedRowId: number | null = null;
  if (isRecord(body.syncState)) {
    const raw = body.syncState.lastAcceptedRowId;
    if (typeof raw === "number" && Number.isInteger(raw)) lastAcceptedRowId = raw;
  }
  return { ingestToken, agentName, lastAcceptedRowId };
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
 * long hex and base64url runs (nonce/token/signature-shaped) are removed,
 * whitespace is collapsed, and the result is length-capped.
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
