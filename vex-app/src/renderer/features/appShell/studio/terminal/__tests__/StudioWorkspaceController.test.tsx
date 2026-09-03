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
import type { FileNode } from "@shared/schemas/files.js";
import { publishFileOpen, useFileOpenIntentStore } from "../../workspace/file-open-intent.js";
import {
  publishFileRename,
  useFileRenameSignalStore,
} from "../../workspace/file-rename-signal.js";
import { WORKSPACE_TERMINAL_GROUPS_MAX } from "../../workspace/types.js";
import {
  peekProjectWorkspaceCommands,
  type ProjectWorkspaceCommands,
} from "../../workspace/workspace-handles.js";
import { StudioWorkspaceController } from "../StudioWorkspaceController.js";
import { useUiStore } from "../../../../../stores/uiStore.js";
import { notifications } from "../../../../../lib/notifications/index.js";
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

/**
 * The directories this suite lets the bridge answer for, and what was asked.
 *
 * Empty for every case but the folder-rename walk, which is the only one that
 * lists anything: following a renamed directory's tabs is the one path in this
 * controller that asks main for a token it cannot compute.
 */
const listedNodeIds: (string | null)[] = [];
let directoryPages: Record<string, readonly FileNode[]> = {};

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
  listProjectChildren: (input: { nodeId: string | null }) => {
    listedNodeIds.push(input.nodeId);
    return Promise.resolve({
      ok: true,
      data: {
        ok: true,
        value: {
          children: directoryPages[input.nodeId ?? "<root>"] ?? [],
          hasMore: false,
          nextCursor: null,
          totalCount: 0,
          excludedCount: 0,
        },
      },
    });
  },
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
  // The LABEL the host reports at spawn. Recognizable in a header assertion for
  // the same reason `shellName` is recognizable in a tab title.
  displayCwd: "auto-dir",
} as const;

beforeEach(() => {
  installMatchMedia();
  installResizeObserver();
  bridge = installTerminalBridge();
  bridge.nextCreate = { ok: true, value: AUTO_TERMINAL };
  registry = new TerminalRegistry(noWebgl);
  fileReads.length = 0;
  listedNodeIds.length = 0;
  directoryPages = {};
  fileViewerRegistry.disposeAll();
  // The notification model is a MODULE SINGLETON: a retained loss notification
  // would count itself into the next test in this file.
  notifications.reset();
  // The FILE TABS' persisted record is a MODULE SINGLETON too, and every case
  // in this file uses the same project id: a strip one case leaves open would
  // be restored into the next one's workspace, walking main for paths that
  // case never mentioned.
  useUiStore.setState({ studioFileTabs: {} });
  document.body.innerHTML = "";
});

