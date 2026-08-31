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
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RenderResult } from "@testing-library/react";
import type { TerminalWorkspaceRestore } from "@shared/schemas/terminal.js";
import { StudioWorkspaceController } from "../StudioWorkspaceController.js";
import { TerminalRegistry } from "../terminal-registry.js";
import {
  clearProjectTerminals,
  peekProjectWorkspaceLifecycle,
} from "../../workspace/project-terminals.js";
import type { WorkspaceCloseOutcome } from "../../workspace/close-lifecycle.js";
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

/** The project's published lifecycle, failing loudly if none exists. */
function lifecycleOf(projectId: string): {
  close: () => Promise<WorkspaceCloseOutcome>;
  discard: () => void;
} {
  const published = peekProjectWorkspaceLifecycle(projectId);
  if (published === null) throw new Error(`no lifecycle published for ${projectId}`);
  return published;
}

/** Run the project's published close and return what it answered. */
async function closeWorkspace(projectId: string): Promise<WorkspaceCloseOutcome> {
  let outcome: WorkspaceCloseOutcome | null = null;
  await act(async () => {
    outcome = await lifecycleOf(projectId).close();
  });
  if (outcome === null) throw new Error("the close did not settle");
  return outcome;
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
    // decision, and hidden workspaces keep their live ptys. Its lifecycle is
    // still published, so the index did not lose it to a neighbour's
    // transition.
    expect(bridge.kills).not.toContain("b1");
    expect(peekProjectWorkspaceLifecycle("p2")).not.toBeNull();
  });

  it("a SECOND close of a settled workspace kills nothing again", async () => {
    const view = renderController("p1");
    await settleRestore();
    await openTerminals(view, ["a1"]);

    expect(await closeWorkspace("p1")).toEqual({ ok: true });
    expect(bridge.kills).toEqual(["a1"]);

    // The handle SURVIVES the close (a failed close has to be retryable), so
    // the phase - not the registry - is what stops a second commit and a
    // second kill.
    expect(await closeWorkspace("p1")).toEqual({ ok: true });
    expect(bridge.kills).toEqual(["a1"]);
    expect(bridge.ops.filter((op) => op.startsWith("persist:")).length).toBe(1);
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

/* ------------------------------------------------------------------ *
 * B4 review, finding W1: the close is answered, fenced and joinable
 * ------------------------------------------------------------------ */

describe("a close whose COMMIT was refused destroys nothing", () => {
  /**
   * THE data-loss proof.
   *
   * The close exists to put the buffers on disk before the shells end. When the
   * commit is refused the buffers are NOT on disk, so killing afterwards
   * destroys exactly what the ordering was protecting - and that is what the
   * shipped code did, because it ignored the outcome of its own persist.
   */
  it("kills nothing after a refused commit and leaves every shell running", async () => {
    const view = renderController("p1");
    await settleRestore();
    await openTerminals(view, ["a1", "a2"]);
    expect([...bridge.livePtys].toSorted()).toEqual(["a1", "a2"]);

    bridge.nextPersist = { ok: false, code: "host_unavailable" };
    const outcome = await closeWorkspace("p1");

    // THE DATA-LOSS ASSERTION FIRST, so a regression names the loss rather
    // than the outcome shape: not "no kill was recorded" but the shells are
    // still RUNNING, with the buffers that were never committed.
    expect([...bridge.livePtys].toSorted()).toEqual(["a1", "a2"]);
    expect(bridge.kills).toEqual([]);
    expect(outcome).toEqual({ ok: false, failure: "persist_refused" });
  });

  it("says so out loud, as an alert, and stays usable", async () => {
    const view = renderController("p1");
    await settleRestore();
    await openTerminals(view, ["a1"]);

    bridge.nextPersist = { ok: false, code: "host_unavailable" };
    await closeWorkspace("p1");

    // An ERROR, not a status: the user asked for something, it did not happen,
    // and their shells are still running.
    const alert = await within(view.container).findByRole("alert");
    expect(alert.textContent).toContain("nothing was closed");
    expect(alert.textContent).toContain("still running");
  });

  it("RETRIES: a second close after a refusal commits and kills", async () => {
    const view = renderController("p1");
    await settleRestore();
    await openTerminals(view, ["a1"]);

    bridge.nextPersist = { ok: false, code: "host_unavailable" };
    expect((await closeWorkspace("p1")).ok).toBe(false);

    bridge.nextPersist = { ok: true };
    expect(await closeWorkspace("p1")).toEqual({ ok: true });
    expect(bridge.kills).toEqual(["a1"]);
    expect([...bridge.livePtys]).toEqual([]);
  });

  it("a kill the host REFUSED fails the close, and one already gone does not", async () => {
    const view = renderController("p1");
    await settleRestore();
    await openTerminals(view, ["a1", "a2"]);

    bridge.killRefusals.set("a1", "host_unavailable");
    const refused = await closeWorkspace("p1");
    expect(refused).toEqual({ ok: false, failure: "kill_incomplete" });
    // The commit DID happen, so the retry is safe and the user is told so.
    expect(bridge.ops[0]).toBe("persist:p1:2");
    expect([...bridge.livePtys]).toEqual(["a1"]);

    // `unknown_terminal` is not a failure: it is the outcome a kill asked for,
    // and it is what a pty the user already exited answers.
    bridge.killRefusals.set("a1", "unknown_terminal");
    expect(await closeWorkspace("p1")).toEqual({ ok: true });
  });
});

describe("the LATE-CREATE fence: nothing escapes the kill set", () => {
  /**
   * A create issued before the close and landing after it.
   *
   * Without the fence its pty publishes into a workspace whose snapshot was
   * already captured and whose kills have already run: a shell holding a host
   * slot and a project lease that no pane names and nothing can ever close.
   */
  it("a create in flight when the close begins does not survive it", async () => {
    const view = renderController("p1");
    await settleRestore();
    await openTerminals(view, ["a1"]);

    // Issue a second create and HOLD it, which is the only way to stand inside
    // the window the fence is about.
    bridge.deferCreate = true;
    bridge.nextCreate = {
      ok: true,
      value: { terminalId: "late", pid: 9, shellName: "late", cwd: "/w" },
    };
    await act(async () => {
      within(view.container).getByRole("button", { name: "New terminal" }).click();
      await Promise.resolve();
    });
    expect(bridge.creates.length).toBe(2);

    // The close JOINS that create rather than racing it, so it cannot resolve
    // before the late pty has been dealt with.
    let settled: WorkspaceCloseOutcome | null = null;
    await act(async () => {
      const running = lifecycleOf("p1").close();
      await Promise.resolve();
      bridge.settleCreates();
      settled = await running;
    });

    expect(settled).toEqual({ ok: true });
    // The late terminal was created and then ENDED by its own publication
    // fence. Neither pty is left running, and the layout that was committed
    // never contained the late one.
    expect(bridge.kills.toSorted()).toEqual(["a1", "late"]);
    expect([...bridge.livePtys]).toEqual([]);
    // The COMMITTED LAYOUT holds one pane, not two: the late terminal never
    // published, so it is not in the snapshot - and the commit still happened
    // before the shell it saved was ended.
    expect(bridge.ops.filter((op) => op.startsWith("persist:"))).toEqual([
      "persist:p1:1",
    ]);
    expect(bridge.ops.indexOf("persist:p1:1")).toBeLessThan(
      bridge.ops.indexOf("kill:a1"),
    );
  });

  it("REFUSES a new terminal gesture made while the workspace is closing", async () => {
    const view = renderController("p1");
    await settleRestore();
    await openTerminals(view, ["a1"]);

    bridge.deferPersist = true;
    const creates = bridge.creates.length;
    await act(async () => {
      void lifecycleOf("p1").close();
      await Promise.resolve();
    });

    await act(async () => {
      within(view.container).getByRole("button", { name: "New terminal" }).click();
      await Promise.resolve();
    });
    // Refused at ADMISSION: no pty was ever asked for, so there is none to
    // strand, and the refusal is rendered by name.
    expect(bridge.creates.length).toBe(creates);
    expect(within(view.container).getByRole("status").textContent).toContain(
      "This workspace is closing",
    );

    await act(async () => {
      bridge.settlePersists();
      await Promise.resolve();
    });
  });
});

describe("a SECOND close JOINS the first", () => {
  /**
   * The take-once registration used to be the concurrency control, and it was
   * the bug: a second gesture arriving mid-commit found nothing, and the centre
   * read that as "no workspace is mounted" and unmounted the controller while
   * its layout was being written.
   */
  it("resolves both callers from ONE commit, and neither before it finished", async () => {
    const view = renderController("p1");
    await settleRestore();
    await openTerminals(view, ["a1"]);

    bridge.deferPersist = true;
    const settledOrder: string[] = [];
    let first: Promise<WorkspaceCloseOutcome> | null = null;
    let second: Promise<WorkspaceCloseOutcome> | null = null;
    await act(async () => {
      first = lifecycleOf("p1").close().then((outcome) => {
        settledOrder.push("first");
        return outcome;
      });
      await Promise.resolve();
      second = lifecycleOf("p1").close().then((outcome) => {
        settledOrder.push("second");
        return outcome;
      });
      await Promise.resolve();
    });

    // Mid-commit: NEITHER has resolved, so nothing downstream can unmount the
    // controller that owns the layout being written.
    expect(settledOrder).toEqual([]);
    expect(bridge.kills).toEqual([]);

    await act(async () => {
      bridge.settlePersists();
      await Promise.resolve();
      expect(await first).toEqual({ ok: true });
      expect(await second).toEqual({ ok: true });
    });

    expect(settledOrder.toSorted()).toEqual(["first", "second"]);
    // ONE commit and ONE kill, not two of each.
    expect(bridge.ops.filter((op) => op.startsWith("persist:"))).toEqual([
      "persist:p1:1",
    ]);
    expect(bridge.kills).toEqual(["a1"]);
  });
});

/* ------------------------------------------------------------------ *
 * B4 review, finding W2: a DELETED project never persists again
 * ------------------------------------------------------------------ */

describe("the DELETION latch", () => {
  /**
   * The chain this closes, measured end to end: the delete's cleanup removes
   * `<userData>/studio/terminal-snapshots/<projectId>.json`, the centre drops
   * the project from the kept-alive set, this controller unmounts, and its
   * teardown flush commits a layout - RECREATING a file that holds a deleted
   * project's terminal scrollback.
   */
  it("suppresses the unmount flush, the debounce and the visibility flush", async () => {
    vi.useFakeTimers();
    const view = renderController("p1");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    bridge.nextCreate = {
      ok: true,
      value: { terminalId: "a1", pid: 1, shellName: "a1", cwd: "/w" },
    };
    await act(async () => {
      within(view.container).getByRole("button", { name: "New terminal" }).click();
      await vi.advanceTimersByTimeAsync(10);
    });
    // Still inside the debounce window, so nothing has been written yet.
    expect(bridge.ops).toEqual([]);

    // What `StudioCenter.handleProjectDeleted` does, and it happens BEFORE the
    // unmount, which is the whole point: the unmount flush is one of the
    // writers being stopped.
    act(() => {
      lifecycleOf("p1").discard();
    });

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      view.unmount();
      await vi.advanceTimersByTimeAsync(5_000);
    });

    // NOTHING was written for a project whose snapshot main has just removed.
    expect(bridge.ops.filter((op) => op.startsWith("persist:"))).toEqual([]);
    // And no shell was killed from here: the delete's own close hook in main
    // has already ended them, under authority this renderer does not have.
    expect(bridge.kills).toEqual([]);
  });

  it("a close ARRIVING AFTER a delete writes nothing and reports settled", async () => {
    const view = renderController("p1");
    await settleRestore();
    await openTerminals(view, ["a1"]);

    act(() => {
      lifecycleOf("p1").discard();
    });
    const outcome = await closeWorkspace("p1");

    // Settled, so the centre unmounts the workspace of a project that is gone -
    // but no commit and no kill was issued for it.
    expect(outcome).toEqual({ ok: true });
    expect(bridge.ops).toEqual([]);
  });
});
