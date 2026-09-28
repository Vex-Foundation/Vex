/**
 * Pure lease-claim rules shared by the repo and the lock-then-validate claim
 * helpers. No database access, so it can be imported anywhere without pulling
 * in the pool (and without being swapped out by a mocked repo module).
 */

/**
 * Whether an existing lease row blocks a claim by `ownerId` presenting
 * `claimToken`. The one rule every lock-then-validate claim path uses, so its
 * pre-check agrees with `acquireLease`'s own WHERE clause: a live lease
 * blocks unless the caller is refreshing the SAME claim (same owner AND the
 * current token). An expired lease never blocks.
 */
export function leaseBlocksClaim(
  existing: {
    readonly ownerId: string;
    readonly expiresAt: Date;
    readonly claimToken: string;
  },
  ownerId: string,
  claimToken: string | undefined,
  now: Date = new Date(),
): boolean {
  if (existing.expiresAt < now) return false;
  return !(
    existing.ownerId === ownerId
    && claimToken !== undefined
    && existing.claimToken === claimToken
  );
}
