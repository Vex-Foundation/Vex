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
import { publishFileOpen, useFileOpenIntentStore } from "../../workspace/file-open-intent.js";
import { WORKSPACE_TERMINAL_GROUPS_MAX } from "../../workspace/types.js";
import { StudioWorkspaceController } from "../StudioWorkspaceController.js";
import { fileViewerRegistry } from "../../viewer/index.js";
import { TerminalRegistry } from "../terminal-registry.js";
import {
  installMatchMedia,
  installResizeObserver,
  installTerminalBridge,
  type TerminalBridgeStub,
} from "./terminal-harness.js";

const noWebgl = { webglLoader: () => Promise.reject(new Error("no gl in jsdom")) };

/**
 * The files bridge, for the REAL `FileViewer` this controller now mounts.
 *
 * The viewer is not stubbed here. The wiring under test is the whole chain -
 * controller to `TerminalTabs`' render prop to the viewer's own read - and a
 * stub would prove only that a prop was passed. What IS faked is the process
 * boundary, which is what a renderer suite always fakes.
 *
 * jsdom defines no `Worker`, so the viewer's registry resolves to the
 * unavailable highlighter and every file renders as plain text with a reason.
 * That is a real degradation path, not a workaround, and it keeps this suite
 * about the workspace rather than about tokenizing.
 */
const fileReads: string[] = [];

vi.mock("../../../../../lib/api/files.js", () => ({
  readProjectFile: (_projectId: string, nodeId: string) => {
    fileReads.push(nodeId);
    return Promise.resolve({
      ok: true,
      data: {
        ok: true,
        value: {
          nodeId,
          path: "src/a.ts",
          text: `contents of ${nodeId}\n`,
          size: 20,
          modifiedMs: 1,
          hash: `hash:${nodeId}`,
        },
      },
    });
  },
  listProjectChildren: () =>
    Promise.resolve({
      ok: true,
      data: {
        ok: true,
        value: {
          children: [],
          hasMore: false,
          nextCursor: null,
          totalCount: 0,
          excludedCount: 0,
        },
      },
    }),
  watchProjectFiles: () =>
    Promise.resolve({
      ok: true,
      data: {
        ok: true,
        value: {
          subscriptionId: "sub-1",
          watcherGeneration: 1,
          state: "watching",
          warnings: [],
        },
      },
    }),
  unwatchProjectFiles: () => Promise.resolve({ ok: true, data: { ok: true, value: null } }),
  onProjectFilesEvent: () => () => undefined,
}));

let bridge: TerminalBridgeStub;
let registry: TerminalRegistry;

/**
 * The terminal a project's OWN AUTO-OPEN creates on mount.
 *
 * Opening a project auto-creates its first terminal, so "a mounted controller
 * with no saved workspace" is a workspace with ONE terminal in it, not zero.
 * Pinning the answer here rather than leaving the harness default gives that
 * terminal a name every case below can recognize in a tab title, a kill list or
 * a detach list, and keeps it distinguishable from the `t0`, `t1`... that
 * `openTerminals` mints for deliberate gestures.
 */
const AUTO_TERMINAL = {
  terminalId: "t-auto",
  pid: 1,
  shellName: "auto-shell",
  cwd: "/w",
} as const;

beforeEach(() => {
  installMatchMedia();
  installResizeObserver();
  bridge = installTerminalBridge();
  bridge.nextCreate = { ok: true, value: AUTO_TERMINAL };
  registry = new TerminalRegistry(noWebgl);
  fileReads.length = 0;
  fileViewerRegistry.disposeAll();
  document.body.innerHTML = "";
});

