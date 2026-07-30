/**
 * Pre-inference byte ceiling (C8).
 *
 * While a live compaction preparation suppresses the 0.88 barrier, mutating
 * tools keep running at high context pressure. The barrier is what normally
 * stops the tape from outgrowing the model's window, so bypassing it is only
 * safe if EVERY inference is first bounded: measure the request, project a
 * LOWER BOUND on the tokens it will cost, and refuse to issue it when that
 * bound already reaches the context limit.
 *
 * The direction of every approximation here is deliberate. The projection must
 * never under-count, because under-counting is what lets an over-limit request
 * reach the provider. Over-counting only makes compaction happen earlier than
 * strictly necessary.
 *
 * TWO CONSERVATIVE STEPS, BOTH JUSTIFIED
 *
 * 1. BYTES: `measureInferenceEnvelopeBytes` does not estimate. It serializes
 *    the request exactly as the provider SDK does (see
 *    `inference/openrouter/request-bytes.ts`), so the byte count is the real
 *    body, including tool definitions, normalized schemas, routing, reasoning,
 *    tool choice and sticky session id.
 *
 * 2. BYTES → TOKENS: `BYTES_PER_TOKEN_LOWER_BOUND = 1`. Every token the
 *    provider bills for is drawn from text present in that body, and no token
 *    is shorter than one UTF-8 byte, so `bytes / 1` bounds the token count from
 *    above. Chat-template scaffolding the body does not literally contain
 *    (role markers and turn delimiters, a handful of tokens per message) is
 *    covered many times over by the JSON structure the body DOES contain for
 *    each message (`{"role":"…","content":"…"}` is tens of bytes). This is why
 *    no separate per-message role-overhead constant exists: inventing one on
 *    top of an exact measurement would be a guess dressed as precision.
 *
 * A stronger (larger) `BYTES_PER_TOKEN_LOWER_BOUND` would make the ceiling
 * less trigger-happy, but it is a SAFETY constant: raise it only against a
 * cited provider measurement of the minimum bytes-per-token for the models we
 * route to, never against intuition.
 */

import type {
  InferenceConfig,
  InferenceRequestContext,
  ProviderMessage,
  ToolDefinition,
} from "@vex-agent/inference/types.js";
import { measureOpenRouterRequestBodyBytes } from "@vex-agent/inference/openrouter/request-bytes.js";

/**
 * Minimum UTF-8 bytes a billed prompt token can occupy. See the module doc —
 * changing this changes how aggressively compaction is forced.
 */
export const BYTES_PER_TOKEN_LOWER_BOUND = 1;

/**
 * Outcome of measuring a request.
 *
 * `unmeasurable` is not a failure to log and move past: the ceiling exists to
 * make barrier bypass safe, so a request whose size is unknown must not be
 * treated as safe. The caller falls back to the ordinary barrier.
 */
export type EnvelopeMeasurement =
  | { readonly kind: "measured"; readonly bytes: number }
  | { readonly kind: "unmeasurable"; readonly provider: string };

/**
 * Result of the ceiling check. `projectedTokensLowerBound` is reported on both
 * arms so the decision is loggable either way.
 */
export type PreInferenceCeilingOutcome =
  | { readonly kind: "ok"; readonly projectedTokensLowerBound: number }
  | { readonly kind: "breach"; readonly projectedTokensLowerBound: number };

/**
 * Measure the request that WOULD be sent for this envelope.
 *
 * Provider-specific by necessity — the byte count is only meaningful against a
 * real wire format. OpenRouter is the only provider in `inference/registry.ts`;
 * a second one must add its own exact measurement here rather than inherit
 * OpenRouter's, and until it does it measures as `unmeasurable`, which fails
 * closed to the ordinary barrier instead of guessing its wire size.
 */
export function measureInferenceEnvelopeBytes(args: {
  readonly providerMessages: ProviderMessage[];
  readonly tools: ToolDefinition[];
  readonly config: InferenceConfig;
  readonly context?: InferenceRequestContext;
}): EnvelopeMeasurement {
  if (args.config.provider !== "openrouter") {
    return { kind: "unmeasurable", provider: args.config.provider };
  }

  const bytes = measureOpenRouterRequestBodyBytes({
    messages: args.providerMessages,
    tools: args.tools,
    config: args.config,
    ...(args.context !== undefined && { context: args.context }),
  });
  if (bytes === null) {
    return { kind: "unmeasurable", provider: args.config.provider };
  }

  return { kind: "measured", bytes };
}

/**
 * Decide whether a measured request may be issued.
 *
 * Breach iff the projected token LOWER bound already reaches `contextLimit` —
 * at that point the request is provably at or over the window even under the
 * most generous tokenisation, so it must never be sent.
 *
 * A non-finite or non-positive `contextLimit` is a breach, not an "ok". A
 * `NaN` limit would make every ordinary `>=` comparison false and silently
 * disable the ceiling, which is the exact fail-OPEN mode this guard exists to
 * prevent.
 */
export function checkPreInferenceCeiling(args: {
  readonly envelopeBytes: number;
  readonly contextLimit: number;
}): PreInferenceCeilingOutcome {
  const projectedTokensLowerBound = Math.floor(
    args.envelopeBytes / BYTES_PER_TOKEN_LOWER_BOUND,
  );

  if (!Number.isFinite(args.contextLimit) || args.contextLimit <= 0) {
    return { kind: "breach", projectedTokensLowerBound };
  }
  if (!Number.isFinite(args.envelopeBytes) || args.envelopeBytes < 0) {
    return { kind: "breach", projectedTokensLowerBound };
  }
  if (projectedTokensLowerBound >= args.contextLimit) {
    return { kind: "breach", projectedTokensLowerBound };
  }
  return { kind: "ok", projectedTokensLowerBound };
}
