/**
 * The explorer session: activation order, the publication fence, event routing
 * and the refresh scheduler.
 *
 * The four cases worth naming, because they are the ones that go quietly wrong
 * and stay wrong:
 *
 *  - THE FENCE. A listing that resolves after `deactivate` describes a tree
 *    nobody is looking at. Without the generation check it repaints the model
 *    of a session that was torn down, and the damage only shows up as a stale
 *    tree after a project switch.
 *  - THE GAP. `batchSeq` is contiguous within a generation for a whole-tree
 *    subscription, so a hole means a batch this window never received and whose
 *    contents are unknowable. Ignoring it leaves a permanently stale tree that
 *    still looks live.
 *  - THE GENERATION DROP. A batch from a superseded watcher describes a tree
 *    that no longer exists.
 *  - THE SCHEDULER. VS Code's `RunOnceScheduler` fires 500 ms after the FIRST
 *    event and is not re-armed while pending. Re-arming per event lets a build
 *    starve the refresh indefinitely - the tree simply stops updating for as
 *    long as the stream lasts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExplorerRegistry } from "../explorer-registry.js";
import {
  EXPLORER_FOCUS_REFRESH_THROTTLE_MS,
  EXPLORER_REFRESH_DELAY_MS,
  ExplorerSession,
} from "../explorer-session.js";
import {
  FilesApiFake,
  changedEvent,
  directoryNode,
  fileNode,
  listingOf,
  refusal,
  resyncEvent,
  statusEvent,
  subscription,
  transportFailure,
} from "./explorer-harness.js";

let api: FilesApiFake;
/**
 * Every live session holds a `window` focus listener. jsdom shares one window
 * across a file, so a session left undisposed keeps answering focus events in
 * LATER tests - which is how a single-focus assertion saw twenty-four listings.
 * Tracking and disposing is the harness upholding the same cleanup contract the
 * component does.
 */
let sessions: ExplorerSession[] = [];

function makeSession(projectId = "p1"): ExplorerSession {
  const session = new ExplorerSession({ projectId });
  sessions.push(session);
  return session;
}

vi.mock("../../../../../lib/api/files.js", () => ({
  listProjectChildren: (input: Parameters<FilesApiFake["listChildren"]>[0]) =>
    api.listChildren(input),
  readProjectFile: () => {
    throw new Error("the tree never reads a file");
  },
  watchProjectFiles: (input: Parameters<FilesApiFake["watchFile"]>[0]) => api.watchFile(input),
  unwatchProjectFiles: (subscriptionId: string) => api.unwatchFile({ subscriptionId }),
  onProjectFilesEvent: (
    subscriptionId: string,
    cb: Parameters<FilesApiFake["onFilesEvent"]>[1],
  ) => api.onFilesEvent(subscriptionId, cb),
}));

/** Let every queued microtask settle. The session awaits several per activation. */
async function flush(): Promise<void> {
  for (let step = 0; step < 20; step += 1) await Promise.resolve();
}

function rowIds(session: ExplorerSession): string[] {
  return session.model.getRows().map((row) => row.id);
}

function noticeTexts(session: ExplorerSession): string[] {
  return session.model
    .getRows()
    .filter((row) => row.kind === "notice")
    .map((row) => (row.kind === "notice" ? row.text : ""));
}

beforeEach(() => {
  api = new FilesApiFake();
});

afterEach(async () => {
  const live = sessions;
  sessions = [];
  await Promise.all(live.map((session) => session.dispose()));
  vi.useRealTimers();
});

describe("activation", () => {
  it("watches, THEN listens, THEN lists", async () => {
    const session = makeSession();
    await session.activate();
    await flush();

    // The order IS the contract: listing before the listener is registered
    // reopens the window in which a change lands unheard.
    expect(api.calls.slice(0, 3)).toEqual(["watch", "listen", "list:root"]);
  });

  it("is idempotent and single-flight, so a double mount opens ONE subscription", async () => {
    const session = makeSession();
    const first = session.activate();
    const second = session.activate();
    await Promise.all([first, second]);
    await flush();
    await session.activate();
    await flush();

    expect(api.watchCount).toBe(1);
    expect(api.listenCount).toBe(1);
  });

  it("reports an unavailable watcher rather than an empty tree", async () => {
    api.watchResult = transportFailureWatch();
    const session = makeSession();
    await session.activate();
    await flush();

    expect(session.getState()).toBe("unavailable");
    expect(noticeTexts(session)).toHaveLength(1);
    // Nothing was listed, because nothing could be.
    expect(api.listCalls).toHaveLength(0);
  });

  it("adopts the watcher state the subscription already carries", async () => {
    api.watchResult = {
      ok: true,
      data: {
        ok: true,
        value: subscription({ state: "unavailable", warnings: ["os_watch_limit_reached"] }),
      },
    };
    const session = makeSession();
    await session.activate();
    await flush();

    expect(session.getState()).toBe("unavailable");
    expect(noticeTexts(session)[0]).toContain("file-watch slots");
  });
});

