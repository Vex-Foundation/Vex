/**
 * The board live scheduler, driven through its real loop over scripted reads.
 *
 * WHAT IS FAKED AND WHY THAT IS THE RIGHT SEAM. Two things: the provider read
 * (a controlled deferred, which is the process boundary) and the clock. Every
 * decision under test is the shipped code - the in-flight ceiling, the priority
 * order, the arm-on-settle rule, the generation fence, the supersede rule, the
 * surface cut and the drain. A test that mocked the scheduler's own decisions
 * would prove that glue called glue.
 *
 * NO WALL-CLOCK SLEEP PROVES ANYTHING HERE. Every ordering below is
 * established by resolving a deferred at a chosen moment or by advancing fake
 * timers, so a race that is real fails every run rather than one run in twenty.
 *
 * Race-table rows covered here: R16, R17, R19, R20, R21, R22, R23, R24.
 * R18 and R25 live in `board-sparkline-service.test.ts`, because the pipeline
 * they are about is the sparkline queue rather than the scheduler.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { log } = await import("../../logger/index.js");
const { createBoardLiveScheduler } = await import("../board-live-scheduler.js");
type BoardChannelDescriptor =
  import("../board-live-scheduler.js").BoardChannelDescriptor;
type BoardChannelRunContext =
  import("../board-live-scheduler.js").BoardChannelRunContext;

/** A promise whose settlement this test owns. */
function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function descriptor(
  overrides: Partial<BoardChannelDescriptor> = {},
): BoardChannelDescriptor {
  return {
    id: "cards-batch",
    owner: "modal",
    cadenceMs: 5_000,
    priority: 0,
    subject: null,
    ...overrides,
  };
}

/** Let already-resolved promise jobs run without advancing the clock. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

/**
 * The signal a run was actually handed.
 *
 * A cast is not the tool here. The compiler narrows `runSignal` to `null`
 * because it cannot see that the callback which assigns it has already run, so
 * an `as unknown as` would be silencing the compiler about the very thing the
 * test needs to be true. A real runtime check proves it instead, and fails
 * with a sentence rather than with `aborted` of undefined.
 */
function startedWith(signal: AbortSignal | null): AbortSignal {
  if (signal === null) throw new Error("the admitted run never started");
  return signal;
}

describe("the in-flight ceiling", () => {
  it("R19: never runs more than two board reads at once, whatever is due", async () => {
    // The bridge's cap of four is SHARED with the agent. The property under
    // test is exactly the one that leaves the agent two slots: seven channels
    // all due at once still produce two exchanges, not seven.
    const scheduler = createBoardLiveScheduler();
    const gates = new Map<string, ReturnType<typeof deferred<void>>>();
    const started: string[] = [];

    const ids = [
      "cards-batch",
      "spotlight-candles",
      "card-sparkline",
      "pair-details",
      "spotlight-context",
      "spotlight-trades",
      "spotlight-traders",
    ] as const;

    for (const id of ids) {
      const gate = deferred();
      gates.set(id, gate);
      scheduler.arm(descriptor({ id, cadenceMs: null, priority: 0, key: id }), async () => {
        started.push(id);
        await gate.promise;
      });
    }

    await flush();
    expect(scheduler.inFlightCount()).toBe(2);
    expect(started).toHaveLength(2);

    // Releasing one admits exactly one more. The ceiling holds across the whole
    // drain rather than only at the start.
    gates.get(started[0] as string)?.resolve(undefined);
    await flush();
    expect(scheduler.inFlightCount()).toBe(2);
    expect(started).toHaveLength(3);

    for (const gate of gates.values()) gate.resolve(undefined);
    await scheduler.stop();
  });

  it("R22: gives the reader's cards the slot before the traders panel", async () => {
    // Priority, not timer luck. Without an order, contention is resolved by
    // whichever timer fired first, which the reader experiences as the cards
    // freezing while a traders panel loads.
    const scheduler = createBoardLiveScheduler();
    const started: string[] = [];
    const hold = deferred();

    // Armed WORST first, so an unordered scheduler would start these two.
    scheduler.arm(
      descriptor({ id: "spotlight-traders", owner: "spotlight", priority: 4, cadenceMs: null }),
      async () => {
        started.push("traders");
        await hold.promise;
      },
    );
    scheduler.arm(
      descriptor({ id: "spotlight-trades", owner: "spotlight", priority: 3, cadenceMs: null }),
      async () => {
        started.push("trades");
        await hold.promise;
      },
    );
    scheduler.arm(descriptor({ id: "cards-batch", priority: 0, cadenceMs: null }), async () => {
      started.push("cards");
      await hold.promise;
    });
    scheduler.arm(
      descriptor({ id: "spotlight-candles", owner: "spotlight", priority: 1, cadenceMs: null }),
      async () => {
        started.push("candles");
        await hold.promise;
      },
    );

    await flush();
    // The two lowest priority NUMBERS ran; the traders panel waited.
    expect(started).toEqual(["cards", "candles"]);

    hold.resolve(undefined);
    await scheduler.stop();
  });
});

