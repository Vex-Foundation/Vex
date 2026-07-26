/**
 * Bridge capability snapshot — the live data behind the DYNAMIC bridge-routing
 * prompt section (R13 / B7).
 *
 * WHY THIS EXISTS: the system prompt's bridge chain list must reflect Khalani's
 * LIVE `GET /v1/chains` (never `CHAIN_ALIASES`, never a marketing table). A
 * network fetch cannot sit behind `buildProtocolsPrompt()`'s permanent process
 * cache, so this module maintains a durable, single-flight snapshot OUTSIDE that
 * cache; the prompt layer reads a pure classification of it each turn.
 *
 * TRUST BOUNDARY: the rendered list lands in the SYSTEM PROMPT of a financial
 * agent. LIVE provider data decides PRESENCE; a TRUSTED curated map decides the
 * WORDING — arbitrary provider name strings never enter the prompt. The result
 * is sanitized defensively anyway (family-filtered to eip155 + solana,
 * curated-mapped, control chars stripped, deduped, sorted, length-bounded).
 *
 * FAIL-SOFT: a refresh NEVER throws into the prompt path. A failed Khalani fetch
 * keeps the last good snapshot; a failed Relay health check conservatively drops
 * the Robinhood-via-Relay line. Freshness is numeric (B7): a 15-min single-flight
 * refresh TTL; a snapshot older than 60 min renders a staleness note; one older
 * than 24 h (or never fetched) renders the conservative fallback line only.
 */

import { getKhalaniClient } from "@tools/khalani/client.js";
import type { KhalaniChain } from "@tools/khalani/types.js";
import { getRelayClient } from "@tools/relay/client.js";
import type { RelayChain } from "@tools/relay/types.js";
import { summarizeProtocolError } from "@vex-agent/tools/protocols/runtime/errors.js";
import logger from "@utils/logger.js";

// ── Freshness thresholds (B7) ───────────────────────────────────────

/** Single-flight refresh cadence — a snapshot younger than this is not re-fetched. */
export const BRIDGE_CAPABILITY_REFRESH_TTL_MS = 15 * 60_000;
/** Older than this → still rendered, but with an explicit staleness note. */
export const BRIDGE_CAPABILITY_STALE_AFTER_MS = 60 * 60_000;
/** Older than this (or never fetched) → the conservative fallback line only. */
export const BRIDGE_CAPABILITY_ABSENT_AFTER_MS = 24 * 60 * 60_000;

/** Robinhood Chain — Khalani does not cover it; Relay is the only bridge route. */
const ROBINHOOD_CHAIN_ID = 4663;
/** Defensive ceiling on the rendered chain count (guards an oversized upstream list). */
const MAX_BRIDGE_CHAIN_NAMES = 64;

// ── Curated display-name map (TRUSTED wording) ──────────────────────
//
// Keyed by live Khalani `/v1/chains` ids (ground truth 2026-07-23). LIVE data
// decides which of these appear; this map decides the WORDS. A live id absent
// here is OMITTED (+ a debug log) — an unknown provider name never reaches the
// system prompt. eip155 + solana only (bitcoin id 0 / tron id 728126428 are
// served live but Vex cannot sign them, and the Khalani client already skips
// those families; the family filter below is defense-in-depth).
export const CURATED_BRIDGE_CHAIN_NAMES: Readonly<Record<number, string>> = {
  1: "Ethereum",
  10: "Optimism",
  56: "BNB Chain",
  130: "Unichain",
  137: "Polygon",
  143: "Monad",
  324: "ZKsync Era",
  2741: "Abstract",
  5000: "Mantle",
  8453: "Base",
  16661: "0G",
  42161: "Arbitrum",
  43114: "Avalanche",
  59144: "Linea",
  80094: "Berachain",
  747474: "Katana",
  5734951: "Jovay",
  20011000000: "Solana",
};

// ── Types ───────────────────────────────────────────────────────────