describe("the publication fence", () => {
  it("does NOT publish a listing that resolves after deactivate", async () => {
    api.manual = true;
    const session = makeSession();
    void session.activate();
    await flush();
    expect(api.pendingLists).toHaveLength(1);

    await session.deactivate();
    // The bridge answers a request whose session is already gone.
    api.settleNextList({
      ok: true,
      data: { ok: true, value: listingOf([fileNode("ghost.ts")]) },
    });
    await flush();

    expect(rowIds(session)).toEqual([]);
    expect(session.getState()).toBe("inactive");
  });

  it("does NOT publish a directory listing after the row was collapsed", async () => {
    api.listResponder = (call) =>
      call.nodeId === null
        ? { ok: true, data: { ok: true, value: listingOf([directoryNode("src", "src")]) } }
        : { ok: true, data: { ok: true, value: listingOf([fileNode("a.ts", "src/a.ts")]) } };
    const session = makeSession();
    await session.activate();
    await flush();

    api.manual = true;
    session.expand("id:src");
    await flush();
    // The user changed their mind while the listing was in flight.
    session.collapse("id:src");
    api.settleNextList();
    await flush();

    expect(rowIds(session)).toEqual(["id:src"]);
  });
});

describe("deactivate and reactivate", () => {
  it("unwatches, removes the listener, and keeps the tree", async () => {
    api.listResponder = (call) =>
      call.nodeId === null
        ? { ok: true, data: { ok: true, value: listingOf([directoryNode("src", "src")]) } }
        : { ok: true, data: { ok: true, value: listingOf([fileNode("a.ts", "src/a.ts")]) } };
    const session = makeSession();
    await session.activate();
    await flush();
    session.expand("id:src");
    await flush();
    expect(rowIds(session)).toEqual(["id:src", "id:src/a.ts"]);

    await session.deactivate();

    expect(api.unwatchCount).toBe(1);
    expect(api.offCount).toBe(1);
    expect(api.hasListener("sub-1")).toBe(false);
    // The user's expansion is user state, and it survives.
    expect(rowIds(session)).toEqual(["id:src", "id:src/a.ts"]);
    expect(session.model.isStale("id:src")).toBe(true);
  });

  it("re-lists every previously expanded directory on reactivation", async () => {
    api.listResponder = (call) =>
      call.nodeId === null
        ? { ok: true, data: { ok: true, value: listingOf([directoryNode("src", "src")]) } }
        : { ok: true, data: { ok: true, value: listingOf([fileNode("a.ts", "src/a.ts")]) } };
    const session = makeSession();
    await session.activate();
    await flush();
    session.expand("id:src");
    await flush();
    await session.deactivate();
    api.calls.length = 0;
    api.listCalls.length = 0;

    await session.activate();
    await flush();

    // An inactive session heard NOTHING while it was away, so what it kept is a
    // guess about the disk until it is re-read.
    expect(api.listCalls.map((call) => call.nodeId)).toEqual([null, "id:src"]);
    expect(session.model.isStale("id:src")).toBe(false);
  });

  it("pages a multi-page ROOT back up on reactivation rather than shrinking it", async () => {
    api.listResponder = (call) => {
      if (call.cursor === "c1") {
        return {
          ok: true,
          data: {
            ok: true,
            value: listingOf([fileNode("p3.ts"), fileNode("p4.ts")], {
              hasMore: true,
              nextCursor: "c2",
              totalCount: 5,
            }),
          },
        };
      }
      if (call.cursor === "c2") {
        return {
          ok: true,
          data: { ok: true, value: listingOf([fileNode("p5.ts")], { totalCount: 5 }) },
        };
      }
      return {
        ok: true,
        data: {
          ok: true,
          value: listingOf([fileNode("p1.ts"), fileNode("p2.ts")], {
            hasMore: true,
            nextCursor: "c1",
            totalCount: 5,
          }),
        },
      };
    };
    const session = makeSession();
    await session.activate();
    await flush();
    session.loadMore(null);
    await flush();
    session.loadMore(null);
    await flush();
    expect(session.model.loadedCountOf(null)).toBe(5);
    const before = rowIds(session);

    await session.deactivate();
    api.listCalls.length = 0;
    await session.activate();
    await flush();

    // A root the user had paged open comes BACK paged open. Listing it as an
    // `initial` would hand back one page and a load-more row, and the user
    // would silently lose what they had - the one directory in the tree that
    // does not go through `#refreshDirectory`.
    expect(api.listCalls.map((call) => call.cursor)).toEqual([null, "c1", "c2"]);
    expect(session.model.loadedCountOf(null)).toBe(5);
    expect(rowIds(session)).toEqual(before);
  });
});

