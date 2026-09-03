/**
 * THE PRELOAD BOUNDARY for `vex.files.*` (stage B3a).
 *
 * Two contracts are under test and both are security ones:
 *
 *  - INPUT VALIDATION AT THE GATE. A malformed request never reaches an invoke,
 *    so a renderer bug is refused in the process that made it rather than
 *    becoming a contract violation logged in the privileged process.
 *  - PAYLOAD VALIDATION ON THE WAY BACK. This is the last place an off-contract
 *    payload from a misbehaving main can be stopped before it becomes renderer
 *    state, and the `.strict()` extra-key case is what proves an absolute path
 *    cannot be smuggled in beside the fields the renderer expects.
 *
 * Plus the routing contract: ONE channel listener for the whole namespace,
 * dispatching by subscription id, with at most one callback per id and a
 * cleanup that cannot remove a replacement.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FILES_CURSOR_MAX,
  type FilesEvent,
} from "../../shared/schemas/files.js";

const listeners = new Map<string, Array<(event: unknown, raw: unknown) => void>>();
/**
 * Typed against the two arguments `invokeWithSchema` actually sends, so
 * `mock.calls[0][0]` is a channel name rather than an element of an empty
 * tuple - which is what the repository's type ratchet catches.
 */
const invoke = vi.fn((_channel: string, _envelope: unknown) =>
  Promise.resolve({ ok: true, data: { ok: true, value: null } }),
);

vi.mock("electron", () => ({
  ipcRenderer: {
    on: (channel: string, handler: (event: unknown, raw: unknown) => void) => {
      const existing = listeners.get(channel) ?? [];
      existing.push(handler);
      listeners.set(channel, existing);
    },
    removeListener: (
      channel: string,
      handler: (event: unknown, raw: unknown) => void,
    ) => {
      const existing = listeners.get(channel) ?? [];
      listeners.set(
        channel,
        existing.filter((item) => item !== handler),
      );
    },
    invoke,
  },
}));

const { EV, CH } = await import("../../shared/ipc/channels.js");
const { files } = await import("../shell/files.js");

const SUBSCRIPTION = "sub-1";

const VALID: FilesEvent = {
  kind: "changed",
  subscriptionId: SUBSCRIPTION,
  projectId: "project-1",
  watcherGeneration: 0,
  batchSeq: 0,
  changes: [{ path: "src/a.ts", kind: "updated", nodeId: "f1.AAAA.BBBB" }],
  overflowed: false,
  droppedCount: 0,
};

function emit(raw: unknown): void {
  for (const handler of [...(listeners.get(EV.files.changed) ?? [])]) {
    handler({}, raw);
  }
}

function channelListenerCount(): number {
  return listeners.get(EV.files.changed)?.length ?? 0;
}

/**
 * The channel listener map is NOT cleared between tests, deliberately.
 *
 * The bridge is a module singleton that attaches its one channel listener
 * lazily and detaches it when the last subscription goes. Clearing the mock's
 * map out from under it would desynchronise the two - the module would believe
 * it was still attached while the mock had forgotten - and every attach
 * assertion after the first would be testing the clear, not the bridge. So
 * every test RELEASES what it registered instead, which is also the contract
 * the renderer has to honour.
 */
beforeEach(() => {
  invoke.mockClear();
});

afterEach(() => {
  expect(
    channelListenerCount(),
    "a test leaked a subscription; the bridge should have detached",
  ).toBe(0);
});