export interface BridgeCapabilitySnapshot {
  /** Curated, sanitized, sorted display names of the live-supported Khalani chains. */
  readonly chainNames: readonly string[];
  /** Whether Relay's `/chains` health gate for Robinhood 4663 passed at fetch time. */
  readonly robinhoodViaRelay: boolean;
  /** Epoch-ms of the last successful Khalani chains fetch that built this snapshot. */
  readonly lastSuccessfulAt: number;
}

/** The freshness-classified view the pure prompt renderer consumes. */
export type BridgeCapabilityView =
  | {
      readonly kind: "available";
      readonly chainNames: readonly string[];
      readonly robinhoodViaRelay: boolean;
      readonly stale: boolean;
    }
  | { readonly kind: "unavailable" };

export interface BridgeCapabilityFetchers {
  readonly fetchKhalaniChains: () => Promise<readonly KhalaniChain[]>;
  readonly fetchRelayChains: () => Promise<readonly RelayChain[]>;
}

// ── Pure projections (system-prompt trust boundary) ─────────────────

/**
 * Strip control chars + newlines and trim — the last defense before a name
 * reaches the system prompt. Curated names are already clean; this is the
 * boundary contract, not a bet on the input.
 */
export function sanitizeBridgeChainName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\u0000-\u001F\u007F]/g, "").trim();
}

/**
 * Project a live Khalani chains payload into the curated display names that may
 * enter the system prompt. Presence is decided by LIVE data (only ids returned
 * by the API), wording by the curated map (unknown id → omit + debug log). The
 * result is family-filtered, deduped, sanitized, sorted, and length-bounded.
 */
export function projectBridgeChainNames(rawChains: readonly KhalaniChain[]): string[] {
  const seenIds = new Set<number>();
  const names: string[] = [];
  for (const chain of rawChains) {
    // Defensive family filter (the client already skips foreign families, but a
    // financial-agent system prompt is a sink that validates its own input).
    if (chain.type !== "eip155" && chain.type !== "solana") continue;
    if (!Number.isInteger(chain.id) || seenIds.has(chain.id)) continue;
    const curated = CURATED_BRIDGE_CHAIN_NAMES[chain.id];
    if (curated === undefined) {
      logger.debug("bridge_capability.chain_omitted_unknown_id", { chainId: chain.id });
      continue;
    }
    seenIds.add(chain.id);
    const clean = sanitizeBridgeChainName(curated);
    if (clean.length === 0) continue;
    names.push(clean);
  }
  const unique = Array.from(new Set(names)).sort((a, b) => {
    const la = a.toLowerCase();
    const lb = b.toLowerCase();
    return la < lb ? -1 : la > lb ? 1 : 0;
  });
  return unique.slice(0, MAX_BRIDGE_CHAIN_NAMES);
}

/**
 * Relay `/chains` health gate for Robinhood 4663 (dossier §1b): the route is
 * advertised only when Relay reports the chain present with `depositEnabled` and
 * not `disabled`. Missing chain or missing fields → fail closed (false).
 */
export function isRobinhoodRelayHealthy(relayChains: readonly RelayChain[]): boolean {
  const chain = relayChains.find((entry) => entry.id === ROBINHOOD_CHAIN_ID);
  if (chain === undefined) return false;
  return chain.depositEnabled === true && chain.disabled === false;
}

/** Classify a snapshot into the render view by numeric freshness (B7). */
export function classifyBridgeCapability(
  snapshot: BridgeCapabilitySnapshot | null,
  nowMs: number,
): BridgeCapabilityView {
  if (snapshot === null || snapshot.chainNames.length === 0) return { kind: "unavailable" };
  const age = nowMs - snapshot.lastSuccessfulAt;
  if (age >= BRIDGE_CAPABILITY_ABSENT_AFTER_MS) return { kind: "unavailable" };
  return {
    kind: "available",
    chainNames: snapshot.chainNames,
    robinhoodViaRelay: snapshot.robinhoodViaRelay,
    stale: age >= BRIDGE_CAPABILITY_STALE_AFTER_MS,
  };
}