describe("the registry's project switch", () => {
  it("establishes the new subscription BEFORE releasing the old one", async () => {
    const registry = new ExplorerRegistry((run) => {
      run();
    });
    registry.acquire("p1");
    await registry.activate("p1");
    await flush();
    api.calls.length = 0;


    await registry.switchTo("p2", "p1");
    await flush();
    await registry.disposeAll();

    // Watchers are refcounted per project in main; releasing first opens the
    // window in which a change lands between a listing and its watcher.
    const watchAt = api.calls.indexOf("watch");
    const unwatchAt = api.calls.indexOf("unwatch");
    expect(watchAt).toBeGreaterThanOrEqual(0);
    expect(unwatchAt).toBeGreaterThan(watchAt);
  });

  it("keeps one session per project and disposes only at zero consumers", async () => {
    const pending: (() => void)[] = [];
    const registry = new ExplorerRegistry((run) => pending.push(run));

    const first = registry.acquire("p1");
    const second = registry.acquire("p1");
    expect(second).toBe(first);
    expect(registry.consumerCount("p1")).toBe(2);

    registry.release("p1");
    expect(registry.sessionCount()).toBe(1);

    registry.release("p1");
    // Still alive: a StrictMode remount reclaims it before the deferred run.
    expect(registry.sessionCount()).toBe(1);
    registry.acquire("p1");
    for (const run of pending.splice(0)) run();
    expect(registry.sessionCount()).toBe(1);

    registry.release("p1");
    for (const run of pending.splice(0)) run();
    await flush();
    expect(registry.sessionCount()).toBe(0);
  });
});

