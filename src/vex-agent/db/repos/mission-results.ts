/**
 * Mission results ledger repo — open/close lifecycle + per-wallet history
 * reads.
 *
 * A row is OPENED when a mission run starts (with a per-wallet `seq_no` and
 * the start bankroll snapshot) and CLOSED when the run finalizes (end
 * bankroll, PnL, trade count, outcome, raw stop_reason). Open/close key on
 * `mission_run_id`, so the start and finalize hooks — which run in
 * different turns — address the same row without holding state in memory.
 *
 * `seq_no` is minted under a transaction-scoped Postgres advisory lock keyed
 * on the wallet address, so two concurrent opens for the SAME wallet can
 * never mint the same number (a bare `SELECT COUNT(*)+1` here would race).
 *
 * PnL is in ETH (bankroll = native ETH + WETH). See migration 041.
 */

import type pg from "pg";
import { query, queryOne, queryOneWith, execute, executeWith, withTransaction } from "../client.js";
import { nullableJsonb } from "../params.js";

export type MissionResultOutcome = "running" | "completed" | "cancelled" | "failed" | "stopped";

export interface MissionResultRow {
  id: string;
  missionId: string;
  missionRunId: string;
  sessionId: string;
  walletAddress: string;
  chainId: number;
  seqNo: number;
  goalSnippet: string | null;
  startedAt: string;
  endedAt: string | null;
  durationS: number | null;
  bankrollStartEth: number | null;
  bankrollEndEth: number | null;
  pnlEth: number | null;
  pnlPct: number | null;
  ethPriceUsdStart: number | null;
  ethPriceUsdEnd: number | null;
  trades: number;
  outcome: MissionResultOutcome;
  stopReason: string | null;
  openPositions: unknown;
  /**
   * The agent's own plain-language account of the run, from
   * `mission_runs.stop_summary`. Null when the run never called
   * `mission_stop`. Prose ONLY — it must never carry a PnL figure; the
   * numeric fields above are the sole source of truth for money.
   */
  stopSummary: string | null;
  /**
   * THE OPERATOR'S OWN WORDS, COMPLETE. `missions.goal` verbatim — NOT the
   * 240-char `goal_snippet` above, which is a display slice minted at
   * ledger-open (`mission-results-capture.ts`) and silently loses the tail of
   * a long prompt. The card clamps for reading but copies THIS, so "copy the
   * mission prompt" yields exactly what was typed. Null for a goal-less draft.
   */
  goalFull: string | null;
  /** `missions.title` — the operator/setup-authored short label, if any. */
  missionTitle: string | null;
  /**
   * `missions.constraints_json` raw. Structured operator-set limits
   * (maxSpendUsd, deadlineAt, maxIterations, …). Deterministic: these were
   * WRITTEN by the contract, never inferred from prose at read time.
   */
  constraints: unknown;
  /** `missions.allowed_chains` — the venue allowlist as accepted. */
  allowedChains: readonly string[];
  /** `missions.allowed_protocols` — the protocol allowlist as accepted. */
  allowedProtocols: readonly string[];
}

export interface OpenMissionResultInput {
  id: string;
  missionId: string;
  missionRunId: string;
  sessionId: string;
  walletAddress: string;
  chainId: number;
  goalSnippet: string | null;
  bankrollStartEth: number | null;
  ethPriceUsdStart: number | null;
}

export interface CloseMissionResultInput {
  missionRunId: string;
  outcome: Exclude<MissionResultOutcome, "running">;
  stopReason: string | null;
  bankrollEndEth: number | null;
  ethPriceUsdEnd: number | null;
  pnlEth: number | null;
  pnlPct: number | null;
  trades: number;
  openPositions: unknown;
}

/**
 * Reads are `mission_results r JOIN mission_runs run`, so every column is
 * table-qualified (both tables carry `id`/`mission_id`/`session_id`).
 *
 * `stop_summary` is the agent-authored prose and lives on `mission_runs`;
 * the ledger deliberately does NOT copy it. One source of truth, and no
 * migration needed to surface it. Note the asymmetry this encodes: the
 * PROSE comes from the run row, the NUMBERS come from the ledger row.
 */
