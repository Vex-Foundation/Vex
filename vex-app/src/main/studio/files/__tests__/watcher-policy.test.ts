/**
 * THE WATCHER'S POLICY, driven through an injected native watcher.
 *
 * The native layer is faked here and ONLY here, because the subject of these
 * tests is not whether inotify works - the real-filesystem suite proves that -
 * but what this class DOES when the OS behaves in ways a temporary directory
 * cannot be made to reproduce on demand: an ENOSPC, five consecutive failures,
 * a root that vanishes and returns. A fake is the only way to establish those
 * states deterministically, and every product decision under test (never
 * restart on an exhausted limit, cap at five, stop before restart, bump the
 * generation, signal overflow) lives in this module rather than in the OS.
 *
 * Timers are faked. A test that proved a 800 ms restart delay by sleeping
 * 800 ms would be slow AND would still not prove the delay - only that the
 * restart had happened by then.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FILES_PENDING_CHANGES_MAX,
  FILES_WATCHER_MAX_RESTARTS,
} from "@shared/schemas/files.js";

import {
  ProjectFileWatcher,
  classifyWatcherFailure,
  resetFileWatcherLogOnceForTests,
  type NativeEvent,
  type WatcherEmission,
} from "../watcher.js";

const ROOT = "/tmp/vex-fake-project";

interface Harness {
  readonly watcher: ProjectFileWatcher;
  readonly emissions: WatcherEmission[];
  readonly subscribeCalls: () => number;
  readonly unsubscribeCalls: () => number;
  /** Deliver events as the native layer would, through the LATEST callback. */
  readonly deliver: (events: NativeEvent[]) => void;
  /**
   * Deliver through the callback the Nth `subscribe` was given.
   *
   * A separate accessor because `deliver` reads the CURRENT callback: using it
   * to test the superseded-generation guard would deliver through the live
   * subscription and prove nothing.
   */
  readonly deliverVia: (index: number, events: NativeEvent[]) => void;
  /** Deliver a failure as the native layer would. */
  readonly fail: (error: Error) => void;
  readonly appearRoot: () => void;
  readonly setRootExists: (exists: boolean) => void;
}

function harness(options: {
  readonly subscribeRejectsWith?: () => Error | null;
} = {}): Harness {
  const emissions: WatcherEmission[] = [];
  let subscribeCalls = 0;
  let unsubscribeCalls = 0;
  let exists = true;
  const callbacks: Array<(error: Error | null, events: NativeEvent[]) => void> = [];
  let onAppeared: (() => void) | null = null;
  const watcher = new ProjectFileWatcher({
    projectId: "project-1",
    realRoot: ROOT,
    ignore: [],
    subscribeNative: (_directory, callback) => {
      subscribeCalls += 1;
      const rejection = options.subscribeRejectsWith?.() ?? null;
      if (rejection !== null) return Promise.reject(rejection);
      callbacks.push(callback);
      return Promise.resolve({
        unsubscribe: () => {
          unsubscribeCalls += 1;
          return Promise.resolve();
        },
      });
    },
    pollForRoot: (_directory, appeared) => {
      onAppeared = appeared;
      return () => {
        onAppeared = null;
      };
    },
    rootExists: () => Promise.resolve(exists),
    emit: (emission) => {
      emissions.push(emission);
    },
  });

  return {
    watcher,
    emissions,
    subscribeCalls: () => subscribeCalls,
    unsubscribeCalls: () => unsubscribeCalls,
    deliver: (events) => {
      callbacks.at(-1)?.(null, events);
    },
    deliverVia: (index, events) => {
      callbacks[index]?.(null, events);
    },
    fail: (error) => {
      callbacks.at(-1)?.(error, []);
    },
    appearRoot: () => {
      exists = true;
      onAppeared?.();
    },
    setRootExists: (value) => {
      exists = value;
    },
  };
}

function statuses(emissions: readonly WatcherEmission[]): Array<{
  state: string;
  reason: string;
  warnings: readonly string[];
}> {
  return emissions
    .filter((e) => e.payload.kind === "status")
    .map((e) => {
      const payload = e.payload as Extract<
        WatcherEmission["payload"],
        { kind: "status" }
      >;
      return {
        state: payload.state,
        reason: payload.reason,
        warnings: payload.warnings,
      };
    });
}

