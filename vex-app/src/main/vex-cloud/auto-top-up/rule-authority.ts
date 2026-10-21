/**
 * THE IN-MEMORY RULE AUTHORITY GENERATION: one counter per auto top-up rule,
 * bumped SYNCHRONOUSLY by every change that can withdraw or reshape the
 * rule's authority (edit, pause, revoke, and resume or expiry for symmetry),
 * read by the executor's FINAL local check right before the offline
 * signature.
 *
 * WHY. The pre-sign gate re-reads the rule from durable state, but between it
 * and the signature there are awaits (the key decryption, the pending-nonce
 * read) and the final check may not touch the network or the database. A
 * cached "the rule held at the gate" would let a revoke committed during
 * those awaits still sign. The generation closes that window without I/O: a
 * mutation bumps it BEFORE its durable write starts and again AFTER it
 * commits, so a final check that runs at any point after the mutation began
 * sees a different number than the one captured at admission.
 *
 * SERIALISATION (the contract the executor header states): a mutation that
 * BEGAN before the final check wins, and the signing is refused with nothing
 * signed; a mutation that begins after the final check passed applies to the
 * NEXT top-up, because the signature follows that check synchronously. The
 * main process is the only writer of rule rows, so every mutation passes
 * through {@link invalidateRuleAuthority}.
 *
 * BOUNDED: one integer per rule id this process touched; an account holds at
 * most one live rule.
 */

const generations = new Map<string, number>();

/** The current generation of `ruleId` (0 before any change in this process). */
export function ruleAuthorityGeneration(ruleId: string): number {
  return generations.get(ruleId) ?? 0;
}

/** Withdraw every admission captured before now. Synchronous, idempotent in effect. */
export function invalidateRuleAuthority(ruleId: string): void {
  generations.set(ruleId, ruleAuthorityGeneration(ruleId) + 1);
}

/**
 * Run one durable rule mutation with the generation bumped before it starts
 * and after it settles (committed or not): an in-flight top-up admitted under
 * the old rule can never pass its final check once this began.
 */
export async function withRuleAuthorityChange<T>(ruleId: string, mutate: () => Promise<T>): Promise<T> {
  invalidateRuleAuthority(ruleId);
  try {
    return await mutate();
  } finally {
    invalidateRuleAuthority(ruleId);
  }
}

/** Test-only. */
export function __resetRuleAuthorityForTests(): void {
  generations.clear();
}
