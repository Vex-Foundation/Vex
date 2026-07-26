/**
 * Session-scoped bounded reveal for the hidden `swap_quote_uniswap` /
 * `swap_execute_uniswap` pair (plan §11.2, Blocker B).
 *
 * Modeled on the existing hot-set precedent
 * (`src/lib/hyperliquid-workspace-mode.ts` — a process-local, session-scoped,
 * fail-closed-to-normal flag) but one layer more local: this state is owned
 * and mutated entirely from WITHIN the agent runtime (an eligible Kyber
 * failure reveals it directly), not bridged in from Electron main.
 *
 * Two effects flip together once `revealUniswapPair` fires for a session:
 *   (a) tool-list visibility — `visibility.ts`'s `requiresUniswapReveal` gate
 *       reads `isUniswapPairRevealed` so the hidden pair joins the catalog;
 *   (b) dispatch-side hard rule — the alias handlers for
 *       `swap_quote_uniswap` / `swap_execute_uniswap` call
 *       `isUniswapPairRevealed` themselves and refuse to dispatch when false,
 *       independent of whatever the tool list showed the model (a direct
 *       dispatch attempt is rejected even if the model somehow named the tool
 *       without seeing it).
 *
 * In-process Map only — never persisted, never shared across processes. A
 * session that never revealed, an unknown session, or an expired reveal are
 * ALL the same fail-closed "hidden" state; there is no separate "denied"
 * signal to leak.
 *
 * BOUNDS (FIX-SPINE round 1, finding 12/C11): an abandoned session's entry
 * used to linger forever unless that EXACT session was queried again. Every
 * `revealUniswapPair` / `isUniswapPairRevealed` call now first runs a lazy
 * GLOBAL sweep (purges every expired entry, not just the one being checked),
 * then enforces `MAX_REVEAL_ENTRIES` by dropping the entries with the
 * OLDEST `revealedAt` first if still over the cap.
 */

import { PREQUOTE_MAX_AGE_MS } from "../protocols/prequote/registry.js";

interface RevealEntry {
  readonly revealedAt: number;
}

const revealedSessions = new Map<string, RevealEntry>();

/** Reveal eligibility window mirrors the prequote freshness window (plan §11.2) — a stale reveal must not outlive a stale prequote. */
const REVEAL_MAX_AGE_MS = PREQUOTE_MAX_AGE_MS;

/** Hard cap on concurrently-tracked sessions — a memory-bounding guard, not a security boundary (a dropped entry just re-fails-closed to hidden). */
const MAX_REVEAL_ENTRIES = 10_000;

/** Lazy global sweep: purge every expired entry, then drop-oldest down to `MAX_REVEAL_ENTRIES` if still over. Runs on every reveal/check call. */
function sweepAndBound(): void {
  const now = Date.now();
  for (const [sessionId, entry] of revealedSessions) {
    if (now - entry.revealedAt > REVEAL_MAX_AGE_MS) {
      revealedSessions.delete(sessionId);
    }
  }
  const overflow = revealedSessions.size - MAX_REVEAL_ENTRIES;
  if (overflow <= 0) return;
  const oldestFirst = [...revealedSessions.entries()].sort((a, b) => a[1].revealedAt - b[1].revealedAt);
  for (let i = 0; i < overflow; i++) {
    revealedSessions.delete(oldestFirst[i]![0]);
  }
}

function isFresh(entry: RevealEntry | undefined): entry is RevealEntry {
  if (!entry) return false;
  return Date.now() - entry.revealedAt <= REVEAL_MAX_AGE_MS;
}

/** Flip the hidden pair visible + dispatchable for this session. Call ONLY on an eligible Kyber failure. */
export function revealUniswapPair(sessionId: string): void {
  sweepAndBound();
  revealedSessions.set(sessionId, { revealedAt: Date.now() });
}

/**
 * True iff the hidden pair is currently usable for this session. An
 * absent/undefined sessionId, an unknown session, or a stale reveal
 * (older than `PREQUOTE_MAX_AGE_MS`) all resolve to `false` — fail-closed.
 */
export function isUniswapPairRevealed(sessionId: string | undefined): boolean {
  sweepAndBound();
  if (sessionId === undefined) return false;
  const entry = revealedSessions.get(sessionId);
  if (!isFresh(entry)) {
    if (entry) revealedSessions.delete(sessionId);
    return false;
  }
  return true;
}

/**
 * Throwing variant of the same check — a hard dispatch-side rule. Callers on
 * the ToolResult boundary should prefer the `isUniswapPairRevealed` boolean
 * (so they can return a clean failed result instead of letting this throw
 * propagate); this variant exists for callers that want throw semantics.
 */
export function assertUniswapPairRevealed(sessionId: string | undefined): void {
  if (!isUniswapPairRevealed(sessionId)) {
    throw new Error(
      "swap_quote_uniswap/swap_execute_uniswap is not available yet for this session — "
        + "reveal requires an eligible KyberSwap route-not-found failure, or the Kyber swap "
        + "transaction reverting on-chain, first.",
    );
  }
}

/** Cleared after a SUCCESSFUL uniswap execute — never on a quote, never on a failed execute. */
export function clearUniswapPairReveal(sessionId: string): void {
  revealedSessions.delete(sessionId);
}
