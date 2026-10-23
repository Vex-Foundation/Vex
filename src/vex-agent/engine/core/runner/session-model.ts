/**
 * The session's model (F06): which catalogue model a session turn runs on.
 *
 * Every agent-mode entry point (the interactive turn, the wake continuation,
 * the gated resume, the mission-session drafting turn) loads its config here
 * instead of calling `provider.loadConfig()` bare, so the operator's pick
 * reaches the turns nobody typed.
 *
 * The model is the turn's own pick (`override`, an interactive chat turn),
 * else the session's persisted pick (`sessions.model_*`, migration 182), else
 * the default (`AGENT_MODEL`). Two ways a pick can fail to apply, kept apart
 * on purpose (owner decision, 2026-10-23):
 *
 *  - BACKEND CHANGED. The pick was made under the other inference backend
 *    (bring-your-own-key OpenRouter vs Vex Inference). Switching backend is a
 *    global act that should not break every older session, so the turn runs
 *    on the default model and a `session_model_fallback` notice says so on
 *    the session's turn. Never silent.
 *  - DELISTED. The active backend's own catalogue no longer lists the pick.
 *    The turn fails with {@link SessionModelUnavailableError} naming the
 *    model, exactly as a delisted `AGENT_MODEL` stops today (`loadConfig`
 *    answers `null`). It never runs on another model behind the operator's
 *    back.
 *
 * THE SUMMARIZER CLAMP. Compaction and the memory judge run on the default
 * model, not the session's. A session on a larger window than the default
 * would hand the summarizer a prefix it cannot read, so the session's limit
 * is capped at the default model's window.
 */

import type { InferenceConfig, InferenceProvider } from "@vex-agent/inference/types.js";
import type { ProviderType } from "@vex-agent/inference/config.js";
import * as sessionModelRepo from "@vex-agent/db/repos/session-model.js";
import { emitSessionModelFallbackNotice } from "@vex-agent/inference/inference-notice-bus.js";
import logger from "@utils/logger.js";

/** All this module needs of a provider: which backend it is, and its configs. */
export type SessionModelProvider = Pick<InferenceProvider, "id" | "loadConfig">;

/** A model pick: the backend it was made under and the catalogue id. */
export interface SessionModelChoice {
  readonly provider: ProviderType;
  readonly modelId: string;
}

export type SessionModelUnavailableReason =
  /** The active backend's catalogue no longer lists the model. */
  | "delisted"
  /** A turn's own pick names a backend that is not the active one. */
  | "backend_changed";

/**
 * The session's model cannot run. Carries the model id and the backend only,
 * never provider text, so a caller can name the model to the operator.
 */
export class SessionModelUnavailableError extends Error {
  readonly code = "session_model_unavailable" as const;

  constructor(
    readonly modelId: string,
    readonly provider: string,
    readonly reason: SessionModelUnavailableReason,
  ) {
    super(
      reason === "delisted"
        ? `The session's model ${modelId} is no longer offered by ${provider}.`
        : `The session's model ${modelId} was picked for another inference backend than ${provider}.`,
    );
    this.name = "SessionModelUnavailableError";
  }
}

export interface LoadSessionInferenceConfigDeps {
  readonly readPick?: typeof sessionModelRepo.getSessionModel;
}

/**
 * Best-effort read of the persisted pick: a preference read must never fail
 * the turn. On a failed read the turn runs on the default, as before this
 * column existed.
 */
async function readPersistedPick(
  sessionId: string,
  deps: LoadSessionInferenceConfigDeps,
): Promise<SessionModelChoice | null> {
  try {
    const pick = await (deps.readPick ?? sessionModelRepo.getSessionModel)(sessionId);
    return pick === null ? null : { provider: pick.provider, modelId: pick.modelId };
  } catch (cause) {
    logger.warn("engine.session_model.read_failed", {
      sessionId,
      error: cause instanceof Error ? cause.message : String(cause),
    });
    return null;
  }
}

/** The default model's config, or the engine's long-standing refusal. */
async function loadDefaultConfig(provider: SessionModelProvider): Promise<InferenceConfig> {
  const config = await provider.loadConfig();
  if (!config) throw new Error("No inference config available");
  return config;
}

/**
 * The config a session turn runs with. `override` is the turn's own pick
 * (an interactive chat turn); without one the session's persisted pick
 * applies. Throws {@link SessionModelUnavailableError} for a pick the active
 * backend no longer lists; falls back to the default (with a notice) for a
 * persisted pick made under the other backend.
 */
export async function loadSessionInferenceConfig(
  provider: SessionModelProvider,
  sessionId: string,
  override?: SessionModelChoice,
  deps: LoadSessionInferenceConfigDeps = {},
): Promise<InferenceConfig> {
  if (override !== undefined && override.provider !== provider.id) {
    // The host validated the pick against the active backend's catalogue, so
    // this is a backend switch racing the submit. Refuse before anything is
    // written: running the operator's fresh pick on another model would be
    // exactly the silent substitution this module exists to prevent.
    throw new SessionModelUnavailableError(override.modelId, provider.id, "backend_changed");
  }

  const pick = override ?? (await readPersistedPick(sessionId, deps));
  if (pick === null) return loadDefaultConfig(provider);

  if (pick.provider !== provider.id) {
    const fallback = await loadDefaultConfig(provider);
    logger.info("engine.session_model.backend_fallback", {
      sessionId,
      pickedProvider: pick.provider,
      pickedModel: pick.modelId,
      activeProvider: provider.id,
      model: fallback.model,
    });
    emitSessionModelFallbackNotice({
      sessionId,
      provider: provider.id,
      model: fallback.model,
      pickedProvider: pick.provider,
      pickedModel: pick.modelId,
    });
    return fallback;
  }

  const picked = await provider.loadConfig({ model: pick.modelId });
  if (!picked) {
    logger.warn("engine.session_model.unavailable", {
      sessionId,
      provider: provider.id,
      model: pick.modelId,
    });
    throw new SessionModelUnavailableError(pick.modelId, provider.id, "delisted");
  }
  return clampToSummarizerWindow(provider, sessionId, picked);
}

/**
 * Cap a session model's window at the default (summarizer) model's, so every
 * compaction corpus fits the model that reads it. A failed default load
 * leaves the session's limit as loaded and logs it; the configured
 * `AGENT_CONTEXT_LIMIT` ceiling already applies to both.
 */
export async function clampToSummarizerWindow(
  provider: SessionModelProvider,
  sessionId: string,
  config: InferenceConfig,
): Promise<InferenceConfig> {
  let summarizer: InferenceConfig | null = null;
  try {
    summarizer = await provider.loadConfig();
  } catch (cause) {
    logger.warn("engine.session_model.summarizer_config_failed", {
      sessionId,
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }
  if (summarizer === null) {
    logger.warn("engine.session_model.summarizer_config_unavailable", {
      sessionId,
      model: config.model,
    });
    return config;
  }
  if (summarizer.model === config.model) return config;
  if (config.contextLimit <= summarizer.contextLimit) return config;
  logger.info("engine.session_model.context_clamped", {
    sessionId,
    model: config.model,
    modelContextLimit: config.contextLimit,
    summarizerModel: summarizer.model,
    contextLimit: summarizer.contextLimit,
  });
  return { ...config, contextLimit: summarizer.contextLimit };
}
