/**
 * The durable side of the Vex Inference funding policy (migrations 178 and
 * 179, the per-top-up network fee ceiling): the
 * low-balance alert setting, the per-account balance watch, the auto top-up
 * standing rule and every deposit execution made under a rule or an agent
 * approval.
 *
 * OWNER. The Electron main process (`vex-app/src/main/vex-cloud/`). This
 * module is persistence only: it never decides whether a deposit may run.
 * The policy (state machine, caps, coverage) lives in
 * `vex-app/src/main/vex-cloud/auto-top-up/`, which calls these functions in
 * the order its contract states.
 *
 * Amounts are raw wei (VEX, 18 decimals) as decimal strings at this boundary
 * and `bigint` on the typed side; NUMERIC(78,0) in Postgres. Never a float.
 */

import type pg from "pg";
import { queryOneWith, queryWith, getPool, withTransaction, type Executor } from "../client.js";

// ── Settings ─────────────────────────────────────────────────────────────

export const DEFAULT_ALERT_PERCENT = 20;

export async function readAlertPercent(db: Executor = getPool()): Promise<number> {
  const row = await queryOneWith<{ alert_percent: number }>(
    db,
    "SELECT alert_percent FROM vex_inference_settings WHERE id = 1",
  );
  return row === null ? DEFAULT_ALERT_PERCENT : row.alert_percent;
}

export async function writeAlertPercent(percent: number, db: Executor = getPool()): Promise<number> {
  if (!Number.isInteger(percent) || percent < 1 || percent > 90) {
    throw new RangeError("alert percent must be a whole number from 1 to 90");
  }
  const row = await queryOneWith<{ alert_percent: number }>(
    db,
    `INSERT INTO vex_inference_settings (id, alert_percent) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET alert_percent = EXCLUDED.alert_percent, updated_at = now()
     RETURNING alert_percent`,
    [percent],
  );
  if (row === null) throw new Error("alert percent write returned no row");
  return row.alert_percent;
}

// ── Balance watch ────────────────────────────────────────────────────────

export interface BalanceWatchRow {
  readonly accountId: string;
  readonly referenceWei: bigint;
  readonly lastBalanceWei: bigint;
  readonly belowAlert: boolean;
  readonly lastCreditedDepositId: string | null;
}

interface BalanceWatchDbRow {
  readonly account_id: string;
  readonly reference_wei: string;
  readonly last_balance_wei: string;
  readonly below_alert: boolean;
  readonly last_credited_deposit_id: string | null;
}

function mapWatch(row: BalanceWatchDbRow): BalanceWatchRow {
  return {
    accountId: row.account_id,
    referenceWei: BigInt(row.reference_wei),
    lastBalanceWei: BigInt(row.last_balance_wei),
    belowAlert: row.below_alert,
    lastCreditedDepositId: row.last_credited_deposit_id,
  };
}

export async function readBalanceWatch(accountId: string, db: Executor = getPool()): Promise<BalanceWatchRow | null> {
  const row = await queryOneWith<BalanceWatchDbRow>(
    db,
    `SELECT account_id, reference_wei::text, last_balance_wei::text, below_alert, last_credited_deposit_id
       FROM vex_inference_balance_watch WHERE account_id = $1`,
    [accountId],
  );
  return row === null ? null : mapWatch(row);
}

/**
 * Run one observation's read-decide-write under a row lock, so two
 * concurrent observations (the poller and an account read) cannot both see
 * "not yet below" and emit two notices for one crossing.
 */
export async function updateBalanceWatch(
  accountId: string,
  decide: (current: BalanceWatchRow | null) => BalanceWatchRow,
): Promise<{ readonly before: BalanceWatchRow | null; readonly after: BalanceWatchRow }> {
  return withTransaction(async (client: pg.PoolClient) => {
    // Serializes the first observation too, when no row exists to lock yet.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('vex_inference_balance_watch:' || $1))", [accountId]);
    const found = await queryOneWith<BalanceWatchDbRow>(
      client,
      `SELECT account_id, reference_wei::text, last_balance_wei::text, below_alert, last_credited_deposit_id
         FROM vex_inference_balance_watch WHERE account_id = $1 FOR UPDATE`,
      [accountId],
    );
    const before = found === null ? null : mapWatch(found);
    const after = decide(before);
    await client.query(
      `INSERT INTO vex_inference_balance_watch
         (account_id, reference_wei, last_balance_wei, below_alert, last_credited_deposit_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (account_id) DO UPDATE SET
         reference_wei = EXCLUDED.reference_wei,
         last_balance_wei = EXCLUDED.last_balance_wei,
         below_alert = EXCLUDED.below_alert,
         last_credited_deposit_id = EXCLUDED.last_credited_deposit_id,
         updated_at = now()`,
      [accountId, after.referenceWei.toString(), after.lastBalanceWei.toString(), after.belowAlert, after.lastCreditedDepositId],
    );
    return { before, after };
  });
}

