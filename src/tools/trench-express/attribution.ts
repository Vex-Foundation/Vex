/**
 * Trench Express CREATOR ATTRIBUTION — the VEX badge on trench.express.
 *
 * The launchpad grants a token the VEX badge when it is shown that the wallet
 * which created the token also signed a fixed attestation string. There is no
 * API key, no bearer token and no relay in this path: the PROOF is the
 * signature itself, so the request carries nothing an attacker could reuse for
 * anything other than the exact token it names.
 *
 * ── The signed string ──────────────────────────────────────────────────────
 *
 *   VEX-attest:<chainId>:<token address, lowercase>
 *
 * built ONLY by `buildAttestMessage` from the chain constant and the address
 * decoded from the create receipt. It is never assembled from model or user
 * input, and the chain id is not a parameter: the launchpad is mainnet-only
 * (`TRENCH_CHAIN_ID`), so accepting a chain here would only create a way to
 * sign something for a venue this module does not serve.
 *
 * ── Why nothing throws ─────────────────────────────────────────────────────
 *
 * Attribution is a BADGE. It never gates a launch, never moves funds and must
 * never be able to fail one, so every expected outcome — a refusal, a timeout,
 * an unreachable host — comes back as a named member of `AttributionOutcome`
 * for the caller to log. The live probe (2026-08-05) answered 401
 * `{"error":"unauthorized"}` for several bad-signature shapes rather than the
 * documented 403, which is exactly why the outcome carries the STATUS rather
 * than a guess at what the status meant.
 *
 * The endpoint is idempotent upstream: repeating a successful attribution, or
 * backfilling one days later, is a no-op.
 */

import { loadConfig } from "../../config/store.js";
import { VexError } from "../../errors.js";
import { fetchWithTimeout, readJson } from "../../utils/http.js";
import { TRENCH_CHAIN_ID } from "./constants.js";

const ATTRIBUTE_PATH = "/vex/attribute";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_DETAIL_LEN = 120;

/** The address shape the attest string is allowed to name: a bare 20-byte hex address. */
const ADDRESS_SHAPE = /^0x[0-9a-fA-F]{40}$/;

export interface AttributeLaunchedTokenInput {
  /** The token decoded from the create receipt. Case-insensitive; lowercased on the wire. */
  readonly tokenAddress: string;
  /** `personal_sign` of `buildAttestMessage(tokenAddress)` by the CREATOR wallet. */
  readonly attestSignature: string;
}

/**
 * What the launchpad did with an attribution request.
 *
 * `rejected` is a definitive provider answer (it read the request and said no);
 * `transport_failed` is the ambiguous lane where we never learned whether the
 * request arrived. The distinction is kept because claiming a refusal we did
 * not observe would be a claim beyond the evidence (rule 90).
 */
export type AttributionOutcome =
  | { readonly kind: "attributed" }
  | { readonly kind: "rejected"; readonly status: number; readonly detail: string }
  | { readonly kind: "transport_failed"; readonly detail: string };

/**
 * The exact string the creator wallet signs. Lowercased address, so the same
 * token always yields byte-identical calldata no matter which casing the
 * decoder produced.
 */
export function buildAttestMessage(tokenAddress: string): string {
  if (!ADDRESS_SHAPE.test(tokenAddress)) {
    throw new Error(
      `trench attribution: refusing to build an attest message for "${tokenAddress}" — not a 20-byte hex address`,
    );
  }
  return `VEX-attest:${TRENCH_CHAIN_ID}:${tokenAddress.toLowerCase()}`;
}

/**
 * Claim the VEX badge for a token whose creator signature we hold.
 *
 * Never throws for an expected failure; see the module note.
 */
export async function attributeLaunchedToken(
  input: AttributeLaunchedTokenInput,
): Promise<AttributionOutcome> {
  if (!ADDRESS_SHAPE.test(input.tokenAddress)) {
    return { kind: "rejected", status: 0, detail: "not a 20-byte hex address" };
  }
  let response: Response;
  try {
    response = await fetchWithTimeout(attributeUrl(), {
      method: "POST",
      timeoutMs: REQUEST_TIMEOUT_MS,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: input.tokenAddress.toLowerCase(),
        signature: input.attestSignature,
      }),
    });
  } catch (err) {
    return { kind: "transport_failed", detail: safeDetail(err) };
  }

  const body = await readJson(response);
  if (!response.ok) {
    return { kind: "rejected", status: response.status, detail: describeErrorBody(body) };
  }
  // TOLERANT READER: `success` is the only field consumed, and every extra the
  // provider sends alongside it is ignored rather than being allowed to fail
  // the parse. A 200 whose body does not carry a boolean `success` is not read
  // as agreement — it is reported as what it is, an unreadable answer.
  if (isRecord(body) && body.success === true) return { kind: "attributed" };
  return {
    kind: "rejected",
    status: response.status,
    detail: isRecord(body) && body.success === false
      ? "provider answered success:false"
      : "provider answered 200 with no success flag",
  };
}

function attributeUrl(): string {
  const base = loadConfig().services.trenchExpressApiUrl;
  return new URL(ATTRIBUTE_PATH, base.endsWith("/") ? base : `${base}/`).toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The provider's own words for a refusal, when it gave any. Untrusted input. */
function describeErrorBody(body: unknown): string {
  if (!isRecord(body)) return "no readable error body";
  for (const field of ["error", "message", "detail"]) {
    const value = body[field];
    if (typeof value === "string" && value.trim().length > 0) return sanitize(value);
  }
  return "no readable error body";
}

function safeDetail(err: unknown): string {
  if (err instanceof VexError) return sanitize(`${err.code}: ${err.message}`);
  return sanitize(err instanceof Error ? err.message : String(err));
}

/**
 * Bound and scrub an untrusted string before it reaches a log line: URLs and
 * long hex blobs are removed (a transport error message embeds the endpoint,
 * and a provider echo can embed the signature), whitespace is collapsed, and
 * the result is length-capped.
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