// ── Durable single-flight snapshot state ────────────────────────────

let currentSnapshot: BridgeCapabilitySnapshot | null = null;
let refreshInFlight: Promise<void> | null = null;
let fetchers: BridgeCapabilityFetchers = defaultFetchers();

function defaultFetchers(): BridgeCapabilityFetchers {
  return {
    fetchKhalaniChains: () => getKhalaniClient().getChains(),
    fetchRelayChains: () => getRelayClient().getChains(),
  };
}

/**
 * One refresh attempt. NEVER throws — a Khalani fetch failure keeps the last
 * good snapshot untouched; a Relay health failure conservatively drops the
 * Robinhood line. `lastSuccessfulAt` advances only when Khalani chains (the
 * mandatory payload) are fetched successfully.
 */
async function performRefresh(): Promise<void> {
  let khalaniChains: readonly KhalaniChain[];
  try {
    khalaniChains = await fetchers.fetchKhalaniChains();
  } catch (err) {
    // Scrub through the canonical boundary (m1): a provider error can carry URLs,
    // bodies, and auth headers — never log it bare.
    logger.warn("bridge_capability.khalani_refresh_failed", {
      error: summarizeProtocolError(err).message,
    });
    return; // keep the last good snapshot
  }

  let robinhoodViaRelay = false;
  try {
    robinhoodViaRelay = isRobinhoodRelayHealthy(await fetchers.fetchRelayChains());
  } catch (err) {
    logger.debug("bridge_capability.relay_health_unavailable", {
      error: summarizeProtocolError(err).message,
    });
    robinhoodViaRelay = false; // no Robinhood line without a confirmed health gate
  }

  currentSnapshot = {
    chainNames: projectBridgeChainNames(khalaniChains),
    robinhoodViaRelay,
    lastSuccessfulAt: Date.now(),
  };
}

/**
 * Trigger a single-flight refresh when the snapshot is older than the TTL (or
 * absent). Returns the shared in-flight promise; NEVER rejects. Safe to call as
 * a warm-up (e.g. engine start) or to await in tests. Concurrent callers share
 * one fetch.
 */
export function triggerBridgeCapabilityRefresh(nowMs: number = Date.now()): Promise<void> {
  const age =
    currentSnapshot === null ? Number.POSITIVE_INFINITY : nowMs - currentSnapshot.lastSuccessfulAt;
  if (age < BRIDGE_CAPABILITY_REFRESH_TTL_MS) return Promise.resolve();
  if (refreshInFlight !== null) return refreshInFlight;
  const run = performRefresh().finally(() => {
    refreshInFlight = null;
  });
  refreshInFlight = run;
  return run;
}

/**
 * Prompt-seam accessor: kicks a background single-flight refresh when stale and
 * returns the CURRENT classified view immediately (stale-while-revalidate). Never
 * blocks on the network, never throws — a cold start renders the fallback line
 * while the first fetch settles for the next turn.
 */
export async function getBridgeCapabilityView(nowMs: number = Date.now()): Promise<BridgeCapabilityView> {
  void triggerBridgeCapabilityRefresh(nowMs);
  return classifyBridgeCapability(currentSnapshot, nowMs);
}

// ── Test/support hooks ──────────────────────────────────────────────

export function setBridgeCapabilityFetchersForTest(next: BridgeCapabilityFetchers | null): void {
  fetchers = next ?? defaultFetchers();
}

export function setBridgeCapabilitySnapshotForTest(snapshot: BridgeCapabilitySnapshot | null): void {
  currentSnapshot = snapshot;
}

export function getBridgeCapabilitySnapshotForTest(): BridgeCapabilitySnapshot | null {
  return currentSnapshot;
}

export function resetBridgeCapabilityStateForTest(): void {
  currentSnapshot = null;
  refreshInFlight = null;
  fetchers = defaultFetchers();
}