const SELECT_COLUMNS = `
  r.id, r.mission_id, r.mission_run_id, r.session_id, r.wallet_address, r.chain_id, r.seq_no,
  r.goal_snippet, r.started_at, r.ended_at, r.duration_s,
  r.bankroll_start_eth, r.bankroll_end_eth, r.pnl_eth, r.pnl_pct,
  r.eth_price_usd_start, r.eth_price_usd_end,
  r.trades, r.outcome, r.stop_reason, r.open_positions_json,
  run.stop_summary,
  m.goal AS mission_goal, m.title AS mission_title,
  m.constraints_json, m.allowed_chains, m.allowed_protocols`;

/**
 * Reads join the run row for its agent-authored prose, and the mission row
 * for the ACCEPTED CONTRACT FACTS (see SELECT_COLUMNS).
 *
 * Three authors, three sources, deliberately kept apart:
 *   - `mission_results r` — the NUMBERS (bankroll, PnL, trades). Engine-computed.
 *   - `mission_runs run`  — the PROSE. Agent-authored, never parsed for money.
 *   - `missions m`        — the ASK. Operator-authored and frozen at accept.
 *
 * The mission join is INNER: `mission_results.mission_id` is NOT NULL and
 * references `missions(id)`, so it can never drop a ledger row.
 */
const RESULTS_FROM = `mission_results r
       JOIN mission_runs run ON run.id = r.mission_run_id
       JOIN missions m ON m.id = r.mission_id`;

interface Raw {
  id: string;
  mission_id: string;
  mission_run_id: string;
  session_id: string;
  wallet_address: string;
  chain_id: string | number;
  seq_no: number;
  goal_snippet: string | null;
  started_at: Date | string;
  ended_at: Date | string | null;
  duration_s: number | null;
  bankroll_start_eth: string | null;
  bankroll_end_eth: string | null;
  pnl_eth: string | null;
  pnl_pct: string | null;
  eth_price_usd_start: string | null;
  eth_price_usd_end: string | null;
  trades: number;
  outcome: MissionResultOutcome;
  stop_reason: string | null;
  open_positions_json: unknown;
  stop_summary: string | null;
  mission_goal: string | null;
  mission_title: string | null;
  constraints_json: unknown;
  allowed_chains: string[] | null;
  allowed_protocols: string[] | null;
}

/**
 * `TEXT[]` comes back as a JS array, but the column is nullable and legacy
 * rows predate the `DEFAULT '{}'`. Normalise to a real array of strings so
 * the renderer never has to null-check an allowlist.
 */
const strList = (v: string[] | null): readonly string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];

// pg returns NUMERIC as string to preserve precision; ETH/PnL fit safely in
// a JS number for display.
const num = (v: string | number | null): number | null => (v === null ? null : Number(v));

const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : String(v));

function toRow(r: Raw): MissionResultRow {
  return {
    id: r.id,
    missionId: r.mission_id,
    missionRunId: r.mission_run_id,
    sessionId: r.session_id,
    walletAddress: r.wallet_address,
    chainId: Number(r.chain_id),
    seqNo: r.seq_no,
    goalSnippet: r.goal_snippet,
    startedAt: iso(r.started_at),
    endedAt: r.ended_at === null ? null : iso(r.ended_at),
    durationS: r.duration_s,
    bankrollStartEth: num(r.bankroll_start_eth),
    bankrollEndEth: num(r.bankroll_end_eth),
    pnlEth: num(r.pnl_eth),
    pnlPct: num(r.pnl_pct),
    ethPriceUsdStart: num(r.eth_price_usd_start),
    ethPriceUsdEnd: num(r.eth_price_usd_end),
    trades: r.trades,
    outcome: r.outcome,
    stopReason: r.stop_reason,
    openPositions: r.open_positions_json,
    stopSummary: r.stop_summary,
    goalFull: r.mission_goal,
    missionTitle: r.mission_title,
    constraints: r.constraints_json,
    allowedChains: strList(r.allowed_chains),
    allowedProtocols: strList(r.allowed_protocols),
  };
}

/**
 * Open the ledger row for a run. `seq_no` is minted as `MAX(seq_no)+1` for
 * the wallet, under a transaction-scoped advisory lock keyed on the
 * (lowercased) wallet address — a concurrent open for a DIFFERENT wallet
 * proceeds independently; a concurrent open for the SAME wallet blocks at
 * the lock until the first transaction commits, so the two can never mint
 * the same number. The lock releases automatically at COMMIT/ROLLBACK.
 *
 * Idempotent: a duplicate open for the same run is a no-op (the run-id
 * unique index + `ON CONFLICT`), so a retried start never double-numbers.
 */
