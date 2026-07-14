import { getLatestSessionIdForPosition } from "@vex-agent/db/repos/activity.js";
import * as missionRunsRepo from "@vex-agent/db/repos/mission-runs.js";
import * as loopWakeRepo from "@vex-agent/db/repos/loop-wake.js";
import { appendEngineMessage } from "@vex-agent/engine/events/index.js";
import type { ProtectionState } from "@vex-agent/tools/protocols/hyperliquid/protection-snapshot.js";
import logger from "@utils/logger.js";

export interface HyperliquidProtectionNotifierDeps {
  readonly getLatestSessionIdForPosition: typeof getLatestSessionIdForPosition;
  readonly getActiveRunBySession: typeof missionRunsRepo.getActiveRunBySession;
  readonly getPendingForSession: typeof loopWakeRepo.getPendingForSession;
  readonly promotePendingWakeForSafety: typeof loopWakeRepo.promotePendingWakeForSafety;
  readonly enqueueWake: typeof loopWakeRepo.enqueue;
  readonly appendEngineMessage: typeof appendEngineMessage;
}

// W13: perp.setTpsl only replaces the STOP-LOSS (it takes slPrice, not tpPrice),
// so the notice must not imply it re-applies a take-profit. If the entry set a
// take-profit, the agent must keep that existing TP trigger and cancel ONLY the
// transient fixed-size stop child — otherwise the TP is silently dropped.
const CONSOLIDATION_NOTICE = "CONSOLIDATING protection detected. Use hyperliquid.perp.setTpsl to place a full-position stop, then cancel ONLY the transient fixed-size stop child before any other Hyperliquid action. If the original entry set a take-profit, leave that take-profit trigger in place — do not cancel it.";
const UNPROTECTED_NOTICE = "UNPROTECTED Hyperliquid position detected. Verify protection immediately; if it cannot be restored, propose a reduce-only close.";

/**
 * The chat-notice identity for a protection state. Two identities so
 * CONSOLIDATING → (escalated / UNPROTECTED / PARTIAL) still reads as a
 * transition, while a state that merely persists across reconcile buckets
 * does not. Healthy states (FLAT / OPENING / PROTECTED) produce no notice.
 */
export type ProtectionNoticeSignal = "CONSOLIDATING" | "UNPROTECTED";

export function protectionNoticeSignal(
  state: ProtectionState | string | undefined,
  escalatedToUnprotected: boolean,
): ProtectionNoticeSignal | null {
  if ((state === "CONSOLIDATING" && escalatedToUnprotected) || state === "UNPROTECTED" || state === "PARTIAL") {
    return "UNPROTECTED";
  }
  if (state === "CONSOLIDATING") return "CONSOLIDATING";
  return null;
}

/**
 * `shouldNotify` gates ONLY the chat message. The safety wake
 * (promote/enqueue) always runs on every bad-state pass, so a paused mission
 * is still woken even when the transient consolidation notice is deduped.
 */
export async function wakeOrNotifyConsolidation(
  capture: Record<string, unknown>,
  deps: HyperliquidProtectionNotifierDeps,
  shouldNotify: boolean,
): Promise<void> {
  await wakeOrNotify(capture, deps, "consolidation", CONSOLIDATION_NOTICE, shouldNotify);
}

export async function wakeOrNotifyUnprotected(
  capture: Record<string, unknown>,
  deps: HyperliquidProtectionNotifierDeps,
  shouldNotify: boolean,
): Promise<void> {
  await wakeOrNotify(capture, deps, "unprotected", UNPROTECTED_NOTICE, shouldNotify);
}

async function wakeOrNotify(
  capture: Record<string, unknown>,
  deps: HyperliquidProtectionNotifierDeps,
  kind: "consolidation" | "unprotected",
  notice: string,
  shouldNotify: boolean,
): Promise<void> {
  const positionKey = stringField(capture, "positionKey");
  const coin = metaString(capture, "coin");
  if (positionKey === undefined || coin === undefined) return;
  const sessionId = await deps.getLatestSessionIdForPosition(positionKey);
  if (sessionId === null) {
    logger.warn("hyperliquid.reconcile.no_owning_session", { coin, kind });
    return;
  }
  // Safety wake runs on EVERY bad-state pass regardless of the notice gate.
  await promoteOrEnqueueWake(sessionId, deps, kind, positionKey, coin);
  // The chat notice is transition-gated so a persistent bad state across
  // reconcile buckets does not spam the transcript once per minute.
  if (!shouldNotify) return;
  await deps.appendEngineMessage(sessionId, `[Engine: hyperliquid_${kind} — ${notice}]`, {
    source: "engine",
    messageType: "hyperliquid_protection",
    visibility: "internal",
    payload: { kind, positionKey, coin },
  });
}

async function promoteOrEnqueueWake(
  sessionId: string,
  deps: HyperliquidProtectionNotifierDeps,
  kind: "consolidation" | "unprotected",
  positionKey: string,
  coin: string,
): Promise<void> {
  const run = await deps.getActiveRunBySession(sessionId);
  if (run?.status !== "paused_wake") return;
  const pending = await deps.getPendingForSession(sessionId);
  if (pending !== null) {
    await deps.promotePendingWakeForSafety(sessionId, run.id);
    return;
  }
  await deps.enqueueWake({
    sessionId,
    missionRunId: run.id,
    dueAt: new Date(),
    reason: `hyperliquid ${kind}: ${coin}`,
    payload: { trigger: `hyperliquid_${kind}`, positionKey, coin },
  });
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const candidate = value[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function metaString(capture: Record<string, unknown>, key: string): string | undefined {
  const value = capture.meta;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return stringField(value as Record<string, unknown>, key);
}
