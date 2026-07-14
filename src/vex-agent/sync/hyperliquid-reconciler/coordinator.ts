/**
 * Thin Hyperliquid reconciliation coordinator.
 *
 * Fetching, comparison, and persistence stay here. Deterministic capture and
 * market projections live in projections.ts; wake policy lives in
 * protection-notifier.ts. This module remains detection-only and never signs.
 */

import { Decimal } from "decimal.js";
import { z } from "zod";

import { resolveHyperliquidNetwork } from "@tools/hyperliquid/constants.js";
import { HyperliquidInfoClient } from "@tools/hyperliquid/info.js";
import {
  getActiveHyperliquidPerpTargets,
  getLatestSessionIdForPosition,
  type HyperliquidPerpTarget,
} from "@vex-agent/db/repos/activity.js";
import * as loopWakeRepo from "@vex-agent/db/repos/loop-wake.js";
import * as missionRunsRepo from "@vex-agent/db/repos/mission-runs.js";
import * as openPositionsRepo from "@vex-agent/db/repos/open-positions.js";
import { appendEngineMessage } from "@vex-agent/engine/events/index.js";
import { buildPositionProtectionSnapshot } from "@vex-agent/tools/protocols/hyperliquid/protection-snapshot.js";
import { recordSyntheticCapture } from "../synthetic-capture.js";
import {
  accountSnapshot,
  coinForPosition,
  coinForTarget,
  extractMarketSnapshot,
  type HyperliquidMarketSnapshot,
  hasOpenOrder,
  parseHyperliquidClearinghouseState,
  parseHyperliquidUserFills,
  projectCancelledCapture,
  projectClosedCapture,
  projectOpenCapture,
  type HyperliquidClearinghouseState,
  type HyperliquidMarketWatchlistItem,
  type HyperliquidUserFills,
} from "./projections.js";
import {
  protectionNoticeSignal,
  wakeOrNotifyConsolidation,
  wakeOrNotifyUnprotected,
  type ProtectionNoticeSignal,
} from "./protection-notifier.js";
import logger from "@utils/logger.js";

const liquidationEventSchema = z.object({
  liquidation: z.object({ liquidated_user: z.string().min(1) }).passthrough(),
}).passthrough();

export interface HyperliquidReconcileResult {
  readonly checked: number;
  readonly captured: number;
  readonly closed: number;
  readonly cancelled: number;
  readonly liquidated: number;
  readonly consolidating: number;
  readonly unprotected: number;
  readonly skipped: number;
  readonly errors: number;
}

export interface HyperliquidReconcilerDeps {
  readonly createInfoClient: () => Pick<HyperliquidInfoClient, "clearinghouseState" | "frontendOpenOrders" | "userFills" | "metaAndAssetCtxs">;
  readonly getOpenPositions: typeof openPositionsRepo.getOpen;
  readonly getActiveTargets: typeof getActiveHyperliquidPerpTargets;
  readonly recordSyntheticCapture: typeof recordSyntheticCapture;
  readonly getLatestSessionIdForPosition: typeof getLatestSessionIdForPosition;
  readonly getActiveRunBySession: typeof missionRunsRepo.getActiveRunBySession;
  readonly getPendingForSession: typeof loopWakeRepo.getPendingForSession;
  readonly promotePendingWakeForSafety: typeof loopWakeRepo.promotePendingWakeForSafety;
  readonly enqueueWake: typeof loopWakeRepo.enqueue;
  readonly appendEngineMessage: typeof appendEngineMessage;
}

function productionDeps(): HyperliquidReconcilerDeps {
  return {
    createInfoClient: () => new HyperliquidInfoClient({ network: resolveHyperliquidNetwork() }),
    getOpenPositions: openPositionsRepo.getOpen,
    getActiveTargets: getActiveHyperliquidPerpTargets,
    recordSyntheticCapture,
    getLatestSessionIdForPosition,
    getActiveRunBySession: missionRunsRepo.getActiveRunBySession,
    getPendingForSession: loopWakeRepo.getPendingForSession,
    promotePendingWakeForSafety: loopWakeRepo.promotePendingWakeForSafety,
    enqueueWake: loopWakeRepo.enqueue,
    appendEngineMessage,
  };
}

/** A userEvents liquidation applies to positions discovered absent on the next pass. */
const liquidationSeenForWallet = new Set<string>();

