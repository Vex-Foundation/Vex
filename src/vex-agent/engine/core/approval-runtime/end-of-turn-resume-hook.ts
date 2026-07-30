/**
 * The end-of-turn resume hook — attempt 3 of the four described in
 * `deferred-resume.ts`, packaged once so every path that releases a session
 * lease invokes it identically.
 *
 * WHO CALLS THIS. Exactly one caller: `runtime/release-and-emit.ts`, which is
 * itself the single chokepoint through which every session lease in the engine
 * is released. It began as a hand-copied `try { await import(...) } catch`
 * block at each lease-releasing runner; five runners had it and five other
 * release sites (mission/recover prepare aborts, the mission setup turn,
 * `discardContinuation`) did not, and the missing ones were found one at a time
 * by review. Owning the hook at the release chokepoint is what makes the class
 * exhaustively correct instead of correct-where-someone-remembered. Do not
 * re-add per-site calls: they are redundant (the pass is idempotent per
 * session) and they reintroduce the drift.
 *
 * Three properties are load-bearing; the caller inherits them from here:
 *
 *   AFTER THE RELEASE. Call it strictly after the session lease has been
 *   released. The dispatch it triggers claims that same lease, so invoking it
 *   while the turn still holds it makes the hook block on itself and fall back
 *   to the 2s/5s/15s ladder — the exact latency this hook exists to avoid.
 *
 *   NEVER FATAL. Callers run this from a `finally`, so it must not be able to
 *   turn a completed turn into a failed one. The dynamic import is wrapped
 *   here, and `dispatchPendingApprovalResumes` is itself fire-and-forget, so
 *   nothing this function does can reject. The 5-minute reconciler stays the
 *   durable backstop if the hook does not fire at all.
 *
 *   CANNOT RUN AWAY. Eligibility ends at the consumption marker
 *   (`resume_consumed_at`), which the resumed turn stamps as it consumes the
 *   result — BEFORE the release that fires this hook. A hook arriving while a
 *   pass is already running for the session does not run concurrently and is
 *   not dropped either: it queues exactly one coalesced follow-up pass. That
 *   chain terminates because each link needs a fresh arrival to justify the
 *   next, and the pass following the last real arrival finds nothing eligible.
 *
 *   Dropping that arrival instead was a defect, not a safety property: a pass
 *   reads its work list once, so a second approval decided after that read was
 *   invisible to it AND silenced by the guard, and waited out the 2s/5s/15s
 *   ladder — in exactly the busy-lease case this hook exists for.
 *
 * The import of `deferred-resume.js` stays DYNAMIC because that module pulls in
 * the approval lifecycle, which reaches back into the runners. Nothing here is
 * in the engine's static graph, which is what lets `runtime/release-and-emit.ts`
 * reach into `core/approval-runtime/` at all without creating a cycle — and it
 * imports this module dynamically too, so `runtime/` keeps no static edge into
 * `core/`.
 */

import logger from "@utils/logger.js";

/**
 * Dispatch any approval resume this session is owed, now that its lease is
 * free. Fire-and-forget by contract — resolves as soon as the pass is armed,
 * not when it finishes.
 */
export async function dispatchPendingApprovalResumesAfterRelease(
  sessionId: string,
): Promise<void> {
  try {
    const { dispatchPendingApprovalResumes } = await import(
      "./deferred-resume.js"
    );
    dispatchPendingApprovalResumes(sessionId);
  } catch (cause) {
    logger.warn("engine.approval_runtime.resume_hook_unavailable", {
      sessionId,
      errorKind: cause instanceof Error ? cause.constructor.name : typeof cause,
    });
  }
}
