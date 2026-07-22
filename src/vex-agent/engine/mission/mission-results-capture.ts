/**
 * Mission results capture — opens the ledger row when a run starts and
 * closes it when the run finalizes. Both are FAIL-SOFT: any error is
 * logged and swallowed so bankroll accounting can never break a mission's
 * lifecycle. Deps are injected for tests; production wires the real
 * repos/helpers.
 *
 * Start and finalize run in different turns, so nothing is held in memory —
 * the row is keyed on `mission_run_id` and re-addressed at close.
 *
 * Finalize also backfills a system-generated `stop_summary` for a run that
 * reached a terminal state without ever calling `mission_stop` (provider
 * error, park, timeout). See `system-summary.ts` for the honesty rules;
 * the write is guarded in SQL so agent-authored prose always wins.
 *
 * Naming: this produces a "mission result (ETH)" — an honest, ETH-
 * denominated PnL record. Never call it "performance" here or in any
 * consumer (agent behavior is directional and carries risk; a single
 * numeric ledger is not a guarantee of future results).
 *
 * Never logs a wallet address — only ids (mission/run/session) and error
 * messages.
 */

import { randomUUID } from "node:crypto";
import { getMission, type Mission } from "../../db/repos/missions.js";
import { resolveLocalChainId } from "../../../tools/evm-chains/registry.js";
import { readEthBankroll } from "./bankroll.js";
import { countMissionTrades } from "./mission-metrics.js";
import {
  openMissionResult,
  closeMissionResult,
  getResultForRun,
  type MissionResultOutcome,
} from "../../db/repos/mission-results.js";
import { setStopSummaryIfAbsent } from "../../db/repos/mission-runs.js";
import { buildSystemSummary } from "./system-summary.js";
import logger from "@utils/logger.js";

const GOAL_SNIPPET_MAX = 240;

export interface CaptureDeps {
  getMission: typeof getMission;
  readBankroll: typeof readEthBankroll;
  openResult: typeof openMissionResult;
  closeResult: typeof closeMissionResult;
  getResult: typeof getResultForRun;
  countTrades: typeof countMissionTrades;
  /**
   * Writes the fallback prose for a run that never called `mission_stop`.
   * No-ops when the agent already wrote one (guarded in SQL).
   */
  setStopSummaryIfAbsent: typeof setStopSummaryIfAbsent;
}

// Built lazily (inside each function's try) rather than at module load: some
// runner tests partially-mock the repo modules, and a top-level object
// literal would touch those bindings at import time. Resolving inside the
// try keeps the access under the fail-soft guard.
function productionDeps(): CaptureDeps {
  return {
    getMission,
    readBankroll: readEthBankroll,
    openResult: openMissionResult,
    closeResult: closeMissionResult,
    getResult: getResultForRun,
    countTrades: countMissionTrades,
    setStopSummaryIfAbsent,
  };
}

/** Pure PnL: ETH delta + percent vs start. Null when either side is unknown. */
export function computePnl(
  startEth: number | null,
  endEth: number | null,
): { pnlEth: number | null; pnlPct: number | null } {
  if (startEth === null || endEth === null) return { pnlEth: null, pnlPct: null };
  const pnlEth = endEth - startEth;
  const pnlPct = startEth > 0 ? (pnlEth / startEth) * 100 : null;
  return { pnlEth, pnlPct };
}

/** The mission's primary wallet + resolved local chain id, or null if either is absent/unresolvable. */
function resolveWalletChain(
  mission: Pick<Mission, "allowedWallets" | "allowedChains">,
): { wallet: string; chainId: number } | null {
  const wallet = mission.allowedWallets[0];
  const chainKey = mission.allowedChains[0];
  if (!wallet || !chainKey) return null;
  const chainId = resolveLocalChainId(chainKey);
  if (chainId === undefined) return null;
  return { wallet, chainId };
}

/** Open the ledger row at run start (fail-soft). */
export async function captureMissionStart(
  args: { missionId: string; runId: string; sessionId: string },
  injected?: CaptureDeps,
): Promise<void> {
  try {
    const deps = injected ?? productionDeps();
    const mission = await deps.getMission(args.missionId);
    if (!mission) return;
    const wc = resolveWalletChain(mission);
    if (!wc) return;
    const bankroll = await deps.readBankroll(wc.wallet, wc.chainId);
    await deps.openResult({
      id: `mres-${randomUUID()}`,
      missionId: args.missionId,
      missionRunId: args.runId,
      sessionId: args.sessionId,
      walletAddress: wc.wallet,
      chainId: wc.chainId,
      goalSnippet: mission.goal?.slice(0, GOAL_SNIPPET_MAX) ?? null,
      bankrollStartEth: bankroll?.bankrollEth ?? null,
      ethPriceUsdStart: bankroll?.ethPriceUsd ?? null,
    });
  } catch (err) {
    logger.warn("mission.results.capture_start_failed", {
      runId: args.runId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Close the ledger row at finalize with PnL + trade count (fail-soft). */
export async function captureMissionFinal(
  args: {
    missionId: string;
    runId: string;
    sessionId: string;
    outcome: Exclude<MissionResultOutcome, "running">;
    stopReason: string | null;
  },
  injected?: CaptureDeps,
): Promise<void> {
  try {
    const deps = injected ?? productionDeps();
    const mission = await deps.getMission(args.missionId);
    const wc = mission ? resolveWalletChain(mission) : null;
    if (!wc) return;
    const existing = await deps.getResult(args.runId, wc.wallet);
    if (!existing) return; // never opened or not owned by this mission wallet -> nothing to close
    const bankroll = await deps.readBankroll(wc.wallet, wc.chainId);
    const endEth = bankroll?.bankrollEth ?? null;
    const { pnlEth, pnlPct } = computePnl(existing.bankrollStartEth, endEth);
    const trades = await deps.countTrades(
      args.sessionId,
      existing.startedAt,
      new Date().toISOString(),
    );
    const openPositions = bankroll?.openPositions ?? null;
    await deps.closeResult({
      missionRunId: args.runId,
      outcome: args.outcome,
      stopReason: args.stopReason,
      bankrollEndEth: endEth,
      ethPriceUsdEnd: bankroll?.ethPriceUsd ?? null,
      pnlEth,
      pnlPct,
      trades,
      openPositions,
    });

    // A run that died without calling `mission_stop` leaves no prose at
    // all, so the card falls back to raw metrics exactly when the operator
    // most needs an explanation — and says nothing about a position left
    // open. Backfill an honest, clearly-labelled account from the facts we
    // just wrote. The repo guards on `stop_summary IS NULL`, so a real
    // agent-authored summary is never overwritten.
    const wrote = await deps.setStopSummaryIfAbsent(
      args.runId,
      buildSystemSummary({
        outcome: args.outcome,
        stopReason: args.stopReason,
        trades,
        pnlEth,
        ethPriceUsd: bankroll?.ethPriceUsd ?? null,
        openPositionSymbols: (openPositions ?? [])
          .map((p) => p.symbol)
          .filter((sym): sym is string => typeof sym === "string" && sym.length > 0),
      }),
    );
    if (wrote) {
      logger.info("mission.results.system_summary_written", {
        runId: args.runId,
        stopReason: args.stopReason,
        openPositions: (openPositions ?? []).length,
      });
    }
  } catch (err) {
    logger.warn("mission.results.capture_final_failed", {
      runId: args.runId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
