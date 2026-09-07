/**
 * `agent_activity` finalizers for `event_role = 'token_launch'` — the ONE
 * reason to change: what a launch's OUTPUT leg is, and when it becomes known.
 *
 * A launch is the only venue action whose output TOKEN DOES NOT EXIST when the
 * intent row is written. Every other handler names `tokenOut` up front; a
 * launch cannot, because the address is minted by the transaction it is about
 * to sign. `createAgentActivityIntent` therefore stores no `token_out_*`, and
 * `confirmActivityEvent` updates AMOUNTS ONLY — so a confirmed launch used to
 * keep `token_out_address` NULL forever.
 *
 * That is not cosmetic. The app's token history matches rows on
 * `token_in_address`/`token_out_address` (`token-history-db-query.ts`), so a
 * launch never appeared in the history of the very token it created: the user
 * saw the token in their wallet with no record of where it came from.
 *
 * Both functions here are additive and CAS-guarded, and both refuse to touch a
 * row whose `event_role` is not `token_launch` — the identity write is only
 * ever correct for the role whose output is discovered post-hoc.
 */

import type { PoolClient } from "pg";

import { queryOne, queryOneWith } from "../../client.js";
import { mapRow } from "./mappers.js";
import { resolveFastLane } from "./fast-lane-signal.js";
import { getActivityEventById } from "./swap-lifecycle/reads.js";
import { withActivitySessionLock } from "./session-lock.js";
import type { CasResult } from "./types.js";

export interface ConfirmLaunchWithOutputIdentityInput {
  readonly executedAmountInHuman?: string | undefined;
  readonly executedAmountInRaw: string;
  readonly executedAmountOutHuman?: string | undefined;
  /**
   * What the launch DELIVERED, raw - or `null` when it is not knowable yet,
   * which on a two-transaction venue is a normal stage rather than a defect.
   *
   * `null` is only accepted together with {@link outputPendingReason}, so an
   * unknown payout can never be written by omission: it is always an explicit
   * statement that a NAMED later writer owes this figure.
   */
  readonly executedAmountOutRaw: string | null;
  /**
   * Why the output leg is UNKNOWN rather than proven, on a row that is
   * otherwise terminal.
   *
   * `keeper_purchase`: the agent tokens are bought by the VIRTUALS KEEPER in a
   * second transaction that had not been observed when this row was confirmed.
   * It stamps `settlement_source = 'keeper_purchase_pending'`, which is the one
   * settlement provenance that is NOT a conclusion: the AgentScan readiness gate
   * holds the terminal report while it stands, and
   * {@link settleLaunchKeeperPurchaseByTxHash} or
   * {@link concludeLaunchKeeperSettlementByTxHash} is what ends the wait.
   */
  readonly outputPendingReason?: "keeper_purchase" | undefined;
  /** The address `TokenCreated` proved. Never guessed, never a prediction. */
  readonly tokenOutAddress: string;
  readonly tokenOutSymbol?: string | undefined;
  /** Read from the token itself; `null` when the read failed — never assumed to be 18. */
  readonly tokenOutDecimals?: number | null | undefined;
}

/**
 * `pending → confirmed` for a launch, writing the executed legs AND the output
 * identity in ONE statement.
 *
 * ATOMIC ON PURPOSE. A confirm followed by a separate identity UPDATE has a
 * window in which the row is `confirmed` with a NULL token — and nothing would
 * ever come back to fill it, because every sweep keys on `pending`.
 *
 * Both executed legs are required, exactly as `confirmActivityEvent` requires
 * them for this role: a launch that mined has both the native `msg.value` spent
 * and the token that now exists. A caller that cannot prove the output amount
 * must leave the row pending for the status-only sweep instead of calling this.
 */
