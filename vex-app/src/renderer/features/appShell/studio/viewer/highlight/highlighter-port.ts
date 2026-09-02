/**
 * THE HIGHLIGHTER PORT - the seam between the viewer and the worker.
 *
 * The session asks a port to highlight text and gets an answer. Whether that
 * answer came from a Worker, from a port that has none, or from a fake in a
 * test is not the session's business, which is what keeps the session testable
 * without a worker runtime (jsdom defines no `Worker` at all).
 *
 * ## Every failure is an ANSWER
 *
 * `highlight` never rejects. A dead worker, a missing `Worker` global, a
 * spent restart budget: each is a `{ ok: false, reason }` the viewer renders
 * as "plain text, because X". A rejected promise here would put a
 * `try`/`catch` in the session for a case that is not exceptional - a file
 * without colour is a normal thing for a viewer to show.
 *
 * ## The restart budget, and why it is bounded
 *
 * A worker that dies takes every pending request with it. Recreating it on the
 * next request is right - a transient crash should not disable highlighting
 * for the session - but recreating it forever is not: a worker that dies
 * during module evaluation (a bad chunk, a CSP change) would be respawned on
 * every keystroke of tab switching. So {@link HIGHLIGHT_WORKER_MAX_RESTARTS}
 * caps it, and AT THE BOUND the port answers `worker_unavailable` for the rest
 * of the renderer's life. The bound reports itself: the viewer's chip says the
 * highlighter is unavailable rather than showing uncoloured code with no
 * explanation.
 *
 * ## Cancellation is the CALLER's, through a handle
 *
 * `highlight` returns a {@link HighlightHandle} rather than a bare promise, so
 * the one thing a caller needs - "stop, I no longer want this" - does not
 * require the caller to know request ids. `cancel` drops the pending entry
 * here (a late result for it is discarded) and tells the WORKER, which removes
 * the request from its queue when it has not started and drops it at the next
 * await point when it has. The outcome resolves `cancelled`, which is an answer
 * the caller asked for and never a reason to show the user.
 *
 * ## Ownership
 *
 * The port owns exactly one `Worker` at a time and every pending request
 * against it. `dispose` terminates the worker, settles every pending request
 * with `worker_unavailable` and admits no more work - so a session torn down
 * mid-highlight leaves no promise for anyone to await forever.
 */

import {
  countLines,
  isHighlightResponse,
  type HighlightCancel,
  type HighlightRequest,
  type TokenLine,
} from "./highlight-protocol.js";

/**
 * How many times a crashed worker is rebuilt before the port gives up.
 *
 * Three: enough to survive a transient OOM or a one-off chunk failure, small
 * enough that a systematically broken worker stops costing spawns. At the bound
 * the port is durably unavailable and says so.
 */
export const HIGHLIGHT_WORKER_MAX_RESTARTS = 3;

/** Why a request produced no tokens. A superset of the worker's own reasons. */
export type HighlightUnavailableReason =
  | "grammar_unavailable"
  | "tokenize_failed"
  /**
   * The file would have produced more tokens than the ask allowed. The WORKER
   * decides this, while it projects, so the oversized graph is never built and
   * never crosses this boundary.
   */
  | "too_many_tokens"
  /** The worker died, or errored, while this request was outstanding. */
  | "worker_failed"
  /** No worker runtime, or the restart budget is spent. Durable. */
  | "worker_unavailable"
  /**
   * The worker answered with something that is not a response.
   *
   * Our own code behind our own build, so this is a bad chunk or a
   * half-applied protocol change rather than an attack - and it fails CLOSED
   * here rather than becoming renderer state.
   */
  | "malformed_result"
  /**
   * The CALLER abandoned this request. Not a failure and never user-visible:
   * the caller cancelled because the tab was hidden, its bytes changed, or it
   * closed, and it is not waiting for an answer to show.
   */
  | "cancelled";

export type HighlightOutcome =
  | { readonly ok: true; readonly lines: readonly TokenLine[]; readonly longLines: number }
  | { readonly ok: false; readonly reason: HighlightUnavailableReason };

export interface HighlightAsk {
  readonly language: string;
  /** The WHOLE file. */
  readonly text: string;
  readonly maxLineLength: number;
  /**
   * The most tokens this file may produce. Zero or less disables the bound.
   *
   * It goes to the WORKER, which refuses over it during projection. The port
   * does not count tokens itself: by the time it could, the clone the bound
   * exists to prevent has already happened.
   */
  readonly maxTokens: number;
  /**
   * Who is asking, when the caller wants the port to enforce its bound.
   *
   * A caller that names itself gets AT MOST ONE outstanding request: a second
   * ask under the same name cancels the first, so a tab whose bytes changed
   * three times while the worker was busy costs one tokenization rather than
   * three. Omitted, the request stands on its own and the caller owns its
   * lifetime through the handle.
   */
  readonly caller?: string;
}

