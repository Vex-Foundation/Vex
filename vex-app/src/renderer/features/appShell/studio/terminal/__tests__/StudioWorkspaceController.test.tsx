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

import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TERMINAL_SNAPSHOT_VERSION,
  type TerminalWorkspaceSnapshot,
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

/** A saved workspace with two DELIBERATELY UNEQUAL panes in one group. */
function savedWorkspace(): TerminalWorkspaceSnapshot {
  return {
    version: TERMINAL_SNAPSHOT_VERSION,
    projectId: "p1",
    savedAt: 1,
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
      cwdAtSpawn: "/w",
      cols: 80,
      rows: 24,
      serialized: "",
      droppedRows: 0,
    })),
  };
}

function renderController(projectId = "p1") {
  return render(<StudioWorkspaceController projectId={projectId} registry={registry} />);
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

describe("StudioWorkspaceController surface", () => {
  it("layers the brand watermark under every terminal pane", async () => {
    const { container } = renderController();
    await openTerminals(1);

    const mark = container.querySelector("svg.text-brand-mark");
    expect(mark).not.toBeNull();
    expect(mark?.getAttribute("aria-hidden")).toBe("true");
  });
});
