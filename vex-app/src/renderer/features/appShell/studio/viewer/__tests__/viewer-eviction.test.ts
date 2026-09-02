/**
 * INACTIVE-CONTENT EVICTION: the registry's warm-tab LRU.
 *
 * The rule under test: at most `VIEWER_WARM_TABS_MAX` sessions hold a file's
 * text and tokens at once. Past that, the least recently SHOWN hidden sessions
 * release theirs and read the file again on their next show. The active tab is
 * never evicted, and neither is an orphan.
 *
 * Driven through `FileViewerRegistry.setActive` - the real entry point the
 * component calls - rather than by poking sessions, because the whole point of
 * the design is that the bound is a decision ACROSS sessions and a test that
 * called `releaseContent` directly would be asserting the thing it wants to
 * prove.
 *
 * RED ON REVERT, four ways:
 *
 *  - delete the `#evictColdSessions` call from `setActive` and "evicts the
 *    least recently shown hidden session" fails: nothing is ever released;
 *  - drop `!record.active` from the candidate filter and "never evicts the
 *    active tab" fails;
 *  - make `holdsEvictableContent` return true for `orphaned` and "never evicts
 *    an orphan" fails;
 *  - delete the `#evicted` branch in `FileViewerSession.setActive` and
 *    "re-reads an evicted tab when it is shown again" fails: the tab comes back
 *    empty and no second read is issued.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExplorerRegistry } from "../../explorer/explorer-registry.js";
import type { WorkspaceFileTab } from "../../workspace/types.js";
import {
  FileViewerRegistry,
  VIEWER_WARM_TABS_MAX,
} from "../file-viewer-registry.js";
import { VIEWER_DELETE_RECHECK_MS } from "../file-viewer-session.js";
import { FakeHighlighterPort, FileApiFake, contentOf, ok } from "./viewer-harness.js";
import {
  FilesApiFake,
  listingOf,
  changedEvent,
} from "../../explorer/__tests__/explorer-harness.js";

let files: FileApiFake;
let tree: FilesApiFake;
let highlighter: FakeHighlighterPort;
let explorers: ExplorerRegistry;
let registry: FileViewerRegistry;

vi.mock("../../../../../lib/api/files.js", () => ({
  readProjectFile: (projectId: string, nodeId: string) =>
    files.readFile(projectId, nodeId),
  listProjectChildren: (input: Parameters<FilesApiFake["listChildren"]>[0]) =>
    tree.listChildren(input),
  watchProjectFiles: (input: Parameters<FilesApiFake["watchFile"]>[0]) =>
    tree.watchFile(input),
  unwatchProjectFiles: (subscriptionId: string) =>
    tree.unwatchFile({ subscriptionId }),
  onProjectFilesEvent: (
    subscriptionId: string,
    cb: Parameters<FilesApiFake["onFilesEvent"]>[1],
  ) => tree.onFilesEvent(subscriptionId, cb),
}));

function tabFor(index: number): WorkspaceFileTab {
  return {
    kind: "file",
    tabId: `tab-${String(index)}`,
    title: `f${String(index)}.ts`,
    relativePath: `src/f${String(index)}.ts`,
    nodeId: `node-${String(index)}`,
    dirty: false,
  };
}

async function flush(): Promise<void> {
  for (let step = 0; step < 20; step += 1) await Promise.resolve();
}

/**
 * Open a tab through the registry, read it to completion, then hide it.
 *
 * Shown before it is hidden, which is what stamps its LRU position: a session
 * that was never shown sorts as the coldest thing in the registry, and every
 * case below cares about the ORDER of the shows, not about that edge.
 */
async function openAndHide(index: number): Promise<void> {
  const tab = tabFor(index);
  const session = registry.acquire("p1", tab);
  void session.activate();
  await flush();
  registry.setActive(tab.tabId, true);
  await flush();
  registry.setActive(tab.tabId, false);
  await flush();
}

beforeEach(() => {
  files = new FileApiFake();
  files.responder = () => ok(contentOf("hello\n"));
  tree = new FilesApiFake();
  tree.listResponder = () => ({
    ok: true,
    data: { ok: true, value: listingOf([]) },
  });
  highlighter = new FakeHighlighterPort();
  // Highlights settle immediately: this suite is about held CONTENT, and a
  // manual port would leave every session stuck in `highlighting`.
  highlighter.manual = false;
  explorers = new ExplorerRegistry();
  registry = new FileViewerRegistry({
    createHighlighter: () => highlighter,
    explorers,
    // Teardown runs inline so a `release` in a test is observable at once.
    defer: (run) => {
      run();
    },
  });
});

