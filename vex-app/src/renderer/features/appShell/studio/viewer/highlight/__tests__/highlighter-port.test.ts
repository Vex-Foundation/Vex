/**
 * The worker port: correlation, failure, the restart budget, and disposal.
 *
 * jsdom defines no `Worker`, which is exactly the two things this suite needs:
 * a FAKE can be installed without shadowing a real global, and the absence
 * itself is a case worth asserting (`defaultHighlighterPort` must degrade, not
 * throw a ReferenceError on the first file the user opens).
 *
 * The defect the restart cases are built around is a worker that dies during
 * module evaluation - a bad chunk, a CSP the build changed. Recreating it on
 * every request would respawn a doomed thread for the life of the renderer, and
 * it would look like nothing at all from the outside: the code just never gets
 * colour. So the budget is bounded and the bound reports itself as a DIFFERENT
 * reason than a transient death.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HIGHLIGHT_MAX_TOKENS,
  type HighlightMessage,
  type HighlightRequest,
  type HighlightResponse,
} from "../highlight-protocol.js";
import {
  defaultHighlighterPort,
  HIGHLIGHT_WORKER_MAX_RESTARTS,
  type HighlightOutcome,
  UnavailableHighlighterPort,
  WorkerHighlighterPort,
} from "../highlighter-port.js";

/**
 * A worker that records instead of running.
 *
 * It `implements Worker` FOR REAL - extending `EventTarget` and declaring the
 * handler slots with the DOM's own types - rather than being cast into place.
 * A cast here would let the fake drift away from the interface the production
 * factory returns, and the first thing to notice would be a runtime failure in
 * the app rather than a type error in this file.
 *
 * Only `postMessage`, `terminate` and the three handler slots do anything; the
 * rest of `Worker` comes from `EventTarget`, which jsdom provides.
 */
class FakeWorker extends EventTarget implements Worker {
  static built: FakeWorker[] = [];
  static failOnConstruct = false;

  readonly received: HighlightMessage[] = [];
  terminated = 0;
  onmessage: ((this: Worker, event: MessageEvent<unknown>) => void) | null = null;
  onmessageerror: ((this: Worker, event: MessageEvent<HighlightResponse>) => void) | null = null;
  onerror: OnErrorEventHandler = null;

  // The real `Worker` constructor's signature, so this class can stand in for
  // the global below without a cast.
  constructor(
    readonly url: string | URL,
    readonly options?: WorkerOptions,
  ) {
    super();
    if (FakeWorker.failOnConstruct) throw new Error("worker refused");
    FakeWorker.built.push(this);
  }

  postMessage(message: HighlightMessage): void {
    this.received.push(message);
  }

  /** Only the highlight requests, in order. */
  get posted(): HighlightRequest[] {
    return this.received.filter(
      (message): message is HighlightRequest => message.kind === "highlight",
    );
  }

  /** The ids this worker was told to cancel, in order. */
  get cancelled(): number[] {
    return this.received
      .filter((message) => message.kind === "cancel")
      .map((message) => message.requestId);
  }

  terminate(): void {
    this.terminated += 1;
  }

  /** Answer one request as the real worker would. */
  answer(response: HighlightResponse): void {
    this.deliver(response);
  }

  /**
   * Post ANYTHING, including something that is not a response.
   *
   * Typed `unknown` deliberately: the shape the port must fail closed on is by
   * definition one the protocol types cannot describe, and a cast would put the
   * lie in this file instead.
   */
  deliver(data: unknown): void {
    this.onmessage?.call(this, new MessageEvent("message", { data }));
  }

  crash(): void {
    this.onerror?.call(this, new ErrorEvent("error", { message: "worker died" }));
  }
}

function makePort(maxRestarts = HIGHLIGHT_WORKER_MAX_RESTARTS): WorkerHighlighterPort {
  return new WorkerHighlighterPort({
    createWorker: () => new FakeWorker(new URL("https://vex.test/w.js")),
    maxRestarts,
  });
}

/**
 * The standard ask. ONE line of text, which every fixture answer below has to
 * match: the port checks the answer's line count against the text it sent, so a
 * fake answer with the wrong cardinality is a malformed result rather than a
 * shortcut.
 */
const ask = {
  language: "typescript",
  text: "const a = 1;",
  maxLineLength: 20_000,
  maxTokens: HIGHLIGHT_MAX_TOKENS,
};


afterEach(() => {
  FakeWorker.built = [];
  FakeWorker.failOnConstruct = false;
  vi.restoreAllMocks();
});