export async function confirmLaunchWithOutputIdentity(
  id: number,
  input: ConfirmLaunchWithOutputIdentityInput,
): Promise<CasResult> {
  const current = await getActivityEventById(id);
  if (!current) {
    throw new Error(`agent_activity: confirmLaunchWithOutputIdentity — row ${id} does not exist`);
  }
  if (current.eventRole !== "token_launch") {
    throw new Error(
      "agent_activity: confirmLaunchWithOutputIdentity — refusing to write a discovered output "
        + `identity onto event_role '${current.eventRole}'; only 'token_launch' discovers its output`,
    );
  }
  if (!input.executedAmountInRaw) {
    throw new Error(
      "agent_activity: confirmLaunchWithOutputIdentity - event_role 'token_launch' requires "
        + "executedAmountInRaw",
    );
  }
  // AN UNKNOWN PAYOUT IS ONLY EVER WRITTEN ON PURPOSE. A missing output leg with
  // no named reason is the old provisional zero in a different disguise: the row
  // would go terminal owing money nobody is waiting for.
  if (!input.executedAmountOutRaw && input.outputPendingReason === undefined) {
    throw new Error(
      "agent_activity: confirmLaunchWithOutputIdentity - event_role 'token_launch' requires "
        + "executedAmountOutRaw, or outputPendingReason naming the writer that owes it",
    );
  }
  if (input.executedAmountOutRaw && input.outputPendingReason !== undefined) {
    throw new Error(
      "agent_activity: confirmLaunchWithOutputIdentity - a proven output amount cannot also be "
        + "pending; the report would be held for a payout that is already known",
    );
  }
  if (!input.tokenOutAddress) {
    throw new Error(
      "agent_activity: confirmLaunchWithOutputIdentity — the created token's address is required; "
        + "a launch confirmed without it is invisible in its own token's history",
    );
  }

  const row = await withActivitySessionLock(current.sessionId, (client) =>
    queryOneWith<Record<string, unknown>>(
      client,
      `UPDATE agent_activity
          SET status = 'confirmed', confirmed_at = NOW(), updated_at = NOW(),
              executed_amount_in_human = $2, executed_amount_in_raw = $3,
              executed_amount_out_human = $4, executed_amount_out_raw = $5,
              token_out_address = $6, token_out_symbol = $7, token_out_decimals = $8,
              -- The STATUS was proven by this handler's own receipt whatever
              -- happened to the amounts; the two provenances are separate
              -- columns for exactly this case (migration 067).
              confirmation_source = 'tool_response', settlement_source = $9,
              pending_reason = NULL,
              -- A TERMINAL ROW HOLDS NO CLAIM — same invariant as every other
              -- winning terminal write, cleared in this statement rather than a
              -- follow-up. A launch row is an ordinary EVM pending row to the
              -- fallback lane, so it can be under claim when this lands.
              evm_claim_lease_until = NULL, evm_claim_token = NULL
        WHERE id = $1 AND status = 'pending' AND event_role = 'token_launch'
        RETURNING *`,
      [
        id,
        input.executedAmountInHuman ?? null,
        input.executedAmountInRaw,
        input.executedAmountOutHuman ?? null,
        input.executedAmountOutRaw,
        input.tokenOutAddress,
        input.tokenOutSymbol ?? null,
        input.tokenOutDecimals ?? null,
        input.outputPendingReason === undefined ? "tool_response" : "keeper_purchase_pending",
      ],
    ));

  if (row) return { applied: true, row: resolveFastLane(mapRow(row)) };

  // THE CAS MISSED, WHICH MEANS THE STATUS-ONLY SWEEP GOT HERE FIRST (it
  // confirms a pending row from its hash after ~90 seconds and writes no
  // amounts). The row is terminal in status and this call is still the only
  // thing that knows the payout is OWED - so the obligation is recorded on the
  // confirmed row rather than lost with the update. Without this, the reporting
  // gate saw a confirmed launch with no settlement provenance at all and, once
  // the grace elapsed, sent the terminal event with an empty payout, spending
  // the server's one merge window before the keeper had acted.
  //
  // Only ever for an input that NAMES the owed payout: a caller with a proven
  // amount owes nothing, and the pools lane (which never passes the reason) is
  // untouched.
  if (input.outputPendingReason === "keeper_purchase") {
    await markKeeperPurchaseOwed(`id = $1`, [id]);
  }
  const currentRow = await getActivityEventById(id);
  if (!currentRow) {
    throw new Error(`agent_activity: confirmLaunchWithOutputIdentity — row ${id} vanished`);
  }
  return { applied: false, row: currentRow };
}

/**
 * The obligation write itself, shared by both of the ways a launch can come to
 * owe one so the guards can never drift apart.
 *
 * A FILL-IN-THE-BLANK, never an overwrite: it refuses a row whose payout is
 * already proven and a row that carries some OTHER settlement provenance, so it
 * can never unsay a settlement, a conclusion or a quarantine. A row that already
 * owes matches, so re-running it is a `true` rather than a failure.
 */
