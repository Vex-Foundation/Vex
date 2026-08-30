/**
 * The file-viewer session: the read queue, the fences, and following the disk.
 *
 * Six rules here go quietly wrong and STAY wrong, which is why each has its own
 * case rather than being implied by a happy path:
 *
 *  - THE GENERATION FENCE. A read or a highlight that resolves after `dispose`
 *    describes a tab nobody is looking at. Without it a closed tab repaints.
 *  - THE HASH FENCE. A file saved twice produces two highlight requests; the
 *    first one's tokens describe text that is no longer on screen. This one is
 *    invisible in review because both results are "valid tokens".
 *  - THE DEPTH-2 QUEUE. A build touching a file fifty times must produce two
 *    reads, not fifty. An unbounded version looks identical until you watch it.
 *  - THE HIDDEN-TAB DEFERRAL. Panels are CSS-hidden and never unmounted, so a
 *    project with eight open files would otherwise put eight tokenizations
 *    through one worker thread for seven files nobody is looking at.
 *  - THE DELETE RE-CHECK. Every atomic save is a delete event (VS Code #13665).
 *    Believing it flashes an orphan banner on every single save.
 *  - THE SAME-BYTES RULE. A touch that changes no bytes must not re-tokenize,
 *    or the code area blinks through `highlighting` for nothing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExplorerRegistry } from "../../explorer/explorer-registry.js";
import type { WorkspaceFileTab } from "../../workspace/types.js";
import {
  FileViewerSession,
  VIEWER_DELETE_RECHECK_MS,
  VIEWER_HIGHLIGHT_MAX_BYTES,
  VIEWER_MAX_TOKENIZE_LINE_LENGTH,
} from "../file-viewer-session.js";
import {
  FakeHighlighterPort,
  FileApiFake,
  contentOf,
  ok,
  refused,
  transportFailure,
} from "./viewer-harness.js";
import {
  FilesApiFake,
  listingOf,
  changedEvent,
} from "../../explorer/__tests__/explorer-harness.js";

let files: FileApiFake;
let tree: FilesApiFake;
let highlighter: FakeHighlighterPort;
let explorers: ExplorerRegistry;
let sessions: FileViewerSession[] = [];

vi.mock("../../../../../lib/api/files.js", () => ({
  readProjectFile: (projectId: string, nodeId: string) => files.readFile(projectId, nodeId),
  listProjectChildren: (input: Parameters<FilesApiFake["listChildren"]>[0]) =>
    tree.listChildren(input),
  watchProjectFiles: (input: Parameters<FilesApiFake["watchFile"]>[0]) => tree.watchFile(input),
  unwatchProjectFiles: (subscriptionId: string) => tree.unwatchFile({ subscriptionId }),
  onProjectFilesEvent: (
    subscriptionId: string,
    cb: Parameters<FilesApiFake["onFilesEvent"]>[1],
  ) => tree.onFilesEvent(subscriptionId, cb),
}));

const TAB: WorkspaceFileTab = {
  kind: "file",
  tabId: "tab-1",
  title: "a.ts",
  relativePath: "src/a.ts",
  nodeId: "node-1",
  dirty: false,
};

function makeSession(tab: WorkspaceFileTab = TAB): FileViewerSession {
  const session = new FileViewerSession({
    projectId: "p1",
    tab,
    highlighter,
    explorers,
  });
  sessions.push(session);
  return session;
}

/** Let every queued microtask settle. A read plus its publication is several. */
async function flush(): Promise<void> {
  for (let step = 0; step < 20; step += 1) await Promise.resolve();
}

/** Activate a session, run its first read to completion, and show the tab. */
async function live(tab: WorkspaceFileTab = TAB): Promise<FileViewerSession> {
  const session = makeSession(tab);
  session.setActive(true);
  session.activate();
  await flush();
  return session;
}

/** Push a watcher change for the tab's path, as main would. */
function emitChange(kind: "added" | "updated" | "deleted", path = "src/a.ts"): void {
  tree.emit(changedEvent([{ path, kind }], { batchSeq: nextBatchSeq() }));
}

let batchSeq = 0;
function nextBatchSeq(): number {
  batchSeq += 1;
  return batchSeq;
}

beforeEach(() => {
  files = new FileApiFake();
  tree = new FilesApiFake();
  tree.listResponder = () => ({ ok: true, data: { ok: true, value: listingOf([]) } });
  highlighter = new FakeHighlighterPort();
  explorers = new ExplorerRegistry();
  batchSeq = 0;
});

afterEach(async () => {
  const live = sessions;
  sessions = [];
  for (const session of live) session.dispose();
  await flush();
  vi.useRealTimers();
});

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