describe("the poll loop", () => {
  it("R21: never overlaps a channel with itself, and arms the next tick on settle", async () => {
    // A run slower than its cadence must produce ONE run, not a pile of
    // concurrent exchanges. The next tick is armed when the previous SETTLES.
    const scheduler = createBoardLiveScheduler();
    let starts = 0;
    let gate = deferred();
    scheduler.arm(descriptor({ cadenceMs: 5_000 }), async () => {
      starts += 1;
      await gate.promise;
    });

    await flush();
    expect(starts).toBe(1);

    // Three cadences pass while the first read is still in flight.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(starts).toBe(1);
    expect(scheduler.inFlightCount()).toBe(1);

    const first = gate;
    gate = deferred();
    first.resolve(undefined);
    await flush();
    // Settled, and the next tick is armed rather than immediate.
    expect(starts).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(starts).toBe(2);

    gate.resolve(undefined);
    await scheduler.stop();
  });

  it("R20: a one-shot runs exactly once and gives its slot back", async () => {
    // A one-shot that re-armed would silently become a poll nobody asked for,
    // and it would hold a slot the cards need.
    const scheduler = createBoardLiveScheduler();
    let starts = 0;
    scheduler.arm(descriptor({ id: "pair-details", cadenceMs: null }), async () => {
      starts += 1;
    });

    await flush();
    expect(starts).toBe(1);
    expect(scheduler.inFlightCount()).toBe(0);
    expect(scheduler.armedCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(starts).toBe(1);

    await scheduler.stop();
  });

  it("a failing read is an ordinary outcome: the next tick is still armed", async () => {
    // A decoration channel that threw used to be a channel that stopped
    // forever. The surface keeps what it had and the poll tries again.
    const scheduler = createBoardLiveScheduler();
    let starts = 0;
    scheduler.arm(descriptor({ cadenceMs: 5_000 }), async () => {
      starts += 1;
      throw new Error("provider refused");
    });

    await flush();
    expect(starts).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(starts).toBe(2);

    await scheduler.stop();
  });

  it("logs the typed CODE of a refusal, not just its class name", async () => {
    // Every refusal on this path arrives as one `VexError`, so a line that
    // printed only the class name said "VexError" for a rate limit, a bad
    // response and a timeout alike, and told an operator nothing.
    const scheduler = createBoardLiveScheduler();
    const refusal = Object.assign(new Error("provider refused"), {
      name: "VexError",
      code: "market.rate_limited",
    });
    scheduler.arm(descriptor({ cadenceMs: null }), async () => {
      throw refusal;
    });

    await flush();

    const lines = vi.mocked(log.info).mock.calls.map((call) => String(call[0]));
    const line = lines.find((entry) => entry.includes("read produced no result"));
    expect(line).toBeDefined();
    expect(line).toContain("market.rate_limited");
    expect(line).toContain("VexError");
    // The message itself is a provider payload and stays out of the log.
    expect(line).not.toContain("provider refused");

    await scheduler.stop();
  });

  it("falls back to the class name when a thrown value carries no code", async () => {
    const scheduler = createBoardLiveScheduler();
    scheduler.arm(descriptor({ cadenceMs: null }), async () => {
      throw new TypeError("boom");
    });

    await flush();

    const lines = vi.mocked(log.info).mock.calls.map((call) => String(call[0]));
    const line = lines.find((entry) => entry.includes("read produced no result"));
    expect(line).toContain("TypeError (TypeError)");

    await scheduler.stop();
  });
});

describe("the generation fence", () => {
  it("R16: a spotlight read in flight when the reader leaves publishes nothing", async () => {
    // Entering and leaving the spotlight mid-tick. The answer arrives after the
    // surface is gone, and painting it would put a token's tape under a grid
    // the reader is already looking at.
    const scheduler = createBoardLiveScheduler();
    const gate = deferred();
    const painted: string[] = [];
    let published: boolean | null = null;
    let aborted = false;

    scheduler.arm(
      descriptor({ id: "spotlight-trades", owner: "spotlight", cadenceMs: 5_000 }),
      async (ctx: BoardChannelRunContext) => {
        ctx.signal.addEventListener("abort", () => {
          aborted = true;
        });
        await gate.promise;
        published = ctx.publish("tape-row", (value) => painted.push(value));
      },
    );
    await flush();
    expect(scheduler.inFlightCount()).toBe(1);

    // The reader leaves the spotlight while the read is in flight.
    scheduler.cutSurface("spotlight");
    expect(aborted).toBe(true);

    gate.resolve(undefined);
    await flush();
    expect(published).toBe(false);
    expect(painted).toEqual([]);

    await scheduler.stop();
  });

  it("R16b: cutting the spotlight leaves the modal's own channels running", async () => {
    // The owner union has no "app" member for exactly this reason: leaving the
    // spotlight must not stop the cards behind it.
    const scheduler = createBoardLiveScheduler();
    const hold = deferred();
    scheduler.arm(descriptor({ id: "cards-batch", owner: "modal" }), async () => {
      await hold.promise;
    });
    scheduler.arm(
      descriptor({ id: "spotlight-trades", owner: "spotlight" }),
      async () => {
        await hold.promise;
      },
    );
    await flush();
    expect(scheduler.armedCount()).toBe(2);

    scheduler.cutSurface("spotlight");
    expect(scheduler.armedCount("spotlight")).toBe(0);
    expect(scheduler.armedCount("modal")).toBe(1);

    hold.resolve(undefined);
    await scheduler.stop();
  });

  it("R17: switching the resolution pill discards the old poll's answer", async () => {
    // The hazard is silent: bars fetched under 1m painted under a 24H pill are
    // indistinguishable from correct ones on the canvas. The old run is cut,
    // its answer is refused, and only the new pill's series is published.
    const scheduler = createBoardLiveScheduler();
    const oldGate = deferred();
    const newGate = deferred();
    const painted: string[] = [];
    let oldPublished: boolean | null = null;
    let oldAborted = false;

    scheduler.arm(
      descriptor({ id: "spotlight-candles", owner: "spotlight", subject: "1m" }),
      async (ctx: BoardChannelRunContext) => {
        ctx.signal.addEventListener("abort", () => {
          oldAborted = true;
        });
        await oldGate.promise;
        oldPublished = ctx.publish("bars@1m", (value) => painted.push(value));
      },
    );
    await flush();

    // The reader taps 24H while the 1m read is still in flight. Same slot, so
    // this SUPERSEDES rather than running beside it.
    scheduler.arm(
      descriptor({ id: "spotlight-candles", owner: "spotlight", subject: "15m" }),
      async (ctx: BoardChannelRunContext) => {
        await newGate.promise;
        ctx.publish("bars@15m", (value) => painted.push(value));
      },
    );
    expect(oldAborted).toBe(true);

    oldGate.resolve(undefined);
    newGate.resolve(undefined);
    await flush();

    expect(oldPublished).toBe(false);
    expect(painted).toEqual(["bars@15m"]);

    await scheduler.stop();
  });

  it("R24: a disarm captured before a supersede does not cut its replacement", async () => {
    // A React effect cleanup runs AFTER the next effect has already armed the
    // replacement. An identity-blind disarm would cut the live channel and
    // leave the surface with nothing.
    const scheduler = createBoardLiveScheduler();
    const hold = deferred();
    const staleDisarm = scheduler.arm(
      descriptor({ id: "spotlight-candles", owner: "spotlight" }),
      async () => {
        await hold.promise;
      },
    );
    scheduler.arm(
      descriptor({ id: "spotlight-candles", owner: "spotlight" }),
      async () => {
        await hold.promise;
      },
    );
    expect(scheduler.armedCount("spotlight")).toBe(1);

    staleDisarm();
    expect(scheduler.armedCount("spotlight")).toBe(1);

    hold.resolve(undefined);
    await scheduler.stop();
  });

  it("hands each run its own coalescence scope", async () => {
    // The bridge joins identical concurrent exchanges onto the first caller's
    // promise. A board poll sharing an agent tool's scope could not be aborted
    // by a modal close, and an agent tool sharing the board's would be killed
    // by one.
    const scheduler = createBoardLiveScheduler();
    const scopes: string[] = [];
    scheduler.arm(descriptor({ id: "cards-batch", cadenceMs: 5_000 }), async (ctx) => {
      scopes.push(ctx.coalesceScope);
    });
    await flush();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(scopes[0]).toBe("board-cards-batch:1");
    // Same channel, same generation across ticks: the scope names the armed
    // channel, and a cut is what changes it.
    expect(scopes[1]).toBe("board-cards-batch:1");

    // A CUT AND A RE-ARM MUST NEVER REUSE A SCOPE. Reusing one would let the
    // new read join the aborted read's in-flight exchange on the bridge and
    // inherit a signal that is already aborted, so the generation counter
    // outlives the channel it belonged to.
    scheduler.cutChannel("cards-batch");
    scheduler.arm(descriptor({ id: "cards-batch", cadenceMs: 5_000 }), async (ctx) => {
      scopes.push(ctx.coalesceScope);
    });
    await flush();
    expect(scopes[2]).toBe("board-cards-batch:3");
    expect(new Set(scopes).size).toBe(2);

    await scheduler.stop();
  });
});

describe("teardown", () => {
  it("R23: stop drains the run in flight rather than abandoning it", async () => {
    // The runs ride the DexScreener bridge's transport. Abandoning one would
    // let the bridge be disposed underneath a read that is still going.
    const scheduler = createBoardLiveScheduler();
    const gate = deferred();
    let finished = false;
    scheduler.arm(descriptor(), async () => {
      await gate.promise;
      finished = true;
    });
    await flush();

    let stopResolved = false;
    const stopping = scheduler.stop().then(() => {
      stopResolved = true;
    });
    await flush();
    expect(stopResolved).toBe(false);

    gate.resolve(undefined);
    await stopping;
    expect(finished).toBe(true);
    expect(scheduler.inFlightCount()).toBe(0);
  });

  it("stop is idempotent and closes admission", async () => {
    const scheduler = createBoardLiveScheduler();
    let starts = 0;
    scheduler.arm(descriptor(), async () => {
      starts += 1;
    });
    await flush();
    await scheduler.stop();
    await scheduler.stop();

    // Arming after a stop is a no-op with a safe disarm, not a throw: a
    // surface unmounting during shutdown must not crash the quit sequence.
    const disarm = scheduler.arm(descriptor(), async () => {
      starts += 1;
    });
    disarm();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(starts).toBe(1);
  });

  it("a cut stops the armed timer, so no tick fires for a surface that is gone", async () => {
    const scheduler = createBoardLiveScheduler();
    let starts = 0;
    scheduler.arm(descriptor({ cadenceMs: 5_000 }), async () => {
      starts += 1;
    });
    await flush();
    expect(starts).toBe(1);

    scheduler.cutSurface("modal");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(starts).toBe(1);

    await scheduler.stop();
  });
});

/* ------------------------------------------------------------------ */
/* Admission - the seam every real board read passes through          */
/* ------------------------------------------------------------------ */

describe("admission", () => {
  it("holds excess admitted reads at the ceiling and admits them as slots free", async () => {
    // THE DEFECT THIS PINS. The scheduler was mounted and never called: every
    // real board read went renderer timer -> IPC -> service, past the cap. If
    // `admit` stops enforcing the ceiling, this observes five concurrent
    // provider reads where two are allowed.
    const scheduler = createBoardLiveScheduler();
    const gates = [0, 1, 2, 3, 4].map(() => deferred<void>());
    let concurrent = 0;
    let peak = 0;
    const startedOrder: number[] = [];

    const answers = gates.map((gate, index) =>
      scheduler.admit(
        { id: "pair-details", owner: "modal", key: `pool-${String(index)}` },
        async () => {
          startedOrder.push(index);
          concurrent += 1;
          peak = Math.max(peak, concurrent);
          await gate.promise;
          concurrent -= 1;
          return index;
        },
      ),
    );

    await flush();
    expect(peak).toBe(2);
    expect(scheduler.inFlightCount()).toBe(2);
    expect(startedOrder).toHaveLength(2);

    // Freeing one slot admits exactly one more, never the whole backlog.
    gates[0]?.resolve();
    await flush();
    expect(peak).toBe(2);
    expect(startedOrder).toHaveLength(3);

    for (const gate of gates) gate.resolve();
    await flush();
    const settled = await Promise.all(answers);
    expect(settled.map((admission) => admission.kind)).toEqual(
      Array.from({ length: 5 }, () => "ran"),
    );
    expect(peak).toBe(2);
  });

  it("contends with an ARMED channel on the same counter, not a second one", async () => {
    // ONE CEILING. An armed poll holding one slot must leave exactly one for
    // admission; two ceilings would let three exchanges run on a pipe sized
    // for two and shared with the agent.
    const scheduler = createBoardLiveScheduler();
    const armedGate = deferred<void>();
    const admittedGates = [deferred<void>(), deferred<void>()];
    let concurrent = 0;
    let peak = 0;

    scheduler.arm(descriptor({ id: "cards-batch", priority: 0 }), async () => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await armedGate.promise;
      concurrent -= 1;
    });
    const answers = admittedGates.map((gate, index) =>
      scheduler.admit(
        { id: "pair-details", owner: "modal", key: `pool-${String(index)}` },
        async () => {
          concurrent += 1;
          peak = Math.max(peak, concurrent);
          await gate.promise;
          concurrent -= 1;
          return index;
        },
      ),
    );

    await flush();
    expect(scheduler.inFlightCount()).toBe(2);
    expect(peak).toBe(2);

    armedGate.resolve();
    for (const gate of admittedGates) gate.resolve();
    await flush();
    await Promise.all(answers);
    expect(peak).toBe(2);
  });

  it("cuts an admitted read in flight and refuses to publish its answer", async () => {
    const scheduler = createBoardLiveScheduler();
    const gate = deferred<void>();
    let runSignal: AbortSignal | null = null;

    const answer = scheduler.admit(
      { id: "spotlight-trades", owner: "spotlight" },
      async (run) => {
        runSignal = run.signal;
        await gate.promise;
        return "tape rows";
      },
    );
    await flush();
    expect(runSignal).not.toBeNull();

    scheduler.cutSurface("spotlight");
    expect(startedWith(runSignal).aborted).toBe(true);

    // The read settles anyway, as a real provider read would. Its VALUE is
    // dropped: the surface it was for has moved on.
    gate.resolve();
    await expect(answer).resolves.toEqual({
      kind: "refused",
      reason: "cancelled",
    });
  });

  it("cutChannel aborts the admitted read of that channel id", async () => {
    const scheduler = createBoardLiveScheduler();
    const gate = deferred<void>();
    let runSignal: AbortSignal | null = null;
    const answer = scheduler.admit(
      { id: "card-sparkline", owner: "modal", key: "pool-a" },
      async (run) => {
        runSignal = run.signal;
        await gate.promise;
        return "series";
      },
    );
    await flush();

    scheduler.cutChannel("card-sparkline");
    expect(startedWith(runSignal).aborted).toBe(true);
    gate.resolve();
    await expect(answer).resolves.toEqual({
      kind: "refused",
      reason: "cancelled",
    });
  });

  it("aborts the run when the CALLER's own signal fires", async () => {
    // This is the path an IPC handler takes: `ctx.signal` is the renderer
    // saying "I stopped waiting", and it must reach the provider read.
    const scheduler = createBoardLiveScheduler();
    const caller = new AbortController();
    const gate = deferred<void>();
    let runSignal: AbortSignal | null = null;

    const answer = scheduler.admit(
      { id: "spotlight-candles", owner: "spotlight", signal: caller.signal },
      async (run) => {
        runSignal = run.signal;
        await gate.promise;
        return "bars";
      },
    );
    await flush();
    caller.abort();
    expect(startedWith(runSignal).aborted).toBe(true);
    gate.resolve();
    await expect(answer).resolves.toEqual({
      kind: "refused",
      reason: "cancelled",
    });
  });

  it("refuses a caller whose signal already aborted, without starting a read", async () => {
    const scheduler = createBoardLiveScheduler();
    const caller = new AbortController();
    caller.abort();
    // TYPED AS THE RUN IT STANDS IN FOR, so the assertion below is about
    // behaviour rather than about a cast. A spy whose signature already
    // matches needs no escape.
    const run = vi.fn(async (): Promise<string> => "never");
    await expect(
      scheduler.admit(
        { id: "pair-details", owner: "modal", signal: caller.signal },
        run,
      ),
    ).resolves.toEqual({ kind: "refused", reason: "cancelled" });
    expect(run).not.toHaveBeenCalled();
  });

  it("settles a read cut BEFORE it ever started, rather than leaving its caller waiting", async () => {
    const scheduler = createBoardLiveScheduler();
    const blockers = [deferred<void>(), deferred<void>()];
    for (const [index, gate] of blockers.entries()) {
      void scheduler.admit(
        { id: "cards-batch", owner: "modal", key: `block-${String(index)}` },
        async () => gate.promise,
      );
    }
    const waiting = vi.fn();
    const answer = scheduler.admit(
      { id: "spotlight-traders", owner: "spotlight" },
      async () => {
        waiting();
      },
    );
    await flush();
    // Both slots are held, so this one never started.
    expect(waiting).not.toHaveBeenCalled();

    scheduler.cutSurface("spotlight");
    await expect(answer).resolves.toEqual({
      kind: "refused",
      reason: "cancelled",
    });
    expect(waiting).not.toHaveBeenCalled();
    for (const gate of blockers) gate.resolve();
    await flush();
  });

  it("refuses `busy` past the waiting bound rather than queueing forever", async () => {
    const scheduler = createBoardLiveScheduler({ admissionQueueMax: 1 });
    const blockers = [deferred<void>(), deferred<void>()];
    for (const [index, gate] of blockers.entries()) {
      void scheduler.admit(
        { id: "cards-batch", owner: "modal", key: `block-${String(index)}` },
        async () => gate.promise,
      );
    }
    await flush();
    // One may wait; the second is refused.
    void scheduler.admit({ id: "pair-details", owner: "modal", key: "a" }, async () =>
      undefined,
    );
    await expect(
      scheduler.admit({ id: "pair-details", owner: "modal", key: "b" }, async () =>
        undefined,
      ),
    ).resolves.toEqual({ kind: "refused", reason: "busy" });

    for (const gate of blockers) gate.resolve();
    await flush();
  });

  it("refuses `not_mounted` once the scheduler stopped", async () => {
    const scheduler = createBoardLiveScheduler();
    await scheduler.stop();
    await expect(
      scheduler.admit({ id: "pair-details", owner: "modal" }, async () => "value"),
    ).resolves.toEqual({ kind: "refused", reason: "not_mounted" });
  });

  it("stop DRAINS an admitted read rather than abandoning it", async () => {
    const scheduler = createBoardLiveScheduler();
    const gate = deferred<void>();
    let finished = false;
    const answer = scheduler.admit(
      { id: "pair-details", owner: "modal" },
      async () => {
        await gate.promise;
        finished = true;
        return "bundle";
      },
    );
    await flush();

    const stopping = scheduler.stop();
    let stopped = false;
    void stopping.then(() => {
      stopped = true;
    });
    await flush();
    expect(stopped).toBe(false);

    gate.resolve();
    await stopping;
    expect(finished).toBe(true);
    expect(stopped).toBe(true);
    await expect(answer).resolves.toEqual({
      kind: "refused",
      reason: "cancelled",
    });
  });

  it("mints a distinct coalescence scope for an armed run and an admitted run of one channel", async () => {
    // The generation counter is shared, so a poll and a one-shot on the same
    // channel can never join each other's exchange on the bridge.
    const scheduler = createBoardLiveScheduler();
    const scopes: string[] = [];
    const gate = deferred<void>();
    scheduler.arm(descriptor({ id: "pair-details", cadenceMs: null }), async (run) => {
      scopes.push(run.coalesceScope);
      await gate.promise;
    });
    const answer = scheduler.admit(
      { id: "pair-details", owner: "modal" },
      async (run) => {
        scopes.push(run.coalesceScope);
        return null;
      },
    );
    await flush();
    gate.resolve();
    await answer;
    await flush();
    expect(scopes).toHaveLength(2);
    expect(new Set(scopes).size).toBe(2);
    expect(scopes.every((scope) => scope.startsWith("board-pair-details:"))).toBe(
      true,
    );
  });

  it("does not let two admitted reads of one channel supersede each other", async () => {
    // `arm` supersedes a slot on purpose. Admission must NOT: two pools'
    // details reads are two independent questions with two callers waiting.
    const scheduler = createBoardLiveScheduler();
    const first = scheduler.admit(
      { id: "pair-details", owner: "modal", key: "pool-a" },
      async () => "a",
    );
    const second = scheduler.admit(
      { id: "pair-details", owner: "modal", key: "pool-a" },
      async () => "b",
    );
    await expect(first).resolves.toEqual({ kind: "ran", value: "a" });
    await expect(second).resolves.toEqual({ kind: "ran", value: "b" });
  });
});