// ── Auto top-up rules ────────────────────────────────────────────────────

export type AutoTopUpRuleStatus = "active" | "paused" | "revoked" | "expired";

export interface AutoTopUpRuleRow {
  readonly ruleId: string;
  readonly accountId: string;
  /** Lowercase hex. */
  readonly sourceWallet: string;
  readonly amountWei: bigint;
  readonly maxPerDay: number;
  readonly monthlyCapWei: bigint;
  /**
   * The user-approved ceiling on ONE top-up's network fee, raw ETH wei.
   * `null` only on a rule approved before migration 179: no ceiling was
   * approved, so the policy treats every fee as above the limit.
   */
  readonly maxNetworkFeeWei: bigint | null;
  readonly triggerKind: "below_alert_percent";
  readonly expiresAt: Date;
  readonly status: AutoTopUpRuleStatus;
  readonly version: number;
  readonly approvedAt: Date;
  readonly updatedAt: Date;
}

interface RuleDbRow {
  readonly rule_id: string;
  readonly account_id: string;
  readonly source_wallet: string;
  readonly amount_wei: string;
  readonly max_per_day: number;
  readonly monthly_cap_wei: string;
  readonly max_network_fee_wei: string | null;
  readonly trigger_kind: "below_alert_percent";
  readonly expires_at: Date;
  readonly status: AutoTopUpRuleStatus;
  readonly version: number;
  readonly approved_at: Date;
  readonly updated_at: Date;
}

const RULE_COLUMNS = `rule_id, account_id, source_wallet, amount_wei::text, max_per_day, monthly_cap_wei::text,
  max_network_fee_wei::text, trigger_kind, expires_at, status, version, approved_at, updated_at`;

function mapRule(row: RuleDbRow): AutoTopUpRuleRow {
  return {
    ruleId: row.rule_id,
    accountId: row.account_id,
    sourceWallet: row.source_wallet,
    amountWei: BigInt(row.amount_wei),
    maxPerDay: row.max_per_day,
    monthlyCapWei: BigInt(row.monthly_cap_wei),
    maxNetworkFeeWei: row.max_network_fee_wei === null ? null : BigInt(row.max_network_fee_wei),
    triggerKind: row.trigger_kind,
    expiresAt: row.expires_at,
    status: row.status,
    version: row.version,
    approvedAt: row.approved_at,
    updatedAt: row.updated_at,
  };
}

/** The live (active or paused) rule of an account, or `null`. */
export async function readLiveRule(accountId: string, db: Executor = getPool()): Promise<AutoTopUpRuleRow | null> {
  const row = await queryOneWith<RuleDbRow>(
    db,
    `SELECT ${RULE_COLUMNS} FROM vex_inference_auto_top_up_rules
      WHERE account_id = $1 AND status IN ('active', 'paused')`,
    [accountId],
  );
  return row === null ? null : mapRule(row);
}

/** Every live rule regardless of account (the poller suspends ones whose account is not the signed-in one). */
export async function listLiveRules(db: Executor = getPool()): Promise<readonly AutoTopUpRuleRow[]> {
  const rows = await queryWith<RuleDbRow>(
    db,
    `SELECT ${RULE_COLUMNS} FROM vex_inference_auto_top_up_rules
      WHERE status IN ('active', 'paused') ORDER BY approved_at`,
  );
  return rows.map(mapRule);
}

export async function readRule(ruleId: string, db: Executor = getPool()): Promise<AutoTopUpRuleRow | null> {
  const row = await queryOneWith<RuleDbRow>(db, `SELECT ${RULE_COLUMNS} FROM vex_inference_auto_top_up_rules WHERE rule_id = $1`, [ruleId]);
  return row === null ? null : mapRule(row);
}

