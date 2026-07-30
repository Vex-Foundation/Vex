/**
 * Endpoint failover — the retry-and-switch policy for capacity failures.
 *
 * THE PROBLEM. `OPENROUTER_ENDPOINT_TAG` pins routing with
 * `order:[tag] + allowFallbacks:false`, so exactly ONE endpoint is eligible.
 * The SDK does not retry 429 (`retryCodes` defaults to `["5XX"]`), and a chat
 * turn has no retry wrapper of its own, so a single upstream rate-limit ended
 * the turn in the user's face. Live probe `provider-429-layer` (2026-07-29)
 * showed the limit was ENDPOINT-level: `deepinfra/fp4` returned 429 on 4/4
 * turn-sized calls while `baidu/fp8` served the identical request in the same
 * minute.
 *
 * THE POLICY (owner decisions 1-3 and 8-10):
 *  - retry ONLY capacity-class failures (`endpoint-failover/capacity-failure.ts`);
 *    everything else propagates on attempt one, exactly as before;
 *  - after TWO consecutive capacity failures in a session, switch to the
 *    sibling endpoint of the same model with the HIGHEST UPTIME;
 *  - a 429 whose `limit_source` says the limit was applied to our ACCOUNT is
 *    retried but never switched — no endpoint can escape it;
 *  - the switch is STICKY for the rest of the session: later failures retry in
 *    place rather than rotating, which bounds the interaction with mission
 *    auto-retry and protects the provider's prompt-cache prefix;
 *  - the switch is PERSISTED FIRST and read back through: the durable row is
 *    written BEFORE the switch is adopted in memory, and a session missing from
 *    the in-memory map (restart, LRU eviction) hydrates from that row before any
 *    retry/switch decision. The map is a cache; `session_endpoint_switches`
 *    (migration 059) is the truth. A failed write does NOT abort the turn we are
 *    rescuing — it is logged loudly, the switch is adopted anyway, and the write
 *    is RETRIED on subsequent requests until the durable truth materialises.
 *    Never swallowed silently;
 *  - on switching, price and context window are RE-RESOLVED from the new
 *    endpoint, because sibling endpoints of one model differ in both and a
 *    stale price would put a knowingly wrong number in `usage_log.cost`.
 *
 * This module is the public entry point; the pieces live in the sibling folder
 * of the same name (classification, backoff policy, candidate catalogue,
 * session state).
 */

import type {
  EndpointCandidate,
  InferenceConfig,
  InferenceRequestContext,
} from "../types.js";
import { resolveEffectiveContextLimit } from "../context-window.js";
import logger from "@utils/logger.js";
import {
  getLatestEndpointSwitch,
  recordEndpointSwitch,
} from "../../db/repos/session-endpoint-switches.js";

import {
  classifyCapacityFailure,
  type CapacityFailure,
} from "./endpoint-failover/capacity-failure.js";
import {
  CONSECUTIVE_FAILURES_BEFORE_SWITCH,
  MAX_CAPACITY_ATTEMPTS,
  nextRetryDelayMs,
} from "./endpoint-failover/retry-policy.js";
import {
  adoptPersistedSwitch,
  clearPersistPending,
  commitEndpointSwitch,
  getPersistPending,
  getSwitchedEndpointTag,
  hasSwitched,
  isHydrated,
  markHydrated,
  markPersistPending,
  recordCapacityFailure,
  recordCapacitySuccess,
} from "./endpoint-failover/session-endpoint-state.js";

export type { EndpointCandidate };
export { classifyCapacityFailure } from "./endpoint-failover/capacity-failure.js";
export type {
  CapacityFailure,
  CapacityFailureClass,
} from "./endpoint-failover/capacity-failure.js";
export {
  clearSessionEndpointState,
  getSwitchedEndpointTag,
  resetAllSessionEndpointState,
} from "./endpoint-failover/session-endpoint-state.js";

/**
 * How the failover reaches the world. Injected rather than imported so the
 * policy is testable without a network, a database or a clock.
 */
