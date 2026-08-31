/**
 * CLOSING a kept-alive workspace, which is an ORDERED operation.
 *
 * VS Code's close semantics, not its reload: the project's shells are ended and
 * reopening the project revives fresh ones carrying the restored screens. The
 * whole contract is therefore a sequence - the buffer-bearing snapshot is
 * committed while every pty is still running, and nothing may overwrite it
 * afterwards - so these tests assert on the bridge's ORDERED `ops` trace rather
 * than on its per-call arrays, which cannot express a "before".
 *
 * Its own file rather than more of `StudioWorkspaceController.test.tsx`: the
 * close is a contract between the controller, the project index and the centre,
 * it needs two mounted workspaces and a remount to state at all, and the
 * controller suite is already at 863 lines with its own subject.
 */

import { StrictMode } from "react";
import { act, render, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RenderResult } from "@testing-library/react";
import type { TerminalWorkspaceRestore } from "@shared/schemas/terminal.js";
import { StudioWorkspaceController } from "../StudioWorkspaceController.js";
import { TerminalRegistry } from "../terminal-registry.js";
import {
  clearProjectTerminals,
  takeProjectWorkspaceClose,
} from "../../workspace/project-terminals.js";
import {
  installMatchMedia,
  installResizeObserver,
  installTerminalBridge,
  type TerminalBridgeStub,
} from "./terminal-harness.js";

const noWebgl = { webglLoader: () => Promise.reject(new Error("no gl in jsdom")) };

let bridge: TerminalBridgeStub;
let registry: TerminalRegistry;

beforeEach(() => {
  installMatchMedia();
  installResizeObserver();
  bridge = installTerminalBridge();
  registry = new TerminalRegistry(noWebgl);
  // The index is a MODULE SINGLETON. A close handler left behind by the
  // previous test would be taken by this one and would kill into a dead tree.
  clearProjectTerminals();
  document.body.innerHTML = "";
});

afterEach(() => {
  clearProjectTerminals();
  vi.useRealTimers();
});

function renderController(projectId: string): RenderResult {
  return render(
    <StudioWorkspaceController projectId={projectId} registry={registry} />,
  );
}