describe("event routing", () => {
  async function liveSession(): Promise<ExplorerSession> {
    api.listResponder = (call) =>
      call.nodeId === null
        ? {
            ok: true,
            data: {
              ok: true,
              value: listingOf([directoryNode("src", "src"), fileNode("top.ts", "top.ts")]),
            },
          }
        : {
            ok: true,
            data: {
              ok: true,
              value: listingOf([fileNode("a.ts", "src/a.ts"), fileNode("b.ts", "src/b.ts")]),
            },
          };
    const session = makeSession();
    await session.activate();
    await flush();
    session.expand("id:src");
    await flush();
    return session;
  }

  it("drops a batch from a SUPERSEDED watcher generation", async () => {
    vi.useFakeTimers();
    const session = await liveSession();
    api.listCalls.length = 0;

    api.emit(changedEvent([{ path: "src/a.ts", kind: "deleted" }], { watcherGeneration: 0 }));
    vi.advanceTimersByTime(EXPLORER_REFRESH_DELAY_MS * 2);
    await flush();

    // The row survives and nothing was re-listed: that batch describes a tree
    // that no longer exists.
    expect(session.model.hasNode("id:src/a.ts")).toBe(true);
    expect(api.listCalls).toHaveLength(0);
  });

  it("adopts a NEWER watcher generation and treats it as a resync", async () => {
    vi.useFakeTimers();
    const session = await liveSession();
    api.listCalls.length = 0;

    api.emit(
      changedEvent([{ path: "src/a.ts", kind: "added" }], {
        watcherGeneration: 2,
        batchSeq: 0,
      }),
    );
    vi.advanceTimersByTime(EXPLORER_REFRESH_DELAY_MS);
    await flush();

    // A full refresh: the root and every open directory, not just the parent.
    expect(api.listCalls.map((call) => call.nodeId)).toEqual([null, "id:src"]);
    expect(session.getState()).toBe("live");
  });

  it("treats a batchSeq GAP as a missed batch and refreshes everything", async () => {
    vi.useFakeTimers();
    await liveSession();
    api.emit(changedEvent([{ path: "src/a.ts", kind: "updated" }], { batchSeq: 0 }));
    api.listCalls.length = 0;

    // batchSeq 1 never arrived, and its contents are unknowable.
    api.emit(changedEvent([{ path: "src/a.ts", kind: "updated" }], { batchSeq: 2 }));
    vi.advanceTimersByTime(EXPLORER_REFRESH_DELAY_MS);
    await flush();

    expect(api.listCalls.map((call) => call.nodeId)).toEqual([null, "id:src"]);
  });

  it("treats overflow as a resync", async () => {
    vi.useFakeTimers();
    await liveSession();
    api.listCalls.length = 0;

    api.emit(
      changedEvent([{ path: "src/a.ts", kind: "updated" }], {
        overflowed: true,
        droppedCount: 900,
      }),
    );
    vi.advanceTimersByTime(EXPLORER_REFRESH_DELAY_MS);
    await flush();

    expect(api.listCalls.map((call) => call.nodeId)).toEqual([null, "id:src"]);
  });

  it("removes a deleted row IMMEDIATELY and refreshes its parent after the window", async () => {
    vi.useFakeTimers();
    const session = await liveSession();
    api.listCalls.length = 0;

    api.emit(changedEvent([{ path: "src/a.ts", kind: "deleted" }], { batchSeq: 0 }));

    // Immediately: cheap, exact, and the row does not linger for half a second.
    expect(session.model.hasNode("id:src/a.ts")).toBe(false);
    expect(api.listCalls).toHaveLength(0);

    vi.advanceTimersByTime(EXPLORER_REFRESH_DELAY_MS);
    await flush();

    const refresh = api.listCallsFor("id:src");
    expect(refresh).toHaveLength(1);
    // The page the directory already held, so a refresh never shrinks it.
    expect(refresh[0]?.limit).toBe(1);
  });

  it("ignores an ADDED under a parent the user has never opened", async () => {
    vi.useFakeTimers();
    const session = await liveSession();
    session.collapse("id:src");
    session.model.forget("id:src");
    api.listCalls.length = 0;

    api.emit(changedEvent([{ path: "src/new.ts", kind: "added" }], { batchSeq: 0 }));
    vi.advanceTimersByTime(EXPLORER_REFRESH_DELAY_MS * 2);
    await flush();

    // VS Code makes the same call: an unresolved parent learns about the child
    // when it is expanded, and refreshing now would resolve a folder nobody
    // asked to see.
    expect(api.listCalls).toHaveLength(0);
    expect(session.model.isResolved("id:src")).toBe(false);
  });

  it("re-lists a resolved parent ONCE for a burst, 500 ms after the FIRST event", async () => {
    vi.useFakeTimers();
    await liveSession();
    api.listCalls.length = 0;

    // A burst inside one window: twenty events, one refresh.
    for (let seq = 0; seq < 20; seq += 1) {
      api.emit(
        changedEvent([{ path: `src/gen-${String(seq)}.ts`, kind: "added" }], { batchSeq: seq }),
      );
    }
    expect(api.listCallsFor("id:src")).toHaveLength(0);
    vi.advanceTimersByTime(EXPLORER_REFRESH_DELAY_MS);
    await flush();
    expect(api.listCallsFor("id:src")).toHaveLength(1);

    // AND IT IS NEVER STARVED. A steady stream arriving faster than the delay -
    // what a build or an install produces - must still refresh. The scheduler is
    // armed on the FIRST event and not re-armed while pending, so the window
    // closes on time; a timer reset by each event would be pushed out for as
    // long as the stream lasts and the tree would simply stop updating.
    //
    // Twenty events, 100 ms apart: 2000 ms of continuous change, and NO trailing
    // idle period. A re-arming timer would have fired zero times by here.
    for (let seq = 20; seq < 40; seq += 1) {
      api.emit(
        changedEvent([{ path: `src/gen-${String(seq)}.ts`, kind: "added" }], { batchSeq: seq }),
      );
      vi.advanceTimersByTime(100);
      await flush();
    }

    expect(api.listCallsFor("id:src").length).toBeGreaterThan(1);
  });

  it("does nothing at all for an UPDATED", async () => {
    vi.useFakeTimers();
    const session = await liveSession();
    api.listCalls.length = 0;
    const before = session.model.getVersion();

    api.emit(changedEvent([{ path: "src/a.ts", kind: "updated" }], { batchSeq: 0 }));
    vi.advanceTimersByTime(EXPLORER_REFRESH_DELAY_MS * 2);
    await flush();

    // The tree shows no size and no mtime; file CONTENT is the viewer's.
    expect(api.listCalls).toHaveLength(0);
    expect(session.model.getVersion()).toBe(before);
  });
});