function batches(emissions: readonly WatcherEmission[]): Array<{
  generation: number;
  batchSeq: number;
  paths: string[];
  overflowed: boolean;
  droppedCount: number;
}> {
  return emissions
    .filter((e) => e.payload.kind === "changed")
    .map((e) => {
      const payload = e.payload as Extract<
        WatcherEmission["payload"],
        { kind: "changed" }
      >;
      return {
        generation: e.generation,
        batchSeq: payload.batchSeq,
        paths: payload.changes.map((c) => c.path),
        overflowed: payload.overflowed,
        droppedCount: payload.droppedCount,
      };
    });
}

beforeEach(() => {
  resetFileWatcherLogOnceForTests();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("classifying a native watcher failure", () => {
  it.each([
    ["an ENOSPC code", { code: "ENOSPC" }, "os_watch_limit"],
    ["an EMFILE code", { code: "EMFILE" }, "os_file_limit"],
    ["an ENFILE code", { code: "ENFILE" }, "os_file_limit"],
    ["an ENOENT code", { code: "ENOENT" }, "root_missing"],
    ["something else", { code: "EIO" }, "io_error"],
  ])("classifies %s", (_label, shape, expected) => {
    expect(classifyWatcherFailure(Object.assign(new Error("x"), shape))).toBe(expected);
  });

  it("falls back to the MESSAGE when the backend attaches no code", () => {
    // Probed against @parcel/watcher 2.6.0: its inotify backend rejects with an
    // Error carrying NO `code` at all. A classifier that trusted `code` alone
    // would call an exhausted limit an ordinary failure and restart into it.
    expect(classifyWatcherFailure(new Error("inotify_add_watch: ENOSPC"))).toBe(
      "os_watch_limit",
    );
    expect(classifyWatcherFailure(new Error("Bad file descriptor"))).toBe("io_error");
  });
});

describe("the watcher's restart policy", () => {
  it("NEVER restarts on an exhausted OS watch limit, and says so durably", async () => {
    const h = harness();
    await h.watcher.start();
    h.fail(Object.assign(new Error("no space"), { code: "ENOSPC" }));
    await vi.advanceTimersByTimeAsync(10_000);

    expect(h.subscribeCalls()).toBe(1);
    expect(h.watcher.currentState).toBe("unavailable");
    // STICKY: the fact outlives the moment, because a fact that lives only in a
    // log the user will never open is a fact the product does not have.
    expect(h.watcher.currentWarnings).toEqual(["os_watch_limit_reached"]);
    expect(statuses(h.emissions).at(-1)).toEqual({
      state: "unavailable",
      reason: "os_watch_limit",
      warnings: ["os_watch_limit_reached"],
    });
  });

  it("NEVER restarts on an exhausted file-descriptor limit", async () => {
    const h = harness();
    await h.watcher.start();
    h.fail(Object.assign(new Error("too many files"), { code: "EMFILE" }));
    await vi.advanceTimersByTimeAsync(10_000);

    expect(h.subscribeCalls()).toBe(1);
    expect(h.watcher.currentWarnings).toEqual(["os_file_limit_reached"]);
  });

  it("restarts an ordinary failure, STOPPING BEFORE IT STARTS AGAIN", async () => {
    const h = harness();
    await h.watcher.start();
    expect(h.subscribeCalls()).toBe(1);

    h.fail(Object.assign(new Error("transient"), { code: "EIO" }));
    // The old subscription is released before the delay even elapses; the new
    // one is created only after it. The process never holds two recursive
    // watches of one tree.
    await vi.advanceTimersByTimeAsync(0);
    expect(h.unsubscribeCalls()).toBe(1);
    expect(h.subscribeCalls()).toBe(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.subscribeCalls()).toBe(2);
    expect(h.watcher.currentState).toBe("watching");
    // A restart is a moment where changes provably happened that no batch
    // carried, so the consumer is told to re-list.
    expect(
      h.emissions.some(
        (e) => e.payload.kind === "resync" && e.payload.reason === "watcher_restarted",
      ),
    ).toBe(true);
  });

  it("GIVES UP after the cap, rather than restarting forever", async () => {
    const h = harness();
    await h.watcher.start();

    for (let attempt = 0; attempt <= FILES_WATCHER_MAX_RESTARTS; attempt += 1) {
      h.fail(Object.assign(new Error("transient"), { code: "EIO" }));
      await vi.advanceTimersByTimeAsync(1_000);
    }

    // One original subscribe plus exactly the capped number of restarts.
    expect(h.subscribeCalls()).toBe(FILES_WATCHER_MAX_RESTARTS + 1);
    expect(h.watcher.currentState).toBe("unavailable");
    expect(h.watcher.currentWarnings).toEqual(["restart_cap_reached"]);
  });

  /*
   * A TERMINAL FAILURE IS TERMINAL FOR THE LIFE OF THIS WATCHER INSTANCE.
   *
   * This matters because `start()` is called by EVERY subscriber that joins a
   * project's entry, and every file the user opens is another subscription on
   * the same instance. A `start()` that re-ran `subscribeNow` after the cap or
   * an ENOSPC would issue a fresh recursive subscribe of the whole tree per
   * file open - unbounded work, asking the kernel for exactly the resource it
   * had just refused. The recovery path is a NEW instance: the domain disposes
   * a project's watcher when its last subscriber leaves, and the next first
   * subscription gets a fresh watcher with a fresh restart budget.
   */
  it("does NOT subscribe again on a start() after the restart cap", async () => {
    const h = harness();
    await h.watcher.start();

    for (let attempt = 0; attempt <= FILES_WATCHER_MAX_RESTARTS; attempt += 1) {
      h.fail(Object.assign(new Error("transient"), { code: "EIO" }));
      await vi.advanceTimersByTimeAsync(1_000);
    }
    const capped = h.subscribeCalls();
    expect(capped).toBe(FILES_WATCHER_MAX_RESTARTS + 1);

    await h.watcher.start();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(h.subscribeCalls()).toBe(capped);
    expect(h.watcher.currentState).toBe("unavailable");
    expect(h.watcher.currentWarnings).toEqual(["restart_cap_reached"]);
  });

  it("does NOT subscribe again on a start() after an ENOSPC", async () => {
    const h = harness();
    await h.watcher.start();
    h.fail(Object.assign(new Error("no space"), { code: "ENOSPC" }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.subscribeCalls()).toBe(1);

    await h.watcher.start();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(h.subscribeCalls()).toBe(1);
    expect(h.watcher.currentState).toBe("unavailable");
    expect(h.watcher.currentWarnings).toEqual(["os_watch_limit_reached"]);
  });

  it("BUMPS THE GENERATION on a restart and resets batchSeq", async () => {
    const h = harness();
    await h.watcher.start();

    h.deliver([{ path: `${ROOT}/a.txt`, type: "create" }]);
    await vi.advanceTimersByTimeAsync(1_000);
    const before = batches(h.emissions);
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ generation: 0, batchSeq: 0 });

    h.fail(Object.assign(new Error("transient"), { code: "EIO" }));
    await vi.advanceTimersByTimeAsync(2_000);

    h.deliver([{ path: `${ROOT}/b.txt`, type: "create" }]);
    await vi.advanceTimersByTimeAsync(1_000);
    const after = batches(h.emissions).at(-1);
    expect(after).toMatchObject({ generation: 1, batchSeq: 0, paths: ["b.txt"] });
  });

  it("IGNORES a callback from a superseded subscription", async () => {
    const h = harness();
    await h.watcher.start();

    h.fail(Object.assign(new Error("transient"), { code: "EIO" }));
    await vi.advanceTimersByTimeAsync(2_000);

    // The callback the FIRST subscription was given, invoked after its
    // generation was superseded. It describes a tree that no longer exists.
    h.deliverVia(0, [{ path: `${ROOT}/ghost.txt`, type: "create" }]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(batches(h.emissions)).toHaveLength(0);
  });
});

describe("batching and overflow", () => {
  it("issues MONOTONIC batchSeq within one generation", async () => {
    const h = harness();
    await h.watcher.start();

    for (let index = 0; index < 3; index += 1) {
      h.deliver([{ path: `${ROOT}/f${String(index)}.txt`, type: "create" }]);
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(batches(h.emissions).map((b) => b.batchSeq)).toEqual([0, 1, 2]);
  });

  it("SIGNALS overflow with a count rather than dropping in silence", async () => {
    const h = harness();
    await h.watcher.start();

    const flood: NativeEvent[] = Array.from(
      { length: FILES_PENDING_CHANGES_MAX + 25 },
      (_, index) => ({ path: `${ROOT}/f${String(index)}.txt`, type: "create" }),
    );
    h.deliver(flood);
    await vi.advanceTimersByTimeAsync(1_000);

    const first = batches(h.emissions)[0];
    expect(first?.overflowed).toBe(true);
    expect(first?.droppedCount).toBe(25);
    // ...and the consumer is additionally told to re-list, which is the only
    // remedy for a change it will never receive.
    expect(
      h.emissions.some(
        (e) => e.payload.kind === "resync" && e.payload.reason === "overflow",
      ),
    ).toBe(true);
  });

  it("splits a large burst into BOUNDED batches instead of one huge message", async () => {
    const h = harness();
    await h.watcher.start();

    h.deliver(
      Array.from({ length: 1_200 }, (_, index) => ({
        path: `${ROOT}/f${String(index)}.txt`,
        type: "create" as const,
      })),
    );
    await vi.advanceTimersByTimeAsync(5_000);

    const emitted = batches(h.emissions);
    expect(emitted.every((b) => b.paths.length <= 500)).toBe(true);
    expect(emitted.reduce((sum, b) => sum + b.paths.length, 0)).toBe(1_200);
    expect(emitted.map((b) => b.batchSeq)).toEqual([0, 1, 2]);
  });

  it("DROPS an event that does not map inside the project", async () => {
    const h = harness();
    await h.watcher.start();
    h.deliver([{ path: "/etc/passwd", type: "update" }]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(batches(h.emissions)).toHaveLength(0);
  });
});

describe("a vanished root", () => {
  it("SUSPENDS rather than restarting, then RESUMES with a synthetic ADDED", async () => {
    const h = harness();
    await h.watcher.start();
    expect(h.subscribeCalls()).toBe(1);

    // The live vanish signal, probed against @parcel/watcher 2.6.0: removing a
    // watched directory emits a `delete` for the ROOT ITSELF and no error.
    h.setRootExists(false);
    h.deliver([{ path: ROOT, type: "delete" }]);
    await vi.advanceTimersByTimeAsync(100);

    expect(h.watcher.currentState).toBe("suspended");
    expect(statuses(h.emissions).at(-1)).toMatchObject({
      state: "suspended",
      reason: "root_missing",
    });
    // NOT a restart: the subscribe count has not moved.
    expect(h.subscribeCalls()).toBe(1);

    h.appearRoot();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(h.subscribeCalls()).toBe(2);
    expect(h.watcher.currentState).toBe("watching");
    expect(
      h.emissions.some(
        (e) => e.payload.kind === "resync" && e.payload.reason === "root_resumed",
      ),
    ).toBe(true);
    // THE SYNTHETIC ADDED for the root. Without it a consumer that watched the
    // root vanish receives nothing when it returns and keeps showing an empty
    // tree over a populated directory.
    const resumed = batches(h.emissions).at(-1);
    expect(resumed).toMatchObject({ generation: 2, batchSeq: 0, paths: [""] });
  });

  it("SUSPENDS instead of starting when the root is absent at start", async () => {
    const h = harness();
    h.setRootExists(false);
    await h.watcher.start();
    expect(h.subscribeCalls()).toBe(0);
    expect(h.watcher.currentState).toBe("suspended");
  });

  it("DISCARDS pending changes for a tree that has just vanished", async () => {
    const h = harness();
    await h.watcher.start();
    h.deliver([{ path: `${ROOT}/a.txt`, type: "create" }]);
    // Vanish BEFORE the aggregation window closes.
    h.setRootExists(false);
    h.deliver([{ path: ROOT, type: "delete" }]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(batches(h.emissions)).toHaveLength(0);
  });
});

describe("teardown", () => {
  it("is idempotent and releases the native subscription exactly once", async () => {
    const h = harness();
    await h.watcher.start();
    await h.watcher.dispose();
    await h.watcher.dispose();
    expect(h.unsubscribeCalls()).toBe(1);
  });

  it("emits NOTHING after dispose, even from a callback already in flight", async () => {
    const h = harness();
    await h.watcher.start();
    const before = h.emissions.length;
    await h.watcher.dispose();
    h.deliver([{ path: `${ROOT}/late.txt`, type: "create" }]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.emissions.length).toBe(before);
  });

  it("joins two concurrent starts into ONE native subscription", async () => {
    const h = harness();
    await Promise.all([h.watcher.start(), h.watcher.start()]);
    expect(h.subscribeCalls()).toBe(1);
  });
});