/** Let the mount's restore settle, so persistence is no longer latched. */
async function settleRestore(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/**
 * Open terminals through the real "New terminal" affordance of ONE workspace.
 *
 * Scoped to that view's container because these tests mount two workspaces at
 * once, and an unscoped query would drive whichever one rendered first.
 */
async function openTerminals(
  view: RenderResult,
  terminalIds: readonly string[],
): Promise<void> {
  for (const [index, terminalId] of terminalIds.entries()) {
    bridge.nextCreate = {
      ok: true,
      value: { terminalId, pid: 100 + index, shellName: terminalId, cwd: "/w" },
    };
    await act(async () => {
      within(view.container)
        .getByRole("button", { name: "New terminal" })
        .click();
      await Promise.resolve();
    });
  }
}

/** Take and run the project's published close, failing loudly if none exists. */
async function closeWorkspace(projectId: string): Promise<void> {
  const close = takeProjectWorkspaceClose(projectId);
  if (close === null) throw new Error(`no close published for ${projectId}`);
  await act(async () => {
    await close();
  });
}

describe("closing a workspace ENDS its shells", () => {
  it("kills every terminal of the closed project and none of another's", async () => {
    const first = renderController("p1");
    const second = renderController("p2");
    await settleRestore();
    await openTerminals(first, ["a1", "a2"]);
    await openTerminals(second, ["b1"]);

    await closeWorkspace("p1");

    expect(bridge.kills.toSorted()).toEqual(["a1", "a2"]);
    // The other kept-alive workspace is untouched: a close is one project's
    // decision, and hidden workspaces keep their live ptys. Its close is still
    // published, so the index did not lose it to a neighbour's transition.
    expect(bridge.kills).not.toContain("b1");
    expect(takeProjectWorkspaceClose("p2")).not.toBeNull();
  });

  it("takes the handler ONCE, so a second close cannot kill again", async () => {
    const view = renderController("p1");
    await settleRestore();
    await openTerminals(view, ["a1"]);

    await closeWorkspace("p1");
    expect(bridge.kills).toEqual(["a1"]);

    // Take-once IS the concurrency control on this path: a second gesture
    // arriving while the first is still committing finds nothing to run.
    expect(takeProjectWorkspaceClose("p1")).toBeNull();
    expect(bridge.kills).toEqual(["a1"]);
  });

  it("kills nothing twice under a StrictMode double mount", async () => {
    render(
      <StrictMode>
        <StudioWorkspaceController projectId="p1" registry={registry} />
      </StrictMode>,
    );
    await settleRestore();

    bridge.nextCreate = {
      ok: true,
      value: { terminalId: "a1", pid: 1, shellName: "a1", cwd: "/w" },
    };
    await act(async () => {
      document
        .querySelectorAll<HTMLButtonElement>('button[aria-label="New terminal"]')
        .forEach((button) => {
          button.click();
        });
      await Promise.resolve();
    });

    await closeWorkspace("p1");

    // StrictMode's mount -> cleanup -> mount republishes the handler, and the
    // identity-checked unregister must not have left a second one behind.
    expect(bridge.kills).toEqual(["a1"]);
  });
});

describe("the close ORDERING: commit the buffers, THEN kill", () => {
  /**
   * THE test the ordering exists for.
   *
   * The host serializes a project's LIVE mirrors when it commits, so any
   * persist that lands after the kills writes a snapshot with no terminals in
   * it - over the one that carried the buffers. Three renderer writers could
   * do it: the debounce timer, the visibility flush, and the unmount flush that
   * runs when the centre removes the project from the kept-alive set. All three
   * are driven here, after the close, and the trace must still show exactly one
   * persist and it must be the first entry.
   */
  it("persists the FULL workspace before the first kill, and nothing after it", async () => {
    vi.useFakeTimers();
    const view = renderController("p1");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    for (const [index, terminalId] of ["a1", "a2"].entries()) {
      bridge.nextCreate = {
        ok: true,
        value: { terminalId, pid: index, shellName: terminalId, cwd: "/w" },
      };
      await act(async () => {
        within(view.container)
          .getByRole("button", { name: "New terminal" })
          .click();
        await vi.advanceTimersByTimeAsync(10);
      });
    }
    // Still inside the debounce window, so the close is what writes.
    expect(bridge.ops).toEqual([]);

    await closeWorkspace("p1");

    expect(bridge.ops[0]).toBe("persist:p1:2");
    expect(bridge.ops.slice(1).toSorted()).toEqual(["kill:a1", "kill:a2"]);

    // ---- now drive every writer that could clobber it ----
    await act(async () => {
      bridge.emitExit("a1", 0, null);
      bridge.emitExit("a2", 0, null);
      await vi.advanceTimersByTimeAsync(0);
    });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
    });
    // The centre's set transition, which unmounts the controller.
    await act(async () => {
      view.unmount();
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(bridge.ops.filter((op) => op.startsWith("persist:"))).toEqual([
      "persist:p1:2",
    ]);
    expect(bridge.ops.indexOf("persist:p1:2")).toBe(0);
  });

  it("writes NOTHING when the restore has not landed, so the snapshot survives", async () => {
    bridge.savedWorkspace = savedWorkspace();
    bridge.deferReadWorkspace = true;
    renderController("p1");
    await act(async () => {
      await Promise.resolve();
    });

    await closeWorkspace("p1");

    // An unhydrated workspace's state is EMPTY. Persisting it would overwrite
    // the very snapshot the mount was about to restore from.
    expect(bridge.ops.filter((op) => op.startsWith("persist:"))).toEqual([]);
  });
});

function savedWorkspace(): TerminalWorkspaceRestore {
  return {
    layout: {
      projectId: "p1",
      activeGroupIndex: 0,
      groups: [
        {
          groupId: "g1",
          orientation: "horizontal",
          activePaneIndex: 0,
          panes: [
            { terminalId: "t1", relativeSize: 0.5 },
            { terminalId: "t2", relativeSize: 0.5 },
          ],
        },
      ],
    },
    terminals: ["t1", "t2"].map((terminalId) => ({
      terminalId,
      title: terminalId,
      shellName: "bash",
      droppedRows: 0,
      reducedRows: 0,
    })),
    idMap: [],
  };
}

describe("reopening a closed project REVIVES through the existing path", () => {
  it("spawns a fresh set carrying the snapshot, not a reattach of the dead ids", async () => {
    bridge.savedWorkspace = savedWorkspace();
    const first = renderController("p1");
    await waitFor(() => {
      expect(bridge.reviveCount).toBe(1);
    });
    await settleRestore();
    // The first revive keeps the snapshot's ids, and they are the LIVE ptys.
    expect([...bridge.livePtys].toSorted()).toEqual(["t1", "t2"]);

    await closeWorkspace("p1");
    expect(bridge.kills.toSorted()).toEqual(["t1", "t2"]);
    expect([...bridge.livePtys]).toEqual([]);
    await act(async () => {
      first.unmount();
    });

    const attachesBeforeReopen = bridge.attaches.length;
    renderController("p1");
    await waitFor(() => {
      expect(bridge.reviveCount).toBe(2);
    });
    await settleRestore();

    // A SECOND revive, because nothing of the project is live any more - which
    // is the same condition main's `deriveOpen` applies. The ids are new, so
    // the reopen cannot be a reattach of the shells the close ended.
    expect([...bridge.livePtys].toSorted()).toEqual(["t1-revive2", "t2-revive2"]);
    expect(bridge.attaches.slice(attachesBeforeReopen).toSorted()).toEqual([
      "t1-revive2",
      "t2-revive2",
    ]);
  });
});