describe("reading", () => {
  it("reads on activate and publishes the file", async () => {
    const session = await live();
    expect(files.readCalls).toEqual([{ projectId: "p1", nodeId: "node-1" }]);
    expect(session.getState()).toEqual({ kind: "ready", content: contentOf("hello\n") });
    expect(session.size()).toBe(6);
    expect(session.copyAll()).toBe("hello\n");
  });

  it("activate is idempotent, so a StrictMode double mount reads ONCE", async () => {
    const session = await live();
    session.activate();
    session.activate();
    await flush();
    expect(files.readCount).toBe(1);
  });

  it("shows a spinner only on the FIRST read, never on a reload", async () => {
    files.manual = true;
    const session = makeSession();
    session.setActive(true);
    session.activate();
    await flush();
    expect(session.getState()).toEqual({ kind: "reading" });

    files.settleNextRead(ok(contentOf("one\n")));
    await flush();
    expect(session.getState().kind).toBe("ready");

    // A reload keeps the file on screen: replacing rendered text with a
    // spinner because a build touched the file would flicker on every save.
    emitChange("updated");
    await flush();
    expect(session.getState().kind).toBe("ready");
    files.settleNextRead(ok(contentOf("two\n")));
    await flush();
    expect(session.copyAll()).toBe("two\n");
  });

  it.each([
    ["too_large", 5_000_000],
    ["binary", undefined],
    ["invalid_utf8", undefined],
    ["not_found", undefined],
    ["symlinked_path", undefined],
    ["not_a_file", undefined],
    ["project_closed", undefined],
    ["io_error", undefined],
  ] as const)("lands a %s refusal with its code", async (code, size) => {
    files.responder = () => refused(code, size);
    const session = await live();
    expect(session.getState()).toEqual({ kind: "refused", code, size });
    // A refusal DROPS content: it is a statement that there is nothing to show.
    expect(session.copyAll()).toBeNull();
  });

  it("reports the real size on too_large, so the UI can name it", async () => {
    files.responder = () => refused("too_large", 3_145_728);
    const session = await live();
    expect(session.size()).toBe(3_145_728);
  });

  it("treats a transport failure as retryable, distinct from a refusal", async () => {
    files.responder = transportFailure;
    const session = await live();
    expect(session.getState()).toEqual({ kind: "failed" });

    files.responder = () => ok(contentOf("recovered\n"));
    session.retry();
    await flush();
    expect(session.copyAll()).toBe("recovered\n");
  });

  it("treats a REJECTED bridge call as a transport failure, not a hang", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    files.manual = true;
    const session = makeSession();
    session.setActive(true);
    session.activate();
    await flush();
    files.rejectNextRead();
    await flush();
    // Swallowing the rejection would leave the tab reading forever.
    expect(session.getState()).toEqual({ kind: "failed" });
  });

  it("publishes NOTHING from a read that resolves after dispose", async () => {
    files.manual = true;
    const session = makeSession();
    session.setActive(true);
    session.activate();
    await flush();

    session.dispose();
    files.settleNextRead(ok(contentOf("late\n")));
    await flush();

    // THE GENERATION FENCE. Without it the disposed session repaints.
    expect(session.getState()).toEqual({ kind: "disposed" });
    expect(session.copyAll()).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * The depth-2 reload queue
 * ------------------------------------------------------------------ */

describe("the reload queue", () => {
  it("coalesces a burst of changes into at most TWO reads", async () => {
    files.manual = true;
    const session = makeSession();
    session.setActive(true);
    session.activate();
    await flush();
    files.settleNextRead(ok(contentOf("one\n")));
    await flush();
    expect(files.readCount).toBe(1);

    // A build touching the file. The first reload runs; every later event asks
    // the same question and collapses into the ONE queued read behind it.
    for (let event = 0; event < 12; event += 1) emitChange("updated");
    await flush();
    expect(files.readCount).toBe(2);

    files.settleNextRead(ok(contentOf("two\n")));
    await flush();
    // THE BOUND: exactly one queued read followed, not twelve.
    expect(files.readCount).toBe(3);
    files.settleNextRead(ok(contentOf("three\n")));
    await flush();
    expect(files.readCount).toBe(3);
    expect(session.copyAll()).toBe("three\n");
  });

  it("a resync re-reads, because a missed batch makes the held text unknowable", async () => {
    const session = await live();
    const before = files.readCount;
    explorers.acquire("p1").refreshNow();
    await flush();
    expect(files.readCount).toBe(before + 1);
    expect(session.getState().kind).toBe("ready");
    explorers.release("p1");
  });
});

/* ------------------------------------------------------------------ *
 * Highlighting
 * ------------------------------------------------------------------ */

describe("highlighting", () => {
  it("asks for the WHOLE text with the long-line bound and publishes the tokens", async () => {
    const session = await live();
    expect(highlighter.asks).toEqual([
      {
        language: "typescript",
        text: "hello\n",
        maxLineLength: VIEWER_MAX_TOKENIZE_LINE_LENGTH,
      },
    ]);
    expect(session.getHighlight()).toEqual({ kind: "highlighting" });

    const lines = [[{ text: "hello", color: null, italic: false, bold: false, underline: false }]];
    highlighter.settleOldest(lines, 2);
    await flush();
    expect(session.getHighlight()).toEqual({ kind: "highlighted", lines, longLines: 2 });
  });

  it("does not highlight a file whose language has no grammar", async () => {
    const session = await live({ ...TAB, relativePath: "notes.txt" });
    expect(highlighter.asks).toEqual([]);
    expect(session.getHighlight()).toEqual({ kind: "plain", reason: "plain_language" });
  });

  it("refuses to highlight over the byte bound and NAMES the bound", async () => {
    const big = "x".repeat(VIEWER_HIGHLIGHT_MAX_BYTES + 1);
    files.responder = () => ok(contentOf(big));
    const session = await live();
    expect(highlighter.asks).toEqual([]);
    expect(session.getHighlight()).toEqual({
      kind: "plain",
      reason: "too_large_to_highlight",
    });
    // The file is shown IN FULL. Only the colour is declined.
    expect(session.copyAll()).toBe(big);
  });

  it("reports a worker failure as a reason rather than as silence", async () => {
    const session = await live();
    highlighter.failOldest("worker_failed");
    await flush();
    expect(session.getHighlight()).toEqual({
      kind: "plain-after-failure",
      reason: "worker_failed",
    });
    expect(session.getState().kind).toBe("ready");
  });

  it("drops a result whose content is no longer on screen", async () => {
    const session = await live();
    expect(highlighter.held).toHaveLength(1);

    // The file was saved while the first tokenization was in flight.
    files.responder = () => ok(contentOf("second version\n"));
    emitChange("updated");
    await flush();
    expect(highlighter.held).toHaveLength(2);

    // Answer the STALE one. Its tokens describe text nobody is looking at.
    const staleLines = [
      [{ text: "STALE", color: null, italic: false, bold: false, underline: false }],
    ];
    highlighter.settleOldest(staleLines, 0);
    await flush();

    // THE HASH FENCE.
    expect(session.getHighlight()).toEqual({ kind: "highlighting" });

    highlighter.settleOldest([], 0);
    await flush();
    expect(session.getHighlight()).toEqual({ kind: "highlighted", lines: [], longLines: 0 });
  });

  it("does not re-highlight when a reload returns the SAME bytes", async () => {
    const session = await live();
    highlighter.settleOldest([], 0);
    await flush();
    expect(highlighter.asks).toHaveLength(1);

    // A `touch`, or a formatter that made no edit. The hash is identical.
    emitChange("updated");
    await flush();
    expect(files.readCount).toBe(2);
    // No second worker round trip, and no blink through `highlighting`.
    expect(highlighter.asks).toHaveLength(1);
    expect(session.getHighlight().kind).toBe("highlighted");
  });

  it("publishes nothing from a highlight that lands after dispose", async () => {
    const session = await live();
    session.dispose();
    highlighter.settleOldest([[]], 0);
    await flush();
    expect(session.getHighlight()).not.toEqual(
      expect.objectContaining({ kind: "highlighted" }),
    );
  });
});

/* ------------------------------------------------------------------ *
 * The hidden tab
 * ------------------------------------------------------------------ */

describe("a hidden tab", () => {
  it("holds NO worker request, and asks when it is shown", async () => {
    const session = makeSession();
    session.activate();
    await flush();

    expect(session.getState().kind).toBe("ready");
    // Seven hidden tabs must not queue seven tokenizations behind the visible
    // one.
    expect(highlighter.asks).toEqual([]);

    session.setActive(true);
    // The want was REMEMBERED, not dropped.
    expect(highlighter.asks).toHaveLength(1);
    highlighter.settleOldest([], 0);
    await flush();
    expect(session.getHighlight().kind).toBe("highlighted");
  });

  it("still follows the disk while hidden", async () => {
    const session = makeSession();
    session.activate();
    await flush();
    files.responder = () => ok(contentOf("changed\n"));
    emitChange("updated");
    await flush();
    // The CONTENT is current even though the colour is not: showing the tab
    // must never mean showing something the disk stopped saying an hour ago.
    expect(session.copyAll()).toBe("changed\n");
    expect(highlighter.asks).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Deletion
 * ------------------------------------------------------------------ */

describe("a delete event", () => {
  it("is DOUBTED for 100 ms, then confirmed as orphaned", async () => {
    vi.useFakeTimers();
    const session = await live();
    highlighter.settleOldest([], 0);
    await flush();
    const readsBefore = files.readCount;

    emitChange("deleted");
    // Nothing has happened yet: the event alone is not believed.
    expect(files.readCount).toBe(readsBefore);
    expect(session.getState().kind).toBe("ready");

    files.responder = () => refused("not_found");
    vi.advanceTimersByTime(VIEWER_DELETE_RECHECK_MS);
    await flush();

    expect(files.readCount).toBe(readsBefore + 1);
    const state = session.getState();
    expect(state.kind).toBe("orphaned");
    // The last contents are KEPT: replacing readable text with a refusal the
    // user can do nothing about would destroy what they were reading.
    expect(session.copyAll()).toBe("hello\n");
  });

  it("reloads instead of orphaning when the file is back (an atomic save)", async () => {
    vi.useFakeTimers();
    const session = await live();

    emitChange("deleted");
    files.responder = () => ok(contentOf("saved\n"));
    vi.advanceTimersByTime(VIEWER_DELETE_RECHECK_MS);
    await flush();

    // Every write-temp-then-rename produces a DELETED. Believing it would
    // flash an orphan banner on every save (VS Code #13665).
    expect(session.getState().kind).toBe("ready");
    expect(session.copyAll()).toBe("saved\n");
  });

  it("cancels the re-check when an update arrives first", async () => {
    vi.useFakeTimers();
    const session = await live();
    const readsBefore = files.readCount;

    emitChange("deleted");
    files.responder = () => ok(contentOf("back\n"));
    emitChange("updated");
    await flush();
    expect(files.readCount).toBe(readsBefore + 1);

    // The timer was dropped, not left to fire a second read behind this one.
    vi.advanceTimersByTime(VIEWER_DELETE_RECHECK_MS * 4);
    await flush();
    expect(files.readCount).toBe(readsBefore + 1);
    expect(session.getState().kind).toBe("ready");
  });

  it("answers not_found plainly when nothing was ever read", async () => {
    vi.useFakeTimers();
    files.responder = () => refused("not_found");
    const session = await live();
    expect(session.getState()).toEqual({ kind: "refused", code: "not_found", size: undefined });

    emitChange("deleted");
    vi.advanceTimersByTime(VIEWER_DELETE_RECHECK_MS);
    await flush();
    // There is no last content to keep, so "orphaned" would be a claim about
    // something the viewer never had.
    expect(session.getState().kind).toBe("refused");
  });

  it("fires no re-check after dispose", async () => {
    vi.useFakeTimers();
    const session = await live();
    const readsBefore = files.readCount;
    emitChange("deleted");
    session.dispose();
    vi.advanceTimersByTime(VIEWER_DELETE_RECHECK_MS * 4);
    await flush();
    expect(files.readCount).toBe(readsBefore);
  });
});

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

describe("lifecycle", () => {
  it("holds the project's explorer session for the tab's lifetime", async () => {
    const session = await live();
    // Without the reference, collapsing the sidebar would drop the session to
    // zero consumers and silently stop the open file from following the disk.
    expect(explorers.consumerCount("p1")).toBe(1);
    expect(explorers.acquire("p1").pathSubscriptionCount()).toBe(1);
    explorers.release("p1");

    session.dispose();
    await flush();
    expect(explorers.consumerCount("p1")).toBe(0);
  });

  it("dispose is idempotent and stops notifying subscribers", async () => {
    const session = await live();
    let notifications = 0;
    session.subscribeRevision(() => {
      notifications += 1;
    });
    session.dispose();
    // ONE notification for the transition into `disposed` - the component has
    // to learn that its session is gone - and then the listener set is
    // cleared, so nothing later reaches it.
    expect(notifications).toBe(1);

    session.dispose();
    emitChange("updated");
    await flush();
    expect(notifications).toBe(1);
  });

  it("bumps ONE revision counter for both state and highlight changes", async () => {
    const session = makeSession();
    const seen: number[] = [];
    session.subscribeRevision(() => {
      seen.push(session.getRevision());
    });
    session.setActive(true);
    session.activate();
    await flush();
    highlighter.settleOldest([], 0);
    await flush();

    expect(seen.length).toBeGreaterThan(1);
    // Strictly increasing: `useSyncExternalStore` compares with `Object.is`,
    // so a counter that ever repeats would drop a commit.
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(new Set(seen).size).toBe(seen.length);
  });
});
