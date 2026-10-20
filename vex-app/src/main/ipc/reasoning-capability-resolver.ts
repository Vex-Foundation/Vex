/**
 * Shared reasoning-capability resolver (S6/D3/D7) — the ONE fallback chain
 * both `models.ts` (global model list) and `sessions/get-model.ts`
 * (per-session echo of the same global model) use to resolve
 * `ModelOptionDto.reasoning` / `SessionModelDto.reasoning`. Extracted out of
 * `sessions/get-model.ts` (its original owner) so a single tested resolver
 * backs both IPC channels instead of two independently-maintained copies —
 * the drift pin test in `ipc-handler-surface/models-sessions.test.ts`
 * asserts both channels return identical capability for the same model id.
 *
 * Fallback chain (D3, in order):
 *  1. Capability entry exists, `reasoning` non-null → return it verbatim,
 *     `supportsReasoning: true`.
 *  2. Capability entry exists, `reasoning` null → boolean-only
 *     `supportsReasoning` from `supportsReasoningParameter`, `reasoning: null`
 *     (no selector — nothing to select from).
 *  3. Capability entry absent (fetch failed, or the model isn't in the
 *     catalog) → fall back to the pre-S6 pricing-proxy probe for
 *     `supportsReasoning` only; `reasoning` stays `null`.
 */

import type { ReasoningCapability } from "@shared/schemas/reasoning.js";
import { activeInferenceProviderMode } from "../vex-cloud/active-mode.js";

/**
 * Upper bound for the pre-S6 pricing-proxy PROBE ONLY
 * (`resolveSupportsReasoning`, the FALLBACK used when the reasoning-
 * capability catalog has no entry for the model). `loadConfig()` is
 * TTL-cached inside the provider, so the warm path resolves immediately;
 * this timeout guards the cold path, which has no bounded timeout of its
 * own. It does NOT bound the PRIMARY D3/D7 path
 * (`resolveReasoningCapability` → `getModelReasoningCapability`): that call
 * is awaited directly and is instead bounded by the catalogue's own fetch
 * timeout (15s, fail-open to `null` on failure) — so a cold capability
 * cache delays the caller's response rather than returning "unknown" and
 * relying on a later renderer refetch to pick it up.
 */
const REASONING_PROBE_TIMEOUT_MS = 3_000;

/**
 * Resolve whether the active model supports reasoning, from the same
 * engine inference config the chat turn uses (`reasoningPricePerM` comes
 * from the OpenRouter catalog's internal-reasoning pricing). Fail-open to
 * `null` ("unknown" → control hidden) on every degraded path: provider
 * unresolved (vault locked / unconfigured), config unavailable, probe
 * timeout, or unexpected import failure.
 *
 * Pre-S6 pricing proxy — kept as the FALLBACK when the reasoning-capability
 * catalog (below) has no entry for the model at all (its own fetch failed).
 * It only ever answers the coarse boolean question; it never has per-model
 * effort levels.
 */
async function resolveSupportsReasoning(): Promise<boolean | null> {
  try {
    const { resolveProvider } = await import(
      "@vex-agent/inference/registry.js"
    );
    const provider = await resolveProvider();
    if (provider === null) return null;
    const config = await Promise.race([
      provider.loadConfig().catch(() => null),
      new Promise<null>((resolve) => {
        const timer = setTimeout(() => resolve(null), REASONING_PROBE_TIMEOUT_MS);
        // Never keep the process alive for a lost race.
        timer.unref();
      }),
    ]);
    if (config === null) return null;
    return config.reasoningPricePerM !== null;
  } catch {
    return null;
  }
}

/**
 * D3 + D7: resolve the per-model reasoning capability for `modelId` from
 * the onboarding catalogue's reasoning-capability map (built from the SAME
 * `/models` fetch a response hook already reads — see
 * `provider-model-catalog.ts`). AWAITS that bounded (15s, fail-open) fetch
 * so a cold cache never leaves the selector silently absent (D7) — this
 * only delays the caller's response, never session opening or the models
 * list.
 */
export async function resolveReasoningCapability(
  modelId: string,
  signal: AbortSignal,
): Promise<{
  readonly reasoning: ReasoningCapability | null;
  readonly supportsReasoning: boolean | null;
}> {
  try {
    const { getModelReasoningCapability } = await import(
      "../onboarding/provider-model-catalog.js"
    );
    // The catalogue of the backend the engine actually talks to: in Vex Cloud
    // mode its `/v1/models` publishes `mandatory: true` without `none`, so
    // the selector never offers Off there.
    const source = activeInferenceProviderMode();
    const entry = await getModelReasoningCapability(modelId, { signal, source });
    if (entry !== null) {
      return {
        reasoning: entry.reasoning,
        supportsReasoning:
          entry.reasoning !== null ? true : entry.supportsReasoningParameter,
      };
    }
  } catch (cause) {
    // A caller abort (`ctx.signal` fired — user cancelled, or the request
    // is being superseded) must propagate immediately so `registerHandler`
    // can normalise it to `internal.cancelled` promptly. Falling through to
    // the pricing-proxy fallback here would ignore the cancellation and run
    // extra work (`resolveProvider` + a second bounded probe) nobody is
    // waiting on anymore. Every OTHER failure (network error, malformed
    // catalog response, etc.) still falls through to the fallback below.
    if (cause instanceof Error && cause.name === "AbortError") throw cause;
  }
  return { reasoning: null, supportsReasoning: await resolveSupportsReasoning() };
}
