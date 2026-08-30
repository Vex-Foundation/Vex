/**
 * Shared test scaffolding for the explorer suites.
 *
 * Three of these pieces are ported from the stage-B3 spike, which is deleted in
 * the same change: the fixed-viewport virtualizer observers, the render
 * counters and the 50k-node tree builder. They earned their keep by being the
 * only way to drive a virtualizer and count commits under jsdom, and the
 * measurement they served is what ratified the model this folder now ships.
 *
 * The fourth piece, {@link FilesApiFake}, is new: a scripted stand-in for
 * `lib/api/files.ts` that records CALL ORDER (the activation contract is an
 * order) and can hold a listing open (the publication fence can only be tested
 * while a request is in flight).
 */

import type {
  FileListing,
  FileNode,
  FilesErrorCode,
  FilesEvent,
  FilesOutcome,
  FilesSubscription,
  FilesWatcherReason,
  FilesWatcherState,
  FilesWatcherWarning,
} from "@shared/schemas/files.js";
import type { Result } from "@shared/ipc/result.js";

/* ------------------------------------------------------------------ *
 * The virtual window (ported from the spike)
 * ------------------------------------------------------------------ */

/**
 * jsdom has no layout: every element measures 0x0, so @tanstack/react-virtual
 * computes a zero-height viewport and renders nothing at all. These observers
 * feed it a fixed 300x600 viewport at scroll offset 0, which is exactly the
 * quantity the virtualization assertions are about.
 *
 * What jsdom CANNOT prove, and no test here claims: real measurement, real
 * scrolling, or paint cost.
 */
export const TEST_VIEWPORT_HEIGHT = 600;
export const TEST_VIEWPORT_WIDTH = 300;

const fixedRect = { width: TEST_VIEWPORT_WIDTH, height: TEST_VIEWPORT_HEIGHT };

export const testViewport = {
  observeElementRect: (
    _instance: unknown,
    cb: (rect: { width: number; height: number }) => void,
  ): (() => void) => {
    cb(fixedRect);
    return () => undefined;
  },
  observeElementOffset: (
    _instance: unknown,
    cb: (offset: number, isScrolling: boolean) => void,
  ): (() => void) => {
    cb(0, false);
    return () => undefined;
  },
};

/* ------------------------------------------------------------------ *
 * Render counters (ported from the spike)
 * ------------------------------------------------------------------ */

export interface RenderCounters {
  listRenders: number;
  readonly rowRenders: Map<string, number>;
  reset: () => void;
  totalRowRenders: () => number;
  distinctRows: () => number;
}

export function createRenderCounters(): RenderCounters {
  const rowRenders = new Map<string, number>();
  const counters: RenderCounters = {
    listRenders: 0,
    rowRenders,
    reset: () => {
      counters.listRenders = 0;
      rowRenders.clear();
    },
    totalRowRenders: () => [...rowRenders.values()].reduce((sum, n) => sum + n, 0),
    distinctRows: () => rowRenders.size,
  };
  return counters;
}

export function countRow(counters: RenderCounters, id: string): void {
  counters.rowRenders.set(id, (counters.rowRenders.get(id) ?? 0) + 1);
}

/* ------------------------------------------------------------------ *
 * Node and listing builders
 * ------------------------------------------------------------------ */

export function fileNode(name: string, path = name): FileNode {
  return { nodeId: `id:${path}`, name, path, kind: "file", size: 12, modifiedMs: 1 };
}

export function directoryNode(name: string, path = name): FileNode {
  return { nodeId: `id:${path}`, name, path, kind: "directory", size: null, modifiedMs: null };
}

export function listingOf(
  children: readonly FileNode[],
  overrides: Partial<Omit<FileListing, "children">> = {},
): FileListing {
  return {
    children: [...children],
    hasMore: false,
    nextCursor: null,
    totalCount: children.length,
    excludedCount: 0,
    ...overrides,
  };
}

export function subscription(
  overrides: Partial<FilesSubscription> = {},
): FilesSubscription {
  return {
    subscriptionId: "sub-1",
    watcherGeneration: 1,
    state: "watching",
    warnings: [],
    ...overrides,
  };
}

/* ------------------------------------------------------------------ *
 * Event builders
 * ------------------------------------------------------------------ */

export function changedEvent(
  changes: readonly { path: string; kind: "added" | "updated" | "deleted" }[],
  overrides: {
    batchSeq?: number;
    watcherGeneration?: number;
    overflowed?: boolean;
    droppedCount?: number;
    subscriptionId?: string;
  } = {},
): FilesEvent {
  return {
    kind: "changed",
    subscriptionId: overrides.subscriptionId ?? "sub-1",
    projectId: "p1",
    watcherGeneration: overrides.watcherGeneration ?? 1,
    batchSeq: overrides.batchSeq ?? 0,
    changes: changes.map((change) => ({
      path: change.path,
      kind: change.kind,
      nodeId: `id:${change.path}`,
    })),
    overflowed: overrides.overflowed ?? false,
    droppedCount: overrides.droppedCount ?? 0,
  };
}

