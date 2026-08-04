/**
 * Agent Scan activity repo — LATE MONEY ENRICHMENT on an already-TERMINAL row.
 *
 * A third responsibility, distinct from both siblings: `../swap-lifecycle.js`
 * owns the once-only `status` transitions, `./swap-lifecycle/verification-
 * bookkeeping.js` owns what we know about a still-PENDING row, and this module
 * owns the amounts of a row whose status question is already answered. It holds
 * role-completeness eligibility, money validation and conflict detection, none
 * of which belong to either of those.
 *
 * WHY THIS EXISTS AT ALL. Every repair sweep in this repository is guarded to
 * `status = 'pending'`, so a row that was confirmed status-only — `confirmed`,
 * `executedAmount* = null`, `amountBasis: "estimated"` forever — is invisible to
 * all of them. Nothing could repair it. These two writers are the seam that
 * lets the pending-fallback lane finish the job, or state by name why it cannot.
 *
 * NEITHER FUNCTION EVER MOVES `status`, and neither touches
 * `confirmation_source`: how the STATUS was established is a different fact from
 * how the MONEY was, which is exactly why migration 067 gave them separate
 * columns.
 *
 * NEITHER IS CLAIM-FENCED, deliberately. Both target `status = 'confirmed'`
 * rows, and the fallback lane's claim predicate selects `status = 'pending'` —
 * so a confirmed row cannot be re-claimed. That, and not "it has no token", is
 * the reason it is safe: a row may still carry a stale token until its lease is
 * released. Stated explicitly so a later "add the fence for symmetry" cannot
 * turn every decline into a permanent no-op.
 */

import { getPool, queryOne } from "../../client.js";
import logger from "@utils/logger.js";
import { mapRow } from "./mappers.js";
import { roleLegsIncomplete } from "./role-legs.js";
import type { AgentActivityEvent } from "./types.js";
import type { ConfirmActivityEventInput } from "./swap-lifecycle.js";
import type { SettlementDeclineReason } from "./provenance-vocabulary.js";

/** The four executed-amount pairs, as DB column stems. */
const AMOUNT_FIELDS = [
  { column: "executed_amount_in_raw", raw: "executedAmountInRaw", human: "executedAmountInHuman", humanColumn: "executed_amount_in_human" },
  { column: "executed_amount_out_raw", raw: "executedAmountOutRaw", human: "executedAmountOutHuman", humanColumn: "executed_amount_out_human" },
  { column: "executed_amount_in2_raw", raw: "executedAmountIn2Raw", human: "executedAmountIn2Human", humanColumn: "executed_amount_in2_human" },
  { column: "executed_amount_out2_raw", raw: "executedAmountOut2Raw", human: "executedAmountOut2Human", humanColumn: "executed_amount_out2_human" },
] as const;

export interface FillExecutedAmountsInput {
  readonly id: number;
  /** Must equal the row's own `tx_hash` — a decode of the wrong transaction can never land here. */
  readonly expectedTxHash: string;
  /** Must equal the row's own `chain_id`. */
  readonly expectedChainId: number;
  readonly amounts: ConfirmActivityEventInput;
}

export type FillExecutedAmountsOutcome =
  | "applied"
  | "already_complete"
  | "conflict"
  | "not_eligible";

export interface FillExecutedAmountsResult {
  readonly outcome: FillExecutedAmountsOutcome;
  readonly row: AgentActivityEvent;
}

/**
 * Fill the executed amounts of a CONFIRMED row that never got them — the one
 * new CAS the pending fallback needs, and the only thing that can repair the
 * amountless-confirmed row this wave exists to fix.
 *
 * There is no `source` parameter on purpose: this function writes
 * `settlement_source = 'receipt_decoded_late'` and nothing else. A widened
 * parameter would let a caller write a source this function must never write.
 *
 * COMPARE BEFORE MERGE, ATOMICALLY. Every existing non-null applicable amount
 * must EQUAL the decoded value before any missing field is filled. The hole this
 * closes: stored input `A`, stored output NULL, decoder returns input `B != A`
 * and output `C` — a per-field `COALESCE` would preserve `A`, write `C`, and
 * assemble a money tuple out of contradictory evidence, with the conflict path
 * never running. ONE disagreement ⇒ NO money is written at all and the row is
 * quarantined.
 *
 * A conflict does NOT mark the transaction failed. The transaction succeeded; it
 * is our READING of the amounts that is disputed.
 */
