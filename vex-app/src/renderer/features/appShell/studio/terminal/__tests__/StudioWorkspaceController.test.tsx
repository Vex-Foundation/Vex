/**
 * The controller: restore, refusal, persistence, and teardown.
 *
 * These four are where a workspace loses user work, and each has a specific way
 * of doing it that this suite is built to catch:
 *
 *  - a restore that equalizes pane shares silently un-does every split the user
 *    sized, and it looks like a rendering choice rather than data loss;
 *  - a keep-alive bound that EVICTS instead of refusing closes a running shell
 *    nobody asked to close;
 *  - a persist that fires before the restore has landed overwrites the snapshot
 *    it was about to read;
 *  - a teardown that KILLS instead of detaching ends every shell on a project
 *    switch.
 *
 * All four stay green under a naive implementation until someone reloads.
 */

import { StrictMode, type JSX } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type TerminalWorkspaceRestore,
} from "@shared/schemas/terminal.js";
import { WORKSPACE_KEEP_ALIVE_MAX } from "../../workspace/types.js";
import { StudioWorkspaceController } from "../StudioWorkspaceController.js";
import { TerminalRegistry } from "../terminal-registry.js";
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
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * A REVIVED workspace with two DELIBERATELY UNEQUAL panes in one group.
 *
 * This is what main returns from an open now: the terminals were revived as
 * live ptys and the layout names those, not the ids the snapshot was written
 * with.
 */
function savedWorkspace(): TerminalWorkspaceRestore {
  return {
    layout: {
      projectId: "p1",
      activeGroupIndex: 0,
      groups: [
        {
          groupId: "g1",
          orientation: "horizontal",
          activePaneIndex: 1,
          panes: [
            { terminalId: "t1", relativeSize: 0.75 },
            { terminalId: "t2", relativeSize: 0.25 },
          ],
        },
      ],
    },
    terminals: ["t1", "t2"].map((terminalId) => ({
      terminalId,
      title: terminalId === "t1" ? "vim" : "bash",
      shellName: "bash",
      droppedRows: 0,
      reducedRows: 0,
    })),
    idMap: ["t1", "t2"].map((terminalId) => ({
      from: `old-${terminalId}`,
      to: terminalId,
    })),
  };
}

function renderController(projectId = "p1") {
  return render(<StudioWorkspaceController projectId={projectId} registry={registry} />);
}

/**
 * The controller under StrictMode, whose double-invoked effects are PART of the
 * experiment for every lifecycle guard below: mount -> effect -> cleanup ->
 * effect is exactly the sequence that bumps the workspace generation twice and
 * that a release-disposes registry would use to destroy a live shell.
 */
function strictTree(projectId: string): JSX.Element {
  return (
    <StrictMode>
      <StudioWorkspaceController projectId={projectId} registry={registry} />
    </StrictMode>
  );
}

function renderStrict(projectId = "p1") {
  return render(strictTree(projectId));
}

/** Open `count` terminals through the real "New terminal" affordance. */
async function openTerminals(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    bridge.nextCreate = {
      ok: true,
      value: {
        terminalId: `t${String(index)}`,
        pid: 100 + index,
        shellName: `shell-${String(index)}`,
        cwd: "/w",
      },
    };
    await act(async () => {
      screen.getByRole("button", { name: "New terminal" }).click();
      await Promise.resolve();
    });
  }
}

describe("StudioWorkspaceController restore", () => {
  it("restores the layout with the PANE SHARES the user chose", async () => {
    bridge.savedWorkspace = savedWorkspace();
    renderController();

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /vim/ })).toBeTruthy();
    });

    const separator = screen.getByRole("separator");
    // 75/25, not 50/50. An equalizing restore would silently undo the split the
    // user sized, which is the whole reason the shares are persisted.
    expect(separator.getAttribute("aria-valuenow")).toBe("75");
    // Both terminals are live and each reattached itself; the layout and the
    // buffers restore through two independent paths.
    expect(bridge.attaches.toSorted()).toEqual(["t1", "t2"]);
  });

  it("starts empty when the project has no saved workspace", async () => {
    bridge.savedWorkspace = null;
    renderController();

    await waitFor(() => {
      expect(screen.queryAllByRole("tab")).toHaveLength(0);
    });
    expect(bridge.attaches).toEqual([]);
  });
});