describe("watcher states", () => {
  async function liveSession(): Promise<ExplorerSession> {
    api.listResponder = () => ({
      ok: true,
      data: { ok: true, value: listingOf([fileNode("top.ts", "top.ts")]) },
    });
    const session = makeSession();
    await session.activate();
    await flush();
    return session;
  }

  it("suspended clears the tree to a single notice", async () => {
    const session = await liveSession();
    expect(rowIds(session)).toEqual(["id:top.ts"]);

    api.emit(statusEvent("suspended", { reason: "root_missing" }));

    // A vanished project folder is not a tree with a warning on it.
    expect(session.getState()).toBe("suspended");
    expect(rowIds(session)).toEqual(["root::notice"]);
    expect(noticeTexts(session)[0]).toContain("not on disk");
  });

  it("stays suspended on `watching` until the root_resumed resync arrives", async () => {
    vi.useFakeTimers();
    const session = await liveSession();
    api.emit(statusEvent("suspended", { reason: "root_missing" }));

    api.emit(statusEvent("watching", { reason: "root_returned" }));
    // The folder is back; its CONTENTS are still unknown.
    expect(session.getState()).toBe("suspended");

    api.emit(resyncEvent("root_resumed"));
    expect(session.getState()).toBe("live");
    vi.advanceTimersByTime(EXPLORER_REFRESH_DELAY_MS);
    await flush();
    expect(rowIds(session)).toEqual(["id:top.ts"]);
  });

  it("unavailable KEEPS the rows and names the remedy", async () => {
    const session = await liveSession();

    api.emit(
      statusEvent("unavailable", {
        reason: "os_watch_limit",
        warnings: ["os_watch_limit_reached"],
      }),
    );

    expect(session.getState()).toBe("unavailable");
    // The rows were true when they were read; "nothing here" would be a lie.
    expect(rowIds(session)).toEqual(["id:top.ts", "root::notice"]);
    expect(noticeTexts(session)[0]).toContain("file-watch slots");
  });

  it("gives each unavailable warning its own remedy", async () => {
    const session = await liveSession();

    api.emit(statusEvent("unavailable", { warnings: ["os_file_limit_reached"] }));
    expect(noticeTexts(session)[0]).toContain("open-file slots");

    api.emit(statusEvent("unavailable", { warnings: ["restart_cap_reached"] }));
    expect(noticeTexts(session)[0]).toContain("failed repeatedly");
  });

  it("closed clears to the deleted-project notice", async () => {
    const session = await liveSession();

    api.emit(statusEvent("closed", { reason: "project_deleted" }));

    expect(session.getState()).toBe("closed");
    expect(rowIds(session)).toEqual(["root::notice"]);
    expect(noticeTexts(session)[0]).toContain("deleted");
  });

  it("shows an empty project as a row rather than a blank panel", async () => {
    api.listResponder = () => ({ ok: true, data: { ok: true, value: listingOf([]) } });
    const session = makeSession();
    await session.activate();
    await flush();

    expect(noticeTexts(session)).toEqual(["This project has no files yet"]);
  });
});

describe("the focus backstop", () => {
  it("refreshes on window focus, at most once per throttle window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000));
    api.listResponder = () => ({
      ok: true,
      data: { ok: true, value: listingOf([fileNode("top.ts", "top.ts")]) },
    });
    const session = makeSession();
    await session.activate();
    await flush();
    api.listCalls.length = 0;

    window.dispatchEvent(new Event("focus"));
    vi.advanceTimersByTime(EXPLORER_REFRESH_DELAY_MS);
    await flush();
    expect(api.listCalls).toHaveLength(1);

    // Inside the window: ignored. The watcher is still live.
    window.dispatchEvent(new Event("focus"));
    vi.advanceTimersByTime(EXPLORER_REFRESH_DELAY_MS);
    await flush();
    expect(api.listCalls).toHaveLength(1);

    vi.advanceTimersByTime(EXPLORER_FOCUS_REFRESH_THROTTLE_MS);
    window.dispatchEvent(new Event("focus"));
    vi.advanceTimersByTime(EXPLORER_REFRESH_DELAY_MS);
    await flush();
    expect(api.listCalls).toHaveLength(2);

    await session.dispose();
    // The listener is the session's handle and it goes with the session.
    window.dispatchEvent(new Event("focus"));
    vi.advanceTimersByTime(EXPLORER_REFRESH_DELAY_MS);
    await flush();
    expect(api.listCalls).toHaveLength(2);
  });
});

describe("the listing queue", () => {
  it("keeps exactly ONE request in flight and serves them in order", async () => {
    api.listResponder = (call) => ({
      ok: true,
      data: {
        ok: true,
        value:
          call.nodeId === null
            ? listingOf([directoryNode("a", "a"), directoryNode("b", "b")])
            : listingOf([]),
      },
    });
    const session = makeSession();
    await session.activate();
    await flush();

    api.manual = true;
    session.expand("id:a");
    session.expand("id:b");
    await flush();

    // A resync of a big expanded tree is many requests; they must not stampede.
    expect(api.pendingLists).toHaveLength(1);
    expect(api.pendingLists[0]?.call.nodeId).toBe("id:a");

    api.settleNextList();
    await flush();
    expect(api.pendingLists).toHaveLength(1);
    expect(api.pendingLists[0]?.call.nodeId).toBe("id:b");
  });

  it("coalesces two refreshes of one directory into one request", async () => {
    vi.useFakeTimers();
    api.listResponder = (call) => ({
      ok: true,
      data: {
        ok: true,
        value:
          call.nodeId === null
            ? listingOf([directoryNode("src", "src")])
            : listingOf([fileNode("a.ts", "src/a.ts")]),
      },
    });
    const session = makeSession();
    await session.activate();
    await flush();
    session.expand("id:src");
    await flush();

    api.manual = true;
    api.listCalls.length = 0;
    session.refreshNow();
    session.refreshNow();
    await flush();

    expect(api.listCalls.filter((call) => call.nodeId === null)).toHaveLength(1);
  });
});