export interface NewRuleInput {
  readonly ruleId: string;
  readonly accountId: string;
  readonly sourceWallet: string;
  readonly amountWei: bigint;
  readonly maxPerDay: number;
  readonly monthlyCapWei: bigint;
  readonly maxNetworkFeeWei: bigint;
  readonly expiresAt: Date;
  readonly approvedAt: Date;
}

export async function insertRule(input: NewRuleInput, db: Executor = getPool()): Promise<AutoTopUpRuleRow> {
  const row = await queryOneWith<RuleDbRow>(
    db,
    `INSERT INTO vex_inference_auto_top_up_rules
       (rule_id, account_id, source_wallet, amount_wei, max_per_day, monthly_cap_wei, max_network_fee_wei, trigger_kind, expires_at, status, approved_at)
     VALUES ($1, $2, $3, $4, $5, $6, $9, 'below_alert_percent', $7, 'active', $8)
     RETURNING ${RULE_COLUMNS}`,
    [
      input.ruleId,
      input.accountId,
      input.sourceWallet.toLowerCase(),
      input.amountWei.toString(),
      input.maxPerDay,
      input.monthlyCapWei.toString(),
      input.expiresAt,
      input.approvedAt,
      input.maxNetworkFeeWei.toString(),
    ],
  );
  if (row === null) throw new Error("rule insert returned no row");
  return mapRule(row);
}

export interface RuleEditInput {
  readonly ruleId: string;
  /** The version the user reviewed; a different stored version refuses (compare-and-set). */
  readonly expectedVersion: number;
  readonly sourceWallet: string;
  readonly amountWei: bigint;
  readonly maxPerDay: number;
  readonly monthlyCapWei: bigint;
  readonly maxNetworkFeeWei: bigint;
  readonly expiresAt: Date;
  readonly approvedAt: Date;
}

/** Compare-and-set edit of a live rule; `null` when the version or status no longer match. */
export async function editRule(input: RuleEditInput, db: Executor = getPool()): Promise<AutoTopUpRuleRow | null> {
  const row = await queryOneWith<RuleDbRow>(
    db,
    `UPDATE vex_inference_auto_top_up_rules
        SET source_wallet = $3, amount_wei = $4, max_per_day = $5, monthly_cap_wei = $6,
            expires_at = $7, approved_at = $8, max_network_fee_wei = $9, version = version + 1, updated_at = now()
      WHERE rule_id = $1 AND version = $2 AND status IN ('active', 'paused')
      RETURNING ${RULE_COLUMNS}`,
    [
      input.ruleId,
      input.expectedVersion,
      input.sourceWallet.toLowerCase(),
      input.amountWei.toString(),
      input.maxPerDay,
      input.monthlyCapWei.toString(),
      input.expiresAt,
      input.approvedAt,
      input.maxNetworkFeeWei.toString(),
    ],
  );
  return row === null ? null : mapRule(row);
}

/**
 * Compare-and-set status change. `from` lists the statuses the change is
 * legal from; the version must be the reviewed one. `null` = refused.
 */
export async function setRuleStatus(
  input: { readonly ruleId: string; readonly expectedVersion: number; readonly from: readonly AutoTopUpRuleStatus[]; readonly to: AutoTopUpRuleStatus },
  db: Executor = getPool(),
): Promise<AutoTopUpRuleRow | null> {
  const row = await queryOneWith<RuleDbRow>(
    db,
    `UPDATE vex_inference_auto_top_up_rules
        SET status = $4, version = version + 1, updated_at = now()
      WHERE rule_id = $1 AND version = $2 AND status = ANY($3::text[])
      RETURNING ${RULE_COLUMNS}`,
    [input.ruleId, input.expectedVersion, [...input.from], input.to],
  );
  return row === null ? null : mapRule(row);
}

/** Retire rules whose expiry passed. Idempotent; returns how many moved. */
export async function expireRules(now: Date, db: Executor = getPool()): Promise<number> {
  const rows = await queryWith<{ rule_id: string }>(
    db,
    `UPDATE vex_inference_auto_top_up_rules SET status = 'expired', version = version + 1, updated_at = now()
      WHERE status IN ('active', 'paused') AND expires_at <= $1 RETURNING rule_id`,
    [now],
  );
  return rows.length;
}

// ── Executions ───────────────────────────────────────────────────────────

export type DepositExecutionAuthority =
  | "auto_top_up_poller"
  | "auto_top_up_agent"
  | "agent_card"
  | "agent_full_permission";

