/**
 * T-5 (Kairos Phase 6): the audited core market reads, callable without a
 * `ToolSearch` round.
 *
 * WHY. A protocol tool becomes callable only on the request AFTER the
 * `ToolSearch` that recorded it (`dispatcher/tool-search.ts`, the recording and
 * `QUERY_NEXT_STEP`), so the cheapest possible market question costs one
 * discovery round before the first read, and two when the model lists the
 * namespace first (a listing records nothing; the select that follows does).
 * Live, a "price of ETH" chat spent 2 of its 4 rounds that way. Preloading the
 * two DexScreener reads a price or pair-state question starts from removes
 * both rounds.
 *
 * THE AUDIT. Every entry was checked for, and is re-checked at runtime by
 * {@link coreMarketReadToolIds}:
 *   - `mutating: false` and `actionKind: "read"` on the manifest: nothing here
 *     can sign, prepare, quote-to-execute or move funds, so no approval or
 *     prequote gate is skipped by calling it without discovery;
 *   - no `requiresEnv` and no credential: public market data only, nothing
 *     about the user's wallet or identity leaves the app;
 *   - already on the T-1 parallel-safe read allowlist
 *     (`tools/parallel-safe-reads.ts`), which audited shared state and the
 *     DexScreener provider cap for exactly these ids.
 * A manifest that stops satisfying the first two is DROPPED from the preload
 * (fail closed to "needs discovery"), never shown.
 *
 * ONE LAW PRESERVED (owner decision D-DS9-R, `injected-protocol-tools.ts`):
 * the injected tools array and the dispatcher's admission read the SAME set,
 * {@link getAdmittedProtocolToolIds}. A preloaded schema is therefore always
 * callable, and nothing callable is missing from the array.
 *
 * NOT IN MISSION SETUP. Setup is Capability Orientation: market-data calls are
 * forbidden there (`engine/prompts/research.ts`), so the preload is withheld
 * and setup keeps today's surface.
 */

import {
  getProtocolManifest,
  isAdvertisedProtocolNamespace,
  isProtocolToolAvailable,
} from "../protocols/catalog.js";
import type { ProtocolToolManifest } from "../protocols/types.js";
import type { SessionKind } from "@vex-agent/engine/types.js";
import { getDiscoveredToolIds } from "./discovered-tools.js";
import { CORE_MARKET_READS_PRELOADED } from "./discovery-policy.js";

/**
 * The preload, in the order it is injected. Deliberately two: the symbol or
 * name resolver a price question starts from (`dexscreener__pairs_search`,
 * whose rows carry `priceUsd`), and the one-pair live state a follow-up or a
 * position poll needs (`dexscreener__pair_get`). Each costs its full schema on
 * every request, so an addition must earn its bytes the same way.
 */
export const CORE_MARKET_READ_TOOL_IDS: readonly string[] = [
  "dexscreener.search",
  "dexscreener.pair.get",
];

/** The audit, as a predicate. Exported so the test asserts it catalog-side. */
export function isAuditedCoreMarketRead(manifest: ProtocolToolManifest): boolean {
  return manifest.mutating === false
    && manifest.actionKind === "read"
    && manifest.requiresEnv === undefined
    && isAdvertisedProtocolNamespace(manifest.namespace)
    && isProtocolToolAvailable(manifest);
}

/** What the preload decision needs from a caller: the session's mode only. */
export interface CoreMarketReadScope {
  readonly sessionKind: SessionKind;
  /** True iff a mission RUN is active; mission setup is `sessionKind: "mission"` with this false. */
  readonly missionRunActive: boolean;
}

function isMissionSetup(scope: CoreMarketReadScope): boolean {
  return scope.sessionKind === "mission" && !scope.missionRunActive;
}

/**
 * The preloaded toolIds for this scope: empty when the T-5 switch is off or in
 * mission setup, otherwise every audited entry that still passes the audit.
 */
export function coreMarketReadToolIds(
  scope: CoreMarketReadScope,
  enabled: boolean = CORE_MARKET_READS_PRELOADED,
): readonly string[] {
  if (!enabled || isMissionSetup(scope)) return [];
  return CORE_MARKET_READ_TOOL_IDS.filter((toolId) => {
    const manifest = getProtocolManifest(toolId);
    return manifest !== undefined && isAuditedCoreMarketRead(manifest);
  });
}

/**
 * THE admitted set: preloaded core reads first (a stable block, so a provider's
 * prefix cache keeps it across turns), then the session's discovered working
 * set in its own order, with a discovered duplicate of a core read skipped (a
 * tools array with one function name twice is refused by providers).
 *
 * With the switch off this is exactly `getDiscoveredToolIds(sessionId)`.
 */
export function getAdmittedProtocolToolIds(
  sessionId: string | undefined,
  scope: CoreMarketReadScope,
  enabled: boolean = CORE_MARKET_READS_PRELOADED,
): readonly string[] {
  const discovered = getDiscoveredToolIds(sessionId);
  const core = coreMarketReadToolIds(scope, enabled);
  if (core.length === 0) return discovered;
  const coreSet = new Set(core);
  return [...core, ...discovered.filter((toolId) => !coreSet.has(toolId))];
}
