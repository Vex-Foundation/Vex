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

import { queryOne, queryOneWith } from "../../client.js";
import { mapRow } from "./mappers.js";
import { getActivityEventById } from "./swap-lifecycle/reads.js";
import { withActivitySessionLock } from "./session-lock.js";
import type { CasResult } from "./types.js";

export interface ConfirmLaunchWithOutputIdentityInput {
  readonly executedAmountInHuman?: string | undefined;
  readonly executedAmountInRaw: string;
  readonly executedAmountOutHuman?: string | undefined;
  readonly executedAmountOutRaw: string;
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
  if (!input.executedAmountInRaw || !input.executedAmountOutRaw) {
    throw new Error(
      "agent_activity: confirmLaunchWithOutputIdentity — event_role 'token_launch' requires "
        + "executedAmountInRaw + executedAmountOutRaw",
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
              token_out_address = $6, token_out_symbol = $7, token_out_decimals = $8
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
      ],
    ));

  if (row) return { applied: true, row: mapRow(row) };
  const currentRow = await getActivityEventById(id);
  if (!currentRow) {
    throw new Error(`agent_activity: confirmLaunchWithOutputIdentity — row ${id} vanished`);
  }
  return { applied: false, row: currentRow };
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