/**
 * One outstanding request, and the only two things a caller does with it.
 *
 * `cancel` is IDEMPOTENT and safe after the outcome has settled: a caller that
 * cancels on hide, on new bytes and again on dispose must not have to track
 * which of those happened first.
 */
export interface HighlightHandle {
  /** The answer. Never rejects; `cancelled` is one of the answers. */
  readonly outcome: Promise<HighlightOutcome>;
  cancel(): void;
}

export interface HighlighterPort {
  /** Tokenize. The handle's outcome resolves; it never rejects. */
  highlight(ask: HighlightAsk): HighlightHandle;
  /** Release the worker. Idempotent. Pending requests settle unavailable. */
  dispose(): void;
}

/** A handle for an answer that is already known. Cancelling it does nothing. */
export function settledHandle(outcome: HighlightOutcome): HighlightHandle {
  return {
    outcome: Promise.resolve(outcome),
    cancel: () => {
      // Already answered; there is nothing outstanding to abandon.
    },
  };
}

/**
 * The port used when this runtime has no `Worker`.
 *
 * jsdom is the case that matters in practice, but the honest statement is
 * broader: a renderer whose CSP forbade `worker-src` would land here too, and
 * it should degrade to readable plain text rather than to a thrown
 * `ReferenceError` on first file open.
 */
export class UnavailableHighlighterPort implements HighlighterPort {
  // The ask is accepted and ignored: this port answers the same way for every
  // request, and dropping the parameter from the signature would make callers
  // that hold a `HighlighterPort` fail to type-check against this one.
  highlight(_ask: HighlightAsk): HighlightHandle {
    return settledHandle({ ok: false, reason: "worker_unavailable" });
  }

  dispose(): void {
    // Nothing is held, and saying so is cheaper than a comment at every call.
  }
}

/** How the port builds its worker. Injected only by tests. */
export type WorkerFactory = () => Worker;

/**
 * The real worker's factory.
 *
 * `new URL("./highlight.worker.ts", import.meta.url)` with `type: "module"` is
 * the form Vite compiles into a separate same-origin chunk. It is deliberately
 * NOT a `blob:` URL or an inline string: both are what a CSP with
 * `worker-src 'self'` is there to refuse, and the build gate asserts that
 * directive stays exactly `'self'`.
 */
function defaultWorkerFactory(): Worker {
  return new Worker(new URL("./highlight.worker.ts", import.meta.url), { type: "module" });
}

interface Pending {
  readonly resolve: (outcome: HighlightOutcome) => void;
  /**
   * How many lines the text of THIS request had.
   *
   * The port knows exactly what it sent, so it can hold the answer to an exact
   * cardinality: a successful result must carry this many lines, no more and no
   * fewer. It is kept per request because the ask is gone by the time the
   * answer arrives, and re-deriving it from a text the port no longer holds is
   * not possible.
   */
  readonly expectedLines: number;
  /** The named caller whose one slot this request holds, when there is one. */
  readonly caller?: string;
}

export interface WorkerHighlighterPortOptions {
  readonly createWorker?: WorkerFactory;
  readonly maxRestarts?: number;
}

export class WorkerHighlighterPort implements HighlighterPort {
  readonly #createWorker: WorkerFactory;
  readonly #maxRestarts: number;

  #worker: Worker | null = null;
  /** Requests posted to the CURRENT worker, by id. */
  readonly #pending = new Map<number, Pending>();
  /**
   * The one outstanding request per NAMED caller. The bound, enforced here.
   *
   * BOUNDED by the callers that named themselves and still have work in
   * flight: an entry is removed when its request settles, is cancelled, or is
   * superseded by that same caller's next ask.
   */
  readonly #outstandingByCaller = new Map<string, number>();
  #nextRequestId = 1;
  /** Workers built after the first. Compared against the bound. */
  #restarts = 0;
  /** Set when the budget is spent: every later request answers immediately. */
  #givenUp = false;
  #disposed = false;

  constructor(options: WorkerHighlighterPortOptions = {}) {
    this.#createWorker = options.createWorker ?? defaultWorkerFactory;
    this.#maxRestarts = options.maxRestarts ?? HIGHLIGHT_WORKER_MAX_RESTARTS;
  }

