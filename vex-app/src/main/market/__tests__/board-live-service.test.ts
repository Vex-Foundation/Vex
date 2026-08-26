/**
 * The board live lease, driven through its real state machine over a scripted
 * batch channel.
 *
 * WHAT IS FAKED AND WHY THAT IS THE RIGHT SEAM. Exactly one thing: the batch
 * attempt, which is the process boundary. Everything above it is the shipped
 * code - the registry and its supersede rule, the exact-key reconciliation, the
 * canonical projector, the backoff arithmetic, the abort controller, the
 * teardown order, and the rule that events come only from a lease that is in
 * the registry. A test that mocked the service's own decisions would prove that
 * glue called glue.
 *
 * Row shapes are the provider's own: `chainId` and `pairAddress` are what
 * `rowKey` reconciles on, so a fixture that spelled them differently would
 * reconcile as a miss and every assertion below would be about nothing.
 *
 * Race-table rows covered here (the renderer-side rows are in
 * `renderer/lib/api/__tests__/board-live-hook.test.tsx`, and R14 lives in
 * `main/dexscreener-bridge/__tests__/ws-bridge-coalesce-scope.test.ts`):
 * R1, R3, R4, R5, R6, R8, R9, R10, R15.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { BoardLiveService } = await import("../board-live-service.js");
const { DexScreenerSiteErrorCodes } = await import(
  "@tools/dexscreener/site-errors.js"
);
const { reconcileBatchRows } = await import(
  "@tools/dexscreener/endpoints/pairs-batch.js"
);
type BatchIdentity =
  import("@tools/dexscreener/endpoints/pairs-batch.js").BatchIdentity;
type BoardLiveBatchAnswer =
  import("../board-live-service.js").BoardLiveBatchAnswer;
type BoardLiveTarget = import("../board-live-service.js").BoardLiveTarget;
type BoardLiveEvent = import("@shared/schemas/board-live.js").BoardLiveEvent;

const POOLS = [
  { chain: "solana", pairAddress: "PairAAA" },
  { chain: "ethereum", pairAddress: "PairBBB" },
] as const;

/** One raw provider row, in the shape `rowKey` and the projector actually read. */
function providerRow(
  chainId: string,
  pairAddress: string,
  priceUsd = "1.25",
): Record<string, unknown> {
  return {
    chainId,
    pairAddress,
    // `priceUSD`, with that exact capitalisation: it is the wire name the
    // provider's own descriptor uses and the one `screen-core/project.ts`
    // reads. Spelling it `priceUsd` here made the projector return null while
    // the fixture looked perfectly reasonable, which is precisely the defect
    // class that makes hand-spelled wire names a defect even when they read
    // correctly.
    priceUSD: priceUsd,
    baseToken: { symbol: "AAA", name: "Token A", address: "BaseAAA" },
    quoteToken: { symbol: "USDC", address: "QuoteUSDC" },
    dexId: "raydium",
  };
}

/**
 * One batch answer, ASSEMBLED BY THE REAL ADAPTER rather than by hand.
 *
 * This is the seam the review found. `reconcileBatchRows` is the shipped
 * function `fetchPairsBatch` uses to turn raw provider rows into the four
 * fields the live service consumes, and it REPAIRS two of the divergences on
 * the way: it removes a row nobody asked for, and it folds a second row for one
 * identity into the first, recording each in `unrequested` and `collapsed`. A
 * hand-built answer skipped that repair, so the old R15 cases were injecting
 * malformed rows on the far side of the very boundary that loses the evidence,
 * and they passed against a service that had no way to see either divergence.
 *
 * Driving the real function means a case here describes what the PROVIDER did,
 * and the service is judged on the answer production would actually hand it.
 */
function answerFrom(
  requested: readonly { chain: string; pairAddress: string }[],
  providerRows: readonly unknown[],
  fetchedAtMs = 1_000,
): BoardLiveBatchAnswer {
  const identities: BatchIdentity[] = requested.map((pool) => ({
    chainId: pool.chain,
    id: pool.pairAddress,
    kind: "pair",
    raw: `${pool.chain}:${pool.pairAddress}`,
  }));
  return { ...reconcileBatchRows(identities, providerRows), fetchedAtMs };
}

