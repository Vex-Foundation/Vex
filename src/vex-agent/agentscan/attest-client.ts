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
 *
 * TWO CALLS, TWO AUTHORITIES. `postTokenAttestation` submits the claim and the
 * server answers `accepted` - meaning it entered the verify queue, NOT that the
 * creation proof held. `fetchTokenAttestationVerdict` reads the verdict back
 * from the public token route, which is the only place the server states whether
 * the proof was actually checked and passed. The request also NAMES its
 * launchpad, because the verifier applies one creation proof per launchpad
 * rather than trying every decoder and accepting whichever matched.
 */

import { fetchWithTimeout, readJson } from "@utils/http.js";
import { readRetryAfterSeconds } from "@utils/http/retry-after.js";

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_DETAIL_LEN = 120;

/**
 * The launchpads the server can prove a token creation on, mirroring its
 * `LAUNCHPADS` enum (`packages/contract/src/launchpad.ts`).
 *
 * The value is part of the CLAIM, not a hint: the verifier dispatches on it to
 * pick ONE creation proof (Trench's `TokenCreated`, pools.fun's `GatewayLaunch`,
 * Virtuals' creator `preLaunch` transaction) rather than trying every decoder
 * and accepting whichever matched. Sending the wrong one is a definitive
 * refusal, never a silent downgrade, so the caller names it explicitly and this
 * client never defaults it - the server's own `trench` default exists for
 * clients that predate the field, and this one does not.
 */
export const AGENTSCAN_LAUNCHPADS = ["trench", "pools_fun", "virtuals"] as const;
export type AgentscanLaunchpad = (typeof AGENTSCAN_LAUNCHPADS)[number];

/**
 * The server's own verdict vocabulary for an attestation
 * (`packages/core/src/attestation-precedence.ts`). `unverified` is the state a
 * freshly accepted claim sits in while the verify job has not run; the other
 * four are terminal.
 *
 * ACCEPTED IS NOT VERIFIED. A 2xx on the POST means the claim entered the verify
 * queue, which is why this vocabulary is read back separately rather than
 * inferred from the submission.
 */
export const AGENTSCAN_VERIFY_STATUSES = [
  "unverified",
  "verified",
  "mismatch",
  "unverifiable",
  "revoked",
] as const;
export type AgentscanVerifyStatus = (typeof AGENTSCAN_VERIFY_STATUSES)[number];

export interface PostTokenAttestationInput {
  readonly chainId: number;
  /** Which creation proof the server must apply. Never defaulted here, see `AGENTSCAN_LAUNCHPADS`. */
  readonly launchpad: AgentscanLaunchpad;
  /** Case-insensitive; lowercased on the wire. */
  readonly tokenAddress: string;
  readonly attestSignature: string;
  /** The launch's own creation tx hash — always known for our rows; the server treats it as a validated hint. */
  readonly txHash: string;
}

export type AttestOutcome =
  | {
      readonly kind: "accepted";
      /**
       * The queue state the server reported for the claim, when it named one.
       * `null` means the response carried no recognizable status, so the
       * submission still landed, and the read-back is what settles the verdict.
       */
      readonly verifyStatus: AgentscanVerifyStatus | null;
    }
  | { readonly kind: "invalid"; readonly detail: string }
  | {
      readonly kind: "retryable";
      readonly status: number | null;
      readonly retryAfterSeconds: number | null;
      readonly detail: string;
    };

/**
 * The verdict read back from `GET /v1/tokens/:chainId/:address`.
 *
 * `absent` is its own member and NOT an error: the server answers 404 for a
 * token it holds no candidate for, which happens legitimately between a POST and
 * the row becoming readable, and collapsing it into a failure would make the
 * sweep retry a route that answered correctly.
 */
export type AttestVerdictOutcome =
  | { readonly kind: "verdict"; readonly status: AgentscanVerifyStatus }
  | { readonly kind: "absent" }
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
        launchpad: input.launchpad,
        tokenAddress: input.tokenAddress.toLowerCase(),
        attestSignature: input.attestSignature,
        txHash: input.txHash,
      }),
    });
  } catch (err) {
    return { kind: "retryable", status: null, retryAfterSeconds: null, detail: safeDetail(err) };
  }

  if (response.ok) {
    const accepted = await readJson(response).catch(() => null);
    return { kind: "accepted", verifyStatus: verifyStatusOf(accepted, "verifyStatus") };
  }

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

/**
 * READ THE SERVER'S VERDICT BACK. The public token route, no authorization, the
 * same keyless posture as the POST.
 *
 * A 404 is `absent`, not a failure: the route answers it for a token with no
 * candidate row, which is the honest answer while a just-submitted claim has not
 * surfaced yet. Every other non-2xx follows the POST's classification exactly -
 * 429 and 5xx and network are retryable, any other 4xx is definitive - so one
 * reader of this module cannot come to a different conclusion from the other.
 */
export async function fetchTokenAttestationVerdict(
  baseUrl: string,
  input: { readonly chainId: number; readonly tokenAddress: string },
): Promise<AttestVerdictOutcome> {
  const path = `v1/tokens/${input.chainId}/${input.tokenAddress.toLowerCase()}`;
  let response: Response;
  try {
    response = await fetchWithTimeout(joinUrl(baseUrl, path), {
      method: "GET",
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
  } catch (err) {
    return { kind: "retryable", status: null, retryAfterSeconds: null, detail: safeDetail(err) };
  }

  if (response.status === 404) return { kind: "absent" };

  if (!response.ok) {
    const body = await readJson(response).catch(() => null);
    if (response.status === 429 || response.status >= 500) {
      return {
        kind: "retryable",
        status: response.status,
        retryAfterSeconds: readRetryAfterSeconds(response.headers, response.status) ?? null,
        detail: describeError(response.status, body),
      };
    }
    return { kind: "invalid", detail: describeError(response.status, body) };
  }

  const dto = await readJson(response).catch(() => null);
  const status = verifyStatusOf(dto, "status");
  if (status === null) {
    // A 200 whose `status` this build does not recognize is NOT a verdict. It is
    // reported as retryable rather than stored, because storing an unknown word
    // would put a value outside the column's CHECK and inventing one would state
    // a verdict the server never gave.
    return {
      kind: "retryable",
      status: response.status,
      retryAfterSeconds: null,
      detail: "unrecognized attestation status",
    };
  }
  return { kind: "verdict", status };
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** One named field of an untrusted JSON body, against the closed status set. */
function verifyStatusOf(body: unknown, field: string): AgentscanVerifyStatus | null {
  if (!isRecord(body)) return null;
  const value = body[field];
  return typeof value === "string" && (AGENTSCAN_VERIFY_STATUSES as readonly string[]).includes(value)
    ? (value as AgentscanVerifyStatus)
    : null;
}

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