describe("listing refusals", () => {
  async function rootWith(
    result: ReturnType<typeof refusal>,
  ): Promise<ExplorerSession> {
    api.listResponder = (call) =>
      call.nodeId === null
        ? { ok: true, data: { ok: true, value: listingOf([directoryNode("src", "src")]) } }
        : result;
    const session = makeSession();
    await session.activate();
    await flush();
    session.expand("id:src");
    await flush();
    return session;
  }

  it("io_error shows the folder's own notice, with a retry", async () => {
    const session = await rootWith(refusal("io_error"));
    const rows = session.model.getRows();
    const notice = rows.find((row) => row.kind === "notice");
    expect(notice?.kind).toBe("notice");
    if (notice?.kind !== "notice") throw new Error("expected a notice row");
    expect(notice.text).toBe("This folder could not be read.");
    expect(notice.action).toBe("retry");
    expect(notice.code).toBe("io_error");
  });

  it("symlinked_path refreshes the PARENT rather than asking the dead question again", async () => {
    vi.useFakeTimers();
    const session = await rootWith(refusal("symlinked_path"));
    api.listCalls.length = 0;
    vi.advanceTimersByTime(EXPLORER_REFRESH_DELAY_MS);
    await flush();

    // The ROW is stale, not the folder: re-listing this node would refuse again.
    expect(api.listCalls.map((call) => call.nodeId)).toEqual([null]);
    expect(session.model.getRows().some((row) => row.kind === "notice")).toBe(false);
  });

  it("not_found and invalid_node take the same stale-row path", async () => {
    vi.useFakeTimers();
    await rootWith(refusal("not_found"));
    api.listCalls.length = 0;
    vi.advanceTimersByTime(EXPLORER_REFRESH_DELAY_MS);
    await flush();
    expect(api.listCalls.map((call) => call.nodeId)).toEqual([null]);
  });

  it("project_closed is about the PROJECT, not the folder", async () => {
    const session = await rootWith(refusal("project_closed"));
    expect(session.getState()).toBe("closed");
    expect(rowIds(session)).toEqual(["root::notice"]);
  });

  it("a transport failure is distinct from every refusal", async () => {
    const session = await rootWith(transportFailure());
    const notice = session.model.getRows().find((row) => row.kind === "notice");
    if (notice?.kind !== "notice") throw new Error("expected a notice row");
    // "Vex could not ask" and "the folder cannot be read" are different facts.
    expect(notice.text).toContain("could not reach the file service");
    expect(notice.action).toBe("retry");
    expect(notice.code).toBeNull();
  });

  it("a REJECTED listing fails the row rather than stranding its spinner", async () => {
    api.listResponder = (call) =>
      call.nodeId === null
        ? { ok: true, data: { ok: true, value: listingOf([directoryNode("src", "src")]) } }
        : { ok: true, data: { ok: true, value: listingOf([]) } };
    const session = makeSession();
    await session.activate();
    await flush();

    api.manual = true;
    session.expand("id:src");
    await flush();
    api.rejectNextList();
    await flush();

    const rows = session.model.getRows();
    const notice = rows.find((row) => row.kind === "notice");
    if (notice?.kind !== "notice") throw new Error("expected a notice row");
    // A rejection is the call failing to complete, which is the same fact a
    // transport failure states, so it says the same sentence and offers Retry.
    expect(notice.text).toContain("could not reach the file service");
    expect(notice.action).toBe("retry");
    const directory = rows.find((row) => row.id === "id:src");
    if (directory?.kind !== "node") throw new Error("expected the directory row");
    // The whole point: NOT `loading`. A swallowed rejection leaves a spinner
    // that no owner will ever clear.
    expect(directory.loadState).toBe("error");
  });

  it("DROPS a rejection that arrives after deactivate", async () => {
    api.listResponder = (call) =>
      call.nodeId === null
        ? { ok: true, data: { ok: true, value: listingOf([directoryNode("src", "src")]) } }
        : { ok: true, data: { ok: true, value: listingOf([]) } };
    const session = makeSession();
    await session.activate();
    await flush();

    api.manual = true;
    session.expand("id:src");
    await flush();
    const before = rowIds(session);

    await session.deactivate();
    api.rejectNextList();
    await flush();

    // The fence is the same one a resolved listing meets: a rejection for a
    // session nobody is looking at repaints nothing.
    expect(rowIds(session)).toEqual(before);
    expect(session.model.getRows().some((row) => row.kind === "notice")).toBe(false);
  });

  it("retry re-lists the folder and clears the notice", async () => {
    const session = await rootWith(refusal("io_error"));
    api.listResponder = () => ({
      ok: true,
      data: { ok: true, value: listingOf([fileNode("a.ts", "src/a.ts")]) },
    });

    session.retry("id:src");
    await flush();

    expect(rowIds(session)).toEqual(["id:src", "id:src/a.ts"]);
  });
});

