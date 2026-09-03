/**
 * The worker's request queue: sequencing, and the two shapes of cancellation.
 *
 * The case worth naming is the DROP BEFORE START. A superseded request that
 * still runs looks identical from the outside - the right tokens arrive for the
 * right tab either way - and the whole cost of the defect is a CPU-bound
 * tokenization the user is paying for and nobody will ever see. Only a counter
 * on the tokenizer can tell the two apart, which is why every case here asserts
 * how many tokenizations HAPPENED and not just what came back.
 */

import { describe, expect, it } from "vitest";
import { createHighlightQueue, type QueueTokenize } from "../highlight-queue.js";
import {
  HIGHLIGHT_MAX_TOKENS,
  type HighlightRequest,
  type HighlightResponse,
} from "../highlight-protocol.js";
import { createTokenizer } from "../shiki-tokenizer.js";
import { PLAIN_LANGUAGE } from "../language-of-path.js";

interface Harness {
  readonly accept: (message: Parameters<ReturnType<typeof createHighlightQueue>["accept"]>[0]) => void;
  readonly queued: () => number;
  readonly posted: HighlightResponse[];
  /** The languages tokenized, in order. The only proof a request really ran. */
  readonly ran: string[];
  /** Answer the tokenization currently in flight. */
  readonly finish: () => void;
}

/**
 * A tokenizer that HOLDS every call until the test releases it.
 *
 * One that resolved immediately could never show a request being cancelled
 * while another is running, because the queue would already be empty.
 */
function harness(): Harness {
  const ran: string[] = [];
  const posted: HighlightResponse[] = [];
  const waiting: (() => void)[] = [];

  const tokenize: QueueTokenize = (_text, language) => {
    ran.push(language);
    return new Promise((resolve) => {
      waiting.push(() => {
        resolve({
          ok: true,
          result: {
            lines: [[]],
            longLines: 0,
            budgetExceededLines: [],
            budgetExceededTotal: 0,
          },
        });
      });
    });
  };

  const queue = createHighlightQueue({
    tokenize,
    post: (response) => posted.push(response),
  });

  return {
    accept: (message) => {
      queue.accept(message);
    },
    queued: () => queue.queued(),
    posted,
    ran,
    finish: () => {
      const next = waiting.shift();
      if (next === undefined) throw new Error("nothing is tokenizing");
      next();
    },
  };
}

function request(requestId: number, language: string): HighlightRequest {
  return {
    kind: "highlight",
    requestId,
    language,
    text: "x",
    maxLineLength: 20_000,
    maxTokens: HIGHLIGHT_MAX_TOKENS,
  };
}

/** Let the queue's own awaits settle. */
async function flush(): Promise<void> {
  for (let step = 0; step < 10; step += 1) await Promise.resolve();
}

