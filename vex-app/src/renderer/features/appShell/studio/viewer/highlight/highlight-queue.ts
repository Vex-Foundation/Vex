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