describe("paging", () => {
  it("appends the next page in the order received and never re-sorts", async () => {
    api.listResponder = (call) =>
      call.cursor === "c1"
        ? {
            ok: true,
            data: {
              ok: true,
              value: listingOf([fileNode("zebra.ts"), fileNode("alpha.ts")], { totalCount: 4 }),
            },
          }
        : {
            ok: true,
            data: {
              ok: true,
              value: listingOf([fileNode("m1.ts"), fileNode("m2.ts")], {
                hasMore: true,
                nextCursor: "c1",
                totalCount: 4,
              }),
            },
          };
    const session = makeSession();
    await session.activate();
    await flush();
    expect(rowIds(session)).toEqual(["id:m1.ts", "id:m2.ts", " root::more"]);

    session.loadMore(null);
    await flush();

    // Main's comparator is the contract; the renderer renders what it is handed.
    expect(rowIds(session)).toEqual([
      "id:m1.ts",
      "id:m2.ts",
      "id:zebra.ts",
      "id:alpha.ts",
    ]);
  });

  it("pages a refresh back up to the count the directory already held", async () => {
    let firstPageServed = false;
    api.listResponder = (call) => {
      if (call.cursor === "c1") {
        return {
          ok: true,
          data: { ok: true, value: listingOf([fileNode("p3.ts")], { totalCount: 3 }) },
        };
      }
      firstPageServed = true;
      return {
        ok: true,
        data: {
          ok: true,
          value: listingOf([fileNode("p1.ts"), fileNode("p2.ts")], {
            hasMore: true,
            nextCursor: "c1",
            totalCount: 3,
          }),
        },
      };
    };
    const session = makeSession();
    await session.activate();
    await flush();
    session.loadMore(null);
    await flush();
    expect(firstPageServed).toBe(true);
    expect(session.model.loadedCountOf(null)).toBe(3);

    api.listCalls.length = 0;
    session.refreshNow();
    await flush();

    // A refresh must not silently shrink what the user had open.
    expect(session.model.loadedCountOf(null)).toBe(3);
    expect(api.listCalls).toHaveLength(2);
    expect(api.listCalls[0]?.cursor).toBeNull();
    expect(api.listCalls[1]?.cursor).toBe("c1");
  });
});

describe("collapse all", () => {
  it("collapses and FORGETS, so the next expand re-reads the disk", async () => {
    api.listResponder = (call) => ({
      ok: true,
      data: {
        ok: true,
        value:
          call.nodeId === null
            ? listingOf([directoryNode("src", "src")])
            : listingOf([fileNode("a.ts", "src/a.ts")]),
      },
    });
    const session = makeSession();
    await session.activate();
    await flush();
    session.expand("id:src");
    await flush();

    session.collapseAll();

    expect(rowIds(session)).toEqual(["id:src"]);
    expect(session.model.isResolved("id:src")).toBe(false);
  });
});

