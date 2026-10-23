/**
 * The in-memory home of main-minted funding proposals (deposit and
 * withdrawal), the `pools-launch` fingerprint-store pattern
 * (`src/vex-agent/tools/protocols/pools/launch/fingerprint-store.ts`):
 *
 *  - PROCESS MEMORY, NOT A TABLE. A restart means the user prepares again,
 *    which re-reads the rate, the balances and the deposit address; a stale
 *    proposal surviving a restart would be a liability, not a feature.
 *  - EXPIRES. Each entry carries its own deadline and is swept on every
 *    access, so the map stays bounded and a lapsed proposal cannot be used.
 *  - BOUNDED. At most {@link MAX_ENTRIES} live entries; minting past that
 *    evicts the oldest (a user cannot approve a card they no longer see).
 *  - THE LOOKUP HAPPENS BEFORE THE SWEEP, so a just-lapsed entry is
 *    reported as `expired`, not confused with one that never existed.
 *  - ONE CLOCK. Every call takes the owner's `now` in milliseconds, the same
 *    clock the owner minted `expiresAtMs` from. A store reading its own
 *    clock while the owner reads another let a proposal expire, or live, by
 *    the wall clock instead of the owner's.
 *
 * The id is a random UUID and carries no information about the proposal.
 */

import { randomUUID } from "node:crypto";

const MAX_ENTRIES = 32;

export interface StoredProposal {
  readonly proposalId: string;
  readonly expiresAtMs: number;
}

export type ProposalLookup<T> =
  | { readonly kind: "ok"; readonly entry: T }
  | { readonly kind: "expired" }
  | { readonly kind: "missing" };

export class ProposalStore<T extends StoredProposal> {
  private readonly entries = new Map<string, T>();

  /** Store a proposal under a fresh id. */
  mint(nowMs: number, build: (proposalId: string) => T): T {
    this.sweep(nowMs);
    this.makeRoom();
    const entry = build(randomUUID());
    this.entries.set(entry.proposalId, entry);
    return entry;
  }

  /** SINGLE USE: the entry leaves the store whatever the answer. */
  consume(proposalId: string, nowMs: number): ProposalLookup<T> {
    const found = this.lookup(proposalId, nowMs);
    this.entries.delete(proposalId);
    this.sweep(nowMs);
    return found;
  }

  /** Read without removing (a withdrawal keeps its proposal, and its key, until it is sent). */
  peek(proposalId: string, nowMs: number): ProposalLookup<T> {
    const found = this.lookup(proposalId, nowMs);
    if (found.kind === "expired") this.entries.delete(proposalId);
    this.sweep(nowMs);
    return found;
  }

  /** Store an entry under its OWN id (a sent withdrawal moving to the unresolved store keeps its id and key). */
  adopt(entry: T, nowMs: number): void {
    this.sweep(nowMs);
    this.entries.delete(entry.proposalId);
    this.makeRoom();
    this.entries.set(entry.proposalId, entry);
  }

  drop(proposalId: string): void {
    this.entries.delete(proposalId);
  }

  private lookup(proposalId: string, nowMs: number): ProposalLookup<T> {
    const entry = this.entries.get(proposalId);
    if (entry === undefined) return { kind: "missing" };
    if (entry.expiresAtMs <= nowMs) return { kind: "expired" };
    return { kind: "ok", entry };
  }

  /** Bounded: past {@link MAX_ENTRIES} the oldest entry leaves. */
  private makeRoom(): void {
    while (this.entries.size >= MAX_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
  }

  private sweep(nowMs: number): void {
    for (const [id, entry] of this.entries) {
      if (entry.expiresAtMs <= nowMs) this.entries.delete(id);
    }
  }
}
