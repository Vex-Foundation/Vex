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

import type { FilesEvent } from "@shared/schemas/files.js";

import {
  closeProjectResources,
  heldProjectLeases,
  resetProjectLifecycleGateForTests,
} from "../../project-lifecycle-gate.js";
import { FilesDomain } from "../files-domain.js";
import { resetFileNodeEpochsForTests } from "../node-id.js";
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
        unsubscribes += 1;
        return Promise.resolve();
      },
    };
  };

  return {
    subscribe,
    gates,
    failures,
    calls: () => calls,
    unsubscribes: () => unsubscribes,
    deliver: (index, events) => {
      callbacks[index]?.(null, events);
    },
  };
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
    resolveProjectDirectory: (projectId) =>
      Promise.resolve(projectId === PROJECT ? root : null),
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