/** The ordinary case: the provider answered exactly what was asked, once each. */
function answerFor(
  pools: readonly { chain: string; pairAddress: string }[],
  fetchedAtMs = 1_000,
  priceUsd?: string,
): BoardLiveBatchAnswer {
  return answerFrom(
    pools,
    pools.map((pool) => providerRow(pool.chain, pool.pairAddress, priceUsd)),
    fetchedAtMs,
  );
}

/**
 * Subscribe with a renderer-minted request id, which the contract now requires.
 *
 * Sequential rather than random so a test that needs to name a request id it
 * has not made yet can predict it.
 */
let requestCounter = 0;
function requestId(n: number): string {
  return `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`;
}
function subscribeTo(
  service: InstanceType<typeof BoardLiveService>,
  args: {
    readonly target: BoardLiveTarget;
    readonly pools: readonly { chain: string; pairAddress: string }[];
  },
): ReturnType<InstanceType<typeof BoardLiveService>["subscribe"]> {
  requestCounter += 1;
  return service.subscribe({ ...args, requestId: requestId(requestCounter) });
}

interface FakeTarget {
  readonly target: BoardLiveTarget;
  readonly events: BoardLiveEvent[];
  /** Fire the window's death, as `destroyed` / crash / navigation would. */
  fireGone(): void;
  readonly listenerCount: () => number;
}

function makeTarget(ownerId: number): FakeTarget {
  const events: BoardLiveEvent[] = [];
  const callbacks = new Set<() => void>();
  return {
    events,
    listenerCount: () => callbacks.size,
    fireGone: () => {
      for (const cb of [...callbacks]) cb();
    },
    target: {
      ownerId,
      send: (event) => {
        events.push(event);
      },
      onGone: (cb) => {
        callbacks.add(cb);
        return () => callbacks.delete(cb);
      },
    },
  };
}

/** A typed site error, exactly as the transport raises one. */
function siteFailure(code: string): Error & { code: string } {
  const error = new Error(`scripted transport failure: ${code}`) as Error & {
    code: string;
  };
  error.code = code;
  return error;
}

function kinds(events: readonly BoardLiveEvent[]): string[] {
  return events.map((event) =>
    event.kind === "closed" ? `closed:${event.reason}` : event.kind,
  );
}

let leaseCounter = 0;
function makeService(
  fetchBatch: BoardLiveServiceFetch,
  overrides: Partial<{
    readonly maxConsecutiveFailures: number;
    readonly isSupported: () => boolean;
  }> = {},
): InstanceType<typeof BoardLiveService> {
  leaseCounter = 0;
  return new BoardLiveService({
    fetchBatch,
    isSupported: overrides.isSupported ?? ((): boolean => true),
    now: () => 5_000,
    newLeaseId: () => {
      leaseCounter += 1;
      return `00000000-0000-4000-8000-${String(leaseCounter).padStart(12, "0")}`;
    },
    tickIntervalMs: 5_000,
    attemptTimeoutMs: 20_000,
    maxBackoffMs: 60_000,
    maxConsecutiveFailures: overrides.maxConsecutiveFailures ?? 6,
    jitterMs: () => 0,
  });
}

type BoardLiveServiceFetch = NonNullable<
  ConstructorParameters<typeof BoardLiveService>[0]
>["fetchBatch"];