export type DepositExecutionStatus = "asked" | "submitted" | "confirmed" | "reverted" | "unknown" | "refused";

export interface DepositExecutionRow {
  readonly executionId: string;
  readonly ruleId: string | null;
  readonly authority: DepositExecutionAuthority;
  readonly sessionId: string | null;
  readonly sourceWallet: string;
  readonly depositAddress: string;
  readonly amountWei: bigint;
  readonly status: DepositExecutionStatus;
  readonly refusalKind: string | null;
  readonly txHash: string | null;
  readonly askedAt: Date;
  readonly decidedAt: Date | null;
}

interface ExecutionDbRow {
  readonly execution_id: string;
  readonly rule_id: string | null;
  readonly authority: DepositExecutionAuthority;
  readonly session_id: string | null;
  readonly source_wallet: string;
  readonly deposit_address: string;
  readonly amount_wei: string;
  readonly status: DepositExecutionStatus;
  readonly refusal_kind: string | null;
  readonly tx_hash: string | null;
  readonly asked_at: Date;
  readonly decided_at: Date | null;
}

const EXECUTION_COLUMNS = `execution_id, rule_id, authority, session_id, source_wallet, deposit_address,
  amount_wei::text, status, refusal_kind, tx_hash, asked_at, decided_at`;

function mapExecution(row: ExecutionDbRow): DepositExecutionRow {
  return {
    executionId: row.execution_id,
    ruleId: row.rule_id,
    authority: row.authority,
    sessionId: row.session_id,
    sourceWallet: row.source_wallet,
    depositAddress: row.deposit_address,
    amountWei: BigInt(row.amount_wei),
    status: row.status,
    refusalKind: row.refusal_kind,
    txHash: row.tx_hash,
    askedAt: row.asked_at,
    decidedAt: row.decided_at,
  };
}

/** Thrown when a rule already has an undecided execution (the durable single flight). */
export class RuleExecutionInFlightError extends Error {
  override readonly name = "RuleExecutionInFlightError";
  constructor() {
    super("an execution for this rule is already in flight");
  }
}

/** Cap usage of a rule over the rolling windows, counting every row that is not `refused`. */
export interface RuleUsage {
  readonly countLastDay: number;
  readonly sumLast30DaysWei: bigint;
}

async function usageWith(db: Executor, ruleId: string, now: Date): Promise<RuleUsage> {
  const row = await queryOneWith<{ day_count: string; month_sum: string }>(
    db,
    `SELECT count(*) FILTER (WHERE asked_at > $2::timestamptz - INTERVAL '24 hours')::text AS day_count,
            COALESCE(sum(amount_wei) FILTER (WHERE asked_at > $2::timestamptz - INTERVAL '30 days'), 0)::text AS month_sum
       FROM vex_inference_deposit_executions
      WHERE rule_id = $1 AND status <> 'refused'`,
    [ruleId, now],
  );
  return { countLastDay: Number(row?.day_count ?? "0"), sumLast30DaysWei: BigInt(row?.month_sum ?? "0") };
}

export async function readRuleUsage(ruleId: string, now: Date, db: Executor = getPool()): Promise<RuleUsage> {
  return usageWith(db, ruleId, now);
}

export interface AskExecutionInput {
  readonly executionId: string;
  readonly ruleId: string | null;
  readonly authority: DepositExecutionAuthority;
  readonly sessionId: string | null;
  readonly sourceWallet: string;
  readonly depositAddress: string;
  readonly amountWei: bigint;
}

/**
 * Record the `asked` row. For a rule execution the caller passes `admit`,
 * which is run inside the same transaction under a per-rule advisory lock
 * with the rule row and its CURRENT cap usage: the cap check and the write
 * that consumes the cap are one atomic step, and the partial unique index
 * refuses a second in-flight row even if a caller skipped the lock.
 * `admit` returns `null` to admit or a refusal reason to refuse (nothing
 * is written then).
 */
