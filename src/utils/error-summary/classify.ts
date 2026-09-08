/**
 * The classification half of `../error-summary.ts`: the 9-value `ErrorCategory`, the
 * closed code sets that decide who rejected a call, and `classifyError`.
 *
 * Extracted verbatim as part of a façade-preserving structural split (SPEC
 * wave 0R.1) and moved here with the rest of the pipeline to neutral ground.
 * `../error-summary.ts` remains the public entry point.
 */

import { VexError, ErrorCodes } from "../../errors.js";

// ── Provider-safe error summarisation (B-003) ────────────────────
//
// A thrown handler error (or any provider/SDK error) can embed URLs, request /
// response bodies, auth headers, and key material. NONE of that may reach the
// tool output, the structured logs, or (downstream) the renderer. We emit ONLY:
//   - a coarse cause CATEGORY (transient vs permanent classification signal),
//   - a bounded message that has been run through the secret redactor AND
//     stripped of URLs, then length-capped.
// The original error is never logged or returned verbatim.

export type ErrorCategory =
  | "timeout"
  | "network"
  | "rate_limit"
  | "auth"
  /**
   * WE rejected the call before (or instead of) trusting it — a parameter the
   * caller or the model supplied did not survive our own validation. Distinct
   * from `provider_error` because the two imply opposite next actions: a
   * provider malfunction invites a retry, a bad parameter invites a FIX. Live
   * proof of the confusion this removes (2026-07-24): `uniswap.swap.quote
   * failed (provider_error): Cannot read decimals for 0x0000…0000 — not a
   * valid ERC-20 contract on this chain` — our own address validation,
   * reported to the agent as the provider's malfunction.
   */
  | "invalid_request"
  /**
   * A VEX SAFETY POLICY refused the call — our own money-path guard looked at
   * what was about to be signed and declined. Nothing was sent to the venue,
   * so nothing about the venue is being reported. Distinct from
   * `provider_error` for the same reason `invalid_request` is: labelling the
   * calldata price floor, the unsafe-build abort, or the provider-gas-limit
   * ceiling as a provider malfunction tells the agent to retry a trade Vex
   * stopped deliberately — and the retry reproduces it every time, because
   * nothing about the venue was ever wrong.
   *
   * Attribution ONLY. Whether retrying helps is `retryable`'s job; a refusal
   * can be either, and the two must not be read off one another.
   */
  | "policy_refusal"
  /**
   * WE could not READ what the provider sent — our own response parser refused
   * a body we do not understand. Distinct from `provider_error` (the provider
   * malfunctioned; retry may help) AND from `invalid_request` (a caller
   * parameter was bad; fixing the parameter helps). Here the request was fine
   * and the provider answered, so NEITHER of those next actions works: the
   * shape mismatch reproduces on every retry and with every parameter until
   * our schema or the provider's payload changes.
   *
   * Live proof of the confusion this removes (2026-07-26): `dexscreener.orders`
   * had been failing on 100% of calls for months because our validator
   * demanded an array root where the API sends `{orders, boosts}` — and the
   * failure was reported to the agent as the PROVIDER's error, inviting a
   * retry that could never succeed.
   */
  | "response_schema"
  /**
   * THE WALLET COULD NOT PAY — the chain refused the transaction because the
   * account cannot cover `value + gas`. Distinct from `provider_error` for the
   * same reason `policy_refusal` and `response_schema` are: the provider did
   * not malfunction and no parameter is malformed, so "retry" is the one action
   * guaranteed to fail, and it fails identically every time until the USER
   * funds the wallet (or the agent lowers the amount).
   *
   * Live proof of the confusion this removes (owner decree 2026-08-02):
   * `launch_preview` failed four times in a row reported as a bare "unexpected
   * error" while the log carried the truth the whole time — "total cost (gas *
   * gas fee + value) … exceeds the balance of the account". The agent retried
   * blind, burning turns, instead of saying "top up the wallet".
   *
   * Attribution ONLY, like the two above: this is never `retryable`, but that
   * is `retryable`'s field to state, not this label's.
   */
  | "insufficient_funds"
  | "provider_error"
  | "unknown";

/**
 * Error codes this repo throws from its OWN validation of caller/model-supplied
 * parameters — an address that is not an address, an amount that is not an
 * amount, a chain we do not serve, a token contract that does not answer
 * `decimals()`. Deliberately a CLOSED, small set: a code that is ALSO used to
 * carry a provider's verdict must stay out of it unless the provider-answered
 * case is separable, which `isLocallyAuthoredValidationFailure` handles below.
 *
 * `KYBER_TOKEN_NOT_FOUND` is in the set despite being reachable from both
 * sides: locally from `uniswap/erc20.ts`, `kyberswap/evm/erc20.ts` and
 * `kyberswap/helpers.ts`, and from KyberSwap's own code 4011 via
 * `mapAggregatorError` — which always stamps `externalName`, the discriminator
 * used below.
 */
