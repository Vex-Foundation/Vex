/**
 * pools.fun CREATOR ATTRIBUTION - the VEX badge on pools.fun.
 *
 * The launchpad grants a token the VEX badge when it is shown that the wallet
 * which launched the token also signed a fixed attestation string. There is no
 * API key, no bearer token and no relay in this path: the PROOF is the
 * signature itself, so the request carries nothing an attacker could reuse for
 * anything other than the exact token it names.
 *
 * ── The signed string ──────────────────────────────────────────────────────
 *
 *   VEX-attest:v1:pools.fun:4663:<token address, lowercase>
 *
 * built ONLY by `buildPoolsAttestMessage` from the chain constant and the
 * address decoded from the launch receipt. It is never assembled from model or
 * user input, and the chain id is not a parameter: pools.fun is pinned to
 * Robinhood Chain (`POOLS_CHAIN_ID`), so accepting a chain here would only
 * create a way to sign something for a venue this module does not serve.
 *
 * WHY IT IS NOT THE TRENCH STRING. trench.express and pools.fun both launch on
 * chain 4663, and the bare `VEX-attest:<chainId>:<token>` form is already
 * consumed by two other verifiers. A byte-identical string across two venues
 * would let a signature produced for one be replayed at the other, so this one
 * is VERSIONED (`v1`) and DOMAIN-BOUND (`pools.fun`). The two literals are
 * distinct on purpose and the signing-oracle guard pins each to its own module.
 *
 * ── Why nothing throws ─────────────────────────────────────────────────────
 *
 * Attribution is a BADGE. It never gates a launch, never moves funds and must
 * never be able to fail one, so every expected outcome comes back as a named
 * member of `PoolsAttributionOutcome` for the caller to log.
 *
 * ── Why the partner's words are never kept ─────────────────────────────────
 *
 * The only thing read out of a refusal is a code from the CLOSED vocabulary in
 * `./attribution-codes.ts`. Partner free text is untrusted input that would
 * otherwise decide whether a durable row is retried forever or dropped; an
 * unreadable or unknown answer is therefore a PROTOCOL VIOLATION classified
 * retryable, never agreement and never a refusal we did not observe. Logs carry
 * the HTTP status and the validated code, nothing else.
 */

import { loadConfig } from "../../config/store.js";
import { VexError } from "../../errors.js";
import { fetchWithTimeout, readJson } from "../../utils/http.js";
import { POOLS_CHAIN_ID } from "./constants.js";
import {
  isPoolsAttestRetryableCode,
  isPoolsAttestTerminalCode,
  type PoolsAttestRetryableCode,
  type PoolsAttestTerminalCode,
} from "./attribution-codes.js";

/** Relative on purpose: a configured base that carries a path keeps it. */
const ATTEST_PATH = "pools-fun/vex/attestations";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_DETAIL_LEN = 120;

/** The address shape the attest string is allowed to name: a bare 20-byte hex address. */
const ADDRESS_SHAPE = /^0x[0-9a-fA-F]{40}$/;

export interface AttributePoolsLaunchInput {
  /** The token decoded from the launch receipt. Case-insensitive; lowercased on the wire. */
  readonly tokenAddress: string;
  /** `personal_sign` of `buildPoolsAttestMessage(tokenAddress)` by the LAUNCHING wallet. */
  readonly attestSignature: string;
  /**
   * The launch transaction. A LOCATOR ONLY - it lets the partner find the
   * receipt to verify against, and it is deliberately NOT part of the signed
   * bytes, so a wrong or stale hash can never change what was attested.
   */
  readonly txHash: string;
}

/**
 * What the launchpad did with an attestation request.
 *
 * Four members, because collapsing any pair of them would lose a decision the
 * sweep has to make:
 *
 *   `attributed`       the badge landed.
 *   `rejected`         a definitive refusal from the closed vocabulary. The row
 *                      leaves the retry lane permanently.
 *   `retryable`        the server ANSWERED but settled nothing - 429, 5xx, a
 *                      retryable code, or a protocol violation we could not
 *                      read. Neither transport failure (we did reach it) nor
 *                      terminal (it did not say no).
 *   `transport_failed` we never learned whether the request arrived.
 */
export type PoolsAttributionOutcome =
  | { readonly kind: "attributed" }
  | { readonly kind: "rejected"; readonly status: number; readonly code: PoolsAttestTerminalCode }
  | {
      readonly kind: "retryable";
      readonly status: number;
      /** `null` when the answer carried no code we recognize - a protocol violation. */
      readonly code: PoolsAttestRetryableCode | null;
    }
  | { readonly kind: "transport_failed"; readonly detail: string };

