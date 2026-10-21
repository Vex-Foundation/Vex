/**
 * Withdrawals that were SENT and whose outcome is unknown (main answered
 * `outcome: "unknown"`): the renderer's record of what it may ask about
 * again. Main owns the proposal and its idempotency key; this store holds only
 * the identity a "Check status" replays (proposal id, amount, destination),
 * so the record survives a tab switch or leaving the funding page. UI-only,
 * never persisted: main's own store is process memory too.
 *
 * A record leaves when a check returns the withdrawal, or when main no longer
 * knows the proposal (it answered or refused definitively, or restarted).
 *
 * BOUNDED: at most {@link MAX_UNRESOLVED} records, the oldest evicted first
 * (the same bound as main's proposal store).
 */

import { create } from "zustand";

export const MAX_UNRESOLVED = 32;

export interface UnresolvedWithdrawal {
  readonly proposalId: string;
  readonly amountWei: string;
  readonly destination: string;
}

interface UnresolvedWithdrawalsState {
  readonly records: readonly UnresolvedWithdrawal[];
  readonly keep: (record: UnresolvedWithdrawal) => void;
  readonly resolve: (proposalId: string) => void;
}

export const useUnresolvedWithdrawals = create<UnresolvedWithdrawalsState>((set) => ({
  records: [],
  keep: (record) =>
    set((state) => {
      const rest = state.records.filter((existing) => existing.proposalId !== record.proposalId);
      const next = [...rest, record];
      return { records: next.length > MAX_UNRESOLVED ? next.slice(next.length - MAX_UNRESOLVED) : next };
    }),
  resolve: (proposalId) =>
    set((state) => {
      if (!state.records.some((record) => record.proposalId === proposalId)) return state;
      return { records: state.records.filter((record) => record.proposalId !== proposalId) };
    }),
}));

/** An open unknown outcome for exactly this amount and destination, if any. */
export function unresolvedFor(
  records: readonly UnresolvedWithdrawal[],
  amountWei: bigint | null,
  destination: string | null,
): UnresolvedWithdrawal | null {
  if (amountWei === null || destination === null) return null;
  return (
    records.find(
      (record) => record.amountWei === amountWei.toString() && record.destination.toLowerCase() === destination.toLowerCase(),
    ) ?? null
  );
}