describe("StudioWorkspaceController refusals", () => {
  it(`REFUSES past ${String(WORKSPACE_KEEP_ALIVE_MAX)} live groups instead of evicting one`, async () => {
    renderController();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "New terminal" })).toBeTruthy();
    });

    await openTerminals(WORKSPACE_KEEP_ALIVE_MAX);
    expect(screen.getAllByRole("tab")).toHaveLength(WORKSPACE_KEEP_ALIVE_MAX);

    const killsBefore = bridge.kills.length;
    await openTerminals(1);

    // The bound is announced, the existing tabs are untouched, and NOTHING was
    // killed to make room.
    expect(screen.getByRole("status").textContent).toContain("Close one");
    expect(screen.getAllByRole("tab")).toHaveLength(WORKSPACE_KEEP_ALIVE_MAX);
    expect(bridge.kills).toHaveLength(killsBefore);
  });

  it("names a host refusal by its remedy rather than as a generic failure", async () => {
    renderController();
    bridge.nextCreate = { ok: false, code: "limit_project_terminals" };

    await act(async () => {
      screen.getByRole("button", { name: "New terminal" }).click();
      await Promise.resolve();
    });

    const status = screen.getByRole("status");
    expect(status.textContent).toContain("maximum number of terminals");
    expect(status.textContent).toContain("Close one");
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
  });
});

describe("StudioWorkspaceController selection and cleanup", () => {
  it("selects the LEFT neighbour on close and KILLS only the closed tab's pty", async () => {
    renderController();
    await openTerminals(3);

    // The third tab is selected after creation; closing it must select the
    // second, not march the selection toward the end of the strip.
    await act(async () => {
      screen.getByRole("button", { name: "Close shell-2" }).click();
      await Promise.resolve();
    });

    expect(bridge.kills).toEqual(["t2"]);
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(2);
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");
  });

  it("DETACHES every terminal on unmount, and kills none", async () => {
    const view = renderController();
    await openTerminals(2);
    expect(bridge.detaches).toEqual([]);

    view.unmount();

    // A project switch or a mode switch is not a decision to end a shell: the
    // ptys survive their grace period and replay on return.
    expect(bridge.detaches.toSorted()).toEqual(["t0", "t1"]);
    expect(bridge.kills).toEqual([]);
    // EXACTLY ONE detach per terminal. Each attachment has a single owner (its
    // own host); a controller that also detached would make that two, and two
    // cleanup paths for one handle is how they eventually disagree.
  });
});

describe("StudioWorkspaceController persistence", () => {
  it("does not persist before the restore has landed", async () => {
    bridge.savedWorkspace = savedWorkspace();
    vi.useFakeTimers();
    renderController();

    // The very first render holds an EMPTY workspace. Writing it here would
    // overwrite the snapshot the restore is about to read.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(bridge.persisted.filter((layout) => layout.groups.length === 0)).toEqual([]);
  });

  it("COALESCES a burst of layout changes into one write", async () => {
    vi.useFakeTimers();
    renderController();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    for (let index = 0; index < 3; index += 1) {
      bridge.nextCreate = {
        ok: true,
        value: {
          terminalId: `t${String(index)}`,
          pid: index,
          shellName: `shell-${String(index)}`,
          cwd: "/w",
        },
      };
      await act(async () => {
        screen.getByRole("button", { name: "New terminal" }).click();
        await vi.advanceTimersByTimeAsync(10);
      });
    }
    // Still inside the debounce window: a splitter drag emits a mutation per
    // pointer move, and a write per move would put a file write on that path.
    expect(bridge.persisted).toHaveLength(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(bridge.persisted).toHaveLength(1);
    expect(bridge.persisted[0]?.groups).toHaveLength(3);
  });

  it("FLUSHES the pending write when the window is hidden", async () => {
    vi.useFakeTimers();
    renderController();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      screen.getByRole("button", { name: "New terminal" }).click();
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(bridge.persisted).toHaveLength(0);

    // `hidden` is the last moment the renderer is reliably alive: a window close
    // or a sleep may never give us the debounce window back.
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });

    expect(bridge.persisted).toHaveLength(1);
    expect(bridge.persisted[0]?.groups).toHaveLength(1);
  });
});

