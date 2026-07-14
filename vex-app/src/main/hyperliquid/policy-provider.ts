/**
 * Electron-main Hyperliquid policy provider.
 *
 * `resolveHlPolicy` is deliberately synchronous because discovery and the
 * dispatcher use it on their hot paths. Main therefore hydrates active durable
 * session overlays into this cache before agent workers start. If that hydration
 * is unavailable or stale, session-scoped mutation resolution returns invalid
 * and runtime fails closed rather than applying an old or guessed overlay.
 */

import {
  HYPERLIQUID_POLICY_VERSION,
  type HyperliquidMissionRisk,
  hyperliquidPolicySchema,
  registerHlPolicyProvider,
  type HlPolicyScope,
  type HyperliquidPolicy,
} from "@vex-lib/hyperliquid-policy.js";
import type { Preferences } from "@shared/schemas/preferences.js";
import { log } from "../logger/index.js";
import { preferencesStore } from "../preferences/store.js";
import { subscribeDbConnection } from "../database/connection-state.js";
import {
  loadActiveHyperliquidPolicyOverlays,
  loadActiveHyperliquidMissionPolicyOverlays,
  type ActiveHyperliquidMissionPolicyOverlay,
  type ActiveHyperliquidPolicyOverlay,
} from "../database/hyperliquid-db.js";

let currentPreferences: Preferences | null = null;
let overlays = new Map<string, ActiveHyperliquidPolicyOverlay>();
let missionOverlays = new Map<string, ActiveHyperliquidMissionPolicyOverlay>();
let overlaysReady = false;
let overlaysFailed = false;
let unsubscribePreferences: (() => void) | null = null;
let unsubscribeBuilderConsent: (() => void) | null = null;
let unsubscribeDbConnection: (() => void) | null = null;
let overlayRefresh: Promise<void> | null = null;
let overlayRetryTimer: ReturnType<typeof setTimeout> | null = null;

const OVERLAY_HYDRATION_RETRY_MS = 30_000;

function overlayKey(sessionId: string, walletAddress: string): string {
  return `${sessionId}\u0000${walletAddress}`;
}

function applySessionOverlay(
  base: HyperliquidPolicy,
  overlay: HyperliquidPolicy,
): HyperliquidPolicy {
  // Session risk cards may tighten or user-confirmed-loosen only these risk
  // caps. Global stop-loss / egress choices stay under the settings owner.
  return hyperliquidPolicySchema.parse({
    ...base,
    leverageCapDefault: overlay.leverageCapDefault,
    perOrderNotionalPct: overlay.perOrderNotionalPct,
    totalNotionalPct: overlay.totalNotionalPct,
  });
}

/** Mission policy can only tighten the active global/session envelope. */
function applyMissionOverlay(base: HyperliquidPolicy, risk: HyperliquidMissionRisk): HyperliquidPolicy {
  const marketAllowlist = risk.marketAllowlist === undefined
    ? base.marketAllowlist
    : base.marketAllowlist === null
      ? risk.marketAllowlist
      : base.marketAllowlist.filter((coin) => risk.marketAllowlist?.includes(coin) ?? false);
  return hyperliquidPolicySchema.parse({
    ...base,
    leverageCapDefault: Math.min(base.leverageCapDefault, risk.leverageCap),
    perOrderNotionalPct: Math.min(base.perOrderNotionalPct, risk.perOrderNotionalPct),
    totalNotionalPct: Math.min(base.totalNotionalPct, risk.totalNotionalPct),
    marketAllowlist,
  });
}

function clearOverlayRefreshRetry(): void {
  if (overlayRetryTimer === null) return;
  clearTimeout(overlayRetryTimer);
  overlayRetryTimer = null;
}

function scheduleOverlayRefreshRetry(): void {
  if (overlayRetryTimer !== null || overlaysReady) return;
  overlayRetryTimer = setTimeout(() => {
    overlayRetryTimer = null;
    void refreshHyperliquidPolicyOverlays();
  }, OVERLAY_HYDRATION_RETRY_MS);
}

function provider(scope: HlPolicyScope): unknown {
  const preferences = currentPreferences;
  if (preferences === null || preferences.hyperliquid.riskAcknowledgedAt === null) {
    // Returning an invalid provider payload is intentional: the shared
    // resolver turns it into `{ kind: 'unavailable' }`, hiding and blocking
    // all HL mutations until the user acknowledges the risk disclosure.
    return undefined;
  }

  if (!overlaysReady || overlaysFailed) {
    void refreshHyperliquidPolicyOverlays();
    return undefined;
  }

  let policy = preferences.hyperliquid.policy;
  let provenance: `preferences` | `session:${string}` | `mission:${string}` = "preferences";
  if (scope.sessionId !== undefined && scope.walletAddress !== undefined) {
    const overlay = overlays.get(overlayKey(scope.sessionId, scope.walletAddress));
    if (overlay !== undefined && (overlay.expiresAt === null || Date.parse(overlay.expiresAt) > Date.now())) {
      policy = applySessionOverlay(policy, overlay.policy);
      provenance = `session:${overlay.proposalId}`;
    }
  }
  if (scope.missionId !== undefined && scope.missionId !== null) {
    const overlay = missionOverlays.get(scope.missionId);
    if (overlay !== undefined) {
      policy = applyMissionOverlay(policy, overlay.risk);
      provenance = `mission:${overlay.contractHash}`;
    }
  }
  return {
    policy,
    version: HYPERLIQUID_POLICY_VERSION,
    provenance,
  };
}