/** Called only by the explicitly owned user-events subscription lifecycle. */
export function recordHyperliquidUserEvent(walletAddress: string, event: unknown): void {
  const parsed = liquidationEventSchema.safeParse(event);
  if (!parsed.success) return;
  if (parsed.data.liquidation.liquidated_user.toLowerCase() === walletAddress.toLowerCase()) {
    liquidationSeenForWallet.add(walletAddress.toLowerCase());
  }
}

/**
 * Reconcile currently tracked positions/resting entries. With neither open
 * local positions nor an active HL target, the function returns before making
 * any exchange request.
 */
export async function reconcileHyperliquid(
  deps: HyperliquidReconcilerDeps = productionDeps(),
): Promise<HyperliquidReconcileResult> {
  const result: MutableReconcileResult = emptyResult();
  const [openPositions, activeTargets] = await Promise.all([
    deps.getOpenPositions(undefined, "hyperliquid"),
    deps.getActiveTargets(),
  ]);
  const wallets = new Set([
    ...openPositions.map((position) => position.walletAddress),
    ...activeTargets.map((target) => target.walletAddress),
  ]);
  if (wallets.size === 0) return result;

  const info = deps.createInfoClient();
  let markets: HyperliquidMarketSnapshot;
  try {
    markets = extractMarketSnapshot(await info.metaAndAssetCtxs());
  } catch (error) {
    logger.warn("hyperliquid.reconcile.marks_failed", { error: errorMessage(error) });
    return { ...result, errors: 1 };
  }

  for (const walletAddress of wallets) {
    try {
      const [stateResponse, orders, fills] = await Promise.all([
        info.clearinghouseState(walletAddress),
        info.frontendOpenOrders(walletAddress),
        info.userFills(walletAddress),
      ]);
      const state = parseHyperliquidClearinghouseState(stateResponse);
      const normalizedFills = parseHyperliquidUserFills(fills);
      await reconcileWallet({
        walletAddress,
        state,
        orders,
        fills: normalizedFills,
        marks: markets.marks,
        marketWatchlist: markets.watchlist,
        localPositions: openPositions.filter((position) => position.walletAddress === walletAddress),
        activeTargets: activeTargets.filter((target) => target.walletAddress === walletAddress),
        deps,
        result,
      });
    } catch (error) {
      result.errors += 1;
      logger.warn("hyperliquid.reconcile.wallet_failed", { error: errorMessage(error) });
    } finally {
      liquidationSeenForWallet.delete(walletAddress.toLowerCase());
    }
  }
  return result;
}

interface ReconcileWalletInput {
  readonly walletAddress: string;
  readonly state: HyperliquidClearinghouseState;
  readonly orders: unknown;
  readonly fills: HyperliquidUserFills;
  readonly marks: ReadonlyMap<string, string>;
  readonly marketWatchlist: readonly HyperliquidMarketWatchlistItem[];
  readonly localPositions: readonly openPositionsRepo.Position[];
  readonly activeTargets: readonly HyperliquidPerpTarget[];
  readonly deps: HyperliquidReconcilerDeps;
  readonly result: MutableReconcileResult;
}

