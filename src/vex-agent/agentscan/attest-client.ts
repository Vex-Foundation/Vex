/**
 * AgentScan TOKEN ATTESTATION client — one keyless POST per launched token,
 * delivering the SAME creator signature already stored for the trench.express
 * VEX badge (`tools/trench-express/attribution.ts`, `buildAttestMessage`) to
 * the AgentScan attestation registry.
 *
 * NO AUTHORIZATION HEADER, exactly like the trench attribution client: the
 * proof is the signature itself, so the request carries nothing an attacker
 * could reuse for anything beyond the one token it names.
 *
 * NOTHING THROWS. Every expected outcome — a definitive refusal, a rate
 * limit, an unreachable host — comes back as a named member of
 * `AttestOutcome` for the sweep to act on: only 429/5xx/network are
 * retryable, and any 400 (`validation_failed`, `invalid_signature`,
 * `chain_unsupported`) is permanent for that row.
 *
 * DETAILS NEVER CARRY THE SIGNATURE. The server's error vocabulary is a
 * closed set of CODES (`error.code`); only the code is ever read into a
 * detail string, never a free-form message — the same discipline
 * `agentscan/client.ts` uses for its own error bodies.
 */

import { fetchWithTimeout, readJson } from "@utils/http.js";
import { readRetryAfterSeconds } from "@utils/http/retry-after.js";

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_DETAIL_LEN = 120;

export interface PostTokenAttestationInput {
  readonly chainId: number;
  /** Case-insensitive; lowercased on the wire. */
  readonly tokenAddress: string;
  readonly attestSignature: string;
  /** The launch's own creation tx hash — always known for our rows; the server treats it as a validated hint. */
  readonly txHash: string;
}

export type AttestOutcome =
  | { readonly kind: "accepted" }
  | { readonly kind: "invalid"; readonly detail: string }
  | {
      readonly kind: "retryable";
      readonly status: number | null;
      readonly retryAfterSeconds: number | null;
      readonly detail: string;
    };

export async function postTokenAttestation(
  baseUrl: string,
  input: PostTokenAttestationInput,
): Promise<AttestOutcome> {
  let response: Response;
  try {
    response = await fetchWithTimeout(joinUrl(baseUrl, "v1/tokens/attest"), {
      method: "POST",
      timeoutMs: REQUEST_TIMEOUT_MS,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chainId: input.chainId,
        tokenAddress: input.tokenAddress.toLowerCase(),
        attestSignature: input.attestSignature,
        txHash: input.txHash,
      }),
    });
  } catch (err) {
    return { kind: "retryable", status: null, retryAfterSeconds: null, detail: safeDetail(err) };
  }

  if (response.ok) return { kind: "accepted" };

  const body = await readJson(response).catch(() => null);
  if (response.status === 429 || response.status >= 500) {
    return {
      kind: "retryable",
      status: response.status,
      retryAfterSeconds: readRetryAfterSeconds(response.headers, response.status) ?? null,
      detail: describeError(response.status, body),
    };
  }
  // Any other 4xx — the contract's three documented 400 codes included — is a
  // definitive refusal, never hot-retried.
  return { kind: "invalid", detail: describeError(response.status, body) };
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** Path-preserving join: a base of `https://host/sub` keeps its subpath. */
function joinUrl(baseUrl: string, path: string): string {
  return new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(body: unknown): string | null {
  if (!isRecord(body) || !isRecord(body.error)) return null;
  return typeof body.error.code === "string" ? body.error.code : null;
}

/** Status + the server's error CODE only — a closed vocabulary the signature can never reach. */
function describeError(status: number, body: unknown): string {
  const code = errorCode(body);
  return sanitize(code === null ? `HTTP ${status}` : `HTTP ${status} ${code}`);
}

function safeDetail(err: unknown): string {
  return sanitize(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
}

/**
 * Bound and scrub an untrusted string before it can reach a log line: URLs
 * and long hex runs (the signature is exactly this shape) are removed,
 * whitespace is collapsed, and the result is length-capped.
 */
function sanitize(text: string): string {
  const scrubbed = text
    .replace(/\bhttps?:\/\/\S+/gi, "<url>")
    .replace(/\b0x[0-9a-fA-F]{16,}\b/g, "<hex>")
    .replace(/\s+/g, " ")
    .trim();
  if (scrubbed.length === 0) return "no detail";
  return scrubbed.length > MAX_DETAIL_LEN ? `${scrubbed.slice(0, MAX_DETAIL_LEN)}…` : scrubbed;
}