afterEach(() => {
  useFileOpenIntentStore.getState().clearFileOpenIntent();
  // The viewer registry is a MODULE SINGLETON, like the controller's own. A
  // session left alive here keeps a path subscription and a read in flight into
  // the next test in this file.
  fileViewerRegistry.disposeAll();
  // The flush case below redefines `document.visibilityState` as an own
  // property, and `document` is per-FILE, not per-case: left in place it would
  // hand every later case in this file a permanently hidden window. Deleting
  // the override restores jsdom's own accessor rather than pinning a value.
  Reflect.deleteProperty(document, "visibilityState");
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
      // The REATTACH SEED main obtained from the host for each live terminal.
      // The active pane is `t2`, so its value is the one the header must show
      // without any property event ever being emitted.
      displayCwd: terminalId === "t1" ? "vex-app" : "vex-app/src/lib",
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
 * WAIT FOR THE ATTACH, NOT ONLY FOR THE TAB.
 *
 * The tab is rendered by the CONTROLLER. The registry entry, the five bridge
 * subscriptions and the attach are established by each `XtermHost`'s OWN mount
 * effect - a second, independent path over the same commit. React schedules
 * that passive effect on a later scheduler turn than the commit that produced
 * the tab, and RTL's `waitFor` runs with the act environment DISABLED (its
 * `asyncWrapper` turns it off and drains with a `setTimeout(0)` that races
 * React's `MessageChannel` flush), so a wait on the tab alone can resolve while
 * the effect is still pending. Measured, not theorised: a probe placed at the
 * `emitProperty` in the restore describe read `subs=0 attaches=[]` on the red
 * run of a 1-in-15 reproduction under load, with two tabs already on screen.
 *
 * A case that then reads `registry.has(...)` sees `false`, and a case that
 * emits a bridge event sees it dropped by a channel with no subscriber and
 * never re-delivered. `attachTerminal` is the LAST statement of that effect
 * body, so `bridge.attaches` covering a terminal proves the whole body - the
 * acquire and all five subscriptions included - has run for it.
 */
async function waitForOpenedTerminal(): Promise<void> {
  await waitFor(() => {
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    expect(bridge.attaches).toContain(AUTO_TERMINAL.terminalId);
  });
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
  await waitForOpenedTerminal();
  return view;
}

/** The same, under StrictMode's double-invoked effects. */
async function renderStrictOpened(projectId = "p1") {
  const view = renderStrict(projectId);
  await waitForOpenedTerminal();
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
        displayCwd: "p1",
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
      expect(screen.getByRole("tab", { name: /Terminal 1/ })).toBeTruthy();
      expect(bridge.attaches.toSorted()).toEqual(["t1", "t2"]);
    });

    const separator = screen.getByRole("separator");
    // 75/25, not 50/50. An equalizing restore would silently undo the split the
    // user sized, which is the whole reason the shares are persisted.
    expect(separator.getAttribute("aria-valuenow")).toBe("75");
  });

  it("shows the reattached terminal's directory WITHOUT waiting for a property event", async () => {
    // THE DEFECT THIS CLOSES. The panel used to keep its own map of directories
    // fed only by the property stream, so a workspace that came back from a
    // reload or a project switch had a header reading "not known yet" until the
    // user pressed Enter somewhere - for shells that had been running all along
    // in a directory main could have named. Nothing below emits a property.
    bridge.savedWorkspace = savedWorkspace();
    renderController();

    // The restore's active pane is `t2`, seeded with `vex-app/src/lib`. The
    // SUBSCRIPTION is waited for alongside the label for the reason
    // `waitForOpenedTerminal` states: the emit below is dropped on the floor by
    // a bridge that has no subscriber yet, and nothing ever re-delivers it.
    await waitFor(() => {
      expect(screen.getByLabelText("Working directory: vex-app/src/lib")).toBeTruthy();
      expect(bridge.attaches.toSorted()).toEqual(["t1", "t2"]);
    });
    expect(screen.queryByLabelText("Working directory not known yet")).toBeNull();

    // And the property stream still supersedes the seed, on the same field.
    bridge.emitProperty("t2", { property: "displayCwd", value: "vex-app/docs" });
    await waitFor(() => {
      expect(screen.getByLabelText("Working directory: vex-app/docs")).toBeTruthy();
    });
  });

  it("seeds a NEWLY CREATED terminal's header from the create result", async () => {
    bridge.savedWorkspace = null;
    renderController();

    // The auto-opened first terminal. The bridge answers a create the way main
    // does, with the label the host reported at spawn, and the header shows it
    // without waiting for the property stream to say the same thing again.
    await waitFor(() => {
      expect(screen.getByLabelText("Working directory: auto-dir")).toBeTruthy();
    });
  });

  it("does NOT auto-open over a restored layout", async () => {
    // The other half of the contract below: a project that came back with its
    // terminals is not empty, and bootstrapping one into it would give the user
    // a shell they never asked for on every reopen.
    bridge.savedWorkspace = savedWorkspace();
    renderController();

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /Terminal 1/ })).toBeTruthy();
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

    const tab = await screen.findByRole("tab", { name: /Terminal 1/ });
    expect(tab).toBeTruthy();
    // Through the SAME path the `+` button uses - one create, for this project,
    // at the same starting geometry - rather than a parallel creation code path
    // that would answer the keep-alive bound and the publication fence twice.
    // `shellId` is part of the create contract now: the renderer names the shell
    // it wants by id, and main re-resolves it. `system_default` is what the
    // harness catalogue reports as the default.
    expect(bridge.creates).toEqual([
      { projectId: "p1", shellId: "system_default", cols: 80, rows: 24 },
    ]);
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

    expect(await screen.findByRole("tab", { name: /Terminal 1/ })).toBeTruthy();
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
      value: { terminalId: "t-user", pid: 7, shellName: "user-shell", displayCwd: "p1" },
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
    // The tab is named `Terminal 1`; the SHELL it started is a fact about the
    // terminal, shown in the panel header rather than used as the tab's name.
    expect(tabs[0]?.textContent).toContain("Terminal 1");
    expect(document.querySelector("[data-vex-terminal-shell]")?.textContent).toBe(
      "user-shell",
    );
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
      screen.getByRole("button", { name: "Close Terminal 1" }).click();
      await Promise.resolve();
    });

    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(bridge.kills).toEqual(["t-auto"]);

    bridge.nextCreate = {
      ok: true,
      value: { terminalId: "t-again", pid: 8, shellName: "again-shell", displayCwd: "p1" },
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

describe("focus lands in a workspace that was just opened", () => {
  /**
   * The measured defect: `Enter` on the welcome's "Open <project>" opened the
   * project and left `document.activeElement` on `document.body`, so a keyboard
   * user tabbed in from the top of the window to reach the shell that had just
   * been opened for them. The controller now claims focus for the terminal the
   * open produced - and only ever from nobody.
   */
  it("puts the caret in the auto-opened terminal", async () => {
    await renderOpened();

    await waitFor(() => {
      expect(document.activeElement?.getAttribute("aria-label")).toBe(
        "Terminal input",
      );
    });
  });

  it("stays out of a HIDDEN workspace, which nobody is looking at", async () => {
    // `StudioCenter` keeps every kept-alive project mounted and hides the
    // inactive ones, so a mount is not an open. It also passes `active: false`
    // while the boot gate or the unlock curtain covers the window.
    render(
      <StudioWorkspaceController projectId="p1" registry={registry} active={false} />,
    );
    await waitForOpenedTerminal();

    expect(document.activeElement).toBe(document.body);
  });

  it("never takes focus a user is already holding", async () => {
    // The restore is a round trip, so the arming outlives the first commit -
    // and a user who reached for something else in the meantime must keep it.
    const held = document.createElement("input");
    document.body.appendChild(held);
    held.focus();

    await renderOpened();
    // Give the arming every commit it could possibly retry on.
    await act(async () => {
      await Promise.resolve();
    });

    expect(document.activeElement).toBe(held);
    held.remove();
  });

  it("claims focus when an un-hidden workspace becomes the shown one", async () => {
    // A project switch is an UN-HIDE, not a mount: the workspace is already
    // there, so the open-time landing has to key on becoming active.
    const view = render(
      <StudioWorkspaceController projectId="p1" registry={registry} active={false} />,
    );
    await waitForOpenedTerminal();
    expect(document.activeElement).toBe(document.body);

    view.rerender(
      <StudioWorkspaceController projectId="p1" registry={registry} active />,
    );

    await waitFor(() => {
      expect(document.activeElement?.getAttribute("aria-label")).toBe(
        "Terminal input",
      );
    });
  });
});

/**
 * THE CARET FOLLOWS THE TERMINAL A GESTURE OPENED.
 *
 * A different landing from the one above, with a different permission, and the
 * measured defect says why it has to be: the new-terminal chord created
 * `Terminal 2` and `Terminal 3` on the built app with focus left on
 * `document.body` each time, so the chord a user pressed twice worked once and
 * then resolved against no surface at all. The open-time landing could not fix
 * it - it may only take focus NOBODY holds, and after the first terminal the
 * caret is in a shell.
 */
describe("focus lands in the terminal a gesture opened", () => {
  it("puts the caret in the terminal the strip's + opened", async () => {
    await renderOpened();
    await waitFor(() => {
      expect(document.activeElement?.getAttribute("aria-label")).toBe("Terminal input");
    });
    const first = document.activeElement;

    await openTerminals(1);

    await waitFor(() => {
      expect(document.activeElement?.getAttribute("aria-label")).toBe("Terminal input");
      // The NEW one, not the one the open-time landing had already claimed.
      expect(document.activeElement).not.toBe(first);
    });
    // And it is the pane of the tab that is now selected.
    const active = document.activeElement?.closest("[data-terminal-id]");
    expect(active?.getAttribute("data-terminal-id")).toBe("t0");
  });

  it("does not land on a terminal that left the workspace before it attached", async () => {
    await renderOpened();
    const held = document.createElement("input");
    document.body.appendChild(held);

    // A create whose pane never arrives: the workspace is torn down under it.
    bridge.nextCreate = { ok: false, code: "host_unavailable" };
    await act(async () => {
      screen.getByRole("button", { name: "New terminal" }).click();
      await Promise.resolve();
    });

    held.focus();
    await act(async () => {
      await Promise.resolve();
    });
    // A refused create arms nothing, so the caret the user moved stays put.
    expect(document.activeElement).toBe(held);
    held.remove();
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
      screen.getByRole("button", { name: "Close Terminal 3" }).click();
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
          displayCwd: "p1",
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
      value: { terminalId: "t-flush", pid: 9, shellName: "flush-shell", displayCwd: "p1" },
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
      value: { terminalId: "t-split", pid: 900, shellName: "bash", displayCwd: "p1" },
    };
    bridge.deferCreate = true;

    await act(async () => {
      screen.getByRole("button", { name: "Split Terminal 1 side by side" }).click();
      await Promise.resolve();
    });
    expect(bridge.creates).toHaveLength(2);
    expect(bridge.kills).not.toContain("t-split");

    await act(async () => {
      screen.getByRole("button", { name: "Close Terminal 1" }).click();
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
      value: { terminalId: "t-p1", pid: 901, shellName: "bash", displayCwd: "p1" },
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
      value: { terminalId: "t-p2-auto", pid: 902, shellName: "p2-shell", displayCwd: "p1" },
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
    expect(document.querySelector("[data-vex-terminal-shell]")?.textContent).toBe(
      "p2-shell",
    );
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
      value: { terminalId: "t-p2", pid: 902, shellName: "p2-shell", displayCwd: "p1" },
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
    // Every terminal tab is now named `Terminal n`, so the name cannot tell the
    // two projects' tabs apart: the COUNT and the shell each tab is running are
    // what distinguish "p2's own terminal survived" from "p1's two came back".
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(1);
    expect(document.querySelector("[data-vex-terminal-shell]")?.textContent).toBe(
      "p2-shell",
    );
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
      screen.getByRole("button", { name: "Close Terminal 1" }).click();
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
      value: { terminalId: "t-second", pid: 903, shellName: "bash", displayCwd: "p1" },
    };
    await act(async () => {
      screen.getByRole("button", { name: "Split Terminal 2 side by side" }).click();
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
      expect(screen.getByRole("tab", { name: /Terminal 1/ })).toBeTruthy();
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
      expect(screen.getByRole("tab", { name: /Terminal 1/ })).toBeTruthy();
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
      expect(screen.getByRole("tab", { name: /Terminal 1/ })).toBeTruthy();
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

  it("raises ONE app-wide notification per loss and closes it when the shells come back", async () => {
    // The inline bar only exists while this project's workspace is on screen.
    // A user in another project, or in agent mode, learns about a dead pty
    // host from the notification or not at all.
    bridge.savedWorkspace = savedWorkspace();
    renderStrict("p1");
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /Terminal 1/ })).toBeTruthy();
    });

    await act(async () => {
      bridge.emitTerminalsLost(["t1"]);
      await Promise.resolve();
    });
    const first = notifications.getSnapshot().items;
    expect({
      count: first.length,
      title: first[0]?.title,
      message: first[0]?.message,
      severity: first[0]?.severity,
      scope: first[0]?.scope,
      action: first[0]?.actions.map((entry) => entry.label),
      // Derived sticky: an error whose remedy is on the notification must not
      // purge itself and take the remedy with it.
      sticky: first[0]?.sticky,
    }).toEqual({
      count: 1,
      title: "The terminal service stopped",
      message: "1 shell ended with it. Their saved output can be restored.",
      severity: "error",
      scope: { kind: "project", projectId: "p1" },
      action: ["Restore terminals"],
      sticky: true,
    });

    // A SECOND batch is the same unresolved loss: the count moves, and no
    // second row appears to report it twice.
    await act(async () => {
      bridge.emitTerminalsLost(["t2"]);
      await Promise.resolve();
    });
    const second = notifications.getSnapshot().items;
    expect({ count: second.length, message: second[0]?.message }).toEqual({
      count: 1,
      message: "2 shells ended with it. Their saved output can be restored.",
    });

    // Restoring resolves it, so the notification goes with the inline bar.
    await act(async () => {
      screen.getByRole("button", { name: "Restore terminals" }).click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(notifications.getSnapshot().items).toHaveLength(0);
    });
  });

  it("detaches the action on unmount rather than holding the workspace alive behind it", async () => {
    bridge.savedWorkspace = savedWorkspace();
    const view = renderStrict("p1");
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /Terminal 1/ })).toBeTruthy();
    });
    await act(async () => {
      bridge.emitTerminalsLost(["t1"]);
      await Promise.resolve();
    });

    view.unmount();

    const item = notifications.getSnapshot().items[0];
    expect({
      // The row survives: the shells are still dead and the user has not read
      // it yet.
      retained: item?.title,
      // But the control is honestly inert rather than quietly doing nothing.
      run: item?.actions[0]?.run,
      reason: item?.actions[0]?.unavailableReason,
    }).toEqual({
      retained: "The terminal service stopped",
      run: null,
      reason: "the project workspace is no longer open",
    });
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

  /**
   * THE TAB FOLLOWS A RENAME, which is the cross-lane defect the browser pass
   * measured: renaming an open file left the tab titled with the OLD name, so
   * the strip named a path that was no longer on disk.
   *
   * Driven through the real signal the explorer session publishes
   * (`workspace/file-rename-signal.ts`) rather than by calling the model, so
   * what is proved here is the WIRING - the controller subscribes, the project
   * key is honoured, the signal is consumed once - and not the model rule,
   * which has its own table in `workspace/__tests__/file-tab-rename.test.ts`.
   */
  it("follows a RENAME: the tab keeps its identity and takes the new name", async () => {
    await renderStrictOpened();

    await act(async () => {
      publishFileOpen("p1", sourceNode("src/before.ts"));
      await Promise.resolve();
    });
    await screen.findByRole("tab", { name: /before\.ts/ });

    await act(async () => {
      publishFileRename("p1", "src/before.ts", {
        title: "after.ts",
        relativePath: "src/after.ts",
        nodeId: "node-src/after.ts",
      });
      await Promise.resolve();
    });

    // The tab is RENAMED, not closed and reopened: one file tab before, one
    // after, under the new name.
    const renamed = await screen.findByRole("tab", { name: /after\.ts/ });
    expect(renamed).toBeTruthy();
    expect(screen.queryByRole("tab", { name: /before\.ts/ })).toBeNull();
    // The VIEWER followed too, because the tab carried the new token: the
    // registry swapped in a session on the new path.
    await waitFor(() => {
      expect(screen.getByTestId("file-viewer").textContent).toContain("src/after.ts");
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(fileReads).toContain("node-src/after.ts");
    expect(useFileRenameSignalStore.getState().signal).toBeNull();
  });

  it("DROPS a rename that happened in another project", async () => {
    await renderStrictOpened();

    await act(async () => {
      publishFileOpen("p1", sourceNode("src/before.ts"));
      await Promise.resolve();
    });
    await screen.findByRole("tab", { name: /before\.ts/ });

    await act(async () => {
      publishFileRename("p2", "src/before.ts", {
        title: "after.ts",
        relativePath: "src/after.ts",
        nodeId: "node-src/after.ts",
      });
      await Promise.resolve();
    });

    expect(screen.getByRole("tab", { name: /before\.ts/ })).toBeTruthy();
    // Still parked: it belongs to p2's workspace, not to this one.
    expect(useFileRenameSignalStore.getState().signal).not.toBeNull();
  });

  /**
   * A rename of a file NOBODY HAS OPEN is the ordinary case, and it must be
   * silent. `retargetFileTab` refuses it by design, and a controller that fed
   * that refusal to `apply` would raise the workspace's refusal notice - a
   * "tab not found" sentence at a user who renamed a file in the tree.
   */
  it("says nothing when the renamed file has no tab", async () => {
    await renderStrictOpened();

    await act(async () => {
      publishFileRename("p1", "src/never-opened.ts", {
        title: "x.ts",
        relativePath: "src/x.ts",
        nodeId: "node-src/x.ts",
      });
      await Promise.resolve();
    });

    expect(screen.queryByRole("alert")).toBeNull();
    expect(useFileRenameSignalStore.getState().signal).toBeNull();
    // And nothing was asked of main: a file rename moves no tab but its own,
    // so the ordinary case costs one array scan and no bridge call.
    expect(listedNodeIds).toEqual([]);
  });

  /**
   * A RENAMED DIRECTORY MOVES EVERY TAB UNDER IT, which the signal itself
   * cannot say: the explorer announces the entry the user typed a new name for,
   * and `src/dir/a.ts` is not that entry.
   *
   * VS Code retargets exactly these editors rather than closing them
   * (`editorService.ts` `handleMovedFile`, :259-300: every editor whose
   * resource is the moved one OR a child of it). What its `joinPath` cannot do
   * for us is the TOKEN: `mintFileNodeId` signs the path in main, so the new
   * one is asked for through the ordinary listing - which is what the two
   * assertions below prove happened, end to end, through the real registry and
   * the real viewer.
   */
  it("follows a FOLDER rename: the tab under it reads the new path", async () => {
    await renderStrictOpened();

    await act(async () => {
      publishFileOpen("p1", sourceNode("src/dir/a.ts"));
      await Promise.resolve();
    });
    await screen.findByRole("tab", { name: /a\.ts/ });

    // What main will answer for the renamed directory: one child, with the
    // token only main can mint.
    directoryPages = {
      "node-src/moved": [
        {
          nodeId: "node-src/moved/a.ts",
          name: "a.ts",
          path: "src/moved/a.ts",
          kind: "file",
          size: 12,
          modifiedMs: 1,
        },
      ],
    };

    await act(async () => {
      publishFileRename("p1", "src/dir", {
        title: "moved",
        relativePath: "src/moved",
        nodeId: "node-src/moved",
      });
      await Promise.resolve();
    });

    // THE TAB IS NOT CLOSED and keeps its name - a rename of a parent does not
    // rename the child - and its viewer now reads the file at the new path.
    await waitFor(() => {
      expect(screen.getByTestId("file-viewer").textContent).toContain("src/moved/a.ts");
    });
    expect(screen.getByRole("tab", { name: /a\.ts/ })).toBeTruthy();
    await act(async () => {
      await Promise.resolve();
    });
    // The RENAMED DIRECTORY was listed (the viewer's own watch lists the root,
    // which is why this is a containment rather than an equality).
    expect(listedNodeIds).toContain("node-src/moved");
    expect(fileReads).toContain("node-src/moved/a.ts");
  });
});

