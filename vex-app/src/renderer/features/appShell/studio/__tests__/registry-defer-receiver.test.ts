/**
 * The registries' default teardown deferral must call the platform's
 * `queueMicrotask` WITHOUT a receiver.
 *
 * In the built app, closing any file tab replaced the whole project workspace
 * with the recovery card ("TypeError: Illegal invocation", audit finding B6):
 * both registries stored the global `queueMicrotask` in a private field and
 * invoked it as `this.#defer(run)`, so Chromium's implementation received the
 * registry as `this` and refused. Node's `queueMicrotask` ignores its receiver,
 * which is why every vitest suite stayed green through the defect.
 *
 * This suite closes that gap deterministically: it replaces `queueMicrotask`
 * with a function that enforces Chromium's receiver rule, then drives the REAL
 * acquire/release path of each registry with its DEFAULT deferral. It is red
 * with the stored-function defaults and green with the wrapped ones.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExplorerRegistry } from "../explorer/explorer-registry.js";
import { FileViewerRegistry } from "../viewer/file-viewer-registry.js";
import type { WorkspaceFileTab } from "../workspace/types.js";
import { FakeHighlighterPort } from "../viewer/__tests__/viewer-harness.js";

// Neither registry reaches the files API before activation, but the modules
// import it; the mock keeps this suite off the window-wide bridge.
vi.mock("../../../../lib/api/files.js", () => ({
  readProjectFile: vi.fn(),
  listProjectChildren: vi.fn(),
  watchProjectFiles: vi.fn(),
  unwatchProjectFiles: vi.fn(),
  onProjectFilesEvent: vi.fn(),
}));

const TAB: WorkspaceFileTab = {
  kind: "file",
  tabId: "tab-1",
  title: "a.ts",
  relativePath: "src/a.ts",
  nodeId: "node-1",
  dirty: false,
};

const realQueueMicrotask = globalThis.queueMicrotask;
let queued: (() => void)[];

/**
 * Chromium's rule: `queueMicrotask` is a WindowOrWorkerGlobalScope method and
 * throws "Illegal invocation" when its receiver is anything but the global
 * (or undefined, the receiver of a plain call in strict code).
 */
function strictQueueMicrotask(this: unknown, callback: () => void): void {
  if (this !== undefined && this !== globalThis) {
    throw new TypeError("Illegal invocation");
  }
  queued.push(callback);
}

beforeEach(() => {
  queued = [];
  vi.stubGlobal("queueMicrotask", strictQueueMicrotask);
});

afterEach(() => {
  vi.stubGlobal("queueMicrotask", realQueueMicrotask);
  vi.unstubAllGlobals();
});

describe("the strict stand-in itself", () => {
  it("throws exactly the way Chromium does when the function is invoked as a method", () => {
    // The defect's shape, reproduced on the stand-in so the suite is known to
    // have teeth: a stored function called through an object receiver.
    const holder = { defer: globalThis.queueMicrotask };
    expect(() => holder.defer(() => undefined)).toThrow(TypeError);
    expect(() => globalThis.queueMicrotask(() => undefined)).not.toThrow();
  });
});

describe("ExplorerRegistry's default deferral", () => {
  it("survives Chromium's receiver rule on the last release", () => {
    const registry = new ExplorerRegistry();
    registry.acquire("p1");
    expect(() => registry.release("p1")).not.toThrow();
    expect(queued).toHaveLength(1);
    for (const run of queued.splice(0)) run();
    expect(registry.sessionCount()).toBe(0);
  });
});

describe("FileViewerRegistry's default deferral", () => {
  it("survives Chromium's receiver rule on the last release", () => {
    const highlighter = new FakeHighlighterPort();
    const registry = new FileViewerRegistry({
      createHighlighter: () => highlighter,
      explorers: new ExplorerRegistry(),
    });
    registry.acquire("p1", TAB);
    expect(() => registry.release(TAB.tabId)).not.toThrow();
    expect(queued).toHaveLength(1);
    for (const run of queued.splice(0)) run();
    expect(registry.sessionCount()).toBe(0);
  });
});