const LOCAL_VALIDATION_ERROR_CODES: ReadonlySet<string> = new Set<string>([
  ErrorCodes.AGENT_VALIDATION_ERROR,
  ErrorCodes.INVALID_ADDRESS,
  ErrorCodes.SOLANA_INVALID_ADDRESS,
  ErrorCodes.INVALID_AMOUNT,
  ErrorCodes.CHAIN_MISMATCH,
  ErrorCodes.INVALID_SPENDER,
  ErrorCodes.KYBER_TOKEN_NOT_FOUND,
]);

/**
 * Error codes thrown by Vex's OWN money-path safety gates — a guard that
 * inspected what was about to be signed and refused. Nothing reaches the venue
 * on any of these paths, so none of them can carry a provider's opinion.
 *
 * Same CLOSED-set discipline as `LOCAL_VALIDATION_ERROR_CODES`, and the same
 * admission test: a code stays out unless every throw site in the tree is a
 * gate WE authored. That test excludes, for example,
 * `KYBER_FEE_EXCEEDS_AMOUNT` (produced by `mapAggregatorError` from KyberSwap's
 * own response) and `PENDLE_VALUATION_TOO_LOW/HIGH` (Pendle's 400 body,
 * re-worded by `tools/pendle/errors.ts`) — those are provider verdicts wearing
 * a Vex code.
 *
 * Distinct from `LOCAL_VALIDATION_ERROR_CODES`, which covers a BAD PARAMETER
 * ("fix your input"); these cover a REFUSAL of a well-formed request ("the
 * trade itself was not safe to sign").
 */
const POLICY_REFUSAL_ERROR_CODES: ReadonlySet<string> = new Set<string>([
  // KyberSwap calldata guard: built `minReturnAmount` below the approved floor.
  ErrorCodes.KYBER_PRICE_FLOOR_VIOLATED,
  // KyberSwap calldata guard: non-price divergence (router/spender/value/fee/flags).
  ErrorCodes.KYBER_UNSAFE_BUILD,
  // `tools/evm-chains/gas-limit-headroom.ts`: provider's gas limit far above our own estimate.
  ErrorCodes.PROVIDER_GAS_LIMIT_EXCESSIVE,
  // `tools/evm-chains/native-value-authorization`: tx.value not attributable to proven costs.
  ErrorCodes.NATIVE_VALUE_UNAUTHORIZED,
  // Pendle calldata guard + redeem fallback — the Pendle sibling of KYBER_UNSAFE_BUILD.
  ErrorCodes.PENDLE_UNSAFE_TX,
  // `solana-transaction/prepare.ts`: strict sole-signer check refused to sign.
  ErrorCodes.SOLANA_TX_SOLE_SIGNER_VIOLATION,
  // `solana-transaction/prepare.ts`: blockhash evidence does not match the transaction.
  ErrorCodes.SOLANA_TX_BLOCKHASH_MISMATCH,
]);

/**
 * Error codes thrown by Vex's OWN RESPONSE parsers — a provider answered and we
 * could not read the body. Same CLOSED-set discipline as the two sets above.
 *
 * Deliberately NOT folded into `LOCAL_VALIDATION_ERROR_CODES`: that set's
 * contract is a bad CALLER/MODEL PARAMETER, and its category (`invalid_request`)
 * tells the agent to fix its input. A response-shape mismatch is not the
 * caller's fault and no parameter change can clear it, so labelling it
 * `invalid_request` would send the agent down a road with no end — the same
 * class of harm as labelling it `provider_error`.
 */
const RESPONSE_SCHEMA_ERROR_CODES: ReadonlySet<string> = new Set<string>([
  ErrorCodes.DEXSCREENER_INVALID_RESPONSE,
]);

/**
 * Evidence that a provider ANSWERED, which outranks any code we attached.
 * These two are the repo's only markers of a provider verdict: `httpStatus` is
 * set exclusively by `utils/http.ts` on a non-ok response, and `externalName`
 * exclusively by a provider error mapper (Khalani, KyberSwap) or by a
 * provider-supplied error code lifted from a response body.
 */
function carriesProviderVerdict(err: VexError): boolean {
  return err.httpStatus !== undefined || err.externalName !== undefined;
}

/**
 * True only when WE authored the rejection. Conservative by construction: any
 * evidence that a provider ANSWERED disqualifies the error, and an unrecognized
 * code keeps today's label rather than guessing.
 */
function isLocallyAuthoredValidationFailure(err: unknown): boolean {
  if (!(err instanceof VexError)) return false;
  if (carriesProviderVerdict(err)) return false;
  return LOCAL_VALIDATION_ERROR_CODES.has(err.code);
}

/** True only when one of Vex's own safety gates refused, with no provider verdict attached. */
function isVexAuthoredPolicyRefusal(err: unknown): boolean {
  if (!(err instanceof VexError)) return false;
  if (carriesProviderVerdict(err)) return false;
  return POLICY_REFUSAL_ERROR_CODES.has(err.code);
}