/** Refresh durable overlays without ever exposing a partially read cache. */
export async function refreshHyperliquidPolicyOverlays(): Promise<void> {
  if (overlayRefresh !== null) return overlayRefresh;
  overlayRefresh = (async () => {
    try {
      const [active, activeMissions] = await Promise.all([
        loadActiveHyperliquidPolicyOverlays(),
        loadActiveHyperliquidMissionPolicyOverlays(),
      ]);
      overlays = new Map(active.map((overlay) => [
        overlayKey(overlay.sessionId, overlay.walletAddress),
        overlay,
      ]));
      missionOverlays = new Map(activeMissions.map((overlay) => [overlay.missionId, overlay]));
      overlaysReady = true;
      overlaysFailed = false;
      clearOverlayRefreshRetry();
    } catch (cause) {
      overlays.clear();
      missionOverlays.clear();
      overlaysReady = false;
      overlaysFailed = true;
      log.info("[hyperliquid-policy] active session policy hydration failed; retry scheduled and session mutations remain disabled", cause);
      scheduleOverlayRefreshRetry();
    } finally {
      overlayRefresh = null;
    }
  })();
  return overlayRefresh;
}

function registerLiveProvider(): void {
  registerHlPolicyProvider(provider);
}

/** Hydrate active DB overlays. Call before agent workers can dispatch tools. */
export async function initializeHyperliquidPolicyProvider(): Promise<void> {
  currentPreferences = await preferencesStore.load();
  registerLiveProvider();

  if (unsubscribePreferences === null) {
    unsubscribePreferences = preferencesStore.subscribe((preferences) => {
      currentPreferences = preferences;
      // Re-register explicitly on every persisted preferences update. The
      // resolver holds no stale snapshot and uses the new closure immediately.
      registerLiveProvider();
    });
  }

  if (unsubscribeBuilderConsent === null) {
    const { hyperliquidBuilderConsentBus } = await import("@vex-agent/engine/events/hyperliquid-builder-bus.js");
    unsubscribeBuilderConsent = hyperliquidBuilderConsentBus.subscribe((maxFeeRate) => {
      void preferencesStore.update({
        hyperliquid: {
          ...(currentPreferences?.hyperliquid ?? { policy: hyperliquidPolicySchema.parse({}), riskAcknowledgedAt: null }),
          policy: hyperliquidPolicySchema.parse({
            ...(currentPreferences?.hyperliquid.policy ?? {}),
            builderFeeConsent: { kind: "approved", maxFeeRate },
          }),
        },
      }).then((preferences) => { currentPreferences = preferences; });
    });
  }

  if (unsubscribeDbConnection === null) {
    unsubscribeDbConnection = subscribeDbConnection((value, previous) => {
      if (previous === null && value !== null) {
        void refreshHyperliquidPolicyOverlays();
      }
    });
  }

  await refreshHyperliquidPolicyOverlays();
}

/** Update the trusted cache only after a main-side activation transaction commits. */
export async function setActiveHyperliquidPolicyOverlay(
  overlay: ActiveHyperliquidPolicyOverlay,
): Promise<void> {
  // A single successful confirmation cannot prove the rest of a boot-failed
  // durable cache is complete. Refresh all overlays first; if that retry still
  // fails, retain this overlay locally but keep the provider unavailable until
  // a later complete refresh succeeds.
  if (!overlaysReady || overlaysFailed) {
    await refreshHyperliquidPolicyOverlays();
  }
  overlays.set(overlayKey(overlay.sessionId, overlay.walletAddress), overlay);
}

/** Test and controlled shutdown helper; runtime policy becomes unavailable. */
export function resetHyperliquidPolicyProvider(): void {
  currentPreferences = null;
  overlays.clear();
  missionOverlays.clear();
  overlaysReady = false;
  overlaysFailed = false;
  clearOverlayRefreshRetry();
  if (unsubscribePreferences !== null) {
    unsubscribePreferences();
    unsubscribePreferences = null;
  }
  if (unsubscribeBuilderConsent !== null) {
    unsubscribeBuilderConsent();
    unsubscribeBuilderConsent = null;
  }
  if (unsubscribeDbConnection !== null) {
    unsubscribeDbConnection();
    unsubscribeDbConnection = null;
  }
}
