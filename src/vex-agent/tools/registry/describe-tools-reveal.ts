/**
 * Session-scoped reveal for the hidden `describe_tools` menu tool (R5, owner
 * "nowy UKRYTY tool dla listowanych tooli", 2026-08-04).
 *
 * `describe_tools` is absent from a fresh session's tool list and Tool Map, and
 * joins them for a session that has produced at least one successful, non-empty
 * `discover_tools` result — list OR ranked. Widened to both modes deliberately
 * (owner directive D1, "zbytnie ograniczenia też są złe w systemie"): gating it
 * to list mode alone would block plan-recall and post-compaction schema
 * recovery, which are exactly the cases the tool exists for.
 *
 * MODELLED ON `./discovered-tools.ts`, NOT on the quote reveals. There is no
 * TTL: `uniswap-reveal.ts` / `relay-reveal.ts` expire because a stale reveal
 * must not outlive quote freshness, and a menu has no such constraint. A
 * session that revealed once keeps the tool until process restart or the
 * bounded-session sweep.
 *
 * In-process only — never persisted, never shared across processes. An unknown
 * or absent session fails closed to hidden.
 */

/** Memory-bounding guard, mirroring the discovered-set bound. A dropped entry just re-fails-closed to hidden. */
const MAX_REVEALED_SESSIONS = 10_000;

/** Insertion order doubles as the session LRU. */
const revealedSessions = new Set<string>();

/**
 * Flip `describe_tools` visible + dispatchable for this session. Call ONLY on a
 * `discover_tools` result that both succeeded and returned at least one row —
 * a failed or empty listing teaches the model nothing to describe.
 */
export function revealDescribeTools(sessionId: string | undefined): void {
  if (sessionId === undefined) return;
  // Delete-then-add keeps Set insertion order a true LRU.
  revealedSessions.delete(sessionId);
  revealedSessions.add(sessionId);
  boundRevealedSessions();
}

/** True iff this session may see and dispatch `describe_tools`. Fails closed. */
export function isDescribeToolsRevealed(sessionId: string | undefined): boolean {
  if (sessionId === undefined) return false;
  return revealedSessions.has(sessionId);
}

/** Drop a session's reveal — used by tests and by session teardown. */
export function clearDescribeToolsReveal(sessionId: string): void {
  revealedSessions.delete(sessionId);
}

function boundRevealedSessions(): void {
  let overflow = revealedSessions.size - MAX_REVEALED_SESSIONS;
  if (overflow <= 0) return;
  for (const sessionId of revealedSessions) {
    if (overflow <= 0) break;
    revealedSessions.delete(sessionId);
    overflow -= 1;
  }
}
