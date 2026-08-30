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
import type { HighlightRequest, HighlightResponse } from "../highlight-protocol.js";
import {
  defaultHighlighterPort,
  HIGHLIGHT_WORKER_MAX_RESTARTS,
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

  readonly posted: HighlightRequest[] = [];
  terminated = 0;
  onmessage: ((this: Worker, event: MessageEvent<HighlightResponse>) => void) | null = null;
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

  postMessage(request: HighlightRequest): void {
    this.posted.push(request);
  }

  terminate(): void {
    this.terminated += 1;
  }

  /** Answer one request as the real worker would. */
  answer(response: HighlightResponse): void {
    this.onmessage?.call(this, new MessageEvent("message", { data: response }));
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

const ask = { language: "typescript", text: "const a = 1;", maxLineLength: 20_000 };

afterEach(() => {
  FakeWorker.built = [];
  FakeWorker.failOnConstruct = false;
  vi.restoreAllMocks();
});

describe("WorkerHighlighterPort", () => {
  it("correlates answers by request id, out of order", async () => {
    const port = makePort();
    const first = port.highlight(ask);
    const second = port.highlight({ ...ask, text: "const b = 2;" });

    const worker = FakeWorker.built[0];
    expect(worker?.posted).toHaveLength(2);
    const [idA, idB] = (worker?.posted ?? []).map((request) => request.requestId);
    expect(idA).not.toBe(idB);

    // Answered in REVERSE. A port that assumed FIFO would hand the second
    // file's tokens to the first tab.
    worker?.answer({ kind: "result", requestId: idB ?? 0, ok: true, lines: [[]], longLines: 7 });
    worker?.answer({
      kind: "result",
      requestId: idA ?? 0,
      ok: false,
      reason: "tokenize_failed",
    });

    await expect(second).resolves.toEqual({ ok: true, lines: [[]], longLines: 7 });
    await expect(first).resolves.toEqual({ ok: false, reason: "tokenize_failed" });
    port.dispose();
  });

  it("builds ONE worker for many requests", () => {
    const port = makePort();
    void port.highlight(ask);
    void port.highlight(ask);
    void port.highlight(ask);
    expect(FakeWorker.built).toHaveLength(1);
    port.dispose();
  });

  it("ignores the ready message and answers for requests it no longer holds", async () => {
    const port = makePort();
    const pending = port.highlight(ask);
    const worker = FakeWorker.built[0];
    worker?.answer({ kind: "ready" });
    // An id nobody is waiting for: the fence, and it must not throw.
    worker?.answer({ kind: "result", requestId: 999, ok: true, lines: [], longLines: 0 });
    const id = worker?.posted[0]?.requestId ?? 0;
    worker?.answer({ kind: "result", requestId: id, ok: true, lines: [], longLines: 0 });
    await expect(pending).resolves.toEqual({ ok: true, lines: [], longLines: 0 });
    port.dispose();
  });

  it("fails EVERY pending request on onerror, terminates, and rebuilds on the next ask", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const port = makePort();
    const first = port.highlight(ask);
    const second = port.highlight(ask);
    const worker = FakeWorker.built[0];

    worker?.crash();

    await expect(first).resolves.toEqual({ ok: false, reason: "worker_failed" });
    await expect(second).resolves.toEqual({ ok: false, reason: "worker_failed" });
    expect(worker?.terminated).toBe(1);
    expect(port.restartCount()).toBe(1);

    // The next request pays for exactly ONE new worker.
    void port.highlight(ask);
    expect(FakeWorker.built).toHaveLength(2);
    port.dispose();
  });

  it("treats onmessageerror the same way", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const port = makePort();
    const pending = port.highlight(ask);
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
      const pending = port.highlight(ask);
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
    await expect(port.highlight(ask)).resolves.toEqual({
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
    await expect(port.highlight(ask)).resolves.toEqual({ ok: false, reason: "worker_failed" });
    await expect(port.highlight(ask)).resolves.toEqual({
      ok: false,
      reason: "worker_unavailable",
    });
    expect(FakeWorker.built).toHaveLength(0);
    port.dispose();
  });

  it("dispose terminates, settles the outstanding request once, and is idempotent", async () => {
    const port = makePort();
    const pending = port.highlight(ask);
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
      lines: [],
      longLines: 0,
    });
    await expect(port.highlight(ask)).resolves.toEqual({
      ok: false,
      reason: "worker_unavailable",
    });
    expect(FakeWorker.built).toHaveLength(1);
  });
});

describe("UnavailableHighlighterPort", () => {
  it("answers every request unavailable and disposes without holding anything", async () => {
    const port = new UnavailableHighlighterPort();
    await expect(port.highlight(ask)).resolves.toEqual({
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
