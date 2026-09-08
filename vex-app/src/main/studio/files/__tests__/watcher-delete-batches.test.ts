import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FILES_AGGREGATION_MS,
  FILES_EMIT_THROTTLE_MS,
  FILES_RAW_EVENTS_MAX,
  FILES_WATCHER_RESTART_DELAY_MS,
} from "@shared/schemas/files.js";

import {
  ProjectFileWatcher,
  type NativeEvent,
  type ProjectFileWatcherOptions,
  type WatcherEmission,
} from "../watcher.js";

const ROOT = path.resolve(os.tmpdir(), "vex-scripted-delete-project");
const watchers: ProjectFileWatcher[] = [];
const directories: string[] = [];

function harness(options: {
  readonly realRoot?: string;
  readonly isPathMissing?: ProjectFileWatcherOptions["isPathMissing"];
} = {}) {
  const root = options.realRoot ?? ROOT;
  const emissions: WatcherEmission[] = [];
  const callbacks: Array<(error: Error | null, events: NativeEvent[]) => void> = [];
  let appeared: (() => void) | undefined;
  const watcher = new ProjectFileWatcher({
    projectId: "scripted-delete-project",
    realRoot: root,
    ignore: [],
    subscribeNative: (_directory, callback) => {
      callbacks.push(callback);
      return Promise.resolve({ unsubscribe: () => Promise.resolve() });
    },
    rootExists: () => Promise.resolve(true),
    pollForRoot: (_directory, onAppeared) => {
      appeared = onAppeared;
      return () => { appeared = undefined; };
    },
    ...(options.isPathMissing === undefined ? {} : { isPathMissing: options.isPathMissing }),
    emit: (emission) => { emissions.push(emission); },
  });
  watchers.push(watcher);
  return {
    watcher,
    emissions,
    deliver: (relativePaths: readonly string[], type: NativeEvent["type"] = "delete") => {
      callbacks.at(-1)?.(null, relativePaths.map((relativePath) => ({
        path: path.join(root, ...relativePath.split("/")),
        type,
      })));
    },
    fail: (cause: Error) => { callbacks.at(-1)?.(cause, []); },
    appearRoot: () => { appeared?.(); },
    changes: () => emissions.flatMap((emission) => emission.payload.kind === "changed"
      ? emission.payload.changes
      : []),
  };
}

// Drain aggregation and emission independently of wall time. The next native
// batch is delivered only after assertions establish the first was published.
async function drainBatch(): Promise<void> {
  await vi.advanceTimersByTimeAsync(FILES_AGGREGATION_MS + FILES_EMIT_THROTTLE_MS);
}

beforeEach(() => { vi.useFakeTimers(); });

