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

  constructor(private readonly now: () => number = Date.now) {}

  /** Store a proposal under a fresh id. */
  mint(build: (proposalId: string) => T): T {
    this.sweep();
    while (this.entries.size >= MAX_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
    const entry = build(randomUUID());
    this.entries.set(entry.proposalId, entry);
    return entry;
  }

  /** SINGLE USE: the entry leaves the store whatever the answer. */
  consume(proposalId: string): ProposalLookup<T> {
    const found = this.lookup(proposalId);
    this.entries.delete(proposalId);
    this.sweep();
    return found;
  }

  /** Read without removing (a withdrawal keeps its proposal, and its key, for a transport retry). */
  peek(proposalId: string): ProposalLookup<T> {
    const found = this.lookup(proposalId);
    if (found.kind === "expired") this.entries.delete(proposalId);
    this.sweep();
    return found;
  }

  /** Replace a live entry (a withdrawal records its submission). */
  update(entry: T): void {
    if (this.entries.has(entry.proposalId)) this.entries.set(entry.proposalId, entry);
  }

  drop(proposalId: string): void {
    this.entries.delete(proposalId);
  }

  /** How many live entries remain (tests and diagnostics). */
  size(): number {
    this.sweep();
    return this.entries.size;
  }

  private lookup(proposalId: string): ProposalLookup<T> {
    const entry = this.entries.get(proposalId);
    if (entry === undefined) return { kind: "missing" };
    if (entry.expiresAtMs <= this.now()) return { kind: "expired" };
    return { kind: "ok", entry };
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, entry] of this.entries) {
      if (entry.expiresAtMs <= now) this.entries.delete(id);
    }
  }
}