/**
 * THE INVISIBLE RUNNING SHELL, from all four directions it used to arrive from.
 *
 * A pty that exists while no pane references it holds a slot against the host's
 * per-project and global bounds and a lease against its project, and nothing in
 * the UI can ever reach it to close it. Each test below drives one of the
 * routes that produced one.
 */
describe("StudioWorkspaceController admissibility and the publication fence", () => {
  it("asks the model BEFORE the pty, so a refused group creates nothing", async () => {
    // F6a. The controller used to create the pty and only then ask whether it
    // could be placed; the refusal then left a live shell no pane named. The
    // notice alone does not catch that - only the absence of a create does.
    renderController();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "New terminal" })).toBeTruthy();
    });

    await openTerminals(WORKSPACE_KEEP_ALIVE_MAX);
    expect(screen.getAllByRole("tab")).toHaveLength(WORKSPACE_KEEP_ALIVE_MAX);
    const createsBefore = bridge.creates.length;

    await openTerminals(1);

    expect(screen.getByRole("status").textContent).toContain("Close one");
    expect(screen.getAllByRole("tab")).toHaveLength(WORKSPACE_KEEP_ALIVE_MAX);
    // No pty was ever ASKED FOR, so there is nothing left running that the UI
    // cannot reach.
    expect(bridge.creates).toHaveLength(createsBefore);
  });

  it("KILLS a split's terminal when its tab was closed while the create was in flight", async () => {
    // F6b. The destination tab is gone by the time the create lands, so the
    // completion is the only holder of that terminal id. Discarding it without
    // killing is precisely how the invisible shell was created.
    renderStrict();
    await openTerminals(1);

    bridge.nextCreate = {
      ok: true,
      value: { terminalId: "t-split", pid: 900, shellName: "bash", cwd: "/w" },
    };
    bridge.deferCreate = true;

    await act(async () => {
      screen.getByRole("button", { name: "Split shell-0 side by side" }).click();
      await Promise.resolve();
    });
    expect(bridge.creates).toHaveLength(2);
    expect(bridge.kills).not.toContain("t-split");

    await act(async () => {
      screen.getByRole("button", { name: "Close shell-0" }).click();
      await Promise.resolve();
    });

    await act(async () => {
      bridge.settleCreates();
      await Promise.resolve();
    });

    expect(bridge.kills).toContain("t-split");
    // And nothing renders it: the workspace has no tabs left at all.
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(registry.has("t-split")).toBe(false);
  });

  it("KILLS a create that lands after a project switch instead of leaking it into the new project", async () => {
    // F6c. A create issued for p1 that publishes into p2 would put one
    // project's terminal under another project's name, and p1 could never
    // reach it again.
    const view = renderStrict("p1");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "New terminal" })).toBeTruthy();
    });

    bridge.nextCreate = {
      ok: true,
      value: { terminalId: "t-p1", pid: 901, shellName: "bash", cwd: "/w" },
    };
    bridge.deferCreate = true;
    await act(async () => {
      screen.getByRole("button", { name: "New terminal" }).click();
      await Promise.resolve();
    });
    expect(bridge.creates).toHaveLength(1);

    await act(async () => {
      view.rerender(strictTree("p2"));
      await Promise.resolve();
    });

    await act(async () => {
      bridge.settleCreates();
      await Promise.resolve();
    });

    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(bridge.kills).toContain("t-p1");
  });

  it("does not let a SLOW RESTORE overwrite the workspace that replaced it", async () => {
    // F6d. The open revives rather than only reads, so a late restore would
    // both show p1's terminals under p2's name and destroy whatever the user
    // opened in p2 while it was in flight.
    bridge.savedWorkspace = savedWorkspace();
    bridge.deferReadWorkspace = true;
    const view = renderStrict("p1");
    await act(async () => {
      await Promise.resolve();
    });

    bridge.deferReadWorkspace = false;
    bridge.savedWorkspace = null;
    await act(async () => {
      view.rerender(strictTree("p2"));
      await Promise.resolve();
    });

    bridge.nextCreate = {
      ok: true,
      value: { terminalId: "t-p2", pid: 902, shellName: "p2-shell", cwd: "/w" },
    };
    await act(async () => {
      screen.getByRole("button", { name: "New terminal" }).click();
      await Promise.resolve();
    });
    expect(screen.getAllByRole("tab")).toHaveLength(1);

    await act(async () => {
      bridge.settleReads();
      await Promise.resolve();
    });

    // p1's revived tabs are nowhere, and p2's own tab survived the late answer.
    expect(screen.queryByRole("tab", { name: /vim/ })).toBeNull();
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.textContent).toContain("p2-shell");
  });
});