afterEach(async () => {
  await Promise.all(watchers.splice(0).map((watcher) => watcher.dispose()));
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe("directory deletion across native batches", () => {
  it.each([
    ["only the leaf", ["tree/inner/leaf.txt"]],
    ["only the inner directory", ["tree/inner"]],
    ["only the parent", ["tree"]],
    ["parent before descendants", ["tree", "tree/inner", "tree/inner/leaf.txt"]],
  ] as const)("reports the highest missing directory when the OS sends %s", async (_label, paths) => {
    const h = harness({ isPathMissing: (absolutePath) => absolutePath !== ROOT });
    await h.watcher.start();

    h.deliver(paths);
    await drainBatch();

    expect(h.changes()).toEqual([{ path: "tree", kind: "deleted" }]);
  });

  it("suppresses a delayed parent and child after the first deletion batch drained", async () => {
    const h = harness({ isPathMissing: (absolutePath) => absolutePath !== ROOT });
    await h.watcher.start();

    h.deliver(["tree/inner/leaf.txt"]);
    await drainBatch();
    expect(h.changes()).toEqual([{ path: "tree", kind: "deleted" }]);

    h.deliver(["tree"]);
    await drainBatch();
    h.deliver(["tree/inner"]);
    await drainBatch();

    expect(h.changes()).toEqual([{ path: "tree", kind: "deleted" }]);
  });

  it("reports a second deletion after the directory is recreated", async () => {
    let missing = true;
    const h = harness({ isPathMissing: (absolutePath) => absolutePath !== ROOT && missing });
    await h.watcher.start();
    h.deliver(["tree/inner/leaf.txt"]);
    await drainBatch();
    expect(h.changes()).toEqual([{ path: "tree", kind: "deleted" }]);

    missing = false;
    h.deliver(["tree"], "create");
    await drainBatch();
    missing = true;
    h.deliver(["tree/inner/leaf.txt"]);
    await drainBatch();

    expect(h.changes()).toEqual([
      { path: "tree", kind: "deleted" },
      { path: "tree", kind: "added" },
      { path: "tree", kind: "deleted" },
    ]);
  });

  it("starts deletion history afresh after a native watcher restart", async () => {
    const h = harness({ isPathMissing: (absolutePath) => absolutePath !== ROOT });
    await h.watcher.start();
    h.deliver(["tree/inner/leaf.txt"]);
    await drainBatch();
    expect(h.changes()).toEqual([{ path: "tree", kind: "deleted" }]);

    h.fail(Object.assign(new Error("read failed"), { code: "EIO" }));
    await vi.advanceTimersByTimeAsync(FILES_WATCHER_RESTART_DELAY_MS + 1);
    expect(h.watcher.currentGeneration).toBe(1);
    h.deliver(["tree/inner/leaf.txt"]);
    await drainBatch();

    expect(h.changes()).toEqual([
      { path: "tree", kind: "deleted" },
      { path: "tree", kind: "deleted" },
    ]);
  });

  it("starts deletion history afresh after the root vanishes and returns", async () => {
    const h = harness({ isPathMissing: (absolutePath) => absolutePath !== ROOT });
    await h.watcher.start();
    h.deliver(["tree/inner/leaf.txt"]);
    await drainBatch();
    expect(h.changes()).toEqual([{ path: "tree", kind: "deleted" }]);

    h.deliver([""]);
    expect(h.watcher.currentState).toBe("suspended");
    h.appearRoot();
    await drainBatch();
    expect(h.watcher.currentState).toBe("watching");
    h.deliver(["tree/inner/leaf.txt"]);
    await drainBatch();

    expect(h.changes()).toEqual([
      { path: "tree", kind: "deleted" },
      { path: "", kind: "added" },
      { path: "tree", kind: "deleted" },
    ]);
  });

  it("emits nothing after disposal and does not share history with a new watcher", async () => {
    const options = { isPathMissing: (absolutePath: string) => absolutePath !== ROOT };
    const first = harness(options);
    await first.watcher.start();
    first.deliver(["tree/inner/leaf.txt"]);
    await drainBatch();
    expect(first.changes()).toEqual([{ path: "tree", kind: "deleted" }]);
    await first.watcher.dispose();
    first.deliver(["tree"]);
    await drainBatch();
    expect(first.changes()).toEqual([{ path: "tree", kind: "deleted" }]);

    const second = harness(options);
    await second.watcher.start();
    second.deliver(["tree/inner/leaf.txt"]);
    await drainBatch();
    expect(second.changes()).toEqual([{ path: "tree", kind: "deleted" }]);
  });

  it.each(["EACCES", "EIO", "ENOTDIR"])("routes %s from the disk probe through watcher failure recovery", async (code) => {
    const h = harness({ isPathMissing: () => { throw Object.assign(new Error("probe failed"), { code }); } });
    await h.watcher.start();
    h.deliver(["tree/inner/leaf.txt"]);
    await vi.advanceTimersByTimeAsync(FILES_AGGREGATION_MS + FILES_WATCHER_RESTART_DELAY_MS + 1);

    expect(h.changes()).toEqual([]);
    expect(h.watcher.currentGeneration).toBe(1);
    expect(h.emissions).toContainEqual({
      generation: 1,
      payload: { kind: "resync", reason: "watcher_restarted", droppedCount: 0 },
    });
  });

  it("discards the rest of a large native callback when a forced fold fails", async () => {
    let failProbe = true;
    const h = harness({ isPathMissing: () => {
      if (failProbe) {
        failProbe = false;
        throw Object.assign(new Error("probe failed"), { code: "EACCES" });
      }
      return false;
    } });
    await h.watcher.start();
    h.deliver([
      "tree/inner/leaf.txt",
      ...Array.from({ length: FILES_RAW_EVENTS_MAX + 2 }, (_, index) => `old-${String(index)}.txt`),
    ]);
    await drainBatch();
    expect(h.changes()).toEqual([]);

    await vi.advanceTimersByTimeAsync(FILES_WATCHER_RESTART_DELAY_MS);
    expect(h.watcher.currentGeneration).toBe(1);
    expect(h.changes()).toEqual([]);
    h.deliver(["current.txt"], "create");
    await drainBatch();
    expect(h.changes()).toEqual([{ path: "current.txt", kind: "added" }]);
  });
});

describe("directory deletion against the real disk boundary", () => {
  async function temporaryRoot(): Promise<string> {
    const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "vex-delete-boundary-"));
    directories.push(directory);
    return directory;
  }

  it("uses lstat to promote an incomplete delete only to the highest missing ancestor", async () => {
    const root = await temporaryRoot();
    await fs.mkdir(path.join(root, "kept/tree/inner"), { recursive: true });
    await fs.writeFile(path.join(root, "kept/tree/inner/leaf.txt"), "leaf");
    const h = harness({ realRoot: root });
    await h.watcher.start();
    await fs.rm(path.join(root, "kept/tree"), { recursive: true });

    h.deliver(["kept/tree/inner/leaf.txt"]);
    await drainBatch();

    expect(h.changes()).toEqual([{ path: "kept/tree", kind: "deleted" }]);
  });

  it("does not treat a surviving dangling directory link as a deleted ancestor", async () => {
    const root = await temporaryRoot();
    const target = path.join(root, "target");
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, "leaf.txt"), "leaf");
    await fs.symlink(target, path.join(root, "link"), process.platform === "win32" ? "junction" : "dir");
    const h = harness({ realRoot: root });
    await h.watcher.start();
    await fs.rm(target, { recursive: true });

    h.deliver(["link/leaf.txt"]);
    await drainBatch();

    expect(h.changes()).toEqual([{ path: "link/leaf.txt", kind: "deleted" }]);
    expect((await fs.lstat(path.join(root, "link"))).isSymbolicLink()).toBe(true);
  });
});
