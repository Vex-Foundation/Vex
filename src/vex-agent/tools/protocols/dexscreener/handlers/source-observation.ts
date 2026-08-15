import type {
  DexScreenerClient,
  DexScreenerObservation,
} from "@tools/dexscreener/client.js";

export interface AgentSourceObservation {
  responseAtMs: number;
  providerFetchedAtMs: number;
  cacheAgeMs: number;
  cacheHit: boolean;
  upstreamAgeMs: number | null;
  upstreamAgeKnown: boolean;
}

function freshFallback(responseAtMs: number): AgentSourceObservation {
  return {
    responseAtMs,
    providerFetchedAtMs: responseAtMs,
    cacheAgeMs: 0,
    cacheHit: false,
    upstreamAgeMs: null,
    upstreamAgeKnown: false,
  };
}

/** Test doubles have no transport metadata, so they truthfully become fresh now. */
export function sourceObservation(
  client: DexScreenerClient,
  value: unknown,
  responseAtMs: number,
): AgentSourceObservation {
  const observed: DexScreenerObservation | null = client.observationFor(value);
  return observed === null
    ? freshFallback(responseAtMs)
    : { responseAtMs, ...observed };
}

export function combinedSourceObservation(
  client: DexScreenerClient,
  values: readonly unknown[],
  responseAtMs: number,
): AgentSourceObservation {
  if (values.length === 0) {
    return freshFallback(responseAtMs);
  }
  const observations = values.map((value) => sourceObservation(client, value, responseAtMs));
  const knownUpstreamAges = observations.flatMap((item) =>
    item.upstreamAgeMs === null ? [] : [item.upstreamAgeMs]);
  return {
    responseAtMs,
    providerFetchedAtMs: Math.min(...observations.map((item) => item.providerFetchedAtMs)),
    cacheAgeMs: Math.max(...observations.map((item) => item.cacheAgeMs)),
    cacheHit: observations.length > 0 && observations.every((item) => item.cacheHit),
    upstreamAgeMs: knownUpstreamAges.length === 0 ? null : Math.max(...knownUpstreamAges),
    upstreamAgeKnown: observations.every((item) => item.upstreamAgeKnown),
  };
}