describe("StudioWorkspaceController terminal disposal", () => {
  it("DISPOSES the xterm when the user closes the tab, and kills the pty", async () => {
    // F6e. `release` deliberately never disposes, so before this fix a closed
    // tab's xterm, scrollback, theme observer, DOM wrapper and WebGL context
    // were retained for the life of the window by a registry no surviving
    // component could name.
    renderStrict();
    await openTerminals(1);
    expect(registry.has("t0")).toBe(true);

    await act(async () => {
      screen.getByRole("button", { name: "Close shell-0" }).click();
      await Promise.resolve();
    });

    expect(registry.has("t0")).toBe(false);
    expect(bridge.kills).toEqual(["t0"]);
  });

  it("only RELEASES on a plain unmount, so a StrictMode remount cannot destroy a live shell", async () => {
    // F6e, the negative half. Disposing on release would make a tab switch or
    // StrictMode's cleanup-then-effect throw away a terminal the user is still
    // using.
    const view = renderStrict();
    await openTerminals(1);
    expect(registry.has("t0")).toBe(true);

    view.unmount();

    expect(registry.has("t0")).toBe(true);
    expect(registry.consumerCount("t0")).toBe(0);
    expect(bridge.kills).toEqual([]);
  });

  it("kills and disposes NOTHING when closing the last pane is refused", async () => {
    // F6f. `closePane` refuses the last pane of a group; a pane that survives
    // the refusal while its terminal was killed would render a shell that no
    // longer exists.
    renderController();
    await openTerminals(1);

    bridge.nextCreate = {
      ok: true,
      value: { terminalId: "t-second", pid: 903, shellName: "bash", cwd: "/w" },
    };
    await act(async () => {
      screen.getByRole("button", { name: "Split shell-0 side by side" }).click();
      await Promise.resolve();
    });

    const paneCloses = screen.getAllByRole("button", {
      name: /^Close terminal \d+ in /,
    });
    expect(paneCloses).toHaveLength(2);

    // Both gestures in ONE batch: the first removes a pane, the second then
    // targets the only pane left and must be refused.
    await act(async () => {
      paneCloses[0]?.click();
      paneCloses[1]?.click();
      await Promise.resolve();
    });

    // Exactly the first pane's terminal died. The survivor is untouched, and a
    // pane still renders it.
    expect(bridge.kills).toEqual(["t0"]);
    expect(registry.has("t-second")).toBe(true);
    expect(
      screen.queryAllByRole("button", { name: /^Close terminal \d+ in / }),
    ).toHaveLength(0);
  });
});

