/**
 * Inference configuration — ENV validation at startup.
 *
 * All configurable values come from .env — validated on load, fail fast.
 * Internal technical constants (timeouts, retry params) are NOT from ENV.
 *
 * M9 refactor: AGENT_ range plus default constants moved to
 * `src/lib/agent-config.ts` (single source of truth, shared with
 * vex-app onboarding writers). Engine behavior preserved:
 *  - AGENT_ keys: parse errors aggregated and thrown (combined message).
 *
 * @see Team Standards §16.1 Config as code, §16.2 Validation at startup
 */

import {
  AGENT_CONTEXT_LIMIT,
  AGENT_MAX_OUTPUT_TOKENS,
  AGENT_TEMPERATURE,
  parseAgentEnv,
} from "../../lib/agent-config.js";
import logger from "@utils/logger.js";

// ── ENV-loaded config (validated at startup) ─────────────────────

export type ProviderType = "openrouter";

export interface EnvConfig {
  /** Explicit provider choice — auto-detected if not set */
  agentProvider: ProviderType | null;
  /** Context window size in tokens */
  contextLimit: number;
  /** OpenRouter API key — required if provider=openrouter */
  openrouterApiKey: string | null;
  /** Model ID — required for OpenRouter */
  agentModel: string | null;
  /**
   * Optional pinned OpenRouter endpoint `tag` (`OPENROUTER_ENDPOINT_TAG`),
   * written by the wizard's provider select. `null` ⇒ "Auto": OpenRouter's own
   * routing, which is also the only mode where its sticky `session_id` applies.
   * Never validated against a list here — the wizard authorises the tag before
   * persisting it, and an endpoint that later disappears must surface as a
   * loud routing failure, not a silent fallback.
   */
  openrouterEndpointTag: string | null;
  /** Sampling temperature — OpenRouter only */
  temperature: number | null;
  /** Max output tokens per response */
  maxOutputTokens: number;
}

const VALID_PROVIDERS = new Set<string>(["openrouter"]);

/**
 * Load and validate all inference ENV variables.
 * Fail fast on invalid values — agent should not start with bad config.
 */
export function loadEnvConfig(): EnvConfig {
  const errors: string[] = [];

  // AGENT_PROVIDER (optional — auto-detected). Local validation —
  // this field is not in agent-config.ts because it's an enum, not a
  // numeric range.
  const rawProvider = process.env.AGENT_PROVIDER?.toLowerCase().trim() ?? null;
  let agentProvider: ProviderType | null = null;
  if (rawProvider !== null) {
    if (!VALID_PROVIDERS.has(rawProvider)) {
      errors.push(`AGENT_PROVIDER="${rawProvider}" is invalid. Must be: openrouter`);
    } else {
      agentProvider = rawProvider as ProviderType;
    }
  }

  // OPENROUTER_API_KEY + AGENT_MODEL — strings, no numeric validation.
  const openrouterApiKey = process.env.OPENROUTER_API_KEY?.trim() ?? null;
  const agentModel = process.env.AGENT_MODEL?.trim() ?? null;
  const rawEndpointTag = process.env.OPENROUTER_ENDPOINT_TAG?.trim() ?? "";
  const openrouterEndpointTag = rawEndpointTag.length > 0 ? rawEndpointTag : null;

  // AGENT_CONTEXT_LIMIT / AGENT_MAX_OUTPUT_TOKENS / AGENT_TEMPERATURE —
  // delegated to shared parser (returns collected ParseErrors so we
  // preserve the "throw all at once" engine contract).
  const agentParse = parseAgentEnv(process.env);
  for (const e of agentParse.errors) {
    if (e.reason === "out_of_range") {
      errors.push(
        `${e.key}="${e.raw}" is invalid. Must be ${e.detail?.min ?? "?"}-${e.detail?.max ?? "?"}`,
      );
    } else {
      errors.push(`${e.key}="${e.raw}" is invalid. Must be a number`);
    }
  }

  if (errors.length > 0) {
    for (const err of errors) {
      logger.error("inference.config.validation_failed", { error: err });
    }
    throw new Error(`Inference config validation failed:\n${errors.join("\n")}`);
  }

  return {
    agentProvider,
    contextLimit: agentParse.value.contextLimit,
    openrouterApiKey,
    agentModel,
    openrouterEndpointTag,
    temperature: agentParse.value.temperature,
    maxOutputTokens: agentParse.value.maxOutputTokens,
  };
}

// ── Re-exports of public field metadata ──────────────────────────
// vex-app onboarding imports from `src/lib/agent-config.ts` directly.
// These are kept here for
// backward compatibility with any in-tree consumer that already
// imports from this module.
export { AGENT_CONTEXT_LIMIT, AGENT_MAX_OUTPUT_TOKENS, AGENT_TEMPERATURE };

// ── Internal constants (not from ENV — technical invariants) ─────

/** Streaming inference timeout (5 min) */
export const INFERENCE_TIMEOUT_MS = 300_000;

/** Non-streaming inference timeout (2 min) */
export const INFERENCE_SIMPLE_TIMEOUT_MS = 120_000;

/** Balance cache TTL (30s) */
export const BALANCE_CACHE_TTL_MS = 30_000;

/**
 * Model config (pricing) cache TTL (1h). `loadConfig()` runs per turn but the
 * underlying `/models` pricing is stable, so a successful fetch is reused for
 * this long before a refresh. Bounds cost-estimate staleness while removing the
 * per-turn `/models` round-trip (F4). Pricing here feeds cost accounting only.
 */
export const MODEL_CONFIG_CACHE_TTL_MS = 3_600_000;

/**
 * Minimum gap between `/models` refresh attempts while serving a STALE last-good
 * config after a transient metadata failure (F4). Prevents every subsequent turn
 * from blocking on a failing `/models` refetch during an OpenRouter outage — we
 * serve the last-good config immediately and re-attempt at most this often.
 */
export const MODEL_CONFIG_STALE_RETRY_MS = 30_000;

/** OpenRouter app URL for rankings */
export const OPENROUTER_APP_URL = "https://vexlabs.ai";

/** OpenRouter app display name */
export const OPENROUTER_APP_TITLE = "Vex Agent";

/** OpenRouter app category */
export const OPENROUTER_APP_CATEGORY = "cli-agent";

/** OpenRouter low balance threshold (USD) */
export const OPENROUTER_LOW_BALANCE_USD = 5.0;

/** OpenRouter SDK timeout (5 min) */
export const OPENROUTER_SDK_TIMEOUT_MS = 300_000;

/** Retry: max attempts for inference calls */
export const INFERENCE_MAX_RETRIES = 2;

/** Retry: initial backoff delay */
export const INFERENCE_BASE_DELAY_MS = 2000;

/** Retry: max backoff delay */
export const INFERENCE_MAX_DELAY_MS = 15_000;
