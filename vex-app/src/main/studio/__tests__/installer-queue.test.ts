/**
 * PER-PROJECT SERIALIZATION and SUPERSEDING (stage A5b item 6).
 *
 * The two properties, and why each one has to be proved rather than assumed:
 *
 *   1. Two renders of one project never overlap. Without it, both read the same
 *      config, both render, and the second replacement meets a file that moved -
 *      a spurious `source_changed` refusal for an edit that was perfectly valid.
 *   2. Updates that are overtaken while waiting do NO filesystem work. Without
 *      it, a burst of five settings edits writes the same files five times, and
 *      an older scope's render can land after a newer one - which is exactly
 *      "the files describe authority the user already replaced".
 *
 * Ordering is established with controlled promises, never a sleep: a wall-clock
 * delay would prove that two things happened slowly, not that they were
 * serialized.
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  __resetStudioRenderQueuesForTests,
  enqueueStudioRender,
} from "../installer/queue.js";

afterEach(() => {
  __resetStudioRenderQueuesForTests();
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("serialization", () => {
  it("never runs two jobs for one project at the same time", async () => {
    const gate = deferred<void>();
    const events: string[] = [];

    const first = enqueueStudioRender({
      projectId: "p1",
      kind: "repair",
      run: async () => {
        events.push("first:start");
        await gate.promise;
        events.push("first:end");
        return 1;
      },
      whenSuperseded: () => -1,
    });

    const second = enqueueStudioRender({
      projectId: "p1",
      kind: "repair",
      run: async () => {
        events.push("second:start");
        return 2;
      },
      whenSuperseded: () => -1,
    });

    // The second job cannot have started while the first is still inside its
    // own body.
    await Promise.resolve();
    expect(events).toEqual(["first:start"]);

    gate.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("runs different projects independently", async () => {
    const gate = deferred<void>();
    const events: string[] = [];

    const blocked = enqueueStudioRender({
      projectId: "p1",
      kind: "repair",
      run: async () => {
        await gate.promise;
        events.push("p1");
        return 1;
      },
      whenSuperseded: () => -1,
    });
    const other = await enqueueStudioRender({
      projectId: "p2",
      kind: "repair",
      run: async () => {
        events.push("p2");
        return 2;
      },
      whenSuperseded: () => -1,
    });

    expect(other).toBe(2);
    expect(events).toEqual(["p2"]);
    gate.resolve();
    await blocked;
  });

  it("keeps serving a project after one job throws", async () => {
    await expect(
      enqueueStudioRender({
        projectId: "p1",
        kind: "repair",
        run: async () => {
          throw new Error("boom");
        },
        whenSuperseded: () => -1,
      }),
    ).rejects.toThrow("boom");

    await expect(
      enqueueStudioRender({
        projectId: "p1",
        kind: "repair",
        run: async () => 7,
        whenSuperseded: () => -1,
      }),
    ).resolves.toBe(7);
  });
});

describe("superseding", () => {
  it("renders the LATEST update only: interleaved updates collapse to one run", async () => {
    const ran: number[] = [];
    const jobs = [0, 1, 2, 3].map((index) =>
      enqueueStudioRender({
        projectId: "p1",
        kind: "update",
        run: async () => {
          ran.push(index);
          return index;
        },
        whenSuperseded: () => -1,
      }),
    );

    const results = await Promise.all(jobs);

    // Four edits committed in order; ONE render, of the newest. The three that
    // were overtaken did no filesystem work at all and say so by returning the
    // superseded value rather than a fabricated success.
    expect(ran).toEqual([3]);
    expect(results).toEqual([-1, -1, -1, 3]);
  });

  it("supersedes only jobs BEHIND the newest, never one already running", async () => {
    const gate = deferred<void>();
    const ran: string[] = [];

    // Job A is running (it is inside `run`, waiting on the gate) when B arrives.
    const running = enqueueStudioRender({
      projectId: "p1",
      kind: "update",
      run: async () => {
        ran.push("A");
        await gate.promise;
        return "A";
      },
      whenSuperseded: () => "superseded",
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(ran).toEqual(["A"]);

    const later = enqueueStudioRender({
      projectId: "p1",
      kind: "update",
      run: async () => {
        ran.push("B");
        return "B";
      },
      whenSuperseded: () => "superseded",
    });

    gate.resolve();
    // A is not cancelled mid-flight: aborting work already in progress is a
    // different and far riskier contract than declining to start it.
    expect(await Promise.all([running, later])).toEqual(["A", "B"]);
  });

  it("NEVER supersedes a repair: it carries authority an update does not", async () => {
    const ran: string[] = [];

    const repair = enqueueStudioRender({
      projectId: "p1",
      kind: "repair",
      run: async () => {
        ran.push("repair");
        return "repair";
      },
      whenSuperseded: () => "superseded",
    });
    const update = enqueueStudioRender({
      projectId: "p1",
      kind: "update",
      run: async () => {
        ran.push("update");
        return "update";
      },
      whenSuperseded: () => "superseded",
    });

    // The repair runs even though a newer update was queued behind it: only a
    // repair overwrites a drifted artifact, so letting a routine settings edit
    // cancel it would silently drop the one thing the user asked for.
    expect(await Promise.all([repair, update])).toEqual(["repair", "update"]);
    expect(ran).toEqual(["repair", "update"]);
  });
});
