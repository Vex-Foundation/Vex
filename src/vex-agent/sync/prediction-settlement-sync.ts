/**
 * Prediction settlement sync — closes zombie Jupiter prediction positions.
 *
 * Jupiter Prediction settles via on-chain keepers, bypassing execute_tool.
 * This module polls the read API to detect settlements and creates synthetic
 * captures that flow through the standard pipeline.
 *
 * Algorithm: wallet-grouped. One API call per unique wallet, local matching.
 *
 * Jupiter settlement semantics:
 *   position_lost              → status "closed", no outputValueUsd
 *   position_won + !claimed    → status "closed", payout in meta only
 *   position_won + claimed     → status "claimed", outputValueUsd = payoutAmountUsd
 */

import { query } from "@vex-agent/db/client.js";
import { recordSyntheticCapture } from "./synthetic-capture.js";
import logger from "@utils/logger.js";

export interface SettlementResult {
  checked: number;
  closed: number;
  skipped: number;
  errors: number;
}

/**
 * Reconcile open prediction positions against protocol APIs.
 * Creates synthetic captures for settled positions.
 */
export async function reconcilePredictionSettlements(): Promise<SettlementResult> {
  const result: SettlementResult = { checked: 0, closed: 0, skipped: 0, errors: 0 };

  // Get all open prediction positions
  const positions = await query<Record<string, unknown>>(
    `SELECT id, namespace, instrument_key, position_key, wallet_address, contracts, notional_usd, data
     FROM proj_open_positions
     WHERE position_type = 'prediction' AND status = 'open'`,
    [],
  );

  if (positions.length === 0) return result;

  result.checked = positions.length;

  // Group by namespace + wallet
  const groups = new Map<string, typeof positions>();
  for (const pos of positions) {
    const key = `${pos.namespace}:${pos.wallet_address}`;
    const group = groups.get(key) ?? [];
    group.push(pos);
    groups.set(key, group);
  }

  for (const [groupKey, groupPositions] of groups) {
    const namespace = groupPositions[0].namespace as string;
    const walletAddress = groupPositions[0].wallet_address as string;

    try {
      if (namespace === "solana") {
        const groupResult = await reconcileJupiterSettlements(walletAddress, groupPositions);
        result.closed += groupResult.closed;
        result.skipped += groupResult.skipped;
        result.errors += groupResult.errors;
      } else {
        result.skipped += groupPositions.length;
      }
    } catch (err) {
      result.errors += groupPositions.length;
      logger.warn("sync.settlement.group_failed", {
        groupKey, namespace,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (result.closed > 0 || result.errors > 0) {
    logger.info("sync.settlement.completed", result);
  }

  return result;
}

// ── Jupiter Prediction ─────────────────────────────────────────────

async function reconcileJupiterSettlements(
  walletAddress: string,
  positions: Record<string, unknown>[],
): Promise<{ closed: number; skipped: number; errors: number }> {
  let closed = 0, skipped = 0, errors = 0;

  const { getJupiterPredictionHistory, getJupiterPredictionPositions } = await import(
    "@tools/solana-ecosystem/jupiter/jupiter-prediction/prediction-api/service.js"
  );

  // Fetch ALL history pages — settlement event may be beyond first 100 entries
  const allHistoryEvents: Awaited<ReturnType<typeof getJupiterPredictionHistory>>["data"] = [];
  const PAGE_SIZE = 100;
  let historyStart = 0;
  let hasMore = true;
  while (hasMore) {
    const page = await getJupiterPredictionHistory({ ownerPubkey: walletAddress, start: historyStart, end: historyStart + PAGE_SIZE });
    const events = page.data ?? [];
    allHistoryEvents.push(...events);
    hasMore = page.pagination?.hasNext === true && events.length === PAGE_SIZE;
    historyStart += PAGE_SIZE;
  }

  const positionsResp = await getJupiterPredictionPositions({ ownerPubkey: walletAddress });

  const historyEvents = allHistoryEvents;
  const apiPositions = positionsResp.data ?? [];

  // Build lookup maps
  const settlementByPositionPubkey = new Map<string, typeof historyEvents[number]>();
  for (const event of historyEvents) {
    if (event.eventType === "position_lost" || event.eventType === "position_won") {
      settlementByPositionPubkey.set(event.positionPubkey, event);
    }
  }

  const apiPositionByPubkey = new Map<string, typeof apiPositions[number]>();
  for (const pos of apiPositions) {
    apiPositionByPubkey.set(pos.pubkey, pos);
  }

  for (const dbPos of positions) {
    const positionKey = dbPos.position_key as string;
    if (!positionKey) { skipped++; continue; }

    const settlementEvent = settlementByPositionPubkey.get(positionKey);
    if (!settlementEvent) { skipped++; continue; }

    const instrumentKey = dbPos.instrument_key as string | null;
    const apiPosition = apiPositionByPubkey.get(positionKey);

    // Determine status based on event type + claimed state
    let status: string;
    let outputValueUsd: string | undefined;

    if (settlementEvent.eventType === "position_lost") {
      status = "closed";
      // No outputValueUsd — payout is $0
    } else if (settlementEvent.eventType === "position_won") {
      if (apiPosition?.claimed === true) {
        status = "claimed";
        outputValueUsd = settlementEvent.payoutAmountUsd;
      } else {
        // Won but not yet claimed — close position, payout in meta only
        status = "closed";
      }
    } else {
      skipped++;
      continue;
    }

    try {
      await recordSyntheticCapture({
        toolId: "settlement_sync.jupiter",
        namespace: "solana",
        tradeCapture: {
          type: "prediction",
          chain: "solana",
          status,
          walletAddress,
          positionKey,
          instrumentKey: instrumentKey ?? undefined,
          ...(outputValueUsd ? { outputValueUsd } : {}),
          ...(settlementEvent.totalCostUsd ? { inputValueUsd: settlementEvent.totalCostUsd } : {}),
          valuationSource: outputValueUsd ? "prediction_exact" : "none",
          settlementAssetKey: "USDC",
          meta: {
            source: "settlement_sync",
            eventType: settlementEvent.eventType,
            contractsSettled: settlementEvent.contractsSettled,
            realizedPnl: settlementEvent.realizedPnl,
            grossProceedsUsd: settlementEvent.grossProceedsUsd,
            payoutAmountUsd: settlementEvent.payoutAmountUsd,
            settledAt: settlementEvent.timestamp,
            claimed: apiPosition?.claimed ?? false,
          },
        },
        source: "settlement_sync",
      });
      closed++;
    } catch (err) {
      errors++;
      logger.warn("sync.settlement.jupiter_position_failed", {
        positionKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { closed, skipped, errors };
}