/* ------------------------------------------------------------------ *
 * What a mounted workspace publishes for the keyboard table
 * ------------------------------------------------------------------ */

/**
 * THE KEYBOARD-REACHABLE ACTIONS, driven through the registry the Studio
 * keyboard hook reads and observed on the strip a user sees.
 *
 * The hook's own suite proves the ROUTING (which project answers, and that an
 * unanswered chord is left alone) against a fake handle. What only this suite
 * can prove is that the published commands are the SAME actions the mouse
 * reaches: a `newTerminal` that opened a pty by its own path would bypass the
 * keep-alive bound and the publication fence, and a `closeActiveTab` that
 * removed a tab without killing its pty would leave a shell running with
 * nothing on screen naming it.
 *
 * Each returns whether it ACTED, and the false cases are load-bearing: the hook
 * takes the keystroke only for a command that answered.
 */
describe("the commands a mounted workspace publishes", () => {
  function commands(): ProjectWorkspaceCommands {
    const published = peekProjectWorkspaceCommands("p1");
    if (published === null) throw new Error("the workspace published no commands");
    return published;
  }

  it("opens a terminal through the same path the strip's + does", async () => {
    await renderOpened();
    bridge.nextCreate = {
      ok: true,
      value: { terminalId: "t-kbd", pid: 7, shellName: "kbd-shell", displayCwd: "p1" },
    };

    await act(async () => {
      expect(commands().newTerminal()).toBe(true);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getAllByRole("tab")).toHaveLength(2);
    });
    // The REAL create went over the bridge, with this workspace's project on it.
    expect(bridge.creates.at(-1)?.projectId).toBe("p1");
  });

  it("closes the active tab AND kills its pty", async () => {
    await renderOpened();

    await act(async () => {
      expect(commands().closeActiveTab()).toBe(true);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.queryAllByRole("tab")).toHaveLength(0);
    });
    expect(bridge.kills).toContain(AUTO_TERMINAL.terminalId);
  });

  it("declines a close when the strip is empty, so the key is left alone", async () => {
    await renderOpened();
    await act(async () => {
      commands().closeActiveTab();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.queryAllByRole("tab")).toHaveLength(0);
    });

    expect(commands().closeActiveTab()).toBe(false);
  });

  it("splits the active terminal side by side", async () => {
    await renderOpened();
    bridge.nextCreate = {
      ok: true,
      value: { terminalId: "t-split", pid: 8, shellName: "split-shell", displayCwd: "p1" },
    };

    await act(async () => {
      expect(commands().splitActiveTerminal()).toBe(true);
      await Promise.resolve();
    });

    // One TAB, two panes with a splitter between them: a split, not a new tab.
    await waitFor(() => {
      expect(screen.getAllByRole("tab")).toHaveLength(1);
      expect(screen.getAllByRole("separator").length).toBeGreaterThan(0);
    });
  });

  /**
   * `Ctrl+Enter` KEEPS THE PREVIEW TAB, through the same promotion the tab's
   * double click performs, and DECLINES whenever there is nothing to keep.
   *
   * The declines are the load-bearing half. `Enter` is a key the workspace must
   * not swallow, and the hook takes the keystroke only for a command that
   * acted - so an empty strip, a terminal group and an already-pinned file all
   * have to answer `false` rather than reporting a promotion that changed
   * nothing.
   */
  it("keeps the preview tab, and declines when there is nothing to keep", async () => {
    await renderOpened();

    // A terminal group is the active tab: nothing to keep.
    expect(commands().pinActiveTab()).toBe(false);

    await act(async () => {
      publishFileOpen(
        "p1",
        {
          nodeId: "node-src/preview.ts",
          name: "preview.ts",
          path: "src/preview.ts",
          kind: "file",
          size: 120,
          modifiedMs: 1,
        },
        "preview",
      );
      await Promise.resolve();
    });
    const tab = await screen.findByRole("tab", { name: /preview\.ts/ });
    // The strip draws the preview state in italics and says it in words.
    expect(tab.querySelector("span.italic")).not.toBeNull();

    await act(async () => {
      expect(commands().pinActiveTab()).toBe(true);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(
        screen.getByRole("tab", { name: /preview\.ts/ }).querySelector("span.italic"),
      ).toBeNull();
    });

    // Already kept: the second press has nothing to do and leaves the key.
    expect(commands().pinActiveTab()).toBe(false);
  });

  it("walks the strip in both directions, wrapping", async () => {
    await renderOpened();
    await openTerminals(2);
    await waitFor(() => {
      expect(screen.getAllByRole("tab")).toHaveLength(3);
    });

    const titles = (): readonly string[] =>
      screen.getAllByRole("tab").map((tab) => tab.getAttribute("aria-selected") ?? "");
    // The third terminal is the one the last open selected.
    expect(titles()).toEqual(["false", "false", "true"]);

    act(() => {
      expect(commands().selectTabAtOffset(1)).toBe(true);
    });
    expect(titles()).toEqual(["true", "false", "false"]);

    act(() => {
      expect(commands().selectTabAtOffset(-1)).toBe(true);
    });
    expect(titles()).toEqual(["false", "false", "true"]);
  });

  /**
   * FOCUS COMES BACK, which is what makes `Ctrl+W` repeatable.
   *
   * The closed tab's trigger is REMOVED, and focus left on a removed node drops
   * the user to `document.body` - outside every Studio surface, so the tab
   * chords stop resolving and the shortcut closes exactly one tab per pointer
   * click. Caught by the browser pass, pinned here.
   */
  it("puts focus back inside the workspace after a keyboard close", async () => {
    await renderOpened();
    await openTerminals(1);
    await waitFor(() => {
      expect(screen.getAllByRole("tab")).toHaveLength(2);
    });

    const card = document.querySelector("[data-vex-workspace-card]");
    expect(card).not.toBeNull();
    screen.getAllByRole("tab")[1]?.focus();

    await act(async () => {
      expect(commands().closeActiveTab()).toBe(true);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getAllByRole("tab")).toHaveLength(1);
    });
    // Still in the workspace, and on the tab the close selected.
    expect(card?.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("tab"));

    // And therefore repeatable: the last tab closes too, and focus lands on the
    // one control an empty strip always has.
    await act(async () => {
      expect(commands().closeActiveTab()).toBe(true);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.queryAllByRole("tab")).toHaveLength(0);
    });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "New terminal" }),
    );
  });

  it("stops publishing when the workspace unmounts", async () => {
    const view = await renderOpened();
    expect(peekProjectWorkspaceCommands("p1")).not.toBeNull();
    act(() => {
      view.unmount();
    });
    expect(peekProjectWorkspaceCommands("p1")).toBeNull();
  });
});