afterEach(() => {
  useFileOpenIntentStore.getState().clearFileOpenIntent();
  // The viewer registry is a MODULE SINGLETON, like the controller's own. A
  // session left alive here keeps a path subscription and a read in flight into
  // the next test in this file.
  fileViewerRegistry.disposeAll();
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

/**
 * Render a project with NO saved workspace and wait for its auto-opened first
 * terminal to land.
 *
 * Every case that wants a settled starting point uses this, because the
 * alternative - asserting while the bootstrap create is still in flight - is a
 * race, not a baseline.
 */
async function renderOpened(projectId = "p1") {
  const view = renderController(projectId);
  await waitFor(() => {
    expect(screen.getAllByRole("tab")).toHaveLength(1);
  });
  return view;
}

/** The same, under StrictMode's double-invoked effects. */
async function renderStrictOpened(projectId = "p1") {
  const view = renderStrict(projectId);
  await waitFor(() => {
    expect(screen.getAllByRole("tab")).toHaveLength(1);
  });
  return view;
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

    // WAIT FOR THE ATTACH, not for the tab. The two are populated by two
    // INDEPENDENT paths - the controller's restore renders the tab, and each
    // `XtermHost`'s own effect attaches its terminal - so waiting only for the
    // tab and then asserting `attaches` raced the second path and failed about
    // one run in seven in isolation. The assertion is unchanged; what changed
    // is which condition the wait is on.
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /vim/ })).toBeTruthy();
      expect(bridge.attaches.toSorted()).toEqual(["t1", "t2"]);
    });

    const separator = screen.getByRole("separator");
    // 75/25, not 50/50. An equalizing restore would silently undo the split the
    // user sized, which is the whole reason the shares are persisted.
    expect(separator.getAttribute("aria-valuenow")).toBe("75");
  });

  it("does NOT auto-open over a restored layout", async () => {
    // The other half of the contract below: a project that came back with its
    // terminals is not empty, and bootstrapping one into it would give the user
    // a shell they never asked for on every reopen.
    bridge.savedWorkspace = savedWorkspace();
    renderController();

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /vim/ })).toBeTruthy();
    });
    expect(bridge.creates).toEqual([]);
  });
});

/**
 * OPENING A PROJECT OPENS ITS FIRST TERMINAL (owner decision, 2026-09-01).
 *
 * This describe replaces the "starts empty when the project has no saved
 * workspace" characterization, which pinned the OLD contract: a fresh project
 * used to land on an unlabelled black rectangle with a `+` in the strip above
 * it and nothing saying what to do. The empty state is now a FALLBACK, reached
 * only where the auto-open deliberately declines or where the user emptied the
 * workspace themselves, and each of those routes has its own case below.
 *
 * The pattern is VS Code's `TerminalViewPane._initializeTerminal`: bootstrap
 * once per view, only when nothing was restored, only when no create is already
 * in flight, and always through the service's own `createTerminal` rather than
 * a second creation path.
 */