/**
 * True when our own response parser refused the body.
 *
 * No `carriesProviderVerdict` gate here, unlike the two predicates above, and
 * the difference is deliberate: every throw site for these codes is a parser WE
 * wrote, running only AFTER a 2xx response, so there is no provider verdict to
 * outrank — a provider answering is the PRECONDITION for this category, not a
 * disqualifier from it. Gating on it would only create a silent fall-through to
 * `provider_error` if a future code in this set ever carried an HTTP status.
 */
function isResponseSchemaFailure(err: unknown): boolean {
  if (!(err instanceof VexError)) return false;
  return RESPONSE_SCHEMA_ERROR_CODES.has(err.code);
}

/**
 * The two phrasings the money paths actually produce for "the account cannot
 * pay", both captured live in this repo: viem's EVM wording ("The total cost
 * (gas * gas fee + value) of executing this transaction exceeds the balance of
 * the account", pinned in the launchpad failure-detail tests) and the node/Solana
 * wording ("insufficient funds for gas * price + value" / "…for rent", pinned
 * in `solana-program-error-reason.test.ts`). Deliberately narrow: a broader
 * "balance" scan would swallow ordinary prose that merely mentions balances.
 */
const INSUFFICIENT_FUNDS_PATTERN = /exceeds the balance|insufficient funds/i;

/**
 * The category an HTTP status alone proves, ahead of every keyword scan
 * (SPEC §1.5 — the owner's 403 requirement).
 *
 * WHY THIS MUST OUTRANK THE TEXT. `parseJsonResponse` REPLACES its own
 * "HTTP 403: Forbidden" line with the provider's body message whenever the body
 * carries `error|message|detail|details`, so the digits the keyword scans below
 * look for are frequently gone by the time we classify. A 403 whose body reads
 * "API key quota exceeded" therefore classified `provider_error`, and the agent
 * retried a call that can never succeed. A status is a bounded integer the
 * provider committed to; prose is a guess about what it meant.
 */
function categoryFromHttpStatus(status: number): ErrorCategory | undefined {
  if (status === 401 || status === 403 || status === 407) return "auth";
  if (status === 429) return "rate_limit";
  if (status === 408 || status === 504) return "timeout";
  if (status >= 400 && status < 500) return "invalid_request";
  if (status >= 500) return "provider_error";
  return undefined;
}

/** Coarse, non-sensitive classification from the error's shape/text. */
export function classifyError(raw: string, err: unknown): ErrorCategory {
  // Checked FIRST, ahead of the text heuristics: a typed code we ourselves
  // attached is direct evidence of who rejected the call, whereas the keyword
  // scans below are guesses about prose that a provider may have written.
  // The three sets are disjoint, so their order relative to each other is not
  // load-bearing — only their position ahead of the scans is. That position
  // matters most for `response_schema`: a parser message quoting a provider
  // body could trip a keyword scan and be mislabelled.
  if (isLocallyAuthoredValidationFailure(err)) return "invalid_request";
  if (isVexAuthoredPolicyRefusal(err)) return "policy_refusal";
  if (isResponseSchemaFailure(err)) return "response_schema";
  // Ahead of the keyword scans below because it is the most SPECIFIC text
  // verdict of the set and none of those scans can produce it: whoever wrote
  // the prose, "the account cannot pay" is the same fact and the same remedy.
  // Scanned on the RAW text, not the scrubbed one, deliberately — scrubbing
  // only ever REMOVES spans (a JSON body quoting the reason, for instance), so
  // raw is strictly the more sensitive input, and the output here is a fixed
  // label that cannot carry anything the raw text contained.
  //
  // Deliberately AHEAD of the status branch below, unlike the other text scans
  // (a narrower reading of SPEC §1.5's "keyword scans second", named here
  // because it is a deviation): "the account cannot pay" is a chain verdict
  // whose remedy only the USER can supply, and a node that wraps it in an HTTP
  // envelope must not turn it into "fix the named parameter". Nothing in the
  // status table can produce this label, and no gateway page carries this
  // wording, so the 403-misclassification this wave fixes is unaffected.
  if (INSUFFICIENT_FUNDS_PATTERN.test(raw)) return "insufficient_funds";
  if (err instanceof VexError && err.httpStatus !== undefined) {
    const fromStatus = categoryFromHttpStatus(err.httpStatus);
    if (fromStatus) return fromStatus;
  }
  const name = err instanceof Error ? err.name.toLowerCase() : "";
  const text = raw.toLowerCase();
  if (name.includes("abort") || text.includes("timeout") || text.includes("timed out")) {
    return "timeout";
  }
  if (text.includes("rate limit") || text.includes("429") || text.includes("too many requests")) {
    return "rate_limit";
  }
  if (text.includes("unauthorized") || text.includes("forbidden") || text.includes("401") || text.includes("403")) {
    return "auth";
  }
  if (
    name.includes("fetch")
    || text.includes("econn")
    || text.includes("enotfound")
    || text.includes("network")
    || text.includes("socket")
  ) {
    return "network";
  }
  if (err instanceof Error) return "provider_error";
  return "unknown";
}