/**
 * THE WATERMARK the empty workspace draws, and where its rows come from.
 *
 * The rows are the caller's: `StudioCenter` passes the shortcuts its mounted
 * keyboard table can actually dispatch. What this proves is the thread - prop
 * to strip to watermark - and the default a controller mounted WITHOUT that
 * caller falls back to, which is the keyless list rather than a blank panel.
 */
describe("the empty workspace's watermark rows", () => {
  async function emptyTheWorkspace(): Promise<void> {
    const published = peekProjectWorkspaceCommands("p1");
    if (published === null) throw new Error("the workspace published no commands");
    await act(async () => {
      published.closeActiveTab();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.queryAllByRole("tab")).toHaveLength(0);
    });
  }

  it("renders the rows the caller supplied, label left and keys right", async () => {
    render(
      <StudioWorkspaceController
        projectId="p1"
        registry={registry}
        watermarkRows={[
          { action: "New terminal", keys: "Ctrl+Shift+`" },
          { action: "Close tab", keys: "Ctrl+W" },
        ]}
      />,
    );
    await waitForOpenedTerminal();
    await emptyTheWorkspace();

    const list = document.querySelector("[data-vex-empty-watermark]");
    expect(list).not.toBeNull();
    expect([...(list?.querySelectorAll("dt") ?? [])].map((n) => n.textContent)).toEqual([
      "New terminal",
      "Close tab",
    ]);
    expect([...(list?.querySelectorAll("dd") ?? [])].map((n) => n.textContent)).toEqual([
      "Ctrl+Shift+`",
      "Ctrl+W",
    ]);
  });

  it("falls back to the surface's own keyless rows with no caller", async () => {
    await renderOpened();
    await emptyTheWorkspace();

    const list = document.querySelector("[data-vex-empty-watermark]");
    expect(list).not.toBeNull();
    expect([...(list?.querySelectorAll("dd") ?? [])].map((n) => n.textContent)).toEqual([
      "",
      "",
    ]);
  });
});

