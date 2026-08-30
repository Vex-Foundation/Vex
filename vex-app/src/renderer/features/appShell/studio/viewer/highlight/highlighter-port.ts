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
 * ## Ownership
 *
 * The port owns exactly one `Worker` at a time and every pending request
 * against it. `dispose` terminates the worker, settles every pending request
 * with `worker_unavailable` and admits no more work - so a session torn down
 * mid-highlight leaves no promise for anyone to await forever.
 */

import type {
  HighlightRequest,
  HighlightResponse,
  TokenLine,
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
  /** The worker died, or errored, while this request was outstanding. */
  | "worker_failed"
  /** No worker runtime, or the restart budget is spent. Durable. */
  | "worker_unavailable";

export type HighlightOutcome =
  | { readonly ok: true; readonly lines: readonly TokenLine[]; readonly longLines: number }
  | { readonly ok: false; readonly reason: HighlightUnavailableReason };

export interface HighlightAsk {
  readonly language: string;
  /** The WHOLE file. */
  readonly text: string;
  readonly maxLineLength: number;
}

export interface HighlighterPort {
  /** Tokenize. Resolves an outcome; never rejects. */
  highlight(ask: HighlightAsk): Promise<HighlightOutcome>;
  /** Release the worker. Idempotent. Pending requests settle unavailable. */
  dispose(): void;
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
  highlight(_ask: HighlightAsk): Promise<HighlightOutcome> {
    return Promise.resolve({ ok: false, reason: "worker_unavailable" });
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

  highlight(ask: HighlightAsk): Promise<HighlightOutcome> {
    if (this.#disposed || this.#givenUp) {
      return Promise.resolve({ ok: false, reason: "worker_unavailable" });
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
      return Promise.resolve({
        ok: false,
        reason: this.#givenUp ? "worker_unavailable" : "worker_failed",
      });
    }

    const requestId = this.#nextRequestId;
    this.#nextRequestId += 1;

    return new Promise<HighlightOutcome>((resolve) => {
      this.#pending.set(requestId, { resolve });
      const request: HighlightRequest = {
        kind: "highlight",
        requestId,
        language: ask.language,
        text: ask.text,
        maxLineLength: ask.maxLineLength,
      };
      try {
        worker.postMessage(request);
      } catch (cause: unknown) {
        // A post that throws (a worker terminated between the check and the
        // call) is the same event as an `onerror`, and takes the same path.
        this.#failAll("worker_failed", cause);
      }
    });
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
    worker.onmessage = (event: MessageEvent<HighlightResponse>) => {
      this.#onMessage(event.data);
    };
    this.#worker = worker;
    return worker;
  }

  #onMessage(response: HighlightResponse): void {
    if (response.kind === "ready") return;
    const pending = this.#pending.get(response.requestId);
    // An answer for a request this port no longer holds: the worker was torn
    // down and rebuilt, or the port was disposed. Dropping it is the fence.
    if (pending === undefined) return;
    this.#pending.delete(response.requestId);
    pending.resolve(
      response.ok
        ? { ok: true, lines: response.lines, longLines: response.longLines }
        : { ok: false, reason: response.reason },
    );
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