describe("the first terminal of an opened project", () => {
  it("AUTO-OPENS one terminal when the project has no saved workspace", async () => {
    bridge.savedWorkspace = null;
    renderController();

    const tab = await screen.findByRole("tab", { name: /auto-shell/ });
    expect(tab).toBeTruthy();
    // Through the SAME path the `+` button uses - one create, for this project,
    // at the same starting geometry - rather than a parallel creation code path
    // that would answer the keep-alive bound and the publication fence twice.
    expect(bridge.creates).toEqual([{ projectId: "p1", cols: 80, rows: 24 }]);
    expect([...bridge.livePtys]).toEqual(["t-auto"]);
    // And it is a real terminal, attached like any other.
    await waitFor(() => {
      expect(bridge.attaches).toEqual(["t-auto"]);
    });
  });

  it("AUTO-OPENS when a saved snapshot restores to NO tabs", async () => {
    // A snapshot is not the same fact as a layout. `fromSnapshot` drops every
    // group whose terminals have no saved buffer, and a project whose last tab
    // was closed persists an empty layout - so "there is a snapshot" can still
    // mean "there is nothing to show". The decision is taken on the RESULTING
    // state, which is what the user is looking at.
    bridge.savedWorkspace = {
      layout: { projectId: "p1", activeGroupIndex: 0, groups: [] },
      terminals: [],
      idMap: [],
    };
    renderController();

    expect(await screen.findByRole("tab", { name: /auto-shell/ })).toBeTruthy();
    expect(bridge.creates).toHaveLength(1);
  });

  it("opens EXACTLY ONE under StrictMode's double-invoked effects", async () => {
    // THE SINGLE-FLIGHT PROOF. StrictMode runs the restore effect twice -
    // effect, cleanup, effect - and a bootstrap without the latch spawns a pty
    // on each pass. Every extra one is a real shell holding a slot against the
    // host's per-project bound that no second tab even reveals, because the
    // model would refuse to place it.
    bridge.savedWorkspace = null;
    renderStrict("p1");

    await waitFor(() => {
      expect(screen.getAllByRole("tab")).toHaveLength(1);
    });
    // Settle anything a second pass could still have in flight before counting.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(bridge.creates).toHaveLength(1);
    expect([...bridge.livePtys]).toEqual(["t-auto"]);
    expect(bridge.kills).toEqual([]);
    expect(screen.getAllByRole("tab")).toHaveLength(1);
  });

  it("does not open a SECOND terminal beside one the user asked for first", async () => {
    // The user pressed `+` while the restore was still reading. Their terminal
    // is the first one; the bootstrap must see the create in flight and stand
    // down rather than open two for one gesture.
    bridge.savedWorkspace = null;
    bridge.deferReadWorkspace = true;
    renderController();
    await act(async () => {
      await Promise.resolve();
    });

    bridge.nextCreate = {
      ok: true,
      value: { terminalId: "t-user", pid: 7, shellName: "user-shell", cwd: "/w" },
    };
    bridge.deferCreate = true;
    await act(async () => {
      screen.getByRole("button", { name: "New terminal" }).click();
      await Promise.resolve();
    });

    await act(async () => {
      bridge.deferReadWorkspace = false;
      bridge.settleReads();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      bridge.deferCreate = false;
      bridge.settleCreates();
      await Promise.resolve();
    });

    expect(bridge.creates).toHaveLength(1);
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.textContent).toContain("user-shell");
  });

  it("does NOT auto-open when the restore FAILED, and says so", async () => {
    // THE ONE THAT COSTS DATA IF IT REGRESSES. A read that failed is not an
    // empty project: the snapshot may be perfectly good and unreachable. A
    // terminal spawned here would be persisted a moment later as the only group
    // of a layout that overwrote the one the read could not deliver.
    bridge.readWorkspaceFailure = "snapshot_unavailable";
    renderController();

    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("could not read");
    expect(bridge.creates).toEqual([]);
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    // And the surface is not a black rectangle: the fallback offers the repair.
    expect(screen.getByRole("button", { name: "Open a terminal" })).toBeTruthy();
  });

  it("SURFACES a terminal service that cannot be reached, once", async () => {
    bridge.savedWorkspace = null;
    bridge.nextCreate = { ok: false, code: "host_unavailable" };
    renderController();

    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("terminal service is not running");
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    // ONE attempt. A latch that re-armed on failure would put a create on every
    // pass of the restore effect against a host that is already known to be
    // down.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(bridge.creates).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Open a terminal" })).toBeTruthy();
  });

  it("shows the empty state, with its own action, after the user closes every tab", async () => {
    // The fallback's OTHER route, and the one that is not a failure at all. The
    // bootstrap is spent, so closing the last tab lands here rather than
    // reopening a shell the user just closed.
    await renderOpened();

    await act(async () => {
      screen.getByRole("button", { name: "Close auto-shell" }).click();
      await Promise.resolve();
    });

    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(bridge.kills).toEqual(["t-auto"]);

    bridge.nextCreate = {
      ok: true,
      value: { terminalId: "t-again", pid: 8, shellName: "again-shell", cwd: "/w" },
    };
    await act(async () => {
      screen.getByRole("button", { name: "Open a terminal" }).click();
      await Promise.resolve();
    });

    // The empty state's action opens a terminal through the same handler the
    // strip's `+` uses, and the state gives way to it.
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Open a terminal" })).toBeNull();
  });
});