describe("the highlight queue", () => {
  it("runs ONE request at a time, in order", async () => {
    const h = harness();
    h.accept(request(1, "typescript"));
    h.accept(request(2, "json"));
    await flush();

    // The second has not started: one thread, one tokenization.
    expect(h.ran).toEqual(["typescript"]);
    expect(h.queued()).toBe(1);

    h.finish();
    await flush();
    expect(h.ran).toEqual(["typescript", "json"]);
    h.finish();
    await flush();
    expect(h.posted.map((response) => response.kind)).toEqual(["result", "result"]);
  });

  it("DROPS a cancelled request that never started, so it costs nothing", async () => {
    const h = harness();
    h.accept(request(1, "typescript"));
    h.accept(request(2, "json"));
    await flush();

    h.accept({ kind: "cancel", requestId: 2 });
    expect(h.queued()).toBe(0);

    h.finish();
    await flush();

    // THE POINT: the superseded request was never tokenized at all, and no
    // answer was posted for it.
    expect(h.ran).toEqual(["typescript"]);
    expect(h.posted).toEqual([
      { kind: "result", requestId: 1, ok: true, lines: [[]], longLines: 0, budgetExceededLines: [], budgetExceededTotal: 0 },
    ]);
  });

  it("answers a cancelled RUNNING request with silence", async () => {
    const h = harness();
    h.accept(request(1, "typescript"));
    await flush();

    // Already started: the CPU cannot be reclaimed, but the result must not
    // cross back to a caller that has been settled without it.
    h.accept({ kind: "cancel", requestId: 1 });
    h.finish();
    await flush();

    expect(h.ran).toEqual(["typescript"]);
    expect(h.posted).toEqual([]);
  });

  it("keeps draining after a cancelled request", async () => {
    const h = harness();
    h.accept(request(1, "typescript"));
    await flush();
    h.accept(request(2, "json"));
    h.accept({ kind: "cancel", requestId: 1 });
    h.finish();
    await flush();

    expect(h.ran).toEqual(["typescript", "json"]);
    h.finish();
    await flush();
    expect(h.posted).toEqual([
      { kind: "result", requestId: 2, ok: true, lines: [[]], longLines: 0, budgetExceededLines: [], budgetExceededTotal: 0 },
    ]);
  });

  it("remembers NOTHING for a cancel it cannot act on", async () => {
    const h = harness();
    // An id already answered, or never seen. Keeping it would grow the set for
    // the life of the worker, and it would silence a future request that reuses
    // the id after a worker restart.
    h.accept({ kind: "cancel", requestId: 99 });
    h.accept(request(99, "typescript"));
    await flush();
    h.finish();
    await flush();

    expect(h.posted).toEqual([
      { kind: "result", requestId: 99, ok: true, lines: [[]], longLines: 0, budgetExceededLines: [], budgetExceededTotal: 0 },
    ]);
  });

  it("posts a tokenizer refusal as a coded failure", async () => {
    const posted: HighlightResponse[] = [];
    const queue = createHighlightQueue({
      tokenize: () => Promise.resolve({ ok: false, reason: "grammar_unavailable" }),
      post: (response) => posted.push(response),
    });
    queue.accept(request(1, "cobol"));
    await flush();
    expect(posted).toEqual([
      { kind: "result", requestId: 1, ok: false, reason: "grammar_unavailable" },
    ]);
  });
});

/**
 * NOTHING OVERSIZED CROSSES THE WIRE.
 *
 * This is the whole reason the token bound moved into the worker. A count on
 * the renderer side can refuse to RENDER an oversized result, but by then the
 * worker has already built the token graph and the structured clone has already
 * carried it across - every cost the bound exists to avoid has been paid, and
 * only the display was prevented.
 *
 * So the assertion is on what is POSTED, driven through the real tokenizer and
 * the real queue: the response for an over-bound file must be a refusal with no
 * lines on it at all.
 */
describe("the token bound never crosses the boundary", () => {
  /** Every response the worker would have posted, in order. */
  function realQueue(): { posted: HighlightResponse[]; accept: (r: HighlightRequest) => void } {
    const tokenizer = createTokenizer();
    const posted: HighlightResponse[] = [];
    const queue = createHighlightQueue({
      tokenize: (text, language, maxLineLength, maxTokens) =>
        tokenizer.tokenize(text, language, maxLineLength, maxTokens),
      post: (response) => posted.push(response),
    });
    return { posted, accept: (r) => { queue.accept(r); } };
  }

  it("posts a refusal, carrying NO lines, for a file over the bound", async () => {
    const { posted, accept } = realQueue();
    // Plain text is one token per non-empty line, so this is 12 tokens against
    // a bound of 4 - the smallest honest way to be over it.
    accept({
      kind: "highlight",
      requestId: 1,
      language: PLAIN_LANGUAGE,
      text: Array.from({ length: 12 }, (_, index) => `line ${String(index)}`).join("\n"),
      maxLineLength: 20_000,
      maxTokens: 4,
    });
    await flush();

    expect(posted).toEqual([
      { kind: "result", requestId: 1, ok: false, reason: "too_many_tokens" },
    ]);
    // Said explicitly, because this is the property under test: no token graph
    // was posted for the caller to have to refuse.
    expect(posted.every((response) => !("lines" in response))).toBe(true);
  });

  it("posts the tokens when the same file is under the bound", async () => {
    const { posted, accept } = realQueue();
    accept({
      kind: "highlight",
      requestId: 1,
      language: PLAIN_LANGUAGE,
      text: Array.from({ length: 12 }, (_, index) => `line ${String(index)}`).join("\n"),
      maxLineLength: 20_000,
      maxTokens: 12,
    });
    await flush();

    const [response] = posted;
    expect(response?.kind === "result" && response.ok).toBe(true);
    expect(response?.kind === "result" && response.ok ? response.lines : []).toHaveLength(12);
  });
});