afterEach(async () => {
  registry.disposeAll();
  await flush();
  vi.useRealTimers();
});

describe("the warm-tab bound", () => {
  it("holds every session while the count is within the bound", async () => {
    for (let index = 0; index < VIEWER_WARM_TABS_MAX; index += 1) {
      await openAndHide(index);
    }
    expect(registry.warmSessionCount()).toBe(VIEWER_WARM_TABS_MAX);
  });

  it("evicts the least recently shown hidden session past the bound", async () => {
    // Shown in order 0, 1, 2, 3 - so 0 is the coldest - then a fifth arrives.
    for (let index = 0; index <= VIEWER_WARM_TABS_MAX; index += 1) {
      await openAndHide(index);
    }

    expect(registry.warmSessionCount()).toBe(VIEWER_WARM_TABS_MAX);
    // The COLDEST one lost its content; the most recent kept it.
    expect(registry.has("tab-0")).toBe(true);
    expect(registry.acquire("p1", tabFor(0)).getState().kind).toBe("idle");
    registry.release("tab-0");
    expect(
      registry.acquire("p1", tabFor(VIEWER_WARM_TABS_MAX)).getState().kind,
    ).toBe("ready");
    registry.release(`tab-${String(VIEWER_WARM_TABS_MAX)}`);
  });

  it("never evicts the ACTIVE tab, even when it is the coldest", async () => {
    // Tab 0 is shown first and STAYS shown; four more are shown and hidden
    // after it, so by last-shown order tab 0 is the oldest of the five.
    const first = tabFor(0);
    const session = registry.acquire("p1", first);
    void session.activate();
    await flush();
    registry.setActive(first.tabId, true);
    await flush();

    for (let index = 1; index <= VIEWER_WARM_TABS_MAX; index += 1) {
      await openAndHide(index);
    }

    expect(session.getState().kind).toBe("ready");
    expect(session.holdsEvictableContent()).toBe(true);
  });

  it("never evicts an ORPHAN, whose bytes cannot be read back", async () => {
    vi.useFakeTimers();
    const tab = tabFor(0);
    const orphan = registry.acquire("p1", tab);
    void orphan.activate();
    await flush();
    registry.setActive(tab.tabId, true);
    await flush();

    // Delete the file, let the re-check confirm it, and confirm the session is
    // holding the last bytes the user saw.
    files.responder = () => ({
      ok: true,
      data: { ok: false, code: "not_found" as const },
    });
    tree.emit(changedEvent([{ path: "src/f0.ts", kind: "deleted" }], { batchSeq: 1 }));
    await vi.advanceTimersByTimeAsync(VIEWER_DELETE_RECHECK_MS + 5);
    await flush();
    expect(orphan.getState().kind).toBe("orphaned");

    vi.useRealTimers();
    registry.setActive(tab.tabId, false);
    files.responder = () => ok(contentOf("hello\n"));
    for (let index = 1; index <= VIEWER_WARM_TABS_MAX + 1; index += 1) {
      await openAndHide(index);
    }

    // Still orphaned, still holding the last contents. Releasing them would
    // turn the orphan notice into a bare `not_found` on the next show.
    expect(orphan.getState().kind).toBe("orphaned");
  });

  it("re-reads an evicted tab when it is shown again", async () => {
    for (let index = 0; index <= VIEWER_WARM_TABS_MAX; index += 1) {
      await openAndHide(index);
    }
    const evicted = registry.acquire("p1", tabFor(0));
    expect(evicted.getState().kind).toBe("idle");

    const readsBefore = files.readCount;
    registry.setActive("tab-0", true);
    await flush();

    expect(files.readCount).toBe(readsBefore + 1);
    expect(evicted.getState().kind).toBe("ready");
    registry.release("tab-0");
  });

  it("keeps the tab's identity across an eviction", async () => {
    for (let index = 0; index <= VIEWER_WARM_TABS_MAX; index += 1) {
      await openAndHide(index);
    }
    const evicted = registry.acquire("p1", tabFor(0));
    // Metadata is `readonly` on the session and survives by construction; the
    // assertion is here because a future eviction that disposed instead of
    // releasing would still pass every other case in this file.
    expect(evicted.tabId).toBe("tab-0");
    expect(evicted.relativePath).toBe("src/f0.ts");
    expect(evicted.nodeId).toBe("node-0");
    registry.release("tab-0");
  });
});