describe("StudioWorkspaceController surface", () => {
  it("layers the brand watermark under every terminal pane", async () => {
    const { container } = renderController();
    await openTerminals(1);

    const mark = container.querySelector("svg.text-brand-mark");
    expect(mark).not.toBeNull();
    expect(mark?.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("a restore leaves EXACTLY ONE live set of ptys", () => {
  /**
   * THE LEAK THIS SUITE COULD NOT SEE BEFORE.
   *
   * The old assertions checked that a stale restore was not APPLIED, which says
   * nothing about the shells it created. Every open revives a set of ptys, and
   * with no model of them a suite cannot distinguish one live set from three.
   *
   * `bridge.livePtys` is that model - the fake main and host together - and
   * `bridge.reviveCount` separates an open that genuinely spawned from one that
   * joined or reused. Both halves of the fix are load-bearing here: main's
   * single-flight stops the duplicate spawn, and the controller's compensation
   * ends a set that belongs to a project it is no longer showing.
   */
  it("survives a StrictMode DOUBLE RESTORE with one revive and one live set", async () => {
    bridge.savedWorkspace = savedWorkspace();
    renderStrict("p1");
    await act(async () => {
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /vim/ })).toBeTruthy();
    });

    // StrictMode ran the restore effect twice. ONE revive, and the terminals
    // the workspace is showing are the ones that are live.
    expect(bridge.reviveCount).toBe(1);
    expect([...bridge.livePtys].sort()).toEqual(["t1", "t2"]);
    // And the surviving set was not killed by a stale continuation that
    // mistook a remount for a project switch.
    expect(bridge.kills).toEqual([]);
  });

  it("KILLS the set a PROJECT SWITCH orphaned instead of leaving it running", async () => {
    bridge.savedWorkspace = savedWorkspace();
    bridge.deferReadWorkspace = true;
    const view = renderStrict("p1");
    await act(async () => {
      await Promise.resolve();
    });

    // The user moves to another project while p1's revive is in flight.
    await act(async () => {
      view.rerender(strictTree("p2"));
      await Promise.resolve();
    });

    await act(async () => {
      bridge.deferReadWorkspace = false;
      bridge.settleReads();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      // NOTHING FROM p1 IS STILL RUNNING. Before the compensation these two
      // shells lived on with no pane referencing them, holding capacity against
      // the per-project bound and a lease against the project, for the life of
      // the window.
      expect([...bridge.livePtys].filter((id) => id === "t1" || id === "t2")).toEqual([]);
    });
    // As a SET: StrictMode gives the joined open two stale continuations, and
    // both compensate. A repeated kill of the same id is idempotent - main
    // answers the second `unknown_terminal` - and de-duplicating it in the
    // controller would mean tracking which ids a sibling mount had already
    // ended, which is state with no other purpose.
    expect([...new Set(bridge.kills)].sort()).toEqual(["t1", "t2"]);
  });

  it("does not spawn a SECOND set when a slow restore is joined by a remount", async () => {
    bridge.savedWorkspace = savedWorkspace();
    bridge.deferReadWorkspace = true;
    const view = renderStrict("p1");
    await act(async () => {
      await Promise.resolve();
    });

    // A remount of the SAME project while the first open is still in flight.
    await act(async () => {
      view.rerender(strictTree("p1"));
      await Promise.resolve();
    });

    await act(async () => {
      bridge.deferReadWorkspace = false;
      bridge.settleReads();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /vim/ })).toBeTruthy();
    });
    expect(bridge.reviveCount).toBe(1);
    expect([...bridge.livePtys].sort()).toEqual(["t1", "t2"]);
    expect(bridge.kills).toEqual([]);
  });
});

describe("a lost pty host is REPORTED, not hidden", () => {
  /**
   * `EV.terminal.terminalsLost` had no consumer at all.
   *
   * Main broadcast it, preload dropped it on the floor, and the workspace went
   * on drawing live tabs over shells that no longer existed and accepting
   * keystrokes into them - permanently, because the per-terminal `exit` that
   * would have said otherwise died with the port that carried it.
   */
  it("marks the panes dead and OFFERS the revive the snapshot still supports", async () => {
    bridge.savedWorkspace = savedWorkspace();
    renderStrict("p1");
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /vim/ })).toBeTruthy();
    });

    await act(async () => {
      bridge.emitTerminalsLost(["t1", "t2"]);
      await Promise.resolve();
    });

    // The user is TOLD, in an alert, and the panes say so themselves.
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("terminal service stopped");
    expect(screen.getAllByText(/This shell ended when the terminal service stopped/))
      .not.toHaveLength(0);

    // And the offer works: it goes through the same open every mount uses, so
    // it produces exactly one fresh set rather than racing anything.
    const before = bridge.reviveCount;
    await act(async () => {
      screen.getByRole("button", { name: "Restore terminals" }).click();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.queryByRole("alert")).toBeNull();
    });
    expect(bridge.reviveCount).toBe(before + 1);
    expect(bridge.livePtys.size).toBe(2);
  });
});