describe("WorkerHighlighterPort", () => {
  it("correlates answers by request id, out of order", async () => {
    const port = makePort();
    const first = port.highlight(ask).outcome;
    const second = port.highlight({ ...ask, text: "const b = 2;" }).outcome;

    const worker = FakeWorker.built[0];
    expect(worker?.posted).toHaveLength(2);
    const [idA, idB] = (worker?.posted ?? []).map((request) => request.requestId);
    expect(idA).not.toBe(idB);

    // Answered in REVERSE. A port that assumed FIFO would hand the second
    // file's tokens to the first tab.
    worker?.answer({ kind: "result", requestId: idB ?? 0, ok: true, lines: [[]], longLines: 1 });
    worker?.answer({
      kind: "result",
      requestId: idA ?? 0,
      ok: false,
      reason: "tokenize_failed",
    });

    await expect(second).resolves.toEqual({ ok: true, lines: [[]], longLines: 1 });
    await expect(first).resolves.toEqual({ ok: false, reason: "tokenize_failed" });
    port.dispose();
  });

  it("builds ONE worker for many requests", () => {
    const port = makePort();
    port.highlight(ask);
    port.highlight(ask);
    port.highlight(ask);
    expect(FakeWorker.built).toHaveLength(1);
    port.dispose();
  });

  it("ignores the ready message and answers for requests it no longer holds", async () => {
    const port = makePort();
    const pending = port.highlight(ask).outcome;
    const worker = FakeWorker.built[0];
    worker?.answer({ kind: "ready" });
    // An id nobody is waiting for: the fence, and it must not throw.
    worker?.answer({ kind: "result", requestId: 999, ok: true, lines: [[]], longLines: 0 });
    const id = worker?.posted[0]?.requestId ?? 0;
    worker?.answer({ kind: "result", requestId: id, ok: true, lines: [[]], longLines: 0 });
    await expect(pending).resolves.toEqual({ ok: true, lines: [[]], longLines: 0 });
    port.dispose();
  });

  it("fails EVERY pending request on onerror, terminates, and rebuilds on the next ask", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const port = makePort();
    const first = port.highlight(ask).outcome;
    const second = port.highlight(ask).outcome;
    const worker = FakeWorker.built[0];

    worker?.crash();

    await expect(first).resolves.toEqual({ ok: false, reason: "worker_failed" });
    await expect(second).resolves.toEqual({ ok: false, reason: "worker_failed" });
    expect(worker?.terminated).toBe(1);
    expect(port.restartCount()).toBe(1);

    // The next request pays for exactly ONE new worker.
    port.highlight(ask);
    expect(FakeWorker.built).toHaveLength(2);
    port.dispose();
  });

  it("treats onmessageerror the same way", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const port = makePort();
    const pending = port.highlight(ask).outcome;
    const failing = FakeWorker.built[0];
    failing?.onmessageerror?.call(
      failing,
      new MessageEvent("messageerror"),
    );
    await expect(pending).resolves.toEqual({ ok: false, reason: "worker_failed" });
    port.dispose();
  });

  it("gives up DURABLY at the restart bound and builds no further worker", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const port = makePort(3);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const pending = port.highlight(ask).outcome;
      const worker = FakeWorker.built[attempt - 1];
      worker?.crash();
      // The first two deaths are transient and say so; the third spends the
      // budget, and the reason changes with it.
      await expect(pending).resolves.toEqual({
        ok: false,
        reason: attempt === 3 ? "worker_unavailable" : "worker_failed",
      });
    }

    expect(FakeWorker.built).toHaveLength(3);
    await expect(port.highlight(ask).outcome).resolves.toEqual({
      ok: false,
      reason: "worker_unavailable",
    });
    // THE BOUND: no fourth worker was constructed.
    expect(FakeWorker.built).toHaveLength(3);
    port.dispose();
  });

  it("counts a construction that throws against the same budget", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    FakeWorker.failOnConstruct = true;
    const port = makePort(2);
    await expect(port.highlight(ask).outcome).resolves.toEqual({ ok: false, reason: "worker_failed" });
    await expect(port.highlight(ask).outcome).resolves.toEqual({
      ok: false,
      reason: "worker_unavailable",
    });
    expect(FakeWorker.built).toHaveLength(0);
    port.dispose();
  });

  it("CANCELS: tells the worker, settles the caller, and drops a late answer", async () => {
    const port = makePort();
    const handle = port.highlight(ask);
    const worker = FakeWorker.built[0];
    const id = worker?.posted[0]?.requestId ?? 0;

    handle.cancel();
    // Idempotent: a caller cancels on hide, on new bytes and again on dispose,
    // and must not have to know which came first.
    handle.cancel();

    await expect(handle.outcome).resolves.toEqual({ ok: false, reason: "cancelled" });
    // The WORKER is told exactly once, so it can drop the request from its
    // queue before it costs a tokenization.
    expect(worker?.cancelled).toEqual([id]);

    // A result that was already on its way in is dropped rather than published.
    worker?.answer({ kind: "result", requestId: id, ok: true, lines: [[]], longLines: 1 });
    await expect(handle.outcome).resolves.toEqual({ ok: false, reason: "cancelled" });
    port.dispose();
  });

  it("holds at most ONE request per named caller, superseding the older", async () => {
    const port = makePort();
    const first = port.highlight({ ...ask, caller: "tab-1" });
    const second = port.highlight({ ...ask, text: "const b = 2;", caller: "tab-1" });
    const other = port.highlight({ ...ask, caller: "tab-2" });
    const worker = FakeWorker.built[0];

    // THE BOUND: the tab's previous request is abandoned before the new one is
    // posted, so three saves in a row cost one live tokenization, not three.
    await expect(first.outcome).resolves.toEqual({ ok: false, reason: "cancelled" });
    expect(worker?.cancelled).toEqual([worker?.posted[0]?.requestId]);

    // A DIFFERENT caller is untouched: they do not share a slot.
    const secondId = worker?.posted[1]?.requestId ?? 0;
    const otherId = worker?.posted[2]?.requestId ?? 0;
    worker?.answer({ kind: "result", requestId: secondId, ok: true, lines: [[]], longLines: 0 });
    worker?.answer({ kind: "result", requestId: otherId, ok: true, lines: [[]], longLines: 1 });
    await expect(second.outcome).resolves.toEqual({ ok: true, lines: [[]], longLines: 0 });
    await expect(other.outcome).resolves.toEqual({ ok: true, lines: [[]], longLines: 1 });
    port.dispose();
  });

  it("frees a caller's slot once its request settles", async () => {
    const port = makePort();
    const first = port.highlight({ ...ask, caller: "tab-1" });
    const worker = FakeWorker.built[0];
    const id = worker?.posted[0]?.requestId ?? 0;
    worker?.answer({ kind: "result", requestId: id, ok: true, lines: [[]], longLines: 0 });
    await expect(first.outcome).resolves.toEqual({ ok: true, lines: [[]], longLines: 0 });

    // The settled request is not cancelled retroactively by the next ask.
    port.highlight({ ...ask, caller: "tab-1" });
    expect(worker?.cancelled).toEqual([]);
    port.dispose();
  });

  it("FAILS CLOSED on a message that is not a response", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const port = makePort();
    const pending = port.highlight(ask).outcome;
    const worker = FakeWorker.built[0];

    // A bad chunk or a half-applied protocol change. `lines` is not an array of
    // token arrays, and publishing it would render `undefined` as a line of the
    // user's file.
    worker?.deliver({
      kind: "result",
      requestId: worker.posted[0]?.requestId,
      ok: true,
      lines: "nope",
    });

    await expect(pending).resolves.toEqual({ ok: false, reason: "malformed_result" });
    port.dispose();
  });

  it("FAILS CLOSED on a token that is missing its fields", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const port = makePort();
    const pending = port.highlight(ask).outcome;
    const worker = FakeWorker.built[0];
    worker?.deliver({
      kind: "result",
      requestId: worker.posted[0]?.requestId,
      ok: true,
      longLines: 0,
      lines: [[{ text: "a" }]],
    });
    await expect(pending).resolves.toEqual({ ok: false, reason: "malformed_result" });
    port.dispose();
  });

  it("dispose terminates, settles the outstanding request once, and is idempotent", async () => {
    const port = makePort();
    const pending = port.highlight(ask).outcome;
    const worker = FakeWorker.built[0];

    port.dispose();
    port.dispose();

    await expect(pending).resolves.toEqual({ ok: false, reason: "worker_unavailable" });
    expect(worker?.terminated).toBe(1);

    // A late answer from the terminated worker must resolve nothing a second
    // time; the pending map was cleared, so this is a no-op by construction.
    worker?.answer({
      kind: "result",
      requestId: worker.posted[0]?.requestId ?? 0,
      ok: true,
      lines: [[]],
      longLines: 0,
    });
    await expect(port.highlight(ask).outcome).resolves.toEqual({
      ok: false,
      reason: "worker_unavailable",
    });
    expect(FakeWorker.built).toHaveLength(1);
  });
});