export function resyncEvent(
  reason: "watcher_restarted" | "root_resumed" | "overflow",
  overrides: { watcherGeneration?: number; droppedCount?: number } = {},
): FilesEvent {
  return {
    kind: "resync",
    subscriptionId: "sub-1",
    projectId: "p1",
    watcherGeneration: overrides.watcherGeneration ?? 1,
    reason,
    droppedCount: overrides.droppedCount ?? 0,
  };
}

export function statusEvent(
  state: FilesWatcherState,
  overrides: {
    warnings?: readonly FilesWatcherWarning[];
    watcherGeneration?: number;
    reason?: FilesWatcherReason;
  } = {},
): FilesEvent {
  return {
    kind: "status",
    subscriptionId: "sub-1",
    projectId: "p1",
    watcherGeneration: overrides.watcherGeneration ?? 1,
    state,
    reason: overrides.reason ?? "started",
    warnings: [...(overrides.warnings ?? [])],
  };
}

/* ------------------------------------------------------------------ *
 * The files API fake
 * ------------------------------------------------------------------ */

export interface ListCall {
  readonly projectId: string;
  readonly nodeId: string | null;
  readonly limit: number | undefined;
  readonly cursor: string | null | undefined;
}

interface PendingList {
  readonly call: ListCall;
  readonly settle: (result: Result<FilesOutcome<FileListing>>) => void;
  /** Reject rather than answer. The bridge can do this; only a fake can drive it. */
  readonly fail: (error: unknown) => void;
}

/**
 * A scripted `lib/api/files.ts`.
 *
 * `calls` is the ORDERED log, because the activation contract is an order
 * (watch, then listen, then list) and an unordered set of counts cannot express
 * it. `manual` holds every listing open so a test can deactivate a session
 * while a request is in flight, which is the only way to observe the
 * publication fence doing its job.
 */
export class FilesApiFake {
  /** Ordered: "watch", "listen", "list:<nodeId>", "unwatch", "off". */
  readonly calls: string[] = [];
  readonly listCalls: ListCall[] = [];
  readonly pendingLists: PendingList[] = [];

  /** When true, `listChildren` does not resolve until `settleNextList` is called. */
  manual = false;

  /** What a watch answers. Replace to script a refusal or a degraded state. */
  watchResult: Result<FilesOutcome<FilesSubscription>> = {
    ok: true,
    data: { ok: true, value: subscription() },
  };

  /** What a listing answers, by parent node id (`null` is the root). */
  listResponder: (call: ListCall) => Result<FilesOutcome<FileListing>> = () => ({
    ok: true,
    data: { ok: true, value: listingOf([]) },
  });

  #listeners = new Map<string, (event: FilesEvent) => void>();

  get watchCount(): number {
    return this.calls.filter((entry) => entry === "watch").length;
  }

  get listenCount(): number {
    return this.calls.filter((entry) => entry === "listen").length;
  }

  get unwatchCount(): number {
    return this.calls.filter((entry) => entry === "unwatch").length;
  }

  get offCount(): number {
    return this.calls.filter((entry) => entry === "off").length;
  }

  /** Listings for one parent, so a test can assert the limit a refresh used. */
  listCallsFor(nodeId: string | null): ListCall[] {
    return this.listCalls.filter((call) => call.nodeId === nodeId);
  }

  listChildren(input: {
    projectId: string;
    nodeId: string | null;
    limit?: number;
    cursor?: string | null;
  }): Promise<Result<FilesOutcome<FileListing>>> {
    const call: ListCall = {
      projectId: input.projectId,
      nodeId: input.nodeId,
      limit: input.limit,
      cursor: input.cursor,
    };
    this.calls.push(`list:${input.nodeId ?? "root"}`);
    this.listCalls.push(call);
    if (!this.manual) return Promise.resolve(this.listResponder(call));
    return new Promise((resolve, reject) => {
      this.pendingLists.push({ call, settle: resolve, fail: reject });
    });
  }

  /** Resolve the oldest held listing. Defaults to whatever `listResponder` says. */
  settleNextList(result?: Result<FilesOutcome<FileListing>>): void {
    const pending = this.pendingLists.shift();
    if (pending === undefined) throw new Error("no listing is in flight");
    pending.settle(result ?? this.listResponder(pending.call));
  }

  /**
   * REJECT the oldest held listing.
   *
   * A rejection is not a refusal: it is the call itself failing to complete,
   * which the bridge can produce where a `FilesOutcome` was expected. The
   * session has to treat it as a transport failure rather than swallow it, and
   * this is the only way to make one happen.
   */
  rejectNextList(error: Error = new Error("the bridge rejected")): void {
    const pending = this.pendingLists.shift();
    if (pending === undefined) throw new Error("no listing is in flight");
    pending.fail(error);
  }

