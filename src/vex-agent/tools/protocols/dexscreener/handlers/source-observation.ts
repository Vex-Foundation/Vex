import type {
  DexScreenerClient,
  DexScreenerObservation,
} from "@tools/dexscreener/client.js";

/**
 * Agent-facing freshness metadata for one DexScreener response.
 *
 * DESIGN: unknown stays null, never 0 - a reader must be able to tell "fresh"
 * from "we cannot tell". Field names carry their scope (`local*` = Vex's own
 * URL cache, `upstream*` = DexScreener's CDN Age header) because a bare
 * `cacheHit: false` next to a non-zero cache age was measured to read as
 * "live data" while describing the stalest response in the run.
 */
export interface AgentSourceObservation {
  /**
   * `false` = no transport metadata exists for this value (test double or an
   * unregistered response) - every nullable field below is null and NOTHING
   * about freshness is claimed. Never fabricate "fetched now" here: a reader
   * acting on a fabricated zero age treats stale money data as live.
   */
  observed: boolean;
  responseAtMs: number;
  /**
   * Derived origin-generation time: local fetch time minus the upstream Age.
   * Null whenever the upstream age is unknown - the earlier fallback (local
   * fetch time) made the naive delta `responseAtMs - providerFetchedAtMs`
   * read "0 ms, fresh" exactly when the age was unknowable.
   */
  providerFetchedAtMs: number | null;
  /** Whether Vex's own URL cache served this value. Null when unobserved. */
  localCacheHit: boolean | null;
  /** Age in Vex's own cache only - excludes the upstream CDN's age. Null when unobserved. */
  localCacheAgeMs: number | null;
  /** DexScreener's CDN age (HTTP `Age` header). Null when absent or unobserved. */
  upstreamAgeMs: number | null;
  upstreamAgeKnown: boolean;
  /**
   * Total provable data age: `localCacheAgeMs + upstreamAgeMs`. Null whenever
   * either input is unknown - a partial sum presented as the total would
   * understate staleness exactly when the reader most needs the truth.
   */
  dataAgeMs: number | null;
}

function unobserved(responseAtMs: number): AgentSourceObservation {
  return {
    observed: false,
    responseAtMs,
    providerFetchedAtMs: null,
    localCacheHit: null,
    localCacheAgeMs: null,
    upstreamAgeMs: null,
    upstreamAgeKnown: false,
    dataAgeMs: null,
  };
}

function fromClientObservation(
  observation: DexScreenerObservation,
  responseAtMs: number,
): AgentSourceObservation {
  return {
    observed: true,
    responseAtMs,
    providerFetchedAtMs: observation.upstreamAgeKnown ? observation.providerFetchedAtMs : null,
    localCacheHit: observation.cacheHit,
    localCacheAgeMs: observation.cacheAgeMs,
    upstreamAgeMs: observation.upstreamAgeMs,
    upstreamAgeKnown: observation.upstreamAgeKnown,
    dataAgeMs: observation.upstreamAgeMs === null
      ? null
      : observation.cacheAgeMs + observation.upstreamAgeMs,
  };
}

export function sourceObservation(
  client: DexScreenerClient,
  value: unknown,
  responseAtMs: number,
): AgentSourceObservation {
  const observation = client.observationFor(value);
  return observation === null
    ? unobserved(responseAtMs)
    : fromClientObservation(observation, responseAtMs);
}

/**
 * Worst-case freshness across the batched responses of one tool call.
 *
 * Ages take the MAX (the stalest batch bounds the answer), fetch time the MIN.
 * If ANY batch is unobserved the whole combination is unobserved: claiming an
 * age for a response we only partially measured is the fabrication this module
 * exists to prevent.
 */
export function combinedSourceObservation(
  client: DexScreenerClient,
  values: readonly unknown[],
  responseAtMs: number,
): AgentSourceObservation {
  const observations = values.map((value) => sourceObservation(client, value, responseAtMs));
  if (observations.length === 0 || observations.some((item) => !item.observed)) {
    return unobserved(responseAtMs);
  }
  const upstreamAgeKnown = observations.every((item) => item.upstreamAgeKnown);
  const dataAges = observations.map((item) => item.dataAgeMs);
  return {
    observed: true,
    responseAtMs,
    providerFetchedAtMs: upstreamAgeKnown
      ? Math.min(...observations.map((item) => item.providerFetchedAtMs ?? responseAtMs))
      : null,
    localCacheHit: observations.every((item) => item.localCacheHit === true),
    localCacheAgeMs: Math.max(...observations.map((item) => item.localCacheAgeMs ?? 0)),
    upstreamAgeMs: upstreamAgeKnown
      ? Math.max(...observations.map((item) => item.upstreamAgeMs ?? 0))
      : null,
    upstreamAgeKnown,
    dataAgeMs: dataAges.every((age): age is number => age !== null)
      ? Math.max(...dataAges)
      : null,
  };
}