let live: InstanceType<typeof BoardLiveService> | null = null;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  await live?.stop();
  live = null;
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("board live lease", () => {
  it("R1: a second subscribe supersedes the first, even while it is still subscribing", async () => {
    // Only the two FIRST attempts are gated - those are the ones whose overlap
    // this row is about. B's later polls answer immediately so the test's own
    // teardown has something finite to drain.
    const gates: Array<(answer: BoardLiveBatchAnswer) => void> = [];
    let attempt = 0;
    const service = makeService(() => {
      attempt += 1;
      if (attempt > 2) return Promise.resolve(answerFor(POOLS, 3_000));
      return new Promise<BoardLiveBatchAnswer>((resolve) => {
        gates.push(resolve);
      });
    });
    live = service;
    const a = makeTarget(1);
    const b = makeTarget(2);

    const first = subscribeTo(service, { target: a.target, pools: POOLS });
    // B arrives while A's very first attempt is still in flight.
    const second = subscribeTo(service, { target: b.target, pools: POOLS });

    // A is closed the moment B claims the slot, not when A's attempt lands.
    expect(kinds(a.events)).toStrictEqual(["closed:superseded"]);

    gates[0]?.(answerFor(POOLS, 1_000));
    gates[1]?.(answerFor(POOLS, 2_000));
    const firstOutcome = await first;
    const secondOutcome = await second;

    expect(firstOutcome.kind).toBe("failed");
    expect(secondOutcome.kind).toBe("subscribed");

    // No tick from A ever reaches its window: its only event is the terminal.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(kinds(a.events)).toStrictEqual(["closed:superseded"]);
    expect(a.listenerCount()).toBe(0);
  });

  it("R3: refuses to release a lease owned by another window, untouched", async () => {
    const service = makeService(() => Promise.resolve(answerFor(POOLS)));
    live = service;
    const owner = makeTarget(1);
    const outcome = await subscribeTo(service, { target: owner.target, pools: POOLS });
    if (outcome.kind !== "subscribed") throw new Error("expected a lease");

    expect(
      service.unsubscribe({ leaseId: outcome.leaseId, ownerId: 999 }),
    ).toBe("not-owner");
    // Untouched: no terminal event, and the poll is still armed.
    expect(kinds(owner.events)).toStrictEqual([]);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(kinds(owner.events)).toStrictEqual(["tick"]);

    expect(
      service.unsubscribe({ leaseId: outcome.leaseId, ownerId: 1 }),
    ).toBe("closed");
    // Idempotent: a cleanup racing a terminal event is an ordinary outcome.
    expect(
      service.unsubscribe({ leaseId: outcome.leaseId, ownerId: 1 }),
    ).toBe("unknown");
  });

  it("R4: one failure degrades and backs off; a success resets and returns to active", async () => {
    let attempt = 0;
    const service = makeService(() => {
      attempt += 1;
      if (attempt === 2) {
        return Promise.reject(siteFailure(DexScreenerSiteErrorCodes.TRANSPORT_FAILED));
      }
      return Promise.resolve(answerFor(POOLS, 1_000 * attempt));
    });
    live = service;
    const owner = makeTarget(1);
    const outcome = await subscribeTo(service, { target: owner.target, pools: POOLS });
    if (outcome.kind !== "subscribed") throw new Error("expected a lease");

    await vi.advanceTimersByTimeAsync(5_000); // attempt 2: fails
    expect(kinds(owner.events)).toStrictEqual(["degraded"]);
    const degraded = owner.events[0];
    if (degraded?.kind !== "degraded") throw new Error("expected degraded");
    // The last-good rows travel with the degradation, so the board keeps
    // showing figures rather than blanking.
    expect(degraded.lastGood?.fetchedAtMs).toBe(1_000);

    // Backed off to base * 2^1 = 10 s, so nothing happens at 5 s.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(kinds(owner.events)).toStrictEqual(["degraded"]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(kinds(owner.events)).toStrictEqual(["degraded", "tick"]);

    // The counter reset: the next cadence is the ordinary 5 s again.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(kinds(owner.events)).toStrictEqual(["degraded", "tick", "tick"]);
  });

  it("R5: a permanent grammar refusal drops the lease without backing off", async () => {
    let attempt = 0;
    const service = makeService(() => {
      attempt += 1;
      if (attempt === 1) return Promise.resolve(answerFor(POOLS));
      return Promise.reject(
        siteFailure(DexScreenerSiteErrorCodes.WS_UPGRADE_REFUSED),
      );
    });
    live = service;
    const owner = makeTarget(1);
    await subscribeTo(service, { target: owner.target, pools: POOLS });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(kinds(owner.events)).toStrictEqual(["closed:dropped"]);
    // Terminal: nothing is armed and no listener survives.
    expect(owner.listenerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(kinds(owner.events)).toStrictEqual(["closed:dropped"]);
  });

  it("R5: exhausting the consecutive-failure budget drops the lease", async () => {
    let attempt = 0;
    const service = makeService(
      () => {
        attempt += 1;
        if (attempt === 1) return Promise.resolve(answerFor(POOLS));
        return Promise.reject(
          siteFailure(DexScreenerSiteErrorCodes.TRANSPORT_FAILED),
        );
      },
      { maxConsecutiveFailures: 3 },
    );
    live = service;
    const owner = makeTarget(1);
    await subscribeTo(service, { target: owner.target, pools: POOLS });

    await vi.advanceTimersByTimeAsync(600_000);
    // Two degradations, then the third failure is terminal rather than a
    // fourth "reconnecting" a reader would keep believing.
    expect(kinds(owner.events)).toStrictEqual([
      "degraded",
      "degraded",
      "closed:dropped",
    ]);
  });

  it("R6: toggle-off aborts the in-flight cycle and drops its late result", async () => {
    let seenSignal: AbortSignal | null = null;
    const release: { fn: ((answer: BoardLiveBatchAnswer) => void) | null } = {
      fn: null,
    };
    let attempt = 0;
    const service = makeService((args) => {
      attempt += 1;
      if (attempt === 1) return Promise.resolve(answerFor(POOLS, 1_000));
      seenSignal = args.signal;
      return new Promise<BoardLiveBatchAnswer>((resolve) => {
        release.fn = resolve;
      });
    });
    live = service;
    const owner = makeTarget(1);
    const outcome = await subscribeTo(service, { target: owner.target, pools: POOLS });
    if (outcome.kind !== "subscribed") throw new Error("expected a lease");

    await vi.advanceTimersByTimeAsync(5_000); // attempt 2 is now in flight
    expect(seenSignal).not.toBeNull();
    expect((seenSignal as unknown as AbortSignal).aborted).toBe(false);

    // The scope this poll runs in is its own, so aborting kills nobody else's
    // socket. That is what makes an immediate abort SAFE here.
    expect(service.unsubscribe({ leaseId: outcome.leaseId, ownerId: 1 })).toBe(
      "closed",
    );
    expect((seenSignal as unknown as AbortSignal).aborted).toBe(true);
    expect(kinds(owner.events)).toStrictEqual(["closed:unsubscribed"]);

    // The late answer lands AFTER the close. It must publish nothing.
    release.fn?.(answerFor(POOLS, 9_999));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(kinds(owner.events)).toStrictEqual(["closed:unsubscribed"]);
  });

  it("R8: a destroyed, crashed or navigated-away window closes the lease", async () => {
    const service = makeService(() => Promise.resolve(answerFor(POOLS)));
    live = service;
    const owner = makeTarget(1);
    await subscribeTo(service, { target: owner.target, pools: POOLS });
    expect(owner.listenerCount()).toBe(1);

    owner.fireGone();
    expect(kinds(owner.events)).toStrictEqual(["closed:renderer-gone"]);
    // The listener is released with the lease: a closed lease leaves nothing
    // attached to a window that may still be alive.
    expect(owner.listenerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(kinds(owner.events)).toStrictEqual(["closed:renderer-gone"]);
  });

  it("R9: stop() closes every lease with shutdown and drains the in-flight cycle", async () => {
    const release: { fn: ((answer: BoardLiveBatchAnswer) => void) | null } = {
      fn: null,
    };
    let attempt = 0;
    const service = makeService(() => {
      attempt += 1;
      if (attempt === 1) return Promise.resolve(answerFor(POOLS));
      return new Promise<BoardLiveBatchAnswer>((resolve) => {
        release.fn = resolve;
      });
    });
    const owner = makeTarget(1);
    await subscribeTo(service, { target: owner.target, pools: POOLS });
    await vi.advanceTimersByTimeAsync(5_000);

    const stopping = service.stop();
    expect(kinds(owner.events)).toStrictEqual(["closed:shutdown"]);
    release.fn?.(answerFor(POOLS, 9_999));
    await stopping;

    // Drained, not abandoned, and the late answer published nothing.
    expect(kinds(owner.events)).toStrictEqual(["closed:shutdown"]);
    // Idempotent.
    await service.stop();
    // A subscribe after shutdown is refused honestly rather than starting a
    // poll into a process that is going away.
    const after = await subscribeTo(service, { target: owner.target, pools: POOLS });
    expect(after.kind).toBe("unsupported");
  });

  it("R10: no event ever follows a terminal one, and the generation is monotonic", async () => {
    const service = makeService(() => Promise.resolve(answerFor(POOLS)));
    live = service;
    const owner = makeTarget(1);
    const outcome = await subscribeTo(service, { target: owner.target, pools: POOLS });
    if (outcome.kind !== "subscribed") throw new Error("expected a lease");

    await vi.advanceTimersByTimeAsync(15_000);
    service.unsubscribe({ leaseId: outcome.leaseId, ownerId: 1 });
    await vi.advanceTimersByTimeAsync(60_000);

    const seen = kinds(owner.events);
    expect(seen[seen.length - 1]).toBe("closed:unsubscribed");
    expect(seen.filter((k) => k.startsWith("closed:"))).toHaveLength(1);

    const generations = owner.events.map((event) => event.generation);
    for (let i = 1; i < generations.length; i += 1) {
      expect(generations[i]).toBeGreaterThan(generations[i - 1] ?? -1);
    }
    // The subscribe response's own generation precedes every event.
    expect(generations[0]).toBeGreaterThan(outcome.generation - 1);
  });

  it.each([
    [
      "a missing identity",
      "incomplete",
      // The provider answered one of the two pools and said nothing about the
      // other. The adapter has nothing to repair; the counts simply do not
      // match.
      (): BoardLiveBatchAnswer =>
        answerFrom(POOLS, [providerRow("solana", "PairAAA")], 9_999),
    ],
    [
      "a live row for a pool this board never named",
      "incomplete",
      // MEASURED CLASS. A one-identity batch came back carrying a real, live
      // row for an entirely different pool. The adapter DROPS that row and
      // records it in `unrequested`, so the remaining answer covers exactly the
      // requested keys and reconciles clean unless the accounting is read.
      (): BoardLiveBatchAnswer =>
        answerFrom(
          POOLS,
          [
            ...POOLS.map((pool) => providerRow(pool.chain, pool.pairAddress)),
            providerRow("base", "PairCCC"),
          ],
          9_999,
        ),
    ],
    [
      "a second row for one identity, folded by the adapter",
      "incomplete",
      // The adapter keeps the FIRST row and records the fold in `collapsed`.
      // The surviving answer is a perfectly well-formed one-row-per-pool set,
      // which is why this case is invisible without the accounting.
      (): BoardLiveBatchAnswer =>
        answerFrom(
          POOLS,
          [
            ...POOLS.map((pool) => providerRow(pool.chain, pool.pairAddress)),
            providerRow("solana", "PairAAA", "2.50"),
          ],
          9_999,
        ),
    ],
    [
      "a row whose shape the projector cannot read",
      "provider",
      // F6. `projectBoardRow` delegates to the surface projector, which THROWS
      // on shape drift rather than returning nulls. Reconciliation itself is
      // clean here: both identities resolve, nothing is unrequested and nothing
      // collapsed. Before the projection was brought inside the classified
      // path, this throw escaped the state machine and left an active lease
      // with no next tick ever scheduled.
      (): BoardLiveBatchAnswer =>
        answerFrom(
          POOLS,
          POOLS.map((pool) => ({
            ...providerRow(pool.chain, pool.pairAddress),
            // A scalar where the projector reads a block.
            baseToken: "not-a-token-block",
          })),
          9_999,
        ),
    ],
  ])(
    "R15: rejects the WHOLE tick on %s, keeping last-good and its timestamp",
    async (_label, expectedReason, makeBad) => {
      let attempt = 0;
      const service = makeService(() => {
        attempt += 1;
        if (attempt === 1) return Promise.resolve(answerFor(POOLS, 1_000, "1.25"));
        return Promise.resolve(makeBad());
      });
      live = service;
      const owner = makeTarget(1);
      const outcome = await subscribeTo(service, {
        target: owner.target,
        pools: POOLS,
      });
      if (outcome.kind !== "subscribed") throw new Error("expected a lease");
      expect(outcome.snapshot.fetchedAtMs).toBe(1_000);

      await vi.advanceTimersByTimeAsync(5_000);

      // ZERO partial events. The only thing emitted is the degradation, and it
      // carries the COMPLETE previous set with its ORIGINAL timestamp: the age
      // on screen is the age of the figures, not of the failed attempt.
      expect(kinds(owner.events)).toStrictEqual(["degraded"]);
      const event = owner.events[0];
      if (event?.kind !== "degraded") throw new Error("expected degraded");
      expect(event.reason).toBe(expectedReason);
      expect(event.lastGood?.fetchedAtMs).toBe(1_000);
      expect(event.lastGood?.rows).toHaveLength(POOLS.length);
      expect(event.lastGood?.rows[0]?.row.priceUsd).toBe("1.25");

      // AND THE LEASE IS STILL RUNNING. A degradation that forgot to arm the
      // next attempt would leave a board frozen with an active lease and no
      // clock, which is exactly what an escaping projection throw used to do.
      await vi.advanceTimersByTimeAsync(600_000);
      expect(kinds(owner.events).length).toBeGreaterThan(1);
    },
  );

  it.each([
    [
      "a row the projector cannot read",
      (): BoardLiveBatchAnswer =>
        answerFrom(
          POOLS,
          POOLS.map((pool) => ({
            ...providerRow(pool.chain, pool.pairAddress),
            baseToken: "not-a-token-block",
          })),
        ),
    ],
    [
      "an answer that does not cover the board",
      (): BoardLiveBatchAnswer =>
        answerFrom(POOLS, [providerRow("solana", "PairAAA")]),
    ],
  ])(
    "F6: a FIRST answer of %s closes the lease instead of leaking it",
    async (_label, makeBad) => {
      const service = makeService(() => Promise.resolve(makeBad()));
      live = service;
      const owner = makeTarget(1);
      const outcome = await subscribeTo(service, {
        target: owner.target,
        pools: POOLS,
      });

      // A TYPED REFUSAL, with a sentence the reader can act on. Not a thrown
      // exception escaping the state machine, which is what an unguarded
      // projection produced.
      expect(outcome.kind).toBe("failed");
      if (outcome.kind !== "failed") throw new Error("expected a failure");
      expect(outcome.detail.length).toBeGreaterThan(0);

      // AND THE LEASE IS NOT LEAKED. The slot is free, nothing is left
      // listening on the window, and the terminal event was delivered.
      expect(kinds(owner.events)).toStrictEqual(["closed:dropped"]);
      expect(owner.listenerCount()).toBe(0);
      // The proof the registry is genuinely free: a fresh subscribe claims it
      // and is granted, which a lease stuck in `subscribing` would have
      // superseded instead.
      const next = await subscribeTo(service, {
        target: makeTarget(2).target,
        pools: POOLS,
      });
      expect(next.kind).toBe("failed");
      await vi.advanceTimersByTimeAsync(60_000);
      // No tick was ever scheduled for a lease that never became active.
      expect(kinds(owner.events)).toStrictEqual(["closed:dropped"]);
    },
  );

  it("R6-pre: a cancel by request id aborts the FIRST fetch before it answers", async () => {
    // The window this test is about: main mints the lease id but does not hand
    // it back until the first fetch settles, so for up to the attempt deadline
    // the renderer holds no handle from main at all. The request id is the one
    // name that exists on both sides from before the call.
    let seenSignal: AbortSignal | null = null;
    const release: { fn: ((answer: BoardLiveBatchAnswer) => void) | null } = {
      fn: null,
    };
    const service = makeService((args) => {
      seenSignal = args.signal;
      return new Promise<BoardLiveBatchAnswer>((resolve) => {
        release.fn = resolve;
      });
    });
    live = service;
    const owner = makeTarget(1);
    const mine = requestId(9_001);

    const pending = service.subscribe({
      target: owner.target,
      pools: POOLS,
      requestId: mine,
    });
    await Promise.resolve();
    const signal = seenSignal as AbortSignal | null;
    if (signal === null) throw new Error("expected the first fetch to start");
    expect(signal.aborted).toBe(false);

    // THE ASSERTION THAT MATTERS is on the underlying signal, not on eventual
    // cleanup: the exchange must end NOW, not run to its 20 s deadline for a
    // reader who has already gone.
    expect(service.unsubscribe({ requestId: mine, ownerId: 1 })).toBe("closed");
    expect(signal.aborted).toBe(true);
    expect(kinds(owner.events)).toStrictEqual(["closed:unsubscribed"]);

    // The subscribe still has to settle, and it must publish nothing.
    release.fn?.(answerFor(POOLS, 9_999));
    const outcome = await pending;
    expect(outcome.kind).not.toBe("subscribed");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(kinds(owner.events)).toStrictEqual(["closed:unsubscribed"]);
  });

  it("R3-pre: a request id is a handle, not a credential", async () => {
    // Held open, then released at the end: the point is the state DURING the
    // first fetch, and `stop()` now genuinely drains that attempt, so a promise
    // that never settled would hang this file's own teardown.
    const release: { fn: ((answer: BoardLiveBatchAnswer) => void) | null } = {
      fn: null,
    };
    const service = makeService(
      () =>
        new Promise<BoardLiveBatchAnswer>((resolve) => {
          release.fn = resolve;
        }),
    );
    live = service;
    const owner = makeTarget(1);
    const mine = requestId(9_002);
    void service.subscribe({
      target: owner.target,
      pools: POOLS,
      requestId: mine,
    });
    await Promise.resolve();

    // Another window naming this request id gets the same typed refusal it
    // would get for a lease id, and the lease is left running.
    expect(service.unsubscribe({ requestId: mine, ownerId: 2 })).toBe(
      "not-owner",
    );
    expect(owner.events).toStrictEqual([]);
    // An id nobody minted is simply unknown.
    expect(
      service.unsubscribe({ requestId: requestId(9_003), ownerId: 1 }),
    ).toBe("unknown");
    expect(owner.events).toStrictEqual([]);
    release.fn?.(answerFor(POOLS, 9_999));
  });

  it("R9-pre: stop() drains the FIRST fetch, not only a later poll", async () => {
    // The initial attempt is the one cycle no tick timer schedules, so it was
    // the one attempt shutdown could abandon in flight rather than drain.
    let settled = false;
    const release: { fn: ((answer: BoardLiveBatchAnswer) => void) | null } = {
      fn: null,
    };
    const service = makeService(
      () =>
        new Promise<BoardLiveBatchAnswer>((resolve) => {
          release.fn = (answer): void => {
            settled = true;
            resolve(answer);
          };
        }),
    );
    const owner = makeTarget(1);
    const pending = service.subscribe({
      target: owner.target,
      pools: POOLS,
      requestId: requestId(9_004),
    });
    await Promise.resolve();

    const stopping = service.stop();
    expect(kinds(owner.events)).toStrictEqual(["closed:shutdown"]);
    expect(settled).toBe(false);

    let stopResolved = false;
    void stopping.then(() => {
      stopResolved = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    // Ordering, not timing: stop() cannot be finished while the attempt it is
    // supposed to be draining has not settled.
    expect(stopResolved).toBe(false);

    release.fn?.(answerFor(POOLS, 9_999));
    await stopping;
    expect(settled).toBe(true);
    await pending;
    expect(kinds(owner.events)).toStrictEqual(["closed:shutdown"]);
  });

  it("R11: reports live unsupported without a bridge, and refuses subscribe by name", async () => {
    const service = makeService(() => Promise.resolve(answerFor(POOLS)), {
      isSupported: () => false,
    });
    live = service;
    const capability = service.capability();
    expect(capability.supported).toBe(false);
    expect(capability.detail).not.toBeNull();

    const owner = makeTarget(1);
    const outcome = await subscribeTo(service, { target: owner.target, pools: POOLS });
    expect(outcome.kind).toBe("unsupported");
    // Nothing was claimed, so nothing has to be released.
    expect(owner.listenerCount()).toBe(0);
    expect(owner.events).toStrictEqual([]);
  });

  it("polls one non-overlapping cycle per interval, measured from the previous settle", async () => {
    const started: number[] = [];
    let elapsed = 0;
    const release: { fn: ((answer: BoardLiveBatchAnswer) => void) | null } = {
      fn: null,
    };
    const service = makeService(() => {
      started.push(elapsed);
      if (started.length === 1) return Promise.resolve(answerFor(POOLS));
      return new Promise<BoardLiveBatchAnswer>((resolve) => {
        release.fn = resolve;
      });
    });
    live = service;
    const owner = makeTarget(1);
    await subscribeTo(service, { target: owner.target, pools: POOLS });

    await vi.advanceTimersByTimeAsync(5_000);
    elapsed += 5_000;
    expect(started).toHaveLength(2);

    // The second cycle is still open. A fixed interval would fire a third here;
    // a settle-scheduled one does not, which is the whole non-overlap contract.
    await vi.advanceTimersByTimeAsync(30_000);
    elapsed += 30_000;
    expect(started).toHaveLength(2);

    release.fn?.(answerFor(POOLS, 2_000));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(started).toHaveLength(3);

    // The third cycle is open; release it so `stop()` has something finite to
    // drain rather than blocking on a promise this test owns.
    release.fn?.(answerFor(POOLS, 3_000));
  });

  it("runs its poll in a lease-owned coalescence scope", async () => {
    const scopes: string[] = [];
    const service = makeService((args) => {
      scopes.push(args.coalesceScope);
      return Promise.resolve(answerFor(POOLS));
    });
    live = service;
    const owner = makeTarget(1);
    const outcome = await subscribeTo(service, { target: owner.target, pools: POOLS });
    if (outcome.kind !== "subscribed") throw new Error("expected a lease");

    await vi.advanceTimersByTimeAsync(5_000);
    expect(scopes.length).toBeGreaterThan(1);
    for (const scope of scopes) {
      expect(scope).toBe(`board-live:${outcome.leaseId}`);
    }
  });
});