  watchFile(_input: {
    projectId: string;
    nodeId: string | null;
  }): Promise<Result<FilesOutcome<FilesSubscription>>> {
    this.calls.push("watch");
    return Promise.resolve(this.watchResult);
  }

  unwatchFile(_input: { subscriptionId: string }): Promise<Result<FilesOutcome<null>>> {
    this.calls.push("unwatch");
    return Promise.resolve({ ok: true, data: { ok: true, value: null } });
  }

  onFilesEvent(subscriptionId: string, cb: (event: FilesEvent) => void): () => void {
    this.calls.push("listen");
    this.#listeners.set(subscriptionId, cb);
    return () => {
      this.calls.push("off");
      this.#listeners.delete(subscriptionId);
    };
  }

  /** Push an event as main would. Throws when nobody is listening, which is the bug. */
  emit(event: FilesEvent): void {
    const listener = this.#listeners.get(event.subscriptionId);
    if (listener === undefined) {
      throw new Error(`no listener for subscription ${event.subscriptionId}`);
    }
    listener(event);
  }

  hasListener(subscriptionId: string): boolean {
    return this.#listeners.has(subscriptionId);
  }

  reset(): void {
    this.calls.length = 0;
    this.listCalls.length = 0;
    this.pendingLists.length = 0;
    this.#listeners.clear();
    this.manual = false;
  }
}

/** A listing that refuses, as an answer about the folder rather than a failure. */
export function refusal(code: FilesErrorCode): Result<FilesOutcome<FileListing>> {
  return { ok: true, data: { ok: false, code } };
}

/** A listing that could not be made at all. Distinct from a refusal. */
export function transportFailure(): Result<FilesOutcome<FileListing>> {
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

/* ------------------------------------------------------------------ *
 * The 50k-node tree (ported from the spike)
 * ------------------------------------------------------------------ */

export interface TreeFixture {
  /** Parent path ("" is the root) -> that directory's children, in order. */
  readonly children: Map<string, FileNode[]>;
  readonly totalNodes: number;
  /** A folder with 10,400 direct children: the splice subject. */
  readonly bigFolderPath: string;
}

/** Mulberry32: deterministic, so every run builds the same tree. */
function makeRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build a synthetic workspace of roughly `targetNodes` entries, then guarantee
 * one folder with 10,400 direct children so "expanded with 10k visible rows" is
 * a FACT of the fixture rather than an accident of the random shape.
 */
export function buildTreeFixture(targetNodes = 50_000): TreeFixture {
  const random = makeRandom(0x5e1f00d);
  const children = new Map<string, FileNode[]>();
  children.set("", []);

  let created = 0;
  const queue: { path: string; depth: number }[] = [{ path: "", depth: 0 }];
  while (created < targetNodes && queue.length > 0) {
    const parent = queue.shift();
    if (parent === undefined) break;
    const maxDepth = 6 + Math.floor(random() * 3);
    const count = 4 + Math.floor(random() * 9);
    const list = children.get(parent.path) ?? [];
    for (let index = 0; index < count && created < targetNodes; index += 1) {
      created += 1;
      const canRecurse = parent.depth + 1 < maxDepth;
      const isFolder = canRecurse && random() < 0.5;
      const name = isFolder ? `dir-${String(created)}` : `file-${String(created)}.ts`;
      const path = parent.path === "" ? name : `${parent.path}/${name}`;
      list.push(isFolder ? directoryNode(name, path) : fileNode(name, path));
      if (isFolder) {
        children.set(path, []);
        queue.push({ path, depth: parent.depth + 1 });
      }
    }
    children.set(parent.path, list);
  }

  const bigFolderPath = "dir-big";
  const root = children.get("") ?? [];
  root.push(directoryNode("dir-big", bigFolderPath));
  children.set("", root);
  const big: FileNode[] = [];
  for (let index = 0; index < 10_400; index += 1) {
    const name = `big-${String(index)}.ts`;
    big.push(fileNode(name, `${bigFolderPath}/${name}`));
  }
  children.set(bigFolderPath, big);

  let totalNodes = 0;
  for (const list of children.values()) totalNodes += list.length;
  return { children, totalNodes, bigFolderPath };
}

/**
 * A listing responder over a {@link TreeFixture}.
 *
 * Serves whole directories in one page, which is what makes the splice suite
 * about the MODEL's cost rather than about pagination. Paging is exercised by
 * its own cases in the session and component suites.
 */
export function fixtureResponder(
  fixture: TreeFixture,
): (call: ListCall) => Result<FilesOutcome<FileListing>> {
  const pathById = new Map<string, string>();
  for (const [parentPath, list] of fixture.children) {
    pathById.set(`id:${parentPath}`, parentPath);
    for (const node of list) pathById.set(node.nodeId, node.path);
  }
  return (call) => {
    const path = call.nodeId === null ? "" : (pathById.get(call.nodeId) ?? "");
    const list = fixture.children.get(path) ?? [];
    return { ok: true, data: { ok: true, value: listingOf(list, { totalCount: list.length }) } };
  };
}