export interface EndpointFailoverDeps {
  /**
   * Candidate endpoints for the configured model, ranked highest-uptime-first.
   * Called only on the failure path and when re-resolving a sticky switch.
   */
  readonly loadCandidates: () => Promise<readonly EndpointCandidate[]>;
  /** Injected for tests; defaults to a real timer. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injected for tests; defaults to the `session_endpoint_switches` repo. */
  readonly persistSwitch?: typeof recordEndpointSwitch;
  /**
   * Durable read-through for stickiness across a restart or an LRU eviction.
   * Injected for tests; defaults to the `session_endpoint_switches` repo.
   */
  readonly loadPersistedSwitch?: typeof getLatestEndpointSwitch;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Deps produced by a provider that knows how to read its own endpoint
 * catalogue, or an empty-candidate fallback when it does not.
 *
 * WHY STRUCTURAL. The real producer is `OpenRouterProvider.failoverDeps()`, but
 * the callers that need it most hold a provider through a LOOSE structural
 * interface (`JudgeProvider`) rather than the concrete class — every background
 * branch does. Importing the concrete provider into those modules to get a type
 * would drag the whole OpenRouter surface into code that deliberately depends
 * on three methods, so the producer is detected by shape instead, at the
 * boundary, without a cast (`rules/03`).
 *
 * TOTAL by construction: a test double, a stub, or any other provider yields
 * the empty-candidate deps. That is degraded, not broken — the seam still
 * honours the session's switched endpoint TAG, which is the whole of owner
 * decision 4; only the price/context re-resolve falls back to model-level
 * values.
 */
export function endpointFailoverDepsFrom(source: unknown): EndpointFailoverDeps {
  if (typeof source === "object" && source !== null) {
    const candidate = source as { failoverDeps?: unknown };
    if (typeof candidate.failoverDeps === "function") {
      const produced: unknown = candidate.failoverDeps.call(source);
      if (
        typeof produced === "object" &&
        produced !== null &&
        typeof (produced as EndpointFailoverDeps).loadCandidates === "function"
      ) {
        return produced as EndpointFailoverDeps;
      }
    }
  }
  return { loadCandidates: async () => [] };
}

/**
 * Read-through: recover a session's switch from the durable table when the
 * in-memory map has no entry for it.
 *
 * WHY THIS IS THE FIRST THING ANY DECISION DOES. The map does not survive a
 * restart, and LRU eviction can drop an entry from a live process. Without this
 * read the session would look un-switched, route back to the pinned endpoint
 * that already ran out of capacity, fail twice more, and switch a SECOND time —
 * writing a second row, burning two more attempts, and abandoning the prompt
 * cache again. Stickiness has to be anchored in the durable row, not in the
 * cache of it.
 *
 * Costs ONE query per session per process: the hydrated flag is set either way,
 * including for a session that never switched.
 *
 * Best-effort by design: if the table cannot be read we log and proceed as
 * un-switched. That is the pre-existing behaviour, not a new failure mode, and
 * refusing the turn because a provenance table is unavailable would be worse.
 */
async function hydrateSessionEndpoint(
  sessionId: string,
  deps: EndpointFailoverDeps,
): Promise<void> {
  if (isHydrated(sessionId)) return;
  try {
    const persisted = await (deps.loadPersistedSwitch ?? getLatestEndpointSwitch)(
      sessionId,
    );
    if (persisted === null) {
      markHydrated(sessionId);
      return;
    }
    adoptPersistedSwitch(sessionId, persisted.newEndpoint);
    logger.info("inference.openrouter.endpoint_switch_rehydrated", {
      sessionId,
      endpointTag: persisted.newEndpoint,
      switchedAt: persisted.createdAt,
      reasonClass: persisted.reasonClass,
    });
  } catch (err) {
    logger.warn("inference.openrouter.endpoint_switch_hydrate_failed", {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Retry a durable write this session still owes.
 *
 * A switch is adopted in memory even when its write failed, because a
 * persistence failure must not kill the turn being rescued. That leaves the
 * durable truth missing, so every subsequent request for the session re-attempts
 * the write until it lands — which is what makes "persist the switch" true
 * rather than best-effort. Cheap: does nothing at all unless a write is owed.
 */
async function flushPendingPersist(
  sessionId: string,
  deps: EndpointFailoverDeps,
): Promise<void> {
  const pending = getPersistPending(sessionId);
  if (pending === null) return;
  try {
    await (deps.persistSwitch ?? recordEndpointSwitch)(pending);
    clearPersistPending(sessionId);
    logger.info("inference.openrouter.endpoint_switch_persist_recovered", {
      sessionId,
      newEndpoint: pending.newEndpoint,
    });
  } catch (err) {
    logger.warn("inference.openrouter.endpoint_switch_persist_retry_failed", {
      sessionId,
      newEndpoint: pending.newEndpoint,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Candidates the request should choose from: the INJECTED list when the app's
 * endpoint catalogue supplied one (the producer contract — that catalogue is
 * what the user actually picked from, so a switch must not land outside it),
 * otherwise the runtime's own read of the same route.
 */
async function candidatesFor(
  config: InferenceConfig,
  deps: EndpointFailoverDeps,
): Promise<readonly EndpointCandidate[]> {
  const injected = config.endpointCandidates;
  if (injected !== undefined && injected.length > 0) return injected;
  return deps.loadCandidates();
}

/**
 * Stamp an endpoint onto a config copy, re-resolving what the endpoint owns
 * (owner decision 7).
 *
 * CONTEXT: clamped through the SAME `resolveEffectiveContextLimit` the model
 * catalogue uses, so the endpoint window can only ever LOWER the limit the
 * engine bands against — never raise it above what the operator configured or
 * the model accepts.
 *
 * PRICE: overridden only where the candidate reports a value. A `null` from the
 * catalogue means "unreported", not "free"; keeping the model-level price is
 * the honest fallback, and inventing a 0 would put a false number in
 * `usage_log.cost`. Note `usage.cost` from the provider stays authoritative
 * where present — this table is the local cross-check.
 */
export function applyEndpointToConfig(
  config: InferenceConfig,
  candidate: EndpointCandidate,
): InferenceConfig {
  const contextLimit = resolveEffectiveContextLimit(
    config.contextLimit,
    candidate.contextLength,
  );

  return {
    ...config,
    endpointTag: candidate.tag,
    contextLimit: contextLimit.effective,
    inputPricePerM: candidate.inputPricePerM ?? config.inputPricePerM,
    outputPricePerM: candidate.outputPricePerM ?? config.outputPricePerM,
    cachePricePerM: candidate.cachePricePerM ?? config.cachePricePerM,
    cacheWritePricePerM: candidate.cacheWritePricePerM ?? config.cacheWritePricePerM,
    reasoningPricePerM: candidate.reasoningPricePerM ?? config.reasoningPricePerM,
  };
}

/**
 * The session's CURRENT effective config: the operator's pin, or the endpoint
 * this session already switched to, with price and context window resolved for
 * whichever it is.
 *
 * THIS IS THE SEAM other subsystems call (owner decision 4). Compaction — both
 * the summary and the chunk branches — must run against the session's current
 * endpoint, not the stale pin, or it bands against the wrong context window and
 * bills against the wrong price table. Any caller holding an `InferenceConfig`
 * and a session id can pass them through here before use.
 *
 * Cheap and safe to call per request: it does nothing at all until the session
 * has actually switched.
 */
export async function resolveSessionInferenceConfig(
  config: InferenceConfig,
  sessionId: string | null,
  deps: EndpointFailoverDeps,
): Promise<InferenceConfig> {
  if (sessionId === null) return config;
  // Read through to the durable row first: after a restart or an eviction the
  // map has no entry, and answering "not switched" here would hand the caller
  // the stale pin.
  await hydrateSessionEndpoint(sessionId, deps);
  const tag = getSwitchedEndpointTag(sessionId);
  if (tag === null) return config;
  if (tag === config.endpointTag) return config;

  const candidate = (await candidatesFor(config, deps)).find((c) => c.tag === tag);
  if (candidate === undefined) {
    // The catalogue no longer lists the endpoint we switched to (delisted, or
    // the read failed). Routing still honours the switch — dropping back to the
    // pin would send the session straight back to the endpoint that failed —
    // but price and window stay at the model-level values, which is a KNOWN
    // and logged approximation rather than a silent one.
    logger.warn("inference.openrouter.switched_endpoint_not_in_catalog", {
      sessionId,
      model: config.model,
      endpointTag: tag,
    });
    return { ...config, endpointTag: tag };
  }
  return applyEndpointToConfig(config, candidate);
}

/**
 * Highest-uptime endpoint that is not the one we are already on, or `null` when
 * there is nothing to switch to.
 */
export function selectSwitchTarget(
  candidates: readonly EndpointCandidate[],
  currentTag: string | undefined,
): EndpointCandidate | null {
  // `loadCandidates` returns the list already ranked highest-uptime-first, so
  // the first eligible row IS the highest-uptime one.
  return candidates.find((candidate) => candidate.tag !== currentTag) ?? null;
}

/**
 * Write the durable row BEFORE the switch is adopted in memory, and report
 * whether it landed.
 *
 * PERSIST-FIRST because the durable row is the authority for stickiness (see
 * `hydrateSessionEndpoint`): adopting first and writing later leaves a window in
 * which a crash loses the switch entirely, and the session comes back on the
 * endpoint that failed.
 *
 * A failure returns `false` rather than throwing. The caller then adopts the
 * switch ANYWAY and parks the record for retry — the money-path rule that a
 * failure in provenance must not kill the operation it describes, applied here
 * to a turn we are in the middle of rescuing. What it must never be is silent:
 * the failure is logged at warn with the record, and every later request for the
 * session re-attempts the write until it lands.
 */
async function persistSwitchFirst(
  deps: EndpointFailoverDeps,
  record: Parameters<typeof recordEndpointSwitch>[0],
): Promise<boolean> {
  try {
    await (deps.persistSwitch ?? recordEndpointSwitch)(record);
    return true;
  } catch (err) {
    logger.warn("inference.openrouter.endpoint_switch_persist_failed", {
      sessionId: record.sessionId,
      model: record.model,
      previousEndpoint: record.previousEndpoint,
      newEndpoint: record.newEndpoint,
      reasonClass: record.reasonClass,
      willRetry: true,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Run one send through the failover policy.
 *
 * `attempt` receives the config to use — which may differ from the one passed
 * in, because a switch re-resolves the endpoint, the price table and the
 * context window. Callers must use the config they are HANDED, not the one they
 * closed over, or they will bill a switched request at the old endpoint's rate.
 *
 * Wrapping the send (not the whole turn) is deliberate: one implementation then
 * covers the streaming path, the buffered path, and the stream→buffered
 * fallback, and a mid-stream failure — after bytes have already reached the
 * user — is NOT retried here, because replaying it would duplicate content.
 */
export async function sendWithEndpointFailover<T>(
  attempt: (config: InferenceConfig) => Promise<T>,
  config: InferenceConfig,
  context: InferenceRequestContext | undefined,
  deps: EndpointFailoverDeps,
): Promise<T> {
  const sessionId = context?.sessionId ?? null;
  const sleep = deps.sleep ?? defaultSleep;

  // Settle any durable write a previous switch still owes, before this request
  // can add another decision on top of an unrecorded one.
  if (sessionId !== null) await flushPendingPersist(sessionId, deps);

  // Hydrates from the durable row on a map miss, so the config below is the
  // session's real current endpoint even right after a restart.
  let effectiveConfig = await resolveSessionInferenceConfig(config, sessionId, deps);
  // Background one-shots carry no session, so they get bounded retry with no
  // switch and no persistence: there is no session to make sticky and no row to
  // attribute the switch to.
  let attemptsMade = 0;
  let localFailures = 0;

  for (;;) {
    try {
      const result = await attempt(effectiveConfig);
      if (sessionId !== null) recordCapacitySuccess(sessionId);
      return result;
    } catch (err) {
      const failure = classifyCapacityFailure(err);
      if (failure === null) throw err;

      attemptsMade += 1;
      const consecutiveFailures =
        sessionId !== null ? recordCapacityFailure(sessionId) : (localFailures += 1);

      logger.warn("inference.openrouter.capacity_failure", {
        model: effectiveConfig.model,
        endpointTag: effectiveConfig.endpointTag ?? null,
        reasonClass: failure.reasonClass,
        switchable: failure.switchable,
        retryAfterSeconds: failure.retryAfterSeconds,
        attemptsMade,
        consecutiveFailures,
      });

      if (attemptsMade >= MAX_CAPACITY_ATTEMPTS) throw err;

      const switched = await maybeSwitch({
        sessionId,
        failure,
        consecutiveFailures,
        baseConfig: config,
        effectiveConfig,
        deps,
      });
      if (switched !== null) {
        effectiveConfig = switched;
        // A switch IS the retry — sitting out the old endpoint's backoff on a
        // different endpoint would be pure latency.
        continue;
      }

      const delayMs = nextRetryDelayMs(attemptsMade, failure.retryAfterSeconds);
      // No usable wait (the advertised one is longer than we will hold a turn
      // for) and nowhere to switch: surface the provider's own error. The
      // session's failure count survives, so the NEXT turn's failure is the
      // second consecutive one and does switch.
      if (delayMs === null) throw err;
      await sleep(delayMs);
    }
  }
}

interface SwitchAttempt {
  readonly sessionId: string | null;
  readonly failure: CapacityFailure;
  readonly consecutiveFailures: number;
  /** Operator's original config — the switch re-resolves from THIS, not from a
   * previously switched copy, so prices cannot compound. */
  readonly baseConfig: InferenceConfig;
  readonly effectiveConfig: InferenceConfig;
  readonly deps: EndpointFailoverDeps;
}

/**
 * Perform the one switch this session is allowed, or return `null` when the
 * gates say no: not switchable (account-level limit), not enough consecutive
 * failures yet, no session to make sticky, already switched, or no candidate.
 */
async function maybeSwitch(input: SwitchAttempt): Promise<InferenceConfig | null> {
  const { sessionId, failure, consecutiveFailures, baseConfig, effectiveConfig, deps } =
    input;

  if (sessionId === null) return null;
  if (!failure.switchable) return null;
  if (consecutiveFailures < CONSECUTIVE_FAILURES_BEFORE_SWITCH) return null;
  if (hasSwitched(sessionId)) return null;

  const candidates = await candidatesFor(baseConfig, deps);
  const target = selectSwitchTarget(candidates, effectiveConfig.endpointTag);
  if (target === null) {
    logger.warn("inference.openrouter.endpoint_switch_unavailable", {
      sessionId,
      model: baseConfig.model,
      endpointTag: effectiveConfig.endpointTag ?? null,
      candidateCount: candidates.length,
    });
    return null;
  }

  const previousEndpoint = effectiveConfig.endpointTag ?? null;
  const record = {
    sessionId,
    model: baseConfig.model,
    previousEndpoint,
    newEndpoint: target.tag,
    reasonClass: failure.reasonClass,
  };

  // PERSIST FIRST, adopt second — the durable row is what makes the switch
  // survive a restart, so it must exist before the routing change does.
  const persisted = await persistSwitchFirst(deps, record);
  commitEndpointSwitch(sessionId, target.tag);
  // Write failed: the switch still happens (the turn is being rescued), and the
  // record is parked so every later request retries it until it lands.
  if (!persisted) markPersistPending(sessionId, record);

  logger.warn("inference.openrouter.endpoint_switched", {
    sessionId,
    model: baseConfig.model,
    previousEndpoint,
    newEndpoint: target.tag,
    newEndpointProvider: target.providerName,
    newEndpointUptimePercent: target.uptimePercent,
    reasonClass: failure.reasonClass,
    persisted,
  });

  return applyEndpointToConfig(baseConfig, target);
}