async function markKeeperPurchaseOwed(
  keyClause: string,
  params: unknown[],
): Promise<boolean> {
  const row = await queryOne<Record<string, unknown>>(
    `UPDATE agent_activity
        SET settlement_source = 'keeper_purchase_pending', updated_at = NOW()
      WHERE ${keyClause} AND event_role = 'token_launch'
        AND executed_amount_out_raw IS NULL
        AND (settlement_source IS NULL OR settlement_source = 'keeper_purchase_pending')
      RETURNING id`,
    params,
  );
  return row !== null;
}

/**
 * Stamp the created token onto a launch row found by its transaction hash,
 * WITHOUT touching status or amounts — the crash-recovery sweep's half.
 *
 * The sweep decodes an identity and nothing else (it never reads an amount off
 * the chain), so it must not pretend to confirm anything. `token_out_address IS
 * NULL` in the predicate makes it a fill-in-the-blank, never an overwrite: the
 * handler's own atomic confirm always wins, in either order, any number of
 * times.
 *
 * Returns whether a row was actually stamped, so the caller can report a real
 * repair instead of assuming one.
 */
export async function stampLaunchOutputIdentityByTxHash(
  txHash: string,
  tokenOutAddress: string,
): Promise<boolean> {
  const row = await queryOne<Record<string, unknown>>(
    `UPDATE agent_activity
        SET token_out_address = $2, updated_at = NOW()
      WHERE tx_hash = $1 AND event_role = 'token_launch' AND token_out_address IS NULL
      RETURNING id`,
    [txHash, tokenOutAddress],
  );
  return row !== null;
}

/**
 * The DURABLE ANSWER the pending lane already wrote about a launch broadcast,
 * looked up by its transaction hash.
 *
 * The identity sweep needs this because the lane is the ONLY writer allowed to
 * terminalize a superseded broadcast (it holds the claim fence and owns both A6
 * clocks), while the launch INTENT it also stalls is a row the lane never
 * touches. Reading the sibling's verdict is how the intent learns it, and it is
 * a read of a durable record rather than a second RPC classification — so the
 * mirror works with the provider completely unavailable.
 *
 * `event_role = 'token_launch'` is REQUIRED in the predicate. `tx_hash` is
 * globally unique on this table (migration 044), so a hash match alone would
 * silently accept a swap or transfer row and let a non-launch verdict decide a
 * launch's terminal status.
 *
 * `null` means "no launch row for this hash", which is not the same as "the row
 * is still pending" — the caller must treat both as no answer.
 */