/**
 * The exact string the launching wallet signs. Lowercased address, so the same
 * token always yields byte-identical signable bytes no matter which casing the
 * decoder produced.
 *
 * Throws for a non-address: this is called with a receipt-decoded address, so a
 * bad value here is a defect in the caller, not a provider outcome, and signing
 * a malformed string would produce a signature nothing can ever verify.
 */
export function buildPoolsAttestMessage(tokenAddress: string): string {
  if (!ADDRESS_SHAPE.test(tokenAddress)) {
    throw new Error(
      `pools attribution: refusing to build an attest message for "${tokenAddress}" - not a 20-byte hex address`,
    );
  }
  return `VEX-attest:v1:pools.fun:${POOLS_CHAIN_ID}:${tokenAddress.toLowerCase()}`;
}

/**
 * Claim the VEX badge for a token whose launcher signature we hold.
 *
 * Never throws for an expected failure; see the module note.
 */
export async function attributePoolsLaunch(
  input: AttributePoolsLaunchInput,
): Promise<PoolsAttributionOutcome> {
  if (!ADDRESS_SHAPE.test(input.tokenAddress)) {
    // Refuse to SEND. Terminal, and named as our own validation failure: no
    // amount of retrying turns a malformed address into a launch, and putting
    // it on the wire would only teach the partner to refuse it for us.
    return { kind: "rejected", status: 0, code: "validation_failed" };
  }

  let response: Response;
  try {
    response = await fetchWithTimeout(attestUrl(), {
      method: "POST",
      timeoutMs: REQUEST_TIMEOUT_MS,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chainId: POOLS_CHAIN_ID,
        tokenAddress: input.tokenAddress.toLowerCase(),
        attestSignature: input.attestSignature,
        txHash: input.txHash,
      }),
    });
  } catch (err) {
    return { kind: "transport_failed", detail: safeDetail(err) };
  }

  const body = await readJson(response);

  if (response.ok) {
    // TOLERANT READER: `success` is the only field consumed, and every extra
    // the partner sends alongside it is ignored rather than being allowed to
    // fail the parse. A 2xx whose body does not carry a boolean `success` is
    // NOT read as agreement - it is a protocol violation, and the row is
    // offered again rather than being marked attributed on an answer we could
    // not read.
    if (isRecord(body) && body.success === true) return { kind: "attributed" };
    return { kind: "retryable", status: response.status, code: null };
  }

  const code = readErrorCode(body);
  if (isPoolsAttestTerminalCode(code)) {
    return { kind: "rejected", status: response.status, code };
  }
  if (isPoolsAttestRetryableCode(code)) {
    return { kind: "retryable", status: response.status, code };
  }
  // Unknown or missing code - including every 429 and 5xx, which carry no code
  // at all. A refusal we cannot name is not a refusal we may act on.
  return { kind: "retryable", status: response.status, code: null };
}

function attestUrl(): string {
  const base = loadConfig().services.poolsFunAttestApiUrl;
  return new URL(ATTEST_PATH, base.endsWith("/") ? base : `${base}/`).toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The partner's machine-readable code, if it sent one in a field we read.
 * Returns the raw value; the CLOSED-set predicates above decide whether it
 * means anything. Nothing else in the body is looked at, and no free text is
 * retained.
 */
function readErrorCode(body: unknown): unknown {
  if (!isRecord(body)) return undefined;
  return body.code ?? body.error;
}

function safeDetail(err: unknown): string {
  if (err instanceof VexError) return sanitize(`${err.code}: ${err.message}`);
  return sanitize(err instanceof Error ? err.message : String(err));
}

/**
 * Bound and scrub a transport error before it reaches a log line: URLs and long
 * hex blobs are removed (a transport error message embeds the endpoint, and can
 * embed the signature), whitespace is collapsed, and the result is
 * length-capped. This is the ONE place an untrusted string survives at all, and
 * it is our own fetch layer's message, not partner-authored content.
 */
function sanitize(text: string): string {
  const scrubbed = text
    .replace(/\bhttps?:\/\/\S+/gi, "<url>")
    .replace(/\b0x[0-9a-fA-F]{16,}\b/g, "<hex>")
    .replace(/\s+/g, " ")
    .trim();
  if (scrubbed.length === 0) return "no detail";
  if (scrubbed.length <= MAX_DETAIL_LEN) return scrubbed;
  // The bound is reported, never silent: the reader sees exactly how many
  // characters were dropped (no-silent-cutting decree; a bare "..." hides that).
  const dropped = scrubbed.length - MAX_DETAIL_LEN;
  return `${scrubbed.slice(0, MAX_DETAIL_LEN)} [+${dropped} chars dropped]`;
}
