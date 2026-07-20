/**
 * Shared row -> DTO mapper for `mission.listResults` /
 * `mission.getResultForRun` — both read the same `mission_results` ledger
 * row shape and must project it identically for the renderer.
 *
 * THREE AUTHORS, KEPT APART. The numbers come from the ledger row, the prose
 * from the run row, and the ASK (goal, title, constraints) from the mission
 * row — see `SELECT_COLUMNS` in `db/repos/mission-results.ts`. The card
 * renders each zone from its own source and nothing crosses over. In
 * particular `constraints` is projected from stored contract JSON and is
 * NEVER derived from `stopSummary`.
 */

import type { MissionResultRow } from "@vex-agent/db/repos/mission-results.js";
import type {
  MissionConstraintFacts,
  MissionResultDto,
} from "@shared/schemas/mission.js";

/**
 * `constraints_json` is a JSONB blob written by the contract surface. It is
 * trusted as to ORIGIN (the engine wrote it) but not as to SHAPE — legacy
 * missions predate individual fields and the column defaults to `{}`. Every
 * read is therefore type-checked, and anything that is not a finite number or
 * a non-empty string collapses to `null` so the card OMITS the chip rather
 * than rendering a garbage one. A guessed constraint is worse than none.
 */
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function int(v: unknown): number | null {
  const n = num(v);
  return n === null ? null : Math.trunc(n);
}

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function toConstraintFacts(row: MissionResultRow): MissionConstraintFacts {
  const c: Record<string, unknown> =
    row.constraints !== null &&
    typeof row.constraints === "object" &&
    !Array.isArray(row.constraints)
      ? (row.constraints as Record<string, unknown>)
      : {};
  return {
    maxSpendUsd: num(c.maxSpendUsd),
    maxLossUsd: num(c.maxLossUsd),
    maxIterations: int(c.maxIterations),
    deadlineAt: str(c.deadlineAt),
    allowedChains: [...row.allowedChains],
    allowedProtocols: [...row.allowedProtocols],
  };
}

export function toMissionResultDto(row: MissionResultRow): MissionResultDto {
  return {
    missionRunId: row.missionRunId,
    sessionId: row.sessionId,
    seqNo: row.seqNo,
    goalSnippet: row.goalSnippet,
    goalFull: row.goalFull,
    missionTitle: row.missionTitle,
    constraints: toConstraintFacts(row),
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    durationS: row.durationS,
    bankrollStartEth: row.bankrollStartEth,
    bankrollEndEth: row.bankrollEndEth,
    pnlEth: row.pnlEth,
    pnlPct: row.pnlPct,
    ethPriceUsdEnd: row.ethPriceUsdEnd,
    trades: row.trades,
    outcome: row.outcome,
    stopReason: row.stopReason,
    openPositionsCount: Array.isArray(row.openPositions) ? row.openPositions.length : 0,
    stopSummary: row.stopSummary,
  };
}
