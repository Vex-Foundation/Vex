/**
 * THE JOIN WINDOW: what happens to an entry while somebody is still joining it.
 *
 * `FilesDomain.entryFor` registers a project's entry and only THEN awaits the
 * native subscribe, which takes milliseconds. For the whole of that await the
 * entry carries ZERO subscriptions, because `watchFile` publishes its own only
 * after `entryFor` returns. Three things can remove the entry in that window -
 * a `collect` triggered by another window's release or another subscriber's
 * `unwatchFile`, a project delete, and app shutdown - and every one of them
 * used to leave `watchFile` returning `ok: true` with a subscription id that no
 * `unwatchFile` would ever find and that no event would ever reach.
 *
 * These are the four interleavings, driven through a FAKE native layer whose
 * `subscribe` resolves exactly when this file says so. That is the only way to
 * hold the window open deterministically: a real @parcel/watcher subscribe
 * returns when it returns, and a test that raced it would pass or fail by
 * machine speed. Everything else is real - the real lifecycle gate, real
 * leases, a real temporary directory, the real containment walk - because the
 * subject is the DOMAIN's ownership, not the operating system's.
 */

import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FILES_EVENTS_OUTSTANDING_MAX,
  FILES_SUBSCRIPTIONS_PER_WINDOW_MAX,
  type FilesEvent,
} from "@shared/schemas/files.js";

import {
  closeProjectAdmission,
  closeProjectResources,
  drainProjectLeases,
  heldProjectLeases,
  resetProjectLifecycleGateForTests,
} from "../../project-lifecycle-gate.js";
import { FilesDomain } from "../files-domain.js";
import {
  invalidateProjectNodes,
  projectNodeEpoch,
  resetFileNodeEpochsForTests,
} from "../node-id.js";
import type { NativeEvent, NativeSubscribe } from "../watcher.js";

const PROJECT = "11111111-2222-3333-4444-555555555555";
const WINDOW_A = "1";
const WINDOW_B = "2";
const WINDOW_C = "3";