export async function fillExecutedAmountsOnConfirmed(
  input: FillExecutedAmountsInput,
): Promise<FillExecutedAmountsResult> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const pinned = await client.query<Record<string, unknown>>(
      `SELECT * FROM agent_activity WHERE id = $1 FOR UPDATE`,
      [input.id],
    );
    const raw = pinned.rows[0];
    if (!raw) {
      await client.query("ROLLBACK");
      throw new Error(`agent_activity: fillExecutedAmountsOnConfirmed — row ${input.id} does not exist`);
    }
    const row = mapRow(raw);

    if (
      row.status !== "confirmed"
      || row.txHash !== input.expectedTxHash
      || row.chainId !== input.expectedChainId
      || row.settlementSource === "conflict_quarantined"
    ) {
      await client.query("ROLLBACK");
      return { outcome: "not_eligible", row };
    }

    const conflicts = AMOUNT_FIELDS.filter((field) => {
      const stored = row[field.raw];
      const decoded = input.amounts[field.raw];
      return stored !== null && decoded !== undefined && stored !== decoded;
    });

    if (conflicts.length > 0) {
      // Two decoders disagreeing about money is a stop-the-line event, not a
      // last-write-wins. Quarantine DURABLY: a log line and a return value do
      // not survive a restart, so the fallback would re-select and re-conflict
      // this row forever.
      const quarantined = await client.query<Record<string, unknown>>(
        `UPDATE agent_activity
            SET settlement_source = 'conflict_quarantined', updated_at = NOW()
          WHERE id = $1 AND status = 'confirmed'
          RETURNING *`,
        [input.id],
      );
      await client.query("COMMIT");
      logger.error("agent_activity.late_fill_conflict", {
        id: input.id,
        fields: conflicts.map((field) => field.column),
        stored: conflicts.map((field) => row[field.raw]),
        decoded: conflicts.map((field) => input.amounts[field.raw]),
      });
      return { outcome: "conflict", row: mapRow(quarantined.rows[0] ?? raw) };
    }

    if (!roleLegsIncomplete(row)) {
      await client.query("ROLLBACK");
      return { outcome: "already_complete", row };
    }

    // Every stored non-null agreed above; the `IS NULL OR =` clauses repeat the
    // check INSIDE the statement so the guard holds under concurrency even
    // without the row pin.
    const params: unknown[] = [input.id, input.expectedTxHash, input.expectedChainId];
    const setClauses: string[] = [];
    const guardClauses: string[] = [];
    for (const field of AMOUNT_FIELDS) {
      const decoded = input.amounts[field.raw] ?? null;
      const decodedHuman = input.amounts[field.human] ?? null;
      params.push(decoded);
      const rawIndex = params.length;
      params.push(decodedHuman);
      const humanIndex = params.length;
      setClauses.push(`${field.column} = COALESCE(${field.column}, $${rawIndex}::text)`);
      setClauses.push(`${field.humanColumn} = COALESCE(${field.humanColumn}, $${humanIndex}::text)`);
      guardClauses.push(`(${field.column} IS NULL OR $${rawIndex}::text IS NULL OR ${field.column} = $${rawIndex}::text)`);
    }

    const updated = await client.query<Record<string, unknown>>(
      `UPDATE agent_activity
          SET ${setClauses.join(", ")},
              settlement_source = 'receipt_decoded_late', updated_at = NOW()
        WHERE id = $1 AND status = 'confirmed'
          AND tx_hash = $2 AND chain_id = $3
          AND ${guardClauses.join(" AND ")}
        RETURNING *`,
      params,
    );
    const applied = updated.rows[0];
    if (!applied) {
      await client.query("ROLLBACK");
      return { outcome: "conflict", row };
    }
    await client.query("COMMIT");
    return { outcome: "applied", row: mapRow(applied) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Why `noteSettlementDeclined` refused. Every refusal is BY NAME, never a bare `false`. */
export type NoteSettlementDeclinedMiss = "not_confirmed" | "already_sourced" | "role_complete";

/**
 * Record that this confirmed row's amounts could NOT be established, and why.
 *
 * `SettlementDeclineReason` is a declared SUBSET of `SettlementSource`: the full
 * union also carries POSITIVE provenance, and a decline path must be
 * structurally unable to stamp a success.
 *
 * THIS WRITER ENFORCES ROLE-AWARE ELIGIBILITY ITSELF. Checking only
 * `status='confirmed' AND settlement_source IS NULL` and leaving role-awareness
 * to the caller would let any caller stamp a role-COMPLETE row as
 * `amounts_incomplete` — recording a missing-amount claim about a row whose
 * amounts are all present. The guard is in the function, and it refuses by name.
 * It uses the SAME `roleLegsIncomplete` predicate as the strict confirm guard
 * and as `fillExecutedAmountsOnConfirmed`; a second copy of that rule is how a
 * row starts satisfying one and violating the other.
 */
export async function noteSettlementDeclined(
  id: number,
  reason: SettlementDeclineReason,
): Promise<{ applied: boolean; reason?: NoteSettlementDeclinedMiss }> {
  const current = await queryOne<Record<string, unknown>>(
    `SELECT * FROM agent_activity WHERE id = $1`,
    [id],
  );
  if (!current) {
    throw new Error(`agent_activity: noteSettlementDeclined — row ${id} does not exist`);
  }
  const row = mapRow(current);
  if (row.status !== "confirmed") return { applied: false, reason: "not_confirmed" };
  // Never overwrite a recorded provenance, positive or negative.
  if (row.settlementSource !== null) return { applied: false, reason: "already_sourced" };
  if (!roleLegsIncomplete(row)) return { applied: false, reason: "role_complete" };

  const written = await queryOne<{ id: number }>(
    `UPDATE agent_activity
        SET settlement_source = $2, updated_at = NOW()
      WHERE id = $1 AND status = 'confirmed' AND settlement_source IS NULL
      RETURNING id`,
    [id, reason],
  );
  // The CAS re-checks the two SQL-expressible conditions under concurrency; a
  // miss here means another writer recorded a source between the read and the
  // write, which is `already_sourced` by definition.
  if (!written) return { applied: false, reason: "already_sourced" };
  return { applied: true };
}