describe("subscribePath (the file viewer's seam)", () => {
  /** Activate a session and record what one path subscriber hears. */
  async function following(
    path: string,
  ): Promise<{
    session: ExplorerSession;
    heard: string[];
    unsubscribe: () => void;
  }> {
    const session = makeSession();
    await session.activate();
    await flush();
    const heard: string[] = [];
    const unsubscribe = session.subscribePath(path, (event) => {
      heard.push(event.kind);
    });
    return { session, heard, unsubscribe };
  }

  it("hears an updated for its own path and NOTHING for a sibling", async () => {
    const { session, heard } = await following("src/a.ts");
    api.emit(
      changedEvent(
        [
          { path: "src/a.ts", kind: "updated" },
          { path: "src/b.ts", kind: "updated" },
          { path: "src", kind: "updated" },
        ],
        { batchSeq: 0 },
      ),
    );
    // Exactly one: the sibling and the PARENT DIRECTORY are not this file.
    // Re-reading on a directory event would put an IPC round trip on every
    // sibling's save.
    expect(heard).toEqual(["updated"]);
    expect(session.pathSubscriptionCount()).toBe(1);
  });

  it("reports an ADDED as an update, because a recreated file is new contents", async () => {
    const { heard } = await following("src/a.ts");
    api.emit(changedEvent([{ path: "src/a.ts", kind: "added" }], { batchSeq: 0 }));
    expect(heard).toEqual(["updated"]);
  });

  it("reports a DELETED as its own kind, because the answer to it is a re-check", async () => {
    const { heard } = await following("src/a.ts");
    api.emit(changedEvent([{ path: "src/a.ts", kind: "deleted" }], { batchSeq: 0 }));
    expect(heard[0]).toBe("deleted");
  });

  it("resyncs every subscriber when the session knows it missed events", async () => {
    const { heard } = await following("src/a.ts");
    // A batchSeq gap: batch 1 never arrived and its contents are unknowable,
    // so the viewer's held text may be stale in a way no event will correct.
    api.emit(changedEvent([{ path: "other/x.ts", kind: "updated" }], { batchSeq: 0 }));
    api.emit(changedEvent([{ path: "other/x.ts", kind: "updated" }], { batchSeq: 2 }));
    expect(heard).toContain("resync");
  });

  it("resyncs on the header's Refresh", async () => {
    const { session, heard } = await following("src/a.ts");
    session.refreshNow();
    await flush();
    expect(heard).toEqual(["resync"]);
  });

  it("unsubscribe is idempotent and shrinks the map back to zero", async () => {
    const { session, heard, unsubscribe } = await following("src/a.ts");
    unsubscribe();
    unsubscribe();
    expect(session.pathSubscriptionCount()).toBe(0);
    api.emit(changedEvent([{ path: "src/a.ts", kind: "updated" }], { batchSeq: 0 }));
    expect(heard).toEqual([]);
  });

  it("keeps two subscribers on one path independent", async () => {
    const session = makeSession();
    await session.activate();
    await flush();
    const first: string[] = [];
    const second: string[] = [];
    const dropFirst = session.subscribePath("src/a.ts", (event) => first.push(event.kind));
    session.subscribePath("src/a.ts", (event) => second.push(event.kind));
    expect(session.pathSubscriptionCount()).toBe(1);

    dropFirst();
    api.emit(changedEvent([{ path: "src/a.ts", kind: "updated" }], { batchSeq: 0 }));
    expect(first).toEqual([]);
    expect(second).toEqual(["updated"]);
    // The path still has a subscriber, so its entry stays.
    expect(session.pathSubscriptionCount()).toBe(1);
  });

  it("survives a listener that unsubscribes itself while being notified", async () => {
    const session = makeSession();
    await session.activate();
    await flush();
    const heard: string[] = [];
    const drop = session.subscribePath("src/a.ts", (event) => {
      heard.push(event.kind);
      drop();
    });
    session.subscribePath("src/a.ts", (event) => heard.push(`second:${event.kind}`));

    // The viewer does exactly this when a delete leads it to tear down. Note
    // what this case does NOT prove: a `Set` tolerates deleting an element it
    // has already visited, so it stays green whether or not the notifier
    // iterates a copy. The case below is the one that pins the copy.
    expect(() => {
      api.emit(changedEvent([{ path: "src/a.ts", kind: "updated" }], { batchSeq: 0 }));
    }).not.toThrow();
    expect(heard).toEqual(["updated", "second:updated"]);
  });

  it("does not deliver an event to a listener that subscribed DURING it", async () => {
    const session = makeSession();
    await session.activate();
    await flush();
    const heard: string[] = [];
    session.subscribePath("src/a.ts", (event) => {
      heard.push(event.kind);
      // A late arrival. It subscribed after this event happened and must not
      // be told about it: a `Set` iterated live would pick up the append and
      // hand it an event that predates it, which for the viewer means a read
      // for a change it was never watching.
      session.subscribePath("src/a.ts", (late) => heard.push(`late:${late.kind}`));
    });

    api.emit(changedEvent([{ path: "src/a.ts", kind: "updated" }], { batchSeq: 0 }));
    expect(heard).toEqual(["updated"]);

    // The next event does reach it.
    api.emit(changedEvent([{ path: "src/a.ts", kind: "updated" }], { batchSeq: 1 }));
    expect(heard).toContain("late:updated");
  });

  it("dispose clears every path listener", async () => {
    const session = makeSession();
    await session.activate();
    await flush();
    session.subscribePath("src/a.ts", () => undefined);
    session.subscribePath("src/b.ts", () => undefined);
    expect(session.pathSubscriptionCount()).toBe(2);

    await session.dispose();

    // A listener left here would be held by a disposed session for the life of
    // the renderer.
    expect(session.pathSubscriptionCount()).toBe(0);
  });
});

/** A watch the bridge could not even make. Distinct from a watcher refusal. */
function transportFailureWatch(): FilesApiFake["watchResult"] {
  return {
    ok: false,
    error: {
      domain: "system",
      code: "internal.unexpected",
      message: "the file service could not be reached",
      retryable: true,
      userActionable: false,
      redacted: true,
      correlationId: "test-correlation",
    },
  };
}
