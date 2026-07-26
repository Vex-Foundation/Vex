/**
 * Provider registry — resolves and caches the active inference provider.
 *
 * Resolution priority:
 * 1. AGENT_PROVIDER env (explicit choice)
 * 2. OPENROUTER_API_KEY present → OpenRouter
 * 3. null (agent won't start)
 */

import type { InferenceProvider } from "./types.js";
import { loadEnvConfig } from "./config.js";
import { FailoverProvider } from "./failover.js";
import logger from "@utils/logger.js";

// ── Lazy imports (avoid loading unused provider dependencies) ────

async function createOpenRouterProvider(): Promise<InferenceProvider> {
  const { OpenRouterProvider } = await import("./openrouter.js");
  return new OpenRouterProvider();
}

/**
 * Wrap the resolved primary in a failover stack, adding the optional fallback
 * provider when BOTH `OPENROUTER_API_KEY_FALLBACK` and `AGENT_MODEL_FALLBACK`
 * are configured.
 *
 * The wrap is UNCONDITIONAL so there is exactly one code path in production.
 * A 1-deep stack is a pass-through: it re-throws the provider's own error
 * untouched and mirrors the primary's `id`/`displayName`/`model`, so an
 * install without a fallback behaves exactly as it did before this change.
 *
 * Constructing the fallback must never take down a working primary — a bad
 * fallback config is logged and dropped, not thrown.
 */
async function withFallback(primary: InferenceProvider): Promise<InferenceProvider> {
  const { fallbackApiKey, fallbackModel } = loadEnvConfig();
  if (fallbackApiKey === null || fallbackModel === null) {
    return new FailoverProvider([primary]);
  }

  try {
    const { OpenRouterProvider } = await import("./openrouter.js");
    const fallback = new OpenRouterProvider({
      apiKey: fallbackApiKey,
      model: fallbackModel,
      id: "openrouter-fallback",
      displayName: "OpenRouter (fallback)",
    });
    logger.info("inference.registry.fallback_enabled", {
      primaryId: primary.id,
      fallbackId: fallback.id,
    });
    return new FailoverProvider([primary, fallback]);
  } catch (err) {
    logger.warn("inference.registry.fallback_init_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return new FailoverProvider([primary]);
  }
}

const PROVIDER_FACTORIES: Record<string, () => Promise<InferenceProvider>> = {
  "openrouter": createOpenRouterProvider,
};

// ── Singleton cache with concurrency-safe dedup ─────────────────
//
// `cachedProvider` is the post-resolve happy-path read. `inFlight` dedups
// the FIRST resolve when multiple sessions hit a null cache concurrently;
// without dedup, parallel sessions could each instantiate their own provider
// before the first commits the cache.
//
// `generation` invalidates pending in-flight resolves on `resetProvider()`
// / `switchProvider()`: if generation moves between the start of a resolve
// and its commit, the resolve does NOT write to `cachedProvider` — a new
// resolve fires with the post-reset env.

let generation = 0;
let cachedProvider: InferenceProvider | null = null;
let inFlight: { gen: number; promise: Promise<InferenceProvider | null> } | null = null;

async function doResolve(): Promise<InferenceProvider | null> {
  const envConfig = loadEnvConfig();

  // 1. Explicit env var — fail fast on misconfiguration
  if (envConfig.agentProvider) {
    const factory = PROVIDER_FACTORIES[envConfig.agentProvider];
    if (!factory) {
      logger.error("inference.registry.unknown_provider", {
        provider: envConfig.agentProvider,
        supported: Object.keys(PROVIDER_FACTORIES),
      });
      return null;
    }
    try {
      const provider = await factory();
      logger.info("inference.registry.resolved", {
        provider: envConfig.agentProvider,
        source: "AGENT_PROVIDER",
      });
      return withFallback(provider);
    } catch (err) {
      logger.error("inference.registry.init_failed", {
        provider: envConfig.agentProvider,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  // 2. OpenRouter API key present
  if (envConfig.openrouterApiKey) {
    try {
      const provider = await createOpenRouterProvider();
      logger.info("inference.registry.resolved", {
        provider: "openrouter",
        source: "OPENROUTER_API_KEY",
      });
      return withFallback(provider);
    } catch (err) {
      logger.warn("inference.registry.openrouter_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.error("inference.registry.none_configured", {
    hint: "Set OPENROUTER_API_KEY and AGENT_MODEL",
  });
  return null;
}

/**
 * Resolve which provider to use based on ENV config.
 * Returns null if no provider is configured — agent should not start.
 *
 * Concurrency-safe: parallel callers share the same in-flight promise so
 * only one provider instance is created on first resolve. A `resetProvider()`
 * mid-flight invalidates the pending result via the generation token.
 */
export async function resolveProvider(): Promise<InferenceProvider | null> {
  if (cachedProvider) return cachedProvider;
  if (inFlight && inFlight.gen === generation) return inFlight.promise;

  const myGen = generation;
  const promise = doResolve().then((provider) => {
    // Commit cache only if no reset/switch happened while we were resolving.
    if (provider && myGen === generation) {
      cachedProvider = provider;
    }
    return provider;
  }).finally(() => {
    if (inFlight && inFlight.gen === myGen) {
      inFlight = null;
    }
  });
  inFlight = { gen: myGen, promise };
  return promise;
}

/** Get the cached provider. Must call resolveProvider() first. */
export function getActiveProvider(): InferenceProvider | null {
  return cachedProvider;
}

/**
 * Reset the cached provider. Used by `switchProvider()` for in-process
 * provider toggling and by tests that want a clean cache between cases.
 * The next `resolveProvider()` will re-read `process.env`.
 *
 * Bumping `generation` ensures any in-flight resolve from before the reset
 * does NOT commit its result to `cachedProvider` — callers that hit the
 * cache after the reset see a fresh resolve.
 */
export function resetProvider(): void {
  generation++;
  cachedProvider = null;
  inFlight = null;
}

/**
 * Switch the active provider in-process: set `AGENT_PROVIDER`, drop the
 * cached instance, and re-resolve. Returns the freshly-instantiated provider
 * (or `null` if `loadEnvConfig` rejects the value or the factory fails).
 *
 * Mutates `process.env.AGENT_PROVIDER` so subsequent `resolveProvider()`
 * calls (anywhere in the process) honour the choice. There is no rollback —
 * callers that need the previous selection should snapshot it first.
 */
export async function switchProvider(
  name: "openrouter",
): Promise<InferenceProvider | null> {
  process.env.AGENT_PROVIDER = name;
  resetProvider();
  return resolveProvider();
}
