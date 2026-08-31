/**
 * THE WORKER'S REQUEST QUEUE - who runs, who is dropped, and when.
 *
 * Lifted out of `highlight.worker.ts` so it can be TESTED. The worker module is
 * the only file in the renderer tree with worker globals (`self.onmessage`,
 * `self.postMessage`), which is why `tsconfig.renderer.json` excludes it - and
 * a test that imported it would drag those globals into the DOM project where
 * using one is meant to stay a type error. This module names no global, so both
 * the worker and its colocated test can have it, and the drop policy stops being
 * the one part of the worker nothing executes.
 *
 * ## The policy, and why a promise chain could not express it
 *
 * One request runs at a time: the work is CPU-bound and this is one thread, so
 * concurrency would only let a hidden tab's file compete with the visible one.
 *
 * Cancellation is answered in the only two places a single thread can answer it:
 *
 *  - a request still in the QUEUE is REMOVED and never runs at all. This is the
 *    one that matters. A promise chain cannot have an entry taken out of it, so
 *    a superseded request would still pay for a whole tokenization before
 *    anyone noticed it was unwanted;
 *  - the request already RUNNING is marked and dropped after its await returns,
 *    before anything is posted. `codeToTokensBase` is synchronous and
 *    vscode-textmate has no yield point inside its line loop, so the CPU
 *    already spent cannot be reclaimed - but the result never crosses back.
 *
 * A cancelled id is answered with SILENCE. The port has already settled that
 * request for its caller, so a response would be an answer nobody holds.
 *
 * ## THE ACCEPTED LATENCY CEILING, and the measurement behind it
 *
 * The consequence of "the running request cannot be interrupted" is a real
 * product cost: a tab the user has just made VISIBLE waits for a hidden tab's
 * tokenization to finish before its own starts. That wait is bounded by the
 * longest tokenization this worker can be asked to perform, and the bound is
 * MEASURED, not estimated.
 *
 * Measured 2026-08-31 on this repo's real worker path - the installed shiki
 * 4.4.3 with `createJavaScriptRegexEngine({ forgiving: false })`, through the
 * real `createTokenizer().tokenize`, grammar pre-warmed so the number is
 * tokenization and not a module import. Node 24.15.0 on an AMD Ryzen 5 5600H
 * under WSL2. Each sample is 512 KiB, which is `VIEWER_HIGHLIGHT_MAX_BYTES`,
 * the largest input the session will ever submit:
 *
 * | sample                          | run 1     | run 2    | run 3    | tokens  |
 * |---------------------------------|-----------|----------|----------|---------|
 * | TypeScript source (512 KiB)     | 1144.6 ms | 854.4 ms | 812.8 ms |  51,678 |
 * | densely punctuated JSON (512 KiB)|  426.0 ms | 420.7 ms | 477.4 ms | 230,510 |
 *
 * WORST OBSERVED: 1145 ms. The ACCEPTED CEILING is therefore 1500 ms of
 * head-of-line delay for a newly visible tab, and passive cancellation stands.
 * Preemption - terminating and rebuilding the worker to interrupt a run - was
 * considered and REJECTED at this measurement: it would trade a bounded
 * sub-1.2 s delay for a rebuilt worker, a re-imported grammar and a second
 * failure mode (a restart budget that a fast tab-switcher can spend), which is
 * a worse deal than the wait it removes.
 *
 * WHAT WOULD REOPEN THE DECISION: the byte bound rising, a grammar being added
 * to the hot set that is materially slower than TypeScript's, or a shiki or
 * engine upgrade. The ceiling is a claim about a measured input size, and the
 * input size is what `VIEWER_HIGHLIGHT_MAX_BYTES` pins - `file-viewer-session`
 * tests that no larger text is ever submitted, which is the deterministic guard
 * that keeps this number meaningful. The timing itself is NOT asserted in a
 * test: a wall-clock assertion on shared CI hardware would be flaky, and a
 * flaky guard is worse than the recorded numbers above.
 *
 * ## Bounds
 *
 * `queue` is bounded by the port, which holds at most one in-flight plus one
 * outstanding request per named caller and supersedes rather than appends.
 * `cancelled` holds AT MOST ONE id: a cancel for a queued request removes it
 * outright, a cancel for anything else names a request already answered or
 * never seen, and the entry is consumed by the run it belongs to.
 */

import type {
  HighlightFailureReason,
  HighlightMessage,
  HighlightRequest,
  HighlightResponse,
  TokenizeResult,
} from "./highlight-protocol.js";

/** What the queue needs from a tokenizer. Never rejects; a refusal is an answer. */
export type QueueTokenize = (
  text: string,
  language: string,
  maxLineLength: number,
  maxTokens: number,
) => Promise<
  | { readonly ok: true; readonly result: TokenizeResult }
  | { readonly ok: false; readonly reason: HighlightFailureReason }
>;

export interface HighlightQueue {
  /** Take one message from the port. Requests run; cancels drop. */
  accept(message: HighlightMessage): void;
  /** How many requests are accepted and not yet started. The bound, measurable. */
  queued(): number;
}

export interface HighlightQueueOptions {
  readonly tokenize: QueueTokenize;
  readonly post: (response: HighlightResponse) => void;
}

export function createHighlightQueue(options: HighlightQueueOptions): HighlightQueue {
  const queue: HighlightRequest[] = [];
  const cancelled = new Set<number>();
  let runningId: number | null = null;
  let draining = false;

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      for (;;) {
        const request = queue.shift();
        if (request === undefined) return;
        runningId = request.requestId;
        const outcome = await options.tokenize(
          request.text,
          request.language,
          request.maxLineLength,
          // The BOUND rides on the request, so the worker refuses exactly what
          // the caller would have refused - and refuses it before the graph is
          // finished, rather than after it has been cloned across.
          request.maxTokens,
        );
        runningId = null;
        // THE CANCELLATION CHECK, at the only await point there is and before
        // anything is posted.
        if (cancelled.delete(request.requestId)) continue;
        if (outcome.ok) {
          options.post({
            kind: "result",
            requestId: request.requestId,
            ok: true,
            lines: outcome.result.lines,
            longLines: outcome.result.longLines,
          });
          continue;
        }
        options.post({
          kind: "result",
          requestId: request.requestId,
          ok: false,
          reason: outcome.reason,
        });
      }
    } finally {
      runningId = null;
      draining = false;
    }
  }

  return {
    accept(message) {
      if (message.kind === "cancel") {
        const at = queue.findIndex((entry) => entry.requestId === message.requestId);
        if (at !== -1) {
          // Never started: dropping it here is the whole point, and no flag has
          // to survive afterwards.
          queue.splice(at, 1);
          return;
        }
        // Only the RUNNING request needs a flag. Anything else is already
        // answered or was never here, and remembering it would grow this set
        // for the life of the worker.
        if (runningId === message.requestId) cancelled.add(message.requestId);
        return;
      }
      // Structured clone hands us whatever the other side posted. Both ends are
      // ours, so this is a shape guard against our own future edits, not a
      // trust boundary - and it fails silently, because a message that is not a
      // request carries no id to answer with.
      if (message.kind !== "highlight") return;
      queue.push(message);
      void drain();
    },
    queued: () => queue.length,
  };
}