/** A promise this file resolves by hand. */
interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (cause: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (cause: Error) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Native {
  readonly subscribe: NativeSubscribe;
  /** One deferred per `subscribe` call, in call order. */
  readonly gates: Array<Deferred<void>>;
  /** How many times the native layer was asked to subscribe. */
  readonly calls: () => number;
  /** Deliver events through the callback the Nth subscribe was given. */
  readonly deliver: (index: number, events: NativeEvent[]) => void;
  /** Make the Nth subscribe REJECT instead of resolving. */
  readonly failures: Set<number>;
  readonly unsubscribes: () => number;
  /**
   * Run at the START of every `unsubscribe`, before it resolves.
   *
   * The seam for asserting what the DOMAIN has already done by the time it
   * disposes a watcher - which is the only way to observe an ordering inside
   * `closeProject` from outside it.
   */
  beforeUnsubscribe: (() => void) | null;
}

/**
 * A native layer that answers only when told to.
 *
 * `gates[n]` is the promise the (n+1)th `subscribe` waits on, so a test can
 * open the join window, run whatever it wants to interleave, and then close it.
 */
function nativeLayer(): Native {
  const gates: Array<Deferred<void>> = [];
  const callbacks: Array<(error: Error | null, events: NativeEvent[]) => void> = [];
  const failures = new Set<number>();
  let unsubscribes = 0;
  let calls = 0;

  const subscribe: NativeSubscribe = async (_directory, callback) => {
    const index = calls;
    calls += 1;
    const gate = deferred<void>();
    gates[index] = gate;
    await gate.promise;
    if (failures.has(index)) {
      throw Object.assign(new Error("transient"), { code: "EIO" });
    }
    callbacks[index] = callback;
    return {
      unsubscribe: () => {
        layer.beforeUnsubscribe?.();
        unsubscribes += 1;
        return Promise.resolve();
      },
    };
  };

  const layer: Native = {
    subscribe,
    gates,
    failures,
    beforeUnsubscribe: null,
    calls: () => calls,
    unsubscribes: () => unsubscribes,
    deliver: (index, events) => {
      callbacks[index]?.(null, events);
    },
  };
  return layer;
}

/** Wait for a condition the domain reaches on its own microtask schedule. */
async function until(what: string, predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

let root = "";
let domain: FilesDomain;
let native: Native;
let events: Array<{ windowId: string; event: FilesEvent }> = [];
let disposed = false;

beforeEach(async () => {
  resetProjectLifecycleGateForTests();
  resetFileNodeEpochsForTests();
  events = [];
  disposed = false;
  native = nativeLayer();
  // REALPATH: every containment check in this feature compares against the
  // place the directory actually is, and on macOS `os.tmpdir()` is a symlink.
  root = await realpath(await mkdtemp(path.join(tmpdir(), "vex-files-race-")));
  domain = new FilesDomain({
    // The ANCHOR and the directory, as production supplies them: the projects
    // root is the realpath'd parent, and the project directory is the lexical
    // join beneath it, unresolved. `realProjectDirectory` proves the pair.
    resolveProjectDirectory: (projectId) =>
      Promise.resolve(
        projectId === PROJECT
          ? { anchoredRoot: path.dirname(root), projectDirectory: root }
          : null,
      ),
    subscribeNative: native.subscribe,
    pollForRoot: () => () => undefined,
    rootExists: () => Promise.resolve(true),
    publish: (windowId, event) => {
      events.push({ windowId, event });
    },
  });
});

afterEach(async () => {
  if (!disposed) await domain.dispose();
  await rm(root, { recursive: true, force: true });
});

/** Start a whole-tree watch without awaiting it, and open its native gate. */
function beginWatch(windowId: string): Promise<
  Awaited<ReturnType<FilesDomain["watchFile"]>>
> {
  return domain.watchFile(windowId, { projectId: PROJECT, nodeId: null });
}

describe("an entry that somebody is still joining is not garbage", () => {
  it("SURVIVES another window's release while its first watch is in flight", async () => {
    const watching = beginWatch(WINDOW_A);
    await until("the native subscribe to be requested", () => native.calls() === 1);

    // Window B closes. `releaseWindow` walks EVERY entry and collects the ones
    // with no subscriptions - which, mid-join, is the entry window A is in the
    // middle of creating. Its reap decision is taken synchronously, here, while
    // the native subscribe is still open; the gate is released before the
    // release is awaited only because a reap that DID happen would then block
    // on disposing the very subscribe it is racing.
    const releasing = domain.releaseWindow(WINDOW_B);
    native.gates[0]?.resolve();
    await releasing;

    const outcome = await watching;
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(domain.watchedProjectCount).toBe(1);
    expect(heldProjectLeases(PROJECT, "watcher")).toBe(1);

    // ...and the subscription is LIVE, not an orphan: a change delivered
    // through the native layer reaches it.
    native.deliver(0, [{ path: path.join(root, "a.txt"), type: "create" }]);
    await until(
      "the change to reach window A's subscription",
      () =>
        events.some(
          (entry) =>
            entry.windowId === WINDOW_A
            && entry.event.kind === "changed"
            && entry.event.subscriptionId === outcome.value.subscriptionId
            && entry.event.changes.some((change) => change.path === "a.txt"),
        ),
    );
  });

  it("SURVIVES the last other subscriber leaving while a JOINER is in flight", async () => {
    /*
     * THE LEVER, stated because it is the only non-obvious thing here.
     *
     * A joiner onto an entry whose watcher is already `watching` never touches
     * the OS - `start()` returns early - so there would be no window to test.
     * This test therefore makes the FIRST native subscribe FAIL with an
     * ordinary EIO: window A still gets a real subscription (the watcher's
     * honest state rides the result), but the watcher is left `unavailable`
     * rather than watching, so the next joiner really does call `subscribeNow`
     * and really does await the native layer. That is where window C sits when
     * window A - the last other subscriber - lets go.
     */
    native.failures.add(0);
    const first = beginWatch(WINDOW_A);
    await until("the first native subscribe", () => native.calls() === 1);
    native.gates[0]?.resolve();
    const a = await first;
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.value.state).toBe("unavailable");

    const joining = beginWatch(WINDOW_C);
    await until("the joiner's native subscribe", () => native.calls() === 2);

    // A lets go while C is mid-join. Without the join reservation this reaps
    // the entry, disposes the watcher and releases the lease under C.
    const releasing = domain.unwatchFile(WINDOW_A, a.value.subscriptionId);
    native.gates[1]?.resolve();
    expect(await releasing).toEqual({ ok: true, value: null });

    const c = await joining;
    expect(c.ok).toBe(true);
    if (!c.ok) return;

    expect(domain.watchedProjectCount).toBe(1);
    expect(heldProjectLeases(PROJECT, "watcher")).toBe(1);
    // C's subscription is the real one on the surviving entry: releasing it is
    // what finally collects the project.
    expect(await domain.unwatchFile(WINDOW_C, c.value.subscriptionId)).toEqual({
      ok: true,
      value: null,
    });
    expect(domain.watchedProjectCount).toBe(0);
    expect(heldProjectLeases(PROJECT, "watcher")).toBe(0);
  });
});

describe("the publication fence", () => {
  it("REFUSES with project_closed when the project is deleted mid-join", async () => {
    const watching = beginWatch(WINDOW_A);
    await until("the native subscribe to be requested", () => native.calls() === 1);

    // The lifecycle gate's close hook, exactly as a committed tombstone runs
    // it. It removes and disposes the entry under the in-flight watch.
    const closing = closeProjectResources(PROJECT);
    native.gates[0]?.resolve();
    await closing;

    const outcome = await watching;
    expect(outcome).toEqual({ ok: false, code: "project_closed" });
    expect(domain.watchedProjectCount).toBe(0);
    expect(heldProjectLeases(PROJECT, "watcher")).toBe(0);
    // No subscription was published, so there is nothing to release.
    expect(await domain.unwatchFile(WINDOW_A, "any-subscription-id")).toEqual({
      ok: false,
      code: "unknown_subscription",
    });
  });

  it("REFUSES with watcher_unavailable when the domain disposes mid-join", async () => {
    const watching = beginWatch(WINDOW_A);
    await until("the native subscribe to be requested", () => native.calls() === 1);

    const disposing = domain.dispose();
    disposed = true;
    native.gates[0]?.resolve();
    await disposing;

    expect(await watching).toEqual({ ok: false, code: "watcher_unavailable" });
    expect(domain.watchedProjectCount).toBe(0);
    expect(heldProjectLeases(PROJECT, "watcher")).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * The other party to the fence: the WINDOW that asked
 * ------------------------------------------------------------------ */

describe("a window that goes away while its own watch is in flight", () => {
  it("PUBLISHES NOTHING, and leaves no subscription and no lease behind", async () => {
    // The publication fence checked that the ENTRY was still the live one, and
    // that is only half of it. `releaseWindow` walks SETTLED subscriptions, and
    // during a native subscribe this window owns none - so the release removed
    // nothing, the acquisition then published a subscription for a window that
    // is already gone, and the result was an orphan holding a native OS watch
    // that no `unwatchFile` will ever arrive for.
    const watching = beginWatch(WINDOW_A);
    await until("the native subscribe to be requested", () => native.calls() === 1);

    // The window closes - or its renderer crashed - mid-acquisition.
    await domain.releaseWindow(WINDOW_A);

    native.gates[0]?.resolve();
    const outcome = await watching;

    expect(outcome).toEqual({ ok: false, code: "watcher_unavailable" });
    // The entry was collected because nothing is joining it and nothing holds
    // it, so no native watch and no lease are left for a dead window.
    expect(domain.watchedProjectCount).toBe(0);
    expect(heldProjectLeases(PROJECT, "watcher")).toBe(0);
    expect(native.unsubscribes()).toBe(1);
  });

  it("does NOT refuse a DIFFERENT window's watch that was in flight at the same time", async () => {
    // The invalidation is per window. A release must not cancel a watch some
    // other window is legitimately waiting on, and it must not reap the entry
    // that watch is joining.
    //
    // THE ORDER MATTERS, AND IT IS THE SURVIVING WINDOW THAT GOES FIRST. B
    // opens the entry and parks inside the native subscribe, which
    // `native.calls() === 1` proves it has reached; from that moment until B
    // publishes, B holds the entry's join reservation, so no interleaving of A
    // can leave the entry collectable. Starting A first and waiting on the same
    // signal would prove only that A is parked - A's gate says nothing about
    // where B is - and on a slow machine B could still be inside `locate`'s
    // real filesystem work when the release lands, in which case A's refusal
    // legitimately collects the entry and B builds a SECOND watcher behind a
    // gate this test never opens. That is what timed the win32 lane out on run
    // 33602264566: the test's ordering hole, not the domain's fence.
    const forB = beginWatch(WINDOW_B);
    await until("the native subscribe to be requested", () => native.calls() === 1);

    // A asks for the same project, then goes away mid-acquisition.
    const forA = beginWatch(WINDOW_A);
    await domain.releaseWindow(WINDOW_A);
    native.gates[0]?.resolve();

    // B FIRST, because B being served is the headline invariant AND because a
    // regression that refuses B strands A behind a second native gate nothing
    // opens: awaiting A first would report that regression as a 15 s timeout
    // instead of as the one-line assertion it is.
    expect((await forB).ok).toBe(true);
    // A's CODE is the proof of the interleaving, not merely of the outcome:
    // `watcher_unavailable` is minted only by the publication fence, which A
    // reaches only after `entryFor` handed it the same LIVE entry. Had the
    // release reaped that entry, A's refusal would read `project_closed`.
    expect(await forA).toEqual({ ok: false, code: "watcher_unavailable" });
    expect(domain.watchedProjectCount).toBe(1);
    // ONE native watch, ever, and it is still held. A second subscribe would
    // mean the release reaped the entry B was joining and B had to start the
    // operating system over, which is the defect this test owns.
    expect(native.calls()).toBe(1);
    expect(native.unsubscribes()).toBe(0);
  });
});

describe("the per-window subscription bound", () => {
  it("REFUSES past FILES_SUBSCRIPTIONS_PER_WINDOW_MAX rather than fanning out forever", async () => {
    // Every native event fans out to EVERY subscription, so an unbounded count
    // turns one `git checkout` into work a renderer chose the size of.
    // The first watch is the only one that reaches the OS; every later one
    // joins the same watcher, which is the whole point of a refcounted watch.
    const first = beginWatch(WINDOW_A);
    await until("the native subscribe to be requested", () => native.calls() === 1);
    native.gates[0]?.resolve();
    expect((await first).ok).toBe(true);

    for (let index = 1; index < FILES_SUBSCRIPTIONS_PER_WINDOW_MAX; index += 1) {
      expect((await beginWatch(WINDOW_A)).ok).toBe(true);
    }

    // At the bound: refused by name, and nothing already held is evicted.
    expect(await beginWatch(WINDOW_A)).toEqual({ ok: false, code: "subscription_limit" });
    expect(domain.watchedProjectCount).toBe(1);

    // ...and the bound is PER WINDOW, so another window is unaffected.
    expect((await beginWatch(WINDOW_C)).ok).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * The fence at PUBLICATION, on its own
 * ------------------------------------------------------------------ */

describe("a read that is still working when the project closes underneath it", () => {
  it("REFUSES at publication, not having noticed anything at the start", async () => {
    // The e2e in the Postgres lane proves a parked listing is refused, but it
    // cannot say WHICH fence refused it: `locate` re-checks the epoch straight
    // after the authority read, and either fence alone is enough to catch a
    // request parked THERE. Reverting either one on its own leaves that test
    // green. So this is the case that isolates the second one - a close that
    // lands after `locate` has already finished checking, while the request is
    // inside its filesystem work, which only a fence at PUBLICATION can catch.
    //
    // The seam is the dependency contract itself. `locate` reads
    // `projectDirectory` off the returned location AFTER its own epoch check,
    // so a getter there fires in exactly the window being modelled: authority
    // said ACTIVE, the start-of-request check passed, and the delete commits
    // while the listing is being built.
    let closedDuringTheWork = false;
    const racing = new FilesDomain({
      resolveProjectDirectory: () =>
        Promise.resolve({
          anchoredRoot: path.dirname(root),
          get projectDirectory(): string {
            if (!closedDuringTheWork) {
              closedDuringTheWork = true;
              invalidateProjectNodes(PROJECT);
            }
            return root;
          },
        }),
      subscribeNative: native.subscribe,
      pollForRoot: () => () => undefined,
      rootExists: () => Promise.resolve(true),
      publish: () => undefined,
    });

    try {
      const listed = await racing.listChildren({ projectId: PROJECT, nodeId: null });
      expect(closedDuringTheWork).toBe(true);
      // Not bytes. The directory is real and readable; the ONLY thing standing
      // between this call and its contents is the fence.
      expect(listed).toEqual({ ok: false, code: "project_closed" });
    } finally {
      await racing.dispose();
    }
  });
});

/* ------------------------------------------------------------------ *
 * The DRAINED `fileOperation` lease
 * ------------------------------------------------------------------ */

describe("a read in flight when a delete begins", () => {
  it("is WAITED FOR by the drain, and publishes because it ran before the tombstone", async () => {
    // The fence at publication refuses a read that finishes after the epoch
    // moved. It is a refusal AFTER the fact, and it depends on the bump having
    // already happened - which the files close hook does behind every other
    // close hook. The lease closes that gap from the other side: step 3 of a
    // delete WAITS for reads already in flight, so there is no interval to
    // fence at all.
    //
    // The park is placed exactly where the real one is: inside the authority
    // resolution, after the lease has been taken.
    let park: () => void = () => undefined;
    const parked = new Promise<void>((resolve) => {
      park = resolve;
    });
    let armed = false;

    const parking = new FilesDomain({
      resolveProjectDirectory: async (projectId) => {
        if (projectId !== PROJECT) return null;
        if (armed) {
          armed = false;
          await parked;
        }
        return { anchoredRoot: path.dirname(root), projectDirectory: root };
      },
      subscribeNative: native.subscribe,
      pollForRoot: () => () => undefined,
      rootExists: () => Promise.resolve(true),
      publish: () => undefined,
    });

    try {
      armed = true;
      const listing = parking.listChildren({ projectId: PROJECT, nodeId: null });
      await until(
        "the read to be counted as in-flight work",
        () => heldProjectLeases(PROJECT, "fileOperation") === 1,
      );

      // THE DELETE'S FIRST TWO STEPS, exactly as `project-delete.ts` runs them:
      // close admission, then drain. Nothing here is faked - `closeProjectAdmission`
      // and `drainProjectLeases` are the production functions.
      closeProjectAdmission(PROJECT);
      let drained = false;
      const draining = drainProjectLeases(PROJECT, 10_000).then((outcome) => {
        drained = true;
        return outcome;
      });

      // THE DRAIN IS WAITING. Several event-loop turns, and it has not settled:
      // without the lease it would have returned `drained: true` immediately and
      // the tombstone would commit over a live read.
      for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(drained).toBe(false);

      // A read STARTED now is refused: admission is closed, and the lease
      // acquisition that opens `listChildren` is that admission check.
      expect(
        await parking.listChildren({ projectId: PROJECT, nodeId: null }),
      ).toEqual({ ok: false, code: "project_closed" });

      // Let the parked read go. It PUBLISHES - correctly: it was admitted while
      // the project existed, and the tombstone has not committed, precisely
      // because this read is what the delete is waiting for.
      park();
      const listed = await listing;
      expect(listed.ok).toBe(true);

      // ...and only now does the drain complete, which is what lets the delete
      // proceed to its transaction.
      expect(await draining).toEqual({ drained: true });
      expect(heldProjectLeases(PROJECT, "fileOperation")).toBe(0);
    } finally {
      park();
      await parking.dispose();
    }
  });

  it("RELEASES the lease on a refusal, not only on a success", async () => {
    // A lease leaked by a failing read is a project that can never be deleted.
    const refused = await domain.readFile({ projectId: "no-such-project", nodeId: "x" });
    expect(refused).toEqual({ ok: false, code: "project_closed" });
    expect(heldProjectLeases("no-such-project", "fileOperation")).toBe(0);
  });
});

describe("the node epoch, and WHEN it moves", () => {
  it("is ALREADY SPENT by the time the close hook disposes the watcher", async () => {
    // The bump used to be the LAST thing `closeProject` did: after the native
    // watcher disposal, after the `closed` statuses, and behind every other
    // close hook the delete runs first. A read released anywhere in that window
    // passed a fence against an epoch that had not moved yet and PUBLISHED
    // bytes out of a project whose tombstone was already durable.
    //
    // The disposal is the slow, awaited part of the teardown, so it is the
    // honest place to ask what the epoch is. Under the fix it has already
    // moved; under the old order it has not moved yet and this reads `before`.
    const watching = beginWatch(WINDOW_A);
    await until("the native subscribe to be requested", () => native.calls() === 1);
    native.gates[0]?.resolve();
    expect((await watching).ok).toBe(true);

    const before = projectNodeEpoch(PROJECT);
    let epochWhenTheWatcherWasDisposed = -1;
    native.beforeUnsubscribe = () => {
      epochWhenTheWatcherWasDisposed = projectNodeEpoch(PROJECT);
    };

    await closeProjectResources(PROJECT);

    expect(native.unsubscribes()).toBe(1);
    expect(epochWhenTheWatcherWasDisposed).toBe(before + 1);
    expect(projectNodeEpoch(PROJECT)).toBe(before + 1);
    expect(domain.watchedProjectCount).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * Event backpressure
 * ------------------------------------------------------------------ */

describe("a consumer that stops acknowledging batches", () => {
  /** Watch, open the native gate, and hand back the subscription id. */
  async function watchAndSettle(windowId: string): Promise<string> {
    const watching = beginWatch(windowId);
    await until(
      "a native subscribe to be requested",
      () => native.gates.length > 0 && native.gates.at(-1) !== undefined,
    );
    native.gates.at(-1)?.resolve();
    const outcome = await watching;
    if (!outcome.ok) throw new Error(`watch refused: ${outcome.code}`);
    return outcome.value.subscriptionId;
  }

  /** Force one `changed` batch through the whole fan-out. */
  async function deliverOneBatch(index: number, name: string): Promise<void> {
    native.deliver(index, [{ path: path.join(root, name), type: "create" }]);
    // The watcher aggregates on a 75 ms timer and throttles emissions, so real
    // time is what carries a batch out of it here.
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  it("STOPS RECEIVING batches past the bound, and gets exactly ONE resync when it drains", async () => {
    const subscriptionId = await watchAndSettle(WINDOW_A);
    const changed = (): FilesEvent[] =>
      events.filter((e) => e.event.kind === "changed").map((e) => e.event);
    const resyncs = (): FilesEvent[] =>
      events
        .filter((e) => e.event.kind === "resync" && e.event.reason === "consumer_backlog")
        .map((e) => e.event);

    const deliveredChanges = (): number =>
      changed().reduce(
        (total, event) => total + (event.kind === "changed" ? event.changes.length : 0),
        0,
      );

    // Never acknowledged. `webContents.send` neither blocks nor reports whether
    // the renderer ran, so without the bound this array grows for as long as
    // the filesystem is busy.
    const files = FILES_EVENTS_OUTSTANDING_MAX + 12;
    for (let index = 0; index < files; index += 1) {
      await deliverOneBatch(0, `f${String(index)}.txt`);
    }

    // THE BOUND HELD. Asserted as a ceiling and not as an exact count because
    // how many BATCHES a given number of changes becomes is the watcher's
    // aggregation window's business - two deliveries landing inside one 75 ms
    // tick are one batch - and that is not this test's subject. The ceiling is.
    expect(changed().length).toBeLessThanOrEqual(FILES_EVENTS_OUTSTANDING_MAX);
    // Batches WERE withheld, so there is something to be owed. (If this ever
    // fails the burst above stopped being big enough to reach the bound, and
    // the ceiling assertion above would be passing for the wrong reason.)
    expect(deliveredChanges()).toBeLessThan(files);
    // Nothing has been said yet: the resync is owed, and it is paid when the
    // consumer proves it is back rather than into a void it is not reading.
    expect(resyncs()).toHaveLength(0);

    // The consumer comes back and acknowledges ONE batch.
    expect(domain.ackEvent(WINDOW_A, subscriptionId)).toEqual({ ok: true, value: null });

    const paid = resyncs();
    expect(paid).toHaveLength(1);
    const only = paid[0];
    expect(only?.kind === "resync" && only.reason).toBe("consumer_backlog");
    // THE COUNT IS ON THE WIRE, not in a log, and it is EXACT: every change
    // this subscription did not receive is in it. Conservation, which is the
    // no-silent-cutting rule stated as arithmetic - what was delivered plus
    // what was declared missing is everything that happened.
    expect(
      deliveredChanges() + (only?.kind === "resync" ? only.droppedCount : -1),
    ).toBe(files);

    // ...and exactly one, not one per withheld batch.
    expect(domain.ackEvent(WINDOW_A, subscriptionId)).toEqual({ ok: true, value: null });
    expect(resyncs()).toHaveLength(1);
  });

  it("does NOT let ANOTHER window's ack credit this subscription", async () => {
    const subscriptionId = await watchAndSettle(WINDOW_A);
    // COMFORTABLY past the bound. How many BATCHES a run of changes becomes is
    // the aggregation window's business - two deliveries inside one 75 ms tick
    // are one batch - so a burst sized to just clear the bound can, on a busy
    // machine, coalesce to just under it and never reach the state this test is
    // about. The margin makes the premise hold, and the assertion below proves
    // it did rather than assuming it.
    const files = FILES_EVENTS_OUTSTANDING_MAX + 12;
    for (let index = 0; index < files; index += 1) {
      await deliverOneBatch(0, `g${String(index)}.txt`);
    }
    const changedCount = (): number =>
      events.filter((e) => e.event.kind === "changed").length;
    const deliveredChanges = (): number =>
      events.reduce(
        (total, e) => total + (e.event.kind === "changed" ? e.event.changes.length : 0),
        0,
      );
    // THE PREMISE: the bound was reached and batches are being withheld right
    // now. Without this the assertions below would pass on a subscription that
    // simply had nothing more to send.
    expect(deliveredChanges()).toBeLessThan(files);
    expect(changedCount()).toBe(FILES_EVENTS_OUTSTANDING_MAX);
    const stoppedAt = changedCount();

    // Window B claims to have consumed window A's batch. If this credited the
    // subscription, a compromised or merely buggy renderer could buy another
    // window unbounded headroom in the privileged process.
    expect(domain.ackEvent(WINDOW_B, subscriptionId)).toEqual({
      ok: false,
      code: "unknown_subscription",
    });
    await deliverOneBatch(0, "after-the-foreign-ack.txt");
    // NOT ONE MORE. The foreign ack bought nothing.
    expect(changedCount()).toBe(stoppedAt);

    // ...whereas the OWNER's ack does credit it, which is what proves the
    // refusal above was about ownership and not about the flow control being
    // stuck shut.
    expect(domain.ackEvent(WINDOW_A, subscriptionId)).toEqual({ ok: true, value: null });
    await deliverOneBatch(0, "after-the-owners-ack.txt");
    expect(changedCount()).toBeGreaterThan(stoppedAt);
  });

  it("never withholds a STATUS, which is the honest signal", async () => {
    const subscriptionId = await watchAndSettle(WINDOW_A);
    for (let index = 0; index < FILES_EVENTS_OUTSTANDING_MAX + 12; index += 1) {
      await deliverOneBatch(0, `h${String(index)}.txt`);
    }
    const statusesBefore = events.filter((e) => e.event.kind === "status").length;

    // A watcher that has stopped seeing changes must say so to a consumer that
    // is behind MORE than to one that is keeping up - it is the only thing that
    // stops a tree looking live while it is not.
    await closeProjectResources(PROJECT);
    const closed = events.filter(
      (e) => e.event.kind === "status" && e.event.state === "closed",
    );
    expect(closed).toHaveLength(1);
    expect(events.filter((e) => e.event.kind === "status").length).toBeGreaterThan(
      statusesBefore,
    );
    expect(closed[0]?.event.subscriptionId).toBe(subscriptionId);
  });
});
