/**
 * THE FILE RENAME SIGNAL: parked by the explorer, taken by the workspace.
 *
 * The channel's two rules are the ones that decide whether a rename in one
 * project can retarget a tab in another, and whether React 19's StrictMode -
 * which invokes an effect twice, synchronously - applies the same rename twice.
 * Both are properties of this store alone, so they are proved here rather than
 * through a mounted controller: `explorer-mutations.test.ts` covers the publish
 * half from the session's side, and the controller's suite covers the consumer,
 * but neither can show what the store does with a signal it must NOT hand over.
 *
 * RED ON REVERT: drop the `projectId` comparison in `consumeFileRenameSignal`
 * and "leaves a signal for another project parked" fails; clear the slot before
 * the comparison and "leaves it parked for its owner" fails; return the signal
 * without clearing and "hands a signal over exactly once" fails.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  nextFileRenameSignalId,
  publishFileRename,
  useFileRenameSignalStore,
} from "../file-rename-signal.js";

const TO = {
  title: "after.ts",
  relativePath: "src/after.ts",
  nodeId: "node-src/after.ts",
} as const;

afterEach(() => {
  useFileRenameSignalStore.getState().clearFileRenameSignal();
});

describe("parking a confirmed rename", () => {
  it("parks the whole rename and names it with the id it returns", () => {
    const signalId = publishFileRename("p1", "src/before.ts", TO);

    expect(useFileRenameSignalStore.getState().signal).toEqual({
      signalId,
      projectId: "p1",
      fromRelativePath: "src/before.ts",
      to: TO,
    });
  });

  /**
   * Two renames in a row are two writes main has already ordered, and the
   * second is the one a workspace that has not run its effect yet should
   * apply. See the module note for why a queue here would be a second ordering
   * authority.
   */
  it("replaces whatever was parked", () => {
    publishFileRename("p1", "src/before.ts", TO);
    const second = publishFileRename("p1", "src/other.ts", TO);

    expect(useFileRenameSignalStore.getState().signal?.signalId).toBe(second);
    expect(useFileRenameSignalStore.getState().signal?.fromRelativePath).toBe(
      "src/other.ts",
    );
  });

  it("mints a fresh id every time", () => {
    expect(nextFileRenameSignalId()).not.toBe(nextFileRenameSignalId());
  });
});

describe("taking it", () => {
  it("hands a signal over exactly once", () => {
    const signalId = publishFileRename("p1", "src/before.ts", TO);
    const store = useFileRenameSignalStore.getState();

    expect(store.consumeFileRenameSignal(signalId, "p1")?.fromRelativePath).toBe(
      "src/before.ts",
    );
    // StrictMode's second effect pass finds nothing, which is what stops one
    // rename from being applied twice.
    expect(store.consumeFileRenameSignal(signalId, "p1")).toBeNull();
    expect(useFileRenameSignalStore.getState().signal).toBeNull();
  });

  /**
   * The project key, and the half that matters most: a foreign project's
   * workspace must not merely decline the signal, it must LEAVE IT for the
   * workspace that owns it. Clearing here would silently drop a rename the
   * right workspace was about to take.
   */
  it("leaves a signal for another project parked for its owner", () => {
    const signalId = publishFileRename("p2", "src/before.ts", TO);
    const store = useFileRenameSignalStore.getState();

    expect(store.consumeFileRenameSignal(signalId, "p1")).toBeNull();
    expect(useFileRenameSignalStore.getState().signal?.projectId).toBe("p2");
    expect(store.consumeFileRenameSignal(signalId, "p2")?.projectId).toBe("p2");
  });

  it("leaves a signal whose id does not match parked", () => {
    publishFileRename("p1", "src/before.ts", TO);
    const store = useFileRenameSignalStore.getState();

    expect(store.consumeFileRenameSignal("some-other-id", "p1")).toBeNull();
    expect(useFileRenameSignalStore.getState().signal).not.toBeNull();
  });

  it("answers null when nothing is parked", () => {
    expect(
      useFileRenameSignalStore.getState().consumeFileRenameSignal("anything", "p1"),
    ).toBeNull();
  });

  it("drops the parked rename on clear", () => {
    publishFileRename("p1", "src/before.ts", TO);
    useFileRenameSignalStore.getState().clearFileRenameSignal();

    expect(useFileRenameSignalStore.getState().signal).toBeNull();
  });
});