async function reconcileWallet(input: ReconcileWalletInput): Promise<void> {
  const remoteByCoin = new Map(
    input.state.assetPositions
      .map((entry) => entry.position)
      .filter((position) => !new Decimal(position.szi).isZero())
      .map((position) => [position.coin, position] as const),
  );
  const localByCoin = new Map(
    input.localPositions
      .map((position) => [coinForPosition(position), position] as const)
      .filter((entry): entry is readonly [string, openPositionsRepo.Position] => entry[0] !== null),
  );
  const targetByCoin = new Map(
    input.activeTargets
      .map((target) => [coinForTarget(target), target] as const)
      .filter((entry): entry is readonly [string, HyperliquidPerpTarget] => entry[0] !== null),
  );
  const coins = new Set([...remoteByCoin.keys(), ...localByCoin.keys(), ...targetByCoin.keys()]);

  for (const coin of coins) {
    input.result.checked += 1;
    const remotePosition = remoteByCoin.get(coin);
    const localPosition = localByCoin.get(coin) ?? null;
    const target = targetByCoin.get(coin) ?? null;
    if (remotePosition !== undefined) {
      const snapshot = buildPositionProtectionSnapshot(input.state, input.orders, coin);
      const capture = projectOpenCapture({
        walletAddress: input.walletAddress,
        coin,
        position: remotePosition,
        markPx: input.marks.get(coin),
        account: accountSnapshot(input.state),
        marketWatchlist: input.marketWatchlist,
        snapshot,
        fills: input.fills,
        localPosition,
        confirmedAt: new Date().toISOString(),
        // A capture per reconciliation minute preserves renderer freshness;
        // duplicate runs in the same minute remain idempotent.
        reconcileBucket: Math.floor(Date.now() / 60_000),
      });
      const persisted = await captureIfChanged(capture, localPosition, input.deps, input.result);
      if (!persisted) continue;
      const escalated = metaString(capture, "protectionEscalation") === "UNPROTECTED";
      // Emit the chat notice only on a protection TRANSITION: compare the
      // protection notice identity against the prior persisted state (from
      // localPosition), never capture-row equality. The per-minute
      // reconcileBucket rewrites the capture every pass, so row equality would
      // spam once per minute; the safety wake below is unaffected either way.
      const currentSignal = protectionNoticeSignal(snapshot.state, escalated);
      const shouldNotify = currentSignal !== null && currentSignal !== priorProtectionNoticeSignal(localPosition);
      if (snapshot.state === "CONSOLIDATING" && escalated) {
        input.result.unprotected += 1;
        await wakeOrNotifyUnprotected(capture, input.deps, shouldNotify);
      } else if (snapshot.state === "CONSOLIDATING") {
        input.result.consolidating += 1;
        await wakeOrNotifyConsolidation(capture, input.deps, shouldNotify);
      } else if (snapshot.state === "UNPROTECTED" || snapshot.state === "PARTIAL") {
        input.result.unprotected += 1;
        await wakeOrNotifyUnprotected(capture, input.deps, shouldNotify);
      }
      continue;
    }

    if (localPosition !== null) {
      const liquidated = liquidationSeenForWallet.has(input.walletAddress.toLowerCase());
      const capture = projectClosedCapture(localPosition, coin, liquidated ? "liquidated" : "closed");
      if (await captureIfChanged(capture, localPosition, input.deps, input.result)) {
        if (liquidated) input.result.liquidated += 1;
        else input.result.closed += 1;
      }
      continue;
    }

    // A tracked pending entry that no longer exists on the venue was cancelled
    // outside Vex. Capture the fact even though no position row was ever open.
    if (target !== null && !hasOpenOrder(input.orders, coin)) {
      const capture = projectCancelledCapture(target, coin);
      if (await captureIfChanged(capture, null, input.deps, input.result)) input.result.cancelled += 1;
    } else {
      input.result.skipped += 1;
    }
  }
}

async function captureIfChanged(
  capture: Record<string, unknown>,
  localPosition: openPositionsRepo.Position | null,
  deps: HyperliquidReconcilerDeps,
  result: MutableReconcileResult,
): Promise<boolean> {
  const version = metaString(capture, "reconcileVersion");
  if (localPosition !== null && stringField(localPosition.data, "reconcileVersion") === version) {
    result.skipped += 1;
    return false;
  }
  const executionId = await deps.recordSyntheticCapture({
    toolId: "hyperliquid_reconcile.position",
    namespace: "hyperliquid",
    tradeCapture: capture,
    source: "hyperliquid_reconciler",
  });
  if (executionId <= 0) throw new Error("Hyperliquid synthetic capture did not persist.");
  result.captured += 1;
  return true;
}


/** The protection notice identity last written for this position, or null on first sighting. */
function priorProtectionNoticeSignal(localPosition: openPositionsRepo.Position | null): ProtectionNoticeSignal | null {
  if (localPosition === null) return null;
  const priorState = stringField(localPosition.data, "protectionState");
  const priorEscalated = stringField(localPosition.data, "protectionEscalation") === "UNPROTECTED";
  return protectionNoticeSignal(priorState, priorEscalated);
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emptyResult(): MutableReconcileResult {
  return {
    checked: 0,
    captured: 0,
    closed: 0,
    cancelled: 0,
    liquidated: 0,
    consolidating: 0,
    unprotected: 0,
    skipped: 0,
    errors: 0,
  };
}

type MutableReconcileResult = {
  -readonly [K in keyof HyperliquidReconcileResult]: HyperliquidReconcileResult[K]
};