export async function askExecution<R>(
  input: AskExecutionInput,
  admit: ((rule: AutoTopUpRuleRow | null, usage: RuleUsage | null) => R | null) | null,
  now: Date,
): Promise<{ readonly admitted: true; readonly row: DepositExecutionRow } | { readonly admitted: false; readonly reason: R }> {
  return withTransaction(async (client: pg.PoolClient) => {
    let rule: AutoTopUpRuleRow | null = null;
    let usage: RuleUsage | null = null;
    if (input.ruleId !== null) {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('vex_inference_rule:' || $1))", [input.ruleId]);
      const found = await queryOneWith<RuleDbRow>(
        client,
        `SELECT ${RULE_COLUMNS} FROM vex_inference_auto_top_up_rules WHERE rule_id = $1 FOR UPDATE`,
        [input.ruleId],
      );
      rule = found === null ? null : mapRule(found);
      usage = await usageWith(client, input.ruleId, now);
      const inFlight = await queryOneWith<{ n: string }>(
        client,
        "SELECT count(*)::text AS n FROM vex_inference_deposit_executions WHERE rule_id = $1 AND status IN ('asked', 'submitted')",
        [input.ruleId],
      );
      if (Number(inFlight?.n ?? "0") > 0) throw new RuleExecutionInFlightError();
    }
    if (admit !== null) {
      const refusal = admit(rule, usage);
      if (refusal !== null) return { admitted: false as const, reason: refusal };
    }
    let row: ExecutionDbRow | null;
    try {
      row = await queryOneWith<ExecutionDbRow>(
        client,
        `INSERT INTO vex_inference_deposit_executions
           (execution_id, rule_id, authority, session_id, source_wallet, deposit_address, amount_wei, status, asked_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'asked', $8)
         RETURNING ${EXECUTION_COLUMNS}`,
        [
          input.executionId,
          input.ruleId,
          input.authority,
          input.sessionId,
          input.sourceWallet.toLowerCase(),
          input.depositAddress.toLowerCase(),
          input.amountWei.toString(),
          now,
        ],
      );
    } catch (cause) {
      if ((cause as { code?: unknown }).code === "23505") throw new RuleExecutionInFlightError();
      throw cause;
    }
    if (row === null) throw new Error("execution insert returned no row");
    return { admitted: true as const, row: mapExecution(row) };
  });
}

/** `asked` -> `submitted`: the transfer is about to be signed. */
export async function markExecutionSubmitted(executionId: string, db: Executor = getPool()): Promise<void> {
  await queryWith(db, "UPDATE vex_inference_deposit_executions SET status = 'submitted' WHERE execution_id = $1 AND status = 'asked'", [executionId]);
}

/** Exactly one decided status per execution: an already decided row is left untouched. */
export async function decideExecution(
  input: {
    readonly executionId: string;
    readonly status: Exclude<DepositExecutionStatus, "asked" | "submitted">;
    readonly txHash: string | null;
    readonly refusalKind: string | null;
    readonly decidedAt: Date;
  },
  db: Executor = getPool(),
): Promise<DepositExecutionRow | null> {
  const row = await queryOneWith<ExecutionDbRow>(
    db,
    `UPDATE vex_inference_deposit_executions
        SET status = $2, tx_hash = $3, refusal_kind = $4, decided_at = $5
      WHERE execution_id = $1 AND status IN ('asked', 'submitted')
      RETURNING ${EXECUTION_COLUMNS}`,
    [input.executionId, input.status, input.txHash?.toLowerCase() ?? null, input.refusalKind, input.decidedAt],
  );
  return row === null ? null : mapExecution(row);
}

/**
 * Executions a previous process left undecided: they may have been signed,
 * so they become `unknown` (still counted against the caps, never retried).
 * Called once per process, before the first execution of this process.
 */
export async function markOrphanedExecutionsUnknown(now: Date, db: Executor = getPool()): Promise<number> {
  const rows = await queryWith<{ execution_id: string }>(
    db,
    `UPDATE vex_inference_deposit_executions
        SET status = 'unknown', refusal_kind = 'process_restarted', decided_at = $1
      WHERE status IN ('asked', 'submitted') RETURNING execution_id`,
    [now],
  );
  return rows.length;
}

export async function listRuleExecutions(
  ruleId: string,
  limit: number,
  db: Executor = getPool(),
): Promise<readonly DepositExecutionRow[]> {
  const rows = await queryWith<ExecutionDbRow>(
    db,
    `SELECT ${EXECUTION_COLUMNS} FROM vex_inference_deposit_executions
      WHERE rule_id = $1 ORDER BY asked_at DESC LIMIT $2`,
    [ruleId, limit],
  );
  return rows.map(mapExecution);
}