export async function findLaunchActivityTerminalByTxHash(
  txHash: string,
): Promise<{ readonly status: string } | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT status FROM agent_activity
      WHERE tx_hash = $1 AND event_role = 'token_launch'
      LIMIT 1`,
    [txHash],
  );
  return row === null ? null : { status: row.status as string };
}

/**
 * The BENIGN-MISS fill-in: write the discovered identity and amounts onto a
 * launch row that is ALREADY `confirmed`.
 *
 * The generic status-only repair sweep confirms a pending row from its tx hash
 * after ~90 seconds and writes no amounts (owner decree 2026-07-30). When it
 * beats the handler's own finalizer, `confirmLaunchWithOutputIdentity` CAS-
 * misses on `status = 'pending'` and the decoded identity would be lost
 * FOREVER — no sweep revisits a `confirmed` row, so the launch stays invisible
 * in its own token's history.
 *
 * `token_out_address IS NULL` keeps this a fill-in-the-blank rather than an
 * overwrite: it can only ever complete a row the sweep left half-known, never
 * restate an identity someone already proved. Status is deliberately untouched
 * — the row is already confirmed and this is not a second confirmation.
 *
 * Returns whether a row was filled, so the caller can require that ONE of the
 * two writers actually landed before it lets the intent leave the sweep's
 * claimable set.
 */
export async function fillLaunchOutputIdentityOnConfirmed(
  id: number,
  input: ConfirmLaunchWithOutputIdentityInput,
): Promise<boolean> {
  const row = await queryOne<Record<string, unknown>>(
    `UPDATE agent_activity
        SET executed_amount_in_human = COALESCE(executed_amount_in_human, $2),
            executed_amount_in_raw = COALESCE(executed_amount_in_raw, $3),
            executed_amount_out_human = COALESCE(executed_amount_out_human, $4),
            executed_amount_out_raw = COALESCE(executed_amount_out_raw, $5),
            token_out_address = $6, token_out_symbol = $7, token_out_decimals = $8,
            updated_at = NOW()
      WHERE id = $1 AND status = 'confirmed' AND event_role = 'token_launch'
        AND token_out_address IS NULL
      RETURNING id`,
    [
      id,
      input.executedAmountInHuman ?? null,
      input.executedAmountInRaw,
      input.executedAmountOutHuman ?? null,
      input.executedAmountOutRaw,
      input.tokenOutAddress,
      input.tokenOutSymbol ?? null,
      input.tokenOutDecimals ?? null,
    ],
  );
  return row !== null;
}

/**
 * ESTABLISH the keeper obligation on a launch row, addressed by the hash of the
 * `preLaunch` that created it.
 *
 * THE OBLIGATION IS OLDER THAN THE CONFIRMATION, and that ordering is the whole
 * point. It used to be installed only by the handler's own finalizer
 * ({@link confirmLaunchWithOutputIdentity}), which CAS-requires `status =
 * 'pending'`; the generic status-only receipt sweep confirms a pending row from
 * its hash after ~90 seconds and can win that race. When it did, the finalizer
 * applied nothing, `settlement_source` stayed NULL, and after the reporting
 * grace the drain sent a TERMINAL launch event with no payout at all - spending
 * the server's single `pending -> terminal` merge window on an empty figure
 * before the keeper had even acted (Codex round-3 blocker 5A, reproduced on real
 * Postgres).
 *
 * So the obligation is written at the moment the launch leg's hash is STAGED -
 * before the bytes reach the network, and therefore before any confirmer,
 * sweep or recovery can see the row at all. This is MetaMask's shape for a
 * pending obligation: `TransactionController` reserves the nonce and stamps the
 * transaction in the same update that makes it publishable
 * (`TransactionController.ts:3102-3135`), and
 * `PendingTransactionTracker` only ever carries that record forward through
 * later status transitions - it never re-derives it after the fact.
 *
 * BY HASH, not by row id, because the two writers that need it address the row
 * differently and must not drift apart: the handler stages the hash it just
 * signed, and the identity-repair sweep knows a launch only by the hash on its
 * intent. Every other keeper writer here is already hash-addressed for the same
 * reason.
 *
 * A FILL-IN-THE-BLANK, never an overwrite. It refuses a row whose payout is
 * already proven and a row that already carries some OTHER settlement
 * provenance, so it can never unsay a settlement, a conclusion or a quarantine;
 * re-running it on a row that already owes returns `true`, so the caller can
 * require the obligation to stand without a repeat becoming a failure.
 *
 * Returns whether the obligation stands after this call.
 */
export async function markLaunchKeeperPurchaseOwedByTxHash(txHash: string): Promise<boolean> {
  return markKeeperPurchaseOwed(`tx_hash = $1`, [txHash]);
}

/**
 * The KEEPER'S proven purchase, written onto a launch row that recorded the
 * payout as owed.
 *
 * A Virtuals launch takes two transactions and only the first is Vex's. When
 * the handler's bounded wait for the keeper elapses it confirms the row with NO
 * output amount and `settlement_source = 'keeper_purchase_pending'`, which is
 * the honest statement at that moment: `preLaunch` buys nothing, no agent tokens
 * exist for the wallet until the keeper's `launch()` runs, and the figure is
 * UNKNOWN rather than zero. The keeper sweep observes that transaction later and
 * its `Launched` event carries `initialPurchasedAmount` - the tokens the launch
 * actually delivered. This writer is where that number lands, and writing it is
 * what ENDS the AgentScan reporting hold the pending marker created.
 *
 * IT ONLY EVER FILLS A ZERO OR A BLANK. The predicate refuses a row that
 * already carries a non-zero amount, so a proven figure - the handler's own,
 * when the keeper acted inside the wait - can never be restated by a later
 * observation. The historical zero is still accepted because rows written before
 * the pending marker existed carry it. Status is untouched: the row is already
 * terminal and this is not a second confirmation.
 *
 * The HUMAN amount is deliberately left alone. `token_out_decimals` is NULL on
 * these rows (the agent token's scale is not read at launch time), and a human
 * figure rendered against an assumed scale is worse than none.
 *
 * Returns whether a row was actually settled, so the caller can keep the launch
 * in its sweep's claimable set instead of retiring it on an unwritten amount.
 */
export async function settleLaunchKeeperPurchaseByTxHash(
  txHash: string,
  executedAmountOutRaw: string,
): Promise<boolean> {
  const row = await queryOne<Record<string, unknown>>(
    `UPDATE agent_activity
        SET executed_amount_out_raw = $2,
            settlement_source = 'keeper_settlement_observed',
            updated_at = NOW()
      WHERE tx_hash = $1 AND event_role = 'token_launch'
        AND (executed_amount_out_raw IS NULL OR executed_amount_out_raw = '0')
      RETURNING id`,
    [txHash, executedAmountOutRaw],
  );
  return row !== null;
}

/**
 * END the keeper wait on a launch whose second transaction is settled but whose
 * payout will never be a proven positive number.
 *
 * The pending marker `settleLaunchKeeperPurchaseByTxHash` normally clears is a
 * HOLD on the AgentScan terminal report, and a hold with no way out is worse
 * than the provisional zero it replaced. There are exactly two ways a keeper
 * wait ends without a delivered amount, and they are different facts:
 *
 *  - `cancelled` - the creator cancelled before the keeper acted. Nothing was
 *    ever delivered and nothing ever will be, so ZERO is the proven payout here
 *    rather than a placeholder, and the row is settled with it. (The refund
 *    itself is the `launch_cancel` row's output leg, not this one's.)
 *  - `amount_unreadable` - the keeper's `Launched` WAS observed and its
 *    `initialPurchasedAmount` could not be read. The launch delivered something;
 *    Vex declines to say how much. The amount stays absent and the row takes the
 *    repository's existing "no reportable amount is coming" provenance, so the
 *    activity is reported without inventing a figure.
 *
 * Only ever applies to a row still carrying the pending marker: a launch whose
 * amount some other writer already proved is finished, and a second conclusion
 * must not unsay it.
 */
export async function concludeLaunchKeeperSettlementByTxHash(
  txHash: string,
  conclusion: "cancelled" | "amount_unreadable",
): Promise<boolean> {
  return runConcludeLaunchKeeperSettlement(
    (sql, params) => queryOne<Record<string, unknown>>(sql, params),
    txHash,
    conclusion,
  );
}

/**
 * {@link concludeLaunchKeeperSettlementByTxHash} on the CALLER's transaction.
 *
 * The cancellation path needs it: retiring the intent and ending the activity's
 * keeper hold are ONE fact about one launch, and committing them separately left
 * a crash window whose end state is unreachable by every repair path we have -
 * `intent = cancelled` (so the keeper sweep, which claims `awaiting_keeper`
 * only, will never look at it again) with `activity = keeper_purchase_pending`
 * (so the reporting gate holds its terminal event forever). Codex's round-3
 * failure injection produced exactly that state, and the function still returned
 * `true`.
 */
export async function concludeLaunchKeeperSettlementByTxHashWith(
  client: PoolClient,
  txHash: string,
  conclusion: "cancelled" | "amount_unreadable",
): Promise<boolean> {
  return runConcludeLaunchKeeperSettlement(
    (sql, params) => queryOneWith<Record<string, unknown>>(client, sql, params),
    txHash,
    conclusion,
  );
}

async function runConcludeLaunchKeeperSettlement(
  run: (sql: string, params: unknown[]) => Promise<Record<string, unknown> | null>,
  txHash: string,
  conclusion: "cancelled" | "amount_unreadable",
): Promise<boolean> {
  const row = await run(
    `UPDATE agent_activity
        SET executed_amount_out_raw =
              CASE WHEN $2::text = 'cancelled' THEN '0' ELSE executed_amount_out_raw END,
            settlement_source =
              CASE WHEN $2::text = 'cancelled' THEN 'keeper_settlement_observed' ELSE 'amounts_incomplete' END,
            updated_at = NOW()
      WHERE tx_hash = $1 AND event_role = 'token_launch'
        AND settlement_source = 'keeper_purchase_pending'
      RETURNING id`,
    [txHash, conclusion],
  );
  return row !== null;
}