describe("StudioWorkspaceController refusals", () => {
  it(`REFUSES past ${String(WORKSPACE_TERMINAL_GROUPS_MAX)} live groups instead of evicting one`, async () => {
    // The project's own auto-opened terminal is the FIRST of the bound, so the
    // user reaches it after one fewer deliberate gesture than before.
    await renderOpened();

    await openTerminals(WORKSPACE_TERMINAL_GROUPS_MAX - 1);
    expect(screen.getAllByRole("tab")).toHaveLength(WORKSPACE_TERMINAL_GROUPS_MAX);

    const killsBefore = bridge.kills.length;
    await openTerminals(1);

    // The bound is announced, the existing tabs are untouched, and NOTHING was
    // killed to make room.
    expect(screen.getByRole("status").textContent).toContain("Close one");
    expect(screen.getAllByRole("tab")).toHaveLength(WORKSPACE_TERMINAL_GROUPS_MAX);
    expect(bridge.kills).toHaveLength(killsBefore);
  });

  it("names a host refusal by its remedy rather than as a generic failure", async () => {
    await renderOpened();
    bridge.nextCreate = { ok: false, code: "limit_project_terminals" };

    await act(async () => {
      screen.getByRole("button", { name: "New terminal" }).click();
      await Promise.resolve();
    });

    const status = screen.getByRole("status");
    expect(status.textContent).toContain("maximum number of terminals");
    expect(status.textContent).toContain("Close one");
    // The refused create added nothing: only the auto-opened first terminal.
    expect(screen.getAllByRole("tab")).toHaveLength(1);
  });
});