/** The keyboard-reachable commands a mounted workspace published. */
function commandsFor(projectId: string): ProjectWorkspaceCommands {
  const published = peekProjectWorkspaceCommands(projectId);
  if (published === null) throw new Error("the workspace published no commands");
  return published;
}

/* ------------------------------------------------------------------ *
 * File tabs across a restart
 * ------------------------------------------------------------------ */

/**
 * THE FILE TABS' OWN HOME, driven through the controller that owns both ends.
 *
 * The live test measured the defect this closes: a project left with four
 * terminals and `.mcp.json` open came back with the four terminals only,
 * because `toPersistedLayout` deliberately writes no file tab and the terminal
 * restore channel answers null for a project with no live terminal.
 *
 * The RECORD's own rules (bounds, LRU, hostile paths) are a table in
 * `stores/__tests__/uiStore-studio-file-tabs-v18.test.ts` and the PLACEMENT
 * rules in `workspace/__tests__/restore-file-tabs.test.ts`. What only this
 * suite can prove is the WIRING: that opening a file writes the record, that a
 * mount reads it, that every path in it is re-resolved through main's own
 * listing before a tab exists, and that a path main cannot confirm is dropped
 * and COUNTED at the user rather than silently missing.
 */
describe("file tabs across a restart", () => {
  function node(path: string) {
    return {
      nodeId: `node-${path}`,
      name: path.slice(path.lastIndexOf("/") + 1),
      path,
      kind: "file" as const,
      size: 12,
      modifiedMs: 1,
    };
  }

  function persisted(): Record<string, unknown> {
    return useUiStore.getState().studioFileTabs;
  }

  it("WRITES the record when a file tab is opened, and again when it closes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await renderStrictOpened();

    await act(async () => {
      publishFileOpen("p1", node("src/a.ts"));
      await Promise.resolve();
    });
    await screen.findByRole("tab", { name: /a\.ts/ });

    // DEBOUNCED, on the terminal layout's own timer: nothing is written yet.
    expect(persisted()["p1"]).toBeUndefined();
    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });

    expect(persisted()["p1"]).toMatchObject({
      tabs: [{ relativePath: "src/a.ts", pinned: true, active: true }],
    });

    // And closing it forgets the project rather than storing an empty strip.
    await act(async () => {
      commandsFor("p1").closeActiveTab();
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });
    expect(persisted()["p1"]).toBeUndefined();
  });

  it("RESTORES a persisted tab, resolving its path through main's own listing", async () => {
    useUiStore.setState({
      studioFileTabs: {
        p1: {
          tabs: [{ relativePath: "src/a.ts", pinned: true, position: 1, active: false }],
          savedAtMs: 1,
        },
      },
    });
    // What main answers for the walk: the root holds `src`, `src` holds `a.ts`.
    directoryPages = {
      "<root>": [
        {
          nodeId: "node-src",
          name: "src",
          path: "src",
          kind: "directory",
          size: null,
          modifiedMs: 1,
        },
      ],
      "node-src": [node("src/a.ts")],
    };

    // NOT `renderStrictOpened`: a workspace that came back with a file in it
    // is not empty, so the first-terminal auto-open declines. That is the
    // behaviour being asserted here as much as the tab is - a relaunch must not
    // add a shell nobody asked for to a strip that restored.
    renderStrict();

    const tab = await screen.findByRole("tab", { name: /a\.ts/ });
    expect(tab).toBeTruthy();
    // THE TOKEN CAME FROM MAIN, not from the record: the viewer read the file
    // through the node the walk confirmed.
    await waitFor(() => {
      expect(fileReads).toContain("node-src/a.ts");
    });
    // And the walk went through the project ROOT, which is the whole security
    // argument for persisting a path.
    expect(listedNodeIds).toContain(null);
    expect(listedNodeIds).toContain("node-src");
    // Nothing was dropped, so nothing is said about a dropped tab. (The
    // viewer's own loading row is a `status` too, which is why this asks for
    // the sentence rather than for the role.)
    expect(screen.queryByText(/could not be restored/)).toBeNull();
    // And no terminal was opened over a workspace that restored to something.
    expect(bridge.attaches).toEqual([]);
    expect(screen.getAllByRole("tab")).toHaveLength(1);
  });

  it("DROPS a path main cannot confirm, and says how many", async () => {
    useUiStore.setState({
      studioFileTabs: {
        p1: {
          tabs: [
            { relativePath: "src/gone.ts", pinned: true, position: 1, active: false },
          ],
          savedAtMs: 1,
        },
      },
    });
    // The root lists nothing: the file was deleted between the sessions.
    directoryPages = {};

    await renderStrictOpened();

    // The count SURVIVES the auto-open that follows it: a workspace that
    // restored to nothing opens its first terminal a moment later, and the
    // transient notice slot is cleared by exactly that success.
    const notice = await screen.findByRole("status");
    expect(notice.textContent).toContain("1 file tab could not be restored");
    expect(screen.queryByRole("tab", { name: /gone\.ts/ })).toBeNull();
  });

  it("does not restore ANOTHER project's record into this workspace", async () => {
    useUiStore.setState({
      studioFileTabs: {
        p2: {
          tabs: [{ relativePath: "src/a.ts", pinned: true, position: 0, active: false }],
          savedAtMs: 1,
        },
      },
    });
    directoryPages = { "<root>": [node("src/a.ts")] };

    await renderStrictOpened("p1");

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole("tab", { name: /a\.ts/ })).toBeNull();
    // Nothing was even asked of main: an absent record costs no listing.
    expect(listedNodeIds).toEqual([]);
  });
});