export async function openMissionResult(input: OpenMissionResultInput): Promise<void> {
  await withTransaction(async (client: pg.PoolClient) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      missionResultsSeqLockKey(input.walletAddress),
    ]);
    const next = await queryOneWith<{ next_seq: string }>(
      client,
      `SELECT (COALESCE(MAX(seq_no), 0) + 1)::text AS next_seq
         FROM mission_results
        WHERE LOWER(wallet_address) = LOWER($1)`,
      [input.walletAddress],
    );
    const seqNo = Number(next?.next_seq ?? "1");
    const sql = `
      INSERT INTO mission_results (
        id, mission_id, mission_run_id, session_id, wallet_address, chain_id,
        seq_no, goal_snippet, bankroll_start_eth, eth_price_usd_start, outcome
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'running')
      ON CONFLICT (mission_run_id) DO NOTHING`;
    await executeWith(client, sql, [
      input.id,
      input.missionId,
      input.missionRunId,
      input.sessionId,
      input.walletAddress,
      input.chainId,
      seqNo,
      input.goalSnippet,
      input.bankrollStartEth,
      input.ethPriceUsdStart,
    ]);
  });
}

/** Stable advisory-lock key for per-wallet seq_no minting (see openMissionResult). */
function missionResultsSeqLockKey(walletAddress: string): string {
  return `mission_results_seq:${walletAddress.toLowerCase()}`;
}

/** Close the ledger row at finalize. No-op if the row was never opened. */
export async function closeMissionResult(input: CloseMissionResultInput): Promise<void> {
  const sql = `
    UPDATE mission_results SET
      outcome = $2,
      stop_reason = $3,
      ended_at = NOW(),
      duration_s = EXTRACT(EPOCH FROM (NOW() - started_at))::int,
      bankroll_end_eth = $4,
      eth_price_usd_end = $5,
      pnl_eth = $6,
      pnl_pct = $7,
      trades = $8,
      open_positions_json = $9,
      updated_at = NOW()
    WHERE mission_run_id = $1`;
  await execute(sql, [
    input.missionRunId,
    input.outcome,
    input.stopReason,
    input.bankrollEndEth,
    input.ethPriceUsdEnd,
    input.pnlEth,
    input.pnlPct,
    input.trades,
    nullableJsonb(input.openPositions),
  ]);
}

/** Per-wallet mission history, newest first. */
export async function listResultsForWallet(
  walletAddress: string,
  limit = 50,
): Promise<MissionResultRow[]> {
  const rows = await query<Raw>(
    `SELECT ${SELECT_COLUMNS}
       FROM ${RESULTS_FROM}
      WHERE LOWER(r.wallet_address) = LOWER($1)
      ORDER BY r.seq_no DESC
      LIMIT $2`,
    [walletAddress, limit],
  );
  return rows.map(toRow);
}

/**
 * The newest ledger row for a session (null when the session never opened a
 * run). Session-scoped rather than wallet-scoped because the session view
 * shows the run that just finished IN THIS SESSION — it has a session id in
 * hand and no wallet address, and the newest row for the session is exactly
 * the run whose summary belongs on screen.
 *
 * Ordered by `started_at DESC` (not `seq_no`): `seq_no` is minted per WALLET,
 * so it does not order a single session's runs if the session ever switched
 * wallets.
 */
export async function getLatestResultForSession(
  sessionId: string,
): Promise<MissionResultRow | null> {
  const row = await queryOne<Raw>(
    `SELECT ${SELECT_COLUMNS}
       FROM ${RESULTS_FROM}
      WHERE r.session_id = $1
      ORDER BY r.started_at DESC
      LIMIT 1`,
    [sessionId],
  );
  return row ? toRow(row) : null;
}

/** The ledger row for a single run and wallet (null if never opened or not owned by that wallet). */
export async function getResultForRun(
  missionRunId: string,
  walletAddress: string,
): Promise<MissionResultRow | null> {
  const row = await queryOne<Raw>(
    `SELECT ${SELECT_COLUMNS}
       FROM ${RESULTS_FROM}
      WHERE r.mission_run_id = $1
        AND LOWER(r.wallet_address) = LOWER($2)`,
    [missionRunId, walletAddress],
  );
  return row ? toRow(row) : null;
}