/**
 * THE CEILINGS ON AN ANSWER.
 *
 * `isHighlightResponse` proves the SHAPE of a response and cannot prove its
 * QUANTITY, because it does not know what was asked. The port does: it holds
 * the text it sent, so it can hold the answer to an EXACT line count. This is
 * the boundary check that stops a worker - ours, behind our own evolving build
 * - from putting a file on screen whose rows do not correspond to the user's.
 *
 * The failure is `malformed_result`, the same fail-closed answer a
 * wrong-shaped message gets, and the viewer shows honest plain text.
 */
describe("the response ceilings", () => {
  /** A three-line text, so a wrong count is unambiguous in either direction. */
  const threeLineAsk = { ...ask, text: "a\nb\nc" };

  /** Answer the one outstanding request with whatever `build` makes of its id. */
  function answerWith(
    build: (requestId: number) => HighlightResponse,
  ): Promise<HighlightOutcome> {
    const port = makePort();
    const pending = port.highlight(threeLineAsk).outcome;
    const worker = FakeWorker.built[0];
    worker?.answer(build(worker.posted[0]?.requestId ?? 0));
    return pending;
  }

  it("refuses an answer with FEWER lines than the text that was sent", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // Two lines for a three-line file: the tail would be silently lost.
    await expect(
      answerWith((requestId) => ({ kind: "result", requestId, ok: true, lines: [[], []], longLines: 0 })),
    ).resolves.toEqual({ ok: false, reason: "malformed_result" });
  });

  it("refuses an answer with MORE lines than the text that was sent", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(
      answerWith((requestId) => ({
        kind: "result",
        requestId,
        ok: true,
        lines: [[], [], [], []],
        longLines: 0,
      })),
    ).resolves.toEqual({ ok: false, reason: "malformed_result" });
  });

  it("accepts the EXACT count", async () => {
    await expect(
      answerWith((requestId) => ({
        kind: "result",
        requestId,
        ok: true,
        lines: [[], [], []],
        longLines: 0,
      })),
    ).resolves.toEqual({ ok: true, lines: [[], [], []], longLines: 0 });
  });

  it("refuses a long-line count larger than the file has lines", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // The count is shown to the user as a count of THEIR file's lines.
    await expect(
      answerWith((requestId) => ({
        kind: "result",
        requestId,
        ok: true,
        lines: [[], [], []],
        longLines: 4,
      })),
    ).resolves.toEqual({ ok: false, reason: "malformed_result" });
  });

  it("carries the token bound to the worker, so the worker can refuse first", () => {
    const port = makePort();
    port.highlight(ask);
    expect(FakeWorker.built[0]?.posted[0]?.maxTokens).toBe(HIGHLIGHT_MAX_TOKENS);
  });

  it("passes the worker's own too_many_tokens refusal through", async () => {
    const port = makePort();
    const pending = port.highlight(ask).outcome;
    const worker = FakeWorker.built[0];
    worker?.answer({
      kind: "result",
      requestId: worker.posted[0]?.requestId ?? 0,
      ok: false,
      reason: "too_many_tokens",
    });
    await expect(pending).resolves.toEqual({ ok: false, reason: "too_many_tokens" });
  });
});

describe("UnavailableHighlighterPort", () => {
  it("answers every request unavailable and disposes without holding anything", async () => {
    const port = new UnavailableHighlighterPort();
    await expect(port.highlight(ask).outcome).resolves.toEqual({
      ok: false,
      reason: "worker_unavailable",
    });
    port.dispose();
  });
});

describe("defaultHighlighterPort", () => {
  it("is the unavailable port when the runtime has no Worker", () => {
    expect(globalThis.Worker).toBeUndefined();
    expect(defaultHighlighterPort()).toBeInstanceOf(UnavailableHighlighterPort);
  });

  it("is the worker port when the runtime has one", () => {
    // Installed for this case only. jsdom defines no `Worker`, so nothing real
    // is being shadowed, and it is removed again in the `finally`.
    globalThis.Worker = FakeWorker;
    try {
      expect(defaultHighlighterPort()).toBeInstanceOf(WorkerHighlighterPort);
    } finally {
      Reflect.deleteProperty(globalThis, "Worker");
    }
    expect(globalThis.Worker).toBeUndefined();
  });
});