describe("vex.files input validation", () => {
  it("REFUSES a listing whose cursor is longer than the bound, without invoking", async () => {
    // DERIVED from the bound rather than a number typed next to it. The literal
    // that used to be here was 9000, chosen when the cursor bound was 4096;
    // when that bound was corrected to the value the declared path length
    // actually encodes to, the literal quietly became a VALID cursor and this
    // test started asserting that the bridge refuses a legal input - which it
    // does not. One past the bound is the only length that tests the bound.
    const result = await files.listChildren({
      projectId: "project-1",
      nodeId: null,
      cursor: "x".repeat(FILES_CURSOR_MAX + 1),
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("validation.invalid_input");
    expect(invoke).not.toHaveBeenCalled();
  });

  /**
   * The two payloads below arrive through `JSON.parse`, which is what an
   * off-contract call actually looks like at this boundary: a value that never
   * went through the typed path. No cast is involved, so nothing here can be
   * silencing a real type error - the same pattern, and the same reason, as
   * `terminal-bridge.test.ts`.
   */
  it("REFUSES an unknown extra field rather than silently dropping it", async () => {
    // `.strict()`, so a caller that invents a `path` parameter is told no. A
    // schema that stripped it would let a future main start honouring it.
    const extraKey: { projectId: string; nodeId: string } = JSON.parse(
      '{"projectId":"project-1","nodeId":"f1.A.B","path":"/etc/passwd"}',
    );
    const result = await files.readFile(extraKey);
    expect(result.ok).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("REFUSES a watch with a missing nodeId field", async () => {
    // `nodeId: null` is a real addressing mode; ABSENT is a caller that forgot.
    const missingNodeId: { projectId: string; nodeId: string | null } = JSON.parse(
      '{"projectId":"project-1"}',
    );
    const result = await files.watchFile(missingNodeId);
    expect(result.ok).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("passes a well-formed request through to its channel", async () => {
    await files.listChildren({ projectId: "project-1", nodeId: null, limit: 10 });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]?.[0]).toBe(CH.files.listChildren);
  });

  /**
   * THE REVEAL, which is the one operation on this surface whose effect is
   * outside the app. Its addressing is the same as every other channel's - a
   * project and a node token - and that is exactly what has to be enforced
   * here: a caller that appends a path to the request must be refused in the
   * process that wrote it, not have the field quietly stripped on the way to a
   * privileged process that could later start reading it.
   */
  it("REFUSES a reveal that carries a path beside the node", async () => {
    const withPath: { projectId: string; nodeId: string } = JSON.parse(
      '{"projectId":"project-1","nodeId":"f1.A.B","absolutePath":"/etc/passwd"}',
    );
    const result = await files.revealInFileManager(withPath);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("validation.invalid_input");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("REFUSES a reveal with no node, so nothing defaults to the project root", async () => {
    const noNode: { projectId: string; nodeId: string } = JSON.parse(
      '{"projectId":"project-1"}',
    );
    const result = await files.revealInFileManager(noNode);
    expect(result.ok).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("sends a well-formed reveal on the reveal channel", async () => {
    await files.revealInFileManager({ projectId: "project-1", nodeId: "f1.A.B" });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]?.[0]).toBe(CH.files.revealInFileManager);
  });
});

describe("vex.files.onFilesEvent", () => {
  it("delivers a valid payload to the matching subscription", () => {
    const seen: FilesEvent[] = [];
    const release = files.onFilesEvent(SUBSCRIPTION, (event) => seen.push(event));
    emit(VALID);
    release();
    expect(seen).toEqual([VALID]);
  });

  it("DROPS a payload carrying a field the contract does not have", () => {
    const seen: FilesEvent[] = [];
    const release = files.onFilesEvent(SUBSCRIPTION, (event) => seen.push(event));
    // An absolute path smuggled in beside the expected fields. `.strict()` is
    // what stops it becoming renderer state.
    emit({ ...VALID, absolutePath: "/home/u/secrets" });
    release();
    expect(seen).toEqual([]);
  });

  it("DROPS a payload whose kind is not one of the three", () => {
    const seen: FilesEvent[] = [];
    const release = files.onFilesEvent(SUBSCRIPTION, (event) => seen.push(event));
    emit({ ...VALID, kind: "something-else" });
    release();
    expect(seen).toEqual([]);
  });

  it("does not deliver ANOTHER subscription's events", () => {
    const seen: FilesEvent[] = [];
    const release = files.onFilesEvent(SUBSCRIPTION, (event) => seen.push(event));
    emit({ ...VALID, subscriptionId: "sub-2" });
    release();
    expect(seen).toEqual([]);
  });

  it("uses ONE channel listener for the whole namespace", () => {
    const releases = [
      files.onFilesEvent("a", () => {}),
      files.onFilesEvent("b", () => {}),
      files.onFilesEvent("c", () => {}),
    ];
    // Not three. A listener per subscription would wake every one of them for
    // every other subscription's events.
    expect(channelListenerCount()).toBe(1);
    for (const release of releases) release();
  });

  it("REPLACES on re-subscription, and a stale cleanup cannot remove the live one", () => {
    const first: FilesEvent[] = [];
    const second: FilesEvent[] = [];
    const staleCleanup = files.onFilesEvent(SUBSCRIPTION, (event) => first.push(event));
    const live = files.onFilesEvent(SUBSCRIPTION, (event) => second.push(event));

    // The React strict-mode double-effect: the FIRST effect's cleanup runs
    // after the second effect already registered its replacement.
    staleCleanup();

    emit(VALID);
    live();
    expect(first).toEqual([]);
    expect(second).toEqual([VALID]);
  });

  it("ACKNOWLEDGES a delivered batch, AFTER the callback has consumed it", () => {
    // Flow control's whole premise is that the ack means CONSUMPTION. An ack
    // posted on arrival would prove only that a message reached this process,
    // which is exactly the stall main's bound exists to notice - so the order
    // is asserted, not just the fact.
    const order: string[] = [];
    // `Once`, not a permanent implementation: `mockClear` between tests keeps
    // call history but not implementations, so a permanent one would leak into
    // every test after this.
    invoke.mockImplementationOnce((channel: string) => {
      order.push(`invoke:${channel}`);
      return Promise.resolve({ ok: true, data: { ok: true, value: null } });
    });
    const release = files.onFilesEvent(SUBSCRIPTION, () => {
      order.push("callback");
    });
    emit(VALID);
    release();
    expect(order).toEqual(["callback", `invoke:${CH.files.ackEvent}`]);
    expect(invoke.mock.calls[0]?.[1]).toMatchObject({
      payload: { subscriptionId: SUBSCRIPTION },
    });
  });

  it("acknowledges ONLY `changed`, never a status or a resync", () => {
    // `status` and `resync` are never withheld by main and are never counted,
    // so acking them would credit a subscription for batches it never owed.
    const release = files.onFilesEvent(SUBSCRIPTION, () => {});
    emit({
      kind: "status",
      subscriptionId: SUBSCRIPTION,
      projectId: "project-1",
      watcherGeneration: 0,
      state: "watching",
      reason: "started",
      warnings: [],
    });
    emit({
      kind: "resync",
      subscriptionId: SUBSCRIPTION,
      projectId: "project-1",
      watcherGeneration: 0,
      reason: "overflow",
      droppedCount: 3,
    });
    release();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("does NOT acknowledge a batch no callback consumed", () => {
    // Nothing is registered for this subscription, so nothing consumed the
    // batch. Acking would tell main a stalled consumer is keeping up.
    const release = files.onFilesEvent(SUBSCRIPTION, () => {});
    emit({ ...VALID, subscriptionId: "sub-nobody-is-listening-to" });
    release();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("DETACHES the channel listener when the last subscription goes", () => {
    const release = files.onFilesEvent(SUBSCRIPTION, () => {});
    expect(channelListenerCount()).toBe(1);
    release();
    release();
    expect(channelListenerCount()).toBe(0);
  });
});