describe("StudioWorkspaceController selection and cleanup", () => {
  it("selects the LEFT neighbour on close and KILLS only the closed tab's pty", async () => {
    await renderOpened();
    await openTerminals(2);

    // The third tab (the second deliberate one) is selected after creation;
    // closing it must select the second, not march the selection toward the end
    // of the strip.
    await act(async () => {
      screen.getByRole("button", { name: "Close shell-1" }).click();
      await Promise.resolve();
    });

    expect(bridge.kills).toEqual(["t1"]);
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(2);
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");
  });

  it("DETACHES every terminal on unmount, and kills none", async () => {
    const view = await renderOpened();
    await openTerminals(2);
    expect(bridge.detaches).toEqual([]);

    view.unmount();

    // A project switch or a mode switch is not a decision to end a shell: the
    // ptys survive their grace period and replay on return.
    expect(bridge.detaches.toSorted()).toEqual(["t-auto", "t0", "t1"]);
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
    // Four: the project's auto-opened first terminal and the three deliberate
    // ones, coalesced into a single write.
    expect(bridge.persisted[0]?.groups).toHaveLength(4);
  });

  it("FLUSHES the pending write when the window is hidden", async () => {
    vi.useFakeTimers();
    renderController();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    bridge.nextCreate = {
      ok: true,
      value: { terminalId: "t-flush", pid: 9, shellName: "flush-shell", cwd: "/w" },
    };
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
    // The auto-opened first terminal plus the one this case opened.
    expect(bridge.persisted[0]?.groups).toHaveLength(2);
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
    await renderOpened();

    await openTerminals(WORKSPACE_TERMINAL_GROUPS_MAX - 1);
    expect(screen.getAllByRole("tab")).toHaveLength(WORKSPACE_TERMINAL_GROUPS_MAX);
    const createsBefore = bridge.creates.length;

    await openTerminals(1);

    expect(screen.getByRole("status").textContent).toContain("Close one");
    expect(screen.getAllByRole("tab")).toHaveLength(WORKSPACE_TERMINAL_GROUPS_MAX);
    // No pty was ever ASKED FOR, so there is nothing left running that the UI
    // cannot reach.
    expect(bridge.creates).toHaveLength(createsBefore);
  });

  it("KILLS a split's terminal when its tab was closed while the create was in flight", async () => {
    // F6b. The destination tab is gone by the time the create lands, so the
    // completion is the only holder of that terminal id. Discarding it without
    // killing is precisely how the invisible shell was created.
    // The group being split is the project's own auto-opened first terminal,
    // which is what a user actually has in front of them a second after opening
    // a project.
    await renderStrictOpened();

    bridge.nextCreate = {
      ok: true,
      value: { terminalId: "t-split", pid: 900, shellName: "bash", cwd: "/w" },
    };
    bridge.deferCreate = true;

    await act(async () => {
      screen.getByRole("button", { name: "Split auto-shell side by side" }).click();
      await Promise.resolve();
    });
    expect(bridge.creates).toHaveLength(2);
    expect(bridge.kills).not.toContain("t-split");

    await act(async () => {
      screen.getByRole("button", { name: "Close auto-shell" }).click();
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
    const view = await renderStrictOpened("p1");

    bridge.nextCreate = {
      ok: true,
      value: { terminalId: "t-p1", pid: 901, shellName: "bash", cwd: "/w" },
    };
    bridge.deferCreate = true;
    await act(async () => {
      screen.getByRole("button", { name: "New terminal" }).click();
      await Promise.resolve();
    });
    expect(bridge.creates).toHaveLength(2);

    // p2's OWN bootstrap answers next, so the two projects' creates cannot be
    // confused for one another in the assertions below.
    bridge.nextCreate = {
      ok: true,
      value: { terminalId: "t-p2-auto", pid: 902, shellName: "p2-shell", cwd: "/w" },
    };
    await act(async () => {
      view.rerender(strictTree("p2"));
      await Promise.resolve();
    });

    await act(async () => {
      bridge.deferCreate = false;
      bridge.settleCreates();
      await Promise.resolve();
      await Promise.resolve();
    });

    // p1's terminal is nowhere in p2's strip, and it is not left running.
    await waitFor(() => {
      expect(screen.getAllByRole("tab")).toHaveLength(1);
    });
    expect(screen.getAllByRole("tab")[0]?.textContent).toContain("p2-shell");
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
    bridge.nextCreate = {
      ok: true,
      value: { terminalId: "t-p2", pid: 902, shellName: "p2-shell", cwd: "/w" },
    };
    await act(async () => {
      view.rerender(strictTree("p2"));
      await Promise.resolve();
    });

    // p2 has no saved workspace, so it bootstraps its own first terminal - and
    // that terminal is exactly what p1's late restore must not replace.
    await waitFor(() => {
      expect(screen.getAllByRole("tab")).toHaveLength(1);
    });

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
    await renderStrictOpened();
    expect(registry.has("t-auto")).toBe(true);

    await act(async () => {
      screen.getByRole("button", { name: "Close auto-shell" }).click();
      await Promise.resolve();
    });

    expect(registry.has("t-auto")).toBe(false);
    expect(bridge.kills).toEqual(["t-auto"]);
  });

  it("only RELEASES on a plain unmount, so a StrictMode remount cannot destroy a live shell", async () => {
    // F6e, the negative half. Disposing on release would make a tab switch or
    // StrictMode's cleanup-then-effect throw away a terminal the user is still
    // using.
    const view = await renderStrictOpened();
    expect(registry.has("t-auto")).toBe(true);

    view.unmount();

    expect(registry.has("t-auto")).toBe(true);
    expect(registry.consumerCount("t-auto")).toBe(0);
    expect(bridge.kills).toEqual([]);
  });

  it("kills and disposes NOTHING when closing the last pane is refused", async () => {
    // F6f. `closePane` refuses the last pane of a group; a pane that survives
    // the refusal while its terminal was killed would render a shell that no
    // longer exists.
    await renderOpened();
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
    const { container } = await renderOpened();

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

describe("opening a file", () => {
  /** A node exactly as the explorer would hand it over. */
  function sourceNode(path: string, nodeId = `node-${path}`) {
    return {
      nodeId,
      name: path.slice(path.lastIndexOf("/") + 1),
      path,
      kind: "file" as const,
      size: 120,
      modifiedMs: 1,
    };
  }

  it("adds a file tab, mounts the VIEWER on it, and closes through closeTab", async () => {
    await renderStrictOpened();

    await act(async () => {
      publishFileOpen("p1", sourceNode("src/deep/service.ts"));
      await Promise.resolve();
    });

    // The TITLE is the node's own name, which main minted; the PANEL shows the
    // project-relative path and nothing else.
    const tab = await screen.findByRole("tab", { name: /service\.ts/ });
    expect(tab).toBeTruthy();
    // The controller supplied the viewer, with the project it holds and the
    // tab the model minted. Its header shows the project-relative path.
    const viewer = screen.getByTestId("file-viewer");
    expect(viewer.textContent).toContain("src/deep/service.ts");
    await act(async () => {
      await Promise.resolve();
    });
    // And it read the file through the tab's own token.
    expect(fileReads).toEqual(["node-src/deep/service.ts"]);
    // No terminal was created FOR THE FILE TAB - the only live pty is the one
    // the project's own auto-open made - and the file tab has no split
    // affordance, because a file is not a pane group.
    expect([...bridge.livePtys]).toEqual(["t-auto"]);
    expect(
      screen.queryByRole("button", { name: "Split service.ts side by side" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Split service.ts top and bottom" }),
    ).toBeNull();

    await act(async () => {
      screen.getByRole("button", { name: "Close service.ts" }).click();
      await Promise.resolve();
    });

    expect(screen.queryByRole("tab", { name: /service\.ts/ })).toBeNull();
    expect(screen.queryByTestId("file-viewer")).toBeNull();
  });

  it("consumes the intent ONCE, so a StrictMode double effect cannot open it twice", async () => {
    renderStrict();
    await waitFor(() => {
      expect(screen.getByRole("tablist")).toBeTruthy();
    });

    await act(async () => {
      publishFileOpen("p1", sourceNode("src/a.ts"));
      await Promise.resolve();
    });

    expect(screen.getAllByRole("tab", { name: /a\.ts/ })).toHaveLength(1);
    expect(useFileOpenIntentStore.getState().intent).toBeNull();
  });

  it("DROPS a file chosen in another project", async () => {
    renderStrict("p1");
    await waitFor(() => {
      expect(screen.getByRole("tablist")).toBeTruthy();
    });

    await act(async () => {
      // The user switched projects while the click was in flight.
      publishFileOpen("p2", sourceNode("other/b.ts"));
      await Promise.resolve();
    });

    expect(screen.queryByRole("tab", { name: /b\.ts/ })).toBeNull();
    // Still parked: it belongs to p2's workspace, not to this one.
    expect(useFileOpenIntentStore.getState().intent).not.toBeNull();
  });

  it("re-selects an already-open file and adopts its new token", async () => {
    renderStrict();
    await waitFor(() => {
      expect(screen.getByRole("tablist")).toBeTruthy();
    });

    await act(async () => {
      publishFileOpen("p1", sourceNode("src/a.ts", "node-epoch-1"));
      await Promise.resolve();
    });
    await openTerminals(1);

    await act(async () => {
      publishFileOpen("p1", sourceNode("src/a.ts", "node-epoch-2"));
      await Promise.resolve();
    });

    // One tab for one path, and it is the selected one again.
    expect(screen.getAllByRole("tab", { name: /a\.ts/ })).toHaveLength(1);
    expect(screen.getByTestId("file-viewer").textContent).toContain("src/a.ts");
    await act(async () => {
      await Promise.resolve();
    });
    // The NEW token was adopted: a file deleted and recreated is the same tab
    // to the user and a different read identity to main, and a viewer still
    // holding the old token would answer `invalid_node` for as long as the tab
    // stayed open.
    expect(fileReads).toContain("node-epoch-2");
  });
});