  /** How many workers this port has built. For a test, and for a log line. */
  restartCount(): number {
    return this.#restarts;
  }

  highlight(ask: HighlightAsk): HighlightHandle {
    if (this.#disposed || this.#givenUp) {
      return settledHandle({ ok: false, reason: "worker_unavailable" });
    }

    // SUPERSEDE. A named caller's previous request is abandoned before the new
    // one is posted, so the worker drops it from its queue if it has not
    // started - which is the request that would otherwise have burned a whole
    // tokenization for bytes nobody is looking at any more.
    const caller = ask.caller;
    if (caller !== undefined) {
      const previous = this.#outstandingByCaller.get(caller);
      if (previous !== undefined) this.#cancel(previous);
    }

    let worker: Worker;
    try {
      worker = this.#ensureWorker();
    } catch (cause: unknown) {
      // Construction itself failed - no `Worker` in this runtime, or the CSP
      // refused the chunk. It COUNTS against the same budget: a runtime that
      // cannot build one worker will not build the fourth either, and without
      // the increment this path would retry construction on EVERY request for
      // the life of the renderer - the unbounded respawn the bound exists to
      // prevent, and the one that never reports itself.
      console.warn("studio viewer highlight: could not start the worker", cause);
      this.#restarts += 1;
      this.#giveUpIfSpent();
      return settledHandle({
        ok: false,
        reason: this.#givenUp ? "worker_unavailable" : "worker_failed",
      });
    }

    const requestId = this.#nextRequestId;
    this.#nextRequestId += 1;
    if (caller !== undefined) this.#outstandingByCaller.set(caller, requestId);

    const expectedLines = countLines(ask.text);
    const outcome = new Promise<HighlightOutcome>((resolve) => {
      this.#pending.set(requestId, {
        resolve,
        expectedLines,
        ...(caller === undefined ? {} : { caller }),
      });
      const request: HighlightRequest = {
        kind: "highlight",
        requestId,
        language: ask.language,
        text: ask.text,
        maxLineLength: ask.maxLineLength,
        maxTokens: ask.maxTokens,
      };
      try {
        worker.postMessage(request);
      } catch (cause: unknown) {
        // A post that throws (a worker terminated between the check and the
        // call) is the same event as an `onerror`, and takes the same path.
        this.#failAll("worker_failed", cause);
      }
    });

    return {
      outcome,
      cancel: () => {
        this.#cancel(requestId);
      },
    };
  }

  /**
   * Abandon one request. Idempotent, and safe after it has settled.
   *
   * The pending entry goes FIRST, so a result already on its way in is dropped
   * by the same fence that drops a result for a rebuilt worker. Then the worker
   * is told, so it can skip work it has not started.
   */
  #cancel(requestId: number): void {
    const pending = this.#pending.get(requestId);
    if (pending === undefined) return;
    this.#pending.delete(requestId);
    this.#forgetCaller(pending, requestId);
    pending.resolve({ ok: false, reason: "cancelled" });

    const worker = this.#worker;
    if (worker === null) return;
    const message: HighlightCancel = { kind: "cancel", requestId };
    try {
      worker.postMessage(message);
    } catch (cause: unknown) {
      this.#failAll("worker_failed", cause);
    }
  }

  /** Release a caller's slot, but only when it still names THIS request. */
  #forgetCaller(pending: Pending, requestId: number): void {
    const caller = pending.caller;
    if (caller === undefined) return;
    if (this.#outstandingByCaller.get(caller) !== requestId) return;
    this.#outstandingByCaller.delete(caller);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#teardown();
    this.#settleAll({ ok: false, reason: "worker_unavailable" });
  }

  /**
   * The current worker, building one if there is none.
   *
   * Rebuilding is what a previous failure left us to do: `#failAll` terminates
   * and clears the handle, so the next request lands here and pays for one new
   * worker - never more, because the handle is set before anything can throw
   * asynchronously.
   */
  #ensureWorker(): Worker {
    const existing = this.#worker;
    if (existing !== null) return existing;

    const worker = this.#createWorker();
    // Registered at ACQUISITION, before the handle is published, so a worker
    // that dies during module evaluation still finds its handlers installed.
    worker.onerror = (event: unknown) => {
      this.#failAll("worker_failed", event);
    };
    worker.onmessageerror = (event: unknown) => {
      // A response that could not be deserialized. The request it belonged to
      // is unknowable, so every outstanding one fails - the same conservative
      // call `onerror` makes.
      this.#failAll("worker_failed", event);
    };
    worker.onmessage = (event: MessageEvent<unknown>) => {
      this.#onMessage(event.data);
    };
    this.#worker = worker;
    return worker;
  }

  /**
   * A message from the worker. VALIDATED before it can become anything.
   *
   * The shape guard is here rather than in the session because this is where
   * the process boundary is (rule 04: validate once, at the real boundary). A
   * message that is not a response cannot be attributed to a request, so every
   * outstanding one fails closed with `malformed_result` - the same
   * conservative call `onmessageerror` makes for the same reason.
   */
  #onMessage(response: unknown): void {
    if (!isHighlightResponse(response)) {
      console.warn("studio viewer highlight: the worker sent an unusable message");
      this.#settleAll({ ok: false, reason: "malformed_result" });
      return;
    }
    if (response.kind === "ready") return;
    const pending = this.#pending.get(response.requestId);
    // An answer for a request this port no longer holds: it was cancelled, the
    // worker was torn down and rebuilt, or the port was disposed. Dropping it
    // is the fence.
    if (pending === undefined) return;
    this.#pending.delete(response.requestId);
    this.#forgetCaller(pending, response.requestId);
    if (!response.ok) {
      pending.resolve({ ok: false, reason: response.reason });
      return;
    }
    pending.resolve(this.#checkedSuccess(response.lines, response.longLines, pending));
  }

  /**
   * THE CEILINGS on a successful answer, checked before it can become state.
   *
   * `isHighlightResponse` proves the SHAPE - that these are lines of tokens with
   * the right field types. It cannot prove the QUANTITY, because it does not
   * know what was asked. This does:
   *
   *  - the line count must EQUAL the line count of the text that was sent. A
   *    file rendered from a projection with a different number of lines is a
   *    file whose rows no longer correspond to the user's, and the viewer is the
   *    one surface where showing that is unacceptable. Exact, not a maximum: a
   *    result with too few lines would silently lose the tail.
   *  - `longLines` cannot exceed the lines that exist, and cannot be negative or
   *    fractional. It is shown to the user as a count of their own file's lines.
   *
   * A violation is `malformed_result`, the same fail-closed answer a message of
   * the wrong shape gets, and the viewer shows honest plain text.
   */
  #checkedSuccess(
    lines: readonly TokenLine[],
    longLines: number,
    pending: Pending,
  ): HighlightOutcome {
    if (lines.length !== pending.expectedLines) {
      console.warn(
        `studio viewer highlight: the worker answered with ${String(lines.length)} line(s) for a ${String(pending.expectedLines)}-line file`,
      );
      return { ok: false, reason: "malformed_result" };
    }
    if (!Number.isInteger(longLines) || longLines < 0 || longLines > lines.length) {
      console.warn(
        `studio viewer highlight: the worker reported ${String(longLines)} long line(s) in a ${String(lines.length)}-line file`,
      );
      return { ok: false, reason: "malformed_result" };
    }
    return { ok: true, lines, longLines };
  }

  /**
   * The worker is gone. Settle everything it owed and drop it.
   *
   * The ORDER matters: the worker is terminated and the handle cleared BEFORE
   * the pending promises resolve, so a caller that immediately asks again from
   * its `then` gets a fresh worker rather than posting into a dead one.
   */
  #failAll(reason: HighlightUnavailableReason, cause: unknown): void {
    if (this.#disposed) return;
    console.warn("studio viewer highlight: the worker failed", cause);
    this.#teardown();
    this.#restarts += 1;
    this.#giveUpIfSpent();
    this.#settleAll({
      ok: false,
      reason: this.#givenUp ? "worker_unavailable" : reason,
    });
  }

  #giveUpIfSpent(): void {
    if (this.#restarts >= this.#maxRestarts) this.#givenUp = true;
  }

  #teardown(): void {
    const worker = this.#worker;
    this.#worker = null;
    if (worker === null) return;
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    worker.terminate();
  }

  /** Resolve every outstanding request exactly once, then forget them all. */
  #settleAll(outcome: HighlightOutcome): void {
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    this.#outstandingByCaller.clear();
    for (const entry of pending) entry.resolve(outcome);
  }
}

/**
 * The port this renderer should use.
 *
 * A runtime with no `Worker` gets the unavailable port rather than a
 * `ReferenceError` on first file open. That is jsdom under vitest today, and
 * it is the honest degradation for any runtime that refuses workers.
 */
export function defaultHighlighterPort(): HighlighterPort {
  if (typeof Worker === "undefined") return new UnavailableHighlighterPort();
  return new WorkerHighlighterPort();
}
