/**
 * The first-party remediation table (SPEC §1.5).
 *
 * Every entry is an authored literal — no provider bytes — which is why it is
 * the one thing allowed past the length cap, exactly as the
 * `insufficient_funds` remedy already was (owner decree 2026-08-02). It tells
 * the agent what to DO, which a category name alone never did: a bare
 * "provider_error" invites a retry, and four of the categories below make a
 * retry the one action guaranteed to fail.
 */

import type { ErrorCategory } from "./classify.js";

const REMEDIATION_BY_CATEGORY: Readonly<Record<ErrorCategory, string | undefined>> = {
  insufficient_funds:
    "the wallet on this chain cannot cover value + gas: top up the wallet or lower the amount",
  auth:
    "this provider rejected our credentials — the key is missing, expired, or out of quota; "
    + "do not retry, report it",
  rate_limit:
    "the provider is rate-limiting; wait before retrying this venue, or use another venue",
  invalid_request:
    "fix the named parameter and call again — retrying unchanged will fail identically",
  policy_refusal:
    "Vex refused this before signing; nothing was sent. Change the request, do not retry it",
  response_schema:
    "the provider's response shape changed; no parameter fixes this — report it and use another route",
  timeout:
    "transport failure — the request may or may not have reached the provider; "
    + "verify state before retrying a mutation",
  network:
    "transport failure — the request may or may not have reached the provider; "
    + "verify state before retrying a mutation",
  provider_error: undefined,
  unknown: undefined,
};

/**
 * The rate-limit remedy with the provider's OWN interval spliced in, when a
 * response advertised one (`VexError.retryAfterSeconds`).
 *
 * "wait before retrying" is true and unactionable: it leaves the agent to
 * invent an interval, and the two failure modes of an invented one are a retry
 * straight back into the wall or a defer far longer than the venue asked for.
 * The number is a validated integer bounded at parse time, so this stays an
 * authored literal with one integer in it — no provider bytes.
 */
export function remediationFor(
  category: ErrorCategory,
  retryAfterSeconds?: number,
): string | undefined {
  if (category === "rate_limit" && retryAfterSeconds !== undefined) {
    return `the provider is rate-limiting; wait ~${retryAfterSeconds}s before retrying this venue, `
      + "or use another venue";
  }
  return REMEDIATION_BY_CATEGORY[category];
}

/** The tolerance an attempt actually applied, the ceiling a retry may not exceed, and the impact observed for it. */
export interface SlippageRemediationInput {
  /** `null` when the request named none and the venue applied its own default — stated as such, never guessed at. */
  readonly appliedBps: number | null;
  readonly maxBps: number;
  /**
   * The price impact the quote behind THIS attempt carried, as a COST-POSITIVE
   * FRACTION: KyberSwap's `(inUsd − outUsd) / inUsd` (0.0015 = 0.15% of value
   * given up), where a NEGATIVE value is the anomaly, not the ordinary case.
   *
   * A venue whose provider reports the OPPOSITE sign must not pass its raw
   * number here. Jupiter was believed to be exactly that venue, off a single
   * negative capture; a fresh read-only `GET /swap/v2/build` capture on
   * 2026-08-03 settled it the other way — Jupiter's `priceImpactPct` is
   * positive and grows monotonically with size, i.e. cost-positive like
   * KyberSwap's — so Jupiter now passes its figure here. See
   * `tools/solana-ecosystem/jupiter/jupiter-swaps/pre-broadcast-rejection-refusal.ts`
   * for the captured numbers.
   *
   * Omitted/`null` when the venue gave none; the sentence is dropped rather
   * than printed empty.
   */
  readonly observedPriceImpactFraction?: number | null;
  /**
   * Whether the venue's shipped stale-reserve caution applies — "a strongly
   * NEGATIVE priceImpact means the quote is wrong, so more tolerance buys a
   * worse fill". `engine/prompts/protocols.ts` teaches it for the EVM venues,
   * whose indexed reserves are the thing that goes stale. It stays FALSE for
   * Jupiter even now that the sign matches: the caution is KyberSwap's shipped
   * instruction about stale indexed reserves, and no capture in this repo
   * evidences that failure mode on Jupiter's live on-chain routing.
   *
   * Required, never defaulted: which caution a money-path message carries is a
   * decision each venue must make out loud.
   */
  readonly staleReserveCaution: boolean;
}

/**
 * The ONE authored remedy for a slippage-class refusal, shared by every venue
 * that has one (EVM pre-sign revert, Jupiter pre-broadcast rejection) so the
 * five surfaces cannot drift apart. Each venue keeps its own preceding sentence
 * — what exactly refused it, and which embedded minimum moved — because that
 * part is genuinely venue-specific; this part is not.
 *
 * OWNER DECREE 2026-08-03, the INFORM side: a slippage failure informs, it never
 * auto-escalates. Vex makes exactly ONE attempt at the tolerance the caller
 * passed and no code path raises it — so the remedy has to say, in the agent's
 * own vocabulary, that the next tolerance is ITS explicit choice, that this is
 * the market moving rather than the venue failing, and that a retry unchanged is
 * refused identically. Silently widening what a mission accepts is a money
 * decision, and money decisions are not made by a retry loop.
 *
 * The final sentence is the one shipped caution this must never contradict
 * (`engine/prompts/protocols.ts`): on a chain whose indexed reserves are stale,
 * a strongly negative priceImpact means the QUOTE is wrong, and more tolerance
 * buys a worse fill rather than a fill. It is venue-gated by
 * `staleReserveCaution` because the sign it depends on is not universal — see
 * that field.
 */
export function slippageRemediation(input: SlippageRemediationInput): string {
  return `Re-quote and retry with a higher slippageBps that YOU choose explicitly — `
    + `${appliedTolerancePhrase(input.appliedBps)}, and Vex rejects anything above ${input.maxBps} rather than clamping it. `
    + `Vex never raises it for you: exactly one attempt was made, at the tolerance this call passed. `
    + observedImpactPhrase(input)
    + `Raise it in steps; every increase widens the worst-case price you accept. `
    + `This is the market moving, not the venue failing — retrying unchanged will be refused the same way.`
    + (input.staleReserveCaution
      ? ` One exception: if the fresh quote's priceImpact is strongly negative (output supposedly worth more than input), `
        + `the venue is pricing off stale reserves and more tolerance would only buy a worse fill — re-quote or switch venue instead.`
      : "");
}

function appliedTolerancePhrase(appliedBps: number | null): string {
  return appliedBps === null
    ? "this attempt set no slippageBps of its own, so the venue applied its default"
    : `this attempt used ${appliedBps}`;
}

/**
 * "Observed price impact 0.15%, this attempt used 50 bps. " — the two numbers
 * side by side, because an impact the tolerance already covered points at a
 * moving pool while an impact far above it points at a route that cannot fill.
 * Empty when the venue reported no usable impact, or the applied tolerance is
 * the venue's unknown default: half a comparison is worse than none.
 */
function observedImpactPhrase(input: SlippageRemediationInput): string {
  const fraction = input.observedPriceImpactFraction;
  if (fraction === undefined || fraction === null || !Number.isFinite(fraction)) return "";
  if (input.appliedBps === null) return `Observed price impact ${(fraction * 100).toFixed(2)}%. `;
  return `Observed price impact ${(fraction * 100).toFixed(2)}%, this attempt used ${input.appliedBps} bps. `;
}
