/**
 * THE IN-MEMORY RULE AUTHORITY: per auto top-up rule, a GENERATION counter
 * and a count of PENDING mutations, both changed SYNCHRONOUSLY by every change
 * that can withdraw or reshape the rule's authority (edit, pause, revoke, and
 * resume for symmetry), read by the executor at admission and in its FINAL
 * local check right before the offline signature.
 *
 * WHY. The pre-sign gate re-reads the rule from durable state, but between it
 * and the signature there are awaits (the key decryption, the pending-nonce
 * read) and the final check may not touch the network or the database. A
 * cached "the rule held at the gate" would let a revoke committed during
 * those awaits still sign.
 *
 * WHY BOTH. The generation alone has a hole: a mutation bumps it BEFORE its
 * durable write, and an execution that captures the generation while that
 * write is still pending would admit against the still-active stored row and
 * see an unchanged number in its final check if the write had not committed
 * yet. The pending count closes it: a mutation is pending from its first bump
 * until its write settled (committed or not), and both admission and the
 * final check refuse while any mutation on the rule is pending.
 *
 * | Check | Admission (before the ASK row, and inside its locked transaction) | Final check (local, no I/O) |
 * |---|---|---|
 * | pending mutation on the rule | refuse | refuse |
 * | generation | captured | unchanged since capture |
 *
 * SERIALISATION AND ORDER (the contract the executor header states):
 *
 * - a mutation that BEGAN before the final check wins: the signing is refused
 *   with nothing signed (recorded `refused`, not counted);
 * - a mutation that begins after the final check passed applies to the NEXT
 *   top-up, because the signature follows that check synchronously;
 * - NO WAITING IN EITHER DIRECTION, so no deadlock: a mutation never waits for
 *   an in-flight execution (it only bumps and counts, then writes), and an
 *   execution never waits for a mutation (it refuses). The only shared wait
 *   is the database's per-rule row lock, held by the ASK transaction for its
 *   own short read-decide-insert, which never awaits a mutation.
 *
 * The main process is the only writer of rule rows, so every mutation passes
 * through {@link withRuleAuthorityChange}.
 *
 * BOUNDED: two integers per rule id this process touched; an account holds at
 * most one live rule. A pending count returns to zero in `finally`.
 */

const generations = new Map<string, number>();
const pending = new Map<string, number>();

/** The current generation of `ruleId` (0 before any change in this process). */
export function ruleAuthorityGeneration(ruleId: string): number {
  return generations.get(ruleId) ?? 0;
}

/** Whether a durable mutation of `ruleId` has begun and not yet settled. */
export function ruleMutationPending(ruleId: string): boolean {
  return (pending.get(ruleId) ?? 0) > 0;
}

function bump(ruleId: string): void {
  generations.set(ruleId, ruleAuthorityGeneration(ruleId) + 1);
}

/**
 * Run one durable rule mutation as PENDING for its whole duration, with the
 * generation bumped before it starts and after it settles (committed or not):
 * no top-up can be admitted, or pass its final check, while it is pending,
 * and one admitted before it began can never pass its final check.
 */
export async function withRuleAuthorityChange<T>(ruleId: string, mutate: () => Promise<T>): Promise<T> {
  pending.set(ruleId, (pending.get(ruleId) ?? 0) + 1);
  bump(ruleId);
  try {
    return await mutate();
  } finally {
    bump(ruleId);
    const left = (pending.get(ruleId) ?? 1) - 1;
    if (left > 0) pending.set(ruleId, left);
    else pending.delete(ruleId);
  }
}

/** Test-only. */
export function __resetRuleAuthorityForTests(): void {
  generations.clear();
  pending.clear();
}
