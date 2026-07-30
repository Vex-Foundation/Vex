/**
 * Bounding for the provider-reported completion facts the runtime persists and
 * logs — generation id, finish reason, canonical error type, routing provider
 * name.
 *
 * ("Signal" here means information the SDK reports about a completion. Nothing
 * in this module relates to `AbortSignal`.)
 *
 * WHY a boundary module. These three values come off a provider response, so
 * they are untrusted input (`rules/03`). They travel to real sinks: the
 * generation id and finish reason are INSERTed into `usage_log` (migration
 * 055) and all three reach log lines. The SDK's zod schemas already guarantee
 * "a string" — they do NOT guarantee a sane length, and two of the three are
 * OPEN enums (`ChatFinishReasonEnum`, `ApiErrorType` are `OpenEnum<…>` in the
 * installed @openrouter/sdk), so an unrecognized value is a legal response and
 * must survive rather than be coerced into a known member.
 *
 * REJECT rather than truncate. An over-long value is returned as `null`
 * ("provider reported nothing usable") instead of a sliced prefix. A truncated
 * generation id would not match anything in OpenRouter's activity log yet
 * would LOOK authoritative — a wrong answer is worse than a missing one when
 * the column exists to reconcile cost.
 *
 * These are opaque provider identifiers and enum labels: no prompt text, no
 * completion text, no key material. They are safe to persist and log as-is
 * within the caps below.
 */

/**
 * Cap for a generation id. OpenRouter's ids are `gen-<millis>-<suffix>`
 * (~30 chars); 128 leaves generous headroom without admitting a payload.
 */
const MAX_GENERATION_ID_LENGTH = 128;

/**
 * Cap for the enum-shaped labels. The longest member shipped in the installed
 * SDK is `unsupported_image_format` (24); 64 admits a plausible new member and
 * nothing resembling a message body.
 */
const MAX_ENUM_LABEL_LENGTH = 64;

function boundedLabel(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) return null;
  return trimmed;
}

/**
 * Provider generation id (`ChatResult.id` buffered, SSE chunk `id` streamed).
 * `null` when absent, non-string, empty, or implausibly long.
 */
export function boundedGenerationId(value: unknown): string | null {
  return boundedLabel(value, MAX_GENERATION_ID_LENGTH);
}

/**
 * Provider finish reason, carried VERBATIM — `ChatFinishReasonEnum` is an open
 * enum, so an unknown label is data, not an error. `null` when absent or
 * unusable.
 */
export function boundedFinishReason(value: unknown): string | null {
  return boundedLabel(value, MAX_ENUM_LABEL_LENGTH);
}

/**
 * Canonical OpenRouter error type from a mid-stream error chunk's
 * `metadata.errorType`. Also an open enum, also carried verbatim. The sibling
 * `metadata.providerCode` is deliberately NOT read anywhere: it is free-form
 * upstream text with no bounded vocabulary.
 */
export function boundedErrorType(value: unknown): string | null {
  return boundedLabel(value, MAX_ENUM_LABEL_LENGTH);
}

/**
 * Upstream provider name from routing metadata (`EndpointInfo.provider` on the
 * `selected` endpoint, or `RouterAttempt.provider`), e.g. `DeepInfra`,
 * `Baidu`. Persisted to `usage_log.serving_provider` (migration 059) as the
 * per-request routing provenance, and logged. Note it is the router's provider
 * NAME, not the routable endpoint `tag` — the installed SDK's `EndpointInfo`
 * carries no tag. `null` when absent or unusable.
 */
export function boundedProviderName(value: unknown): string | null {
  return boundedLabel(value, MAX_ENUM_LABEL_LENGTH);
}

/**
 * `error.metadata.limit_source` off a 429 — WHERE the limit was applied.
 * LIVE-VERIFIED (probe `provider-429-layer`, 2026-07-29,
 * `agents_dm/runtime-harness/fixtures/openrouter-429-shape.json`): a real 429
 * carried `limit_source: "upstream_provider_shared_pool"` with
 * `provider_error_code: "engine_overloaded"`, while a sibling endpoint of the
 * same model served the identical request in the same minute.
 *
 * This is the ONLY field that distinguishes "the upstream endpoint's shared
 * pool is saturated" (switching endpoints helps) from an account/key/credit
 * limit (switching helps NOTHING and would burn an attempt on every endpoint),
 * so it is a ROUTING input, not decoration — see
 * `endpoint-failover/capacity-failure.ts`. Undocumented open vocabulary:
 * carried verbatim within the label cap, classified with a total default.
 */
export function boundedLimitSource(value: unknown): string | null {
  return boundedLabel(value, MAX_ENUM_LABEL_LENGTH);
}

/**
 * `error.metadata.provider_error_code` — the UPSTREAM provider's own code
 * (e.g. `engine_overloaded`). Free-form-ish but short and enum-shaped in
 * practice; kept as a secondary capacity signal for the case where
 * `limit_source` is absent. Distinct from `metadata.providerCode` on a
 * mid-stream error chunk, which is deliberately never carried (see
 * `errors.ts`): that one is a free-text field with no bounded vocabulary,
 * whereas this one is read ONLY through the closed classifier and never
 * rendered as user-facing copy.
 */
export function boundedProviderErrorCode(value: unknown): string | null {
  return boundedLabel(value, MAX_ENUM_LABEL_LENGTH);
}
