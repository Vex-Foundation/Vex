/**
 * The Studio centre: keep-alive, the refusal prompt, the disposal an explicit
 * close performs, the stale-selection repair, and the explorer switch ORDER.
 *
 * `StudioWorkspaceController` is replaced by a marker here. The controller has
 * its own suite over the real xterm registry; what THIS file is about is the
 * centre's own contract - which controllers exist, which are hidden, and which
 * DOM nodes survive - and mounting four real terminal workspaces to assert node
 * identity would test the terminal instead.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Result } from "@shared/ipc/result.js";
import type { ProjectDto, ProjectList } from "@shared/schemas/projects.js";
import { projectKeys } from "../../../../lib/api/projects.js";
import { useUiStore } from "../../../../stores/uiStore.js";
import { ExplorerRegistry } from "../explorer/index.js";
import { TerminalRegistry } from "../terminal/index.js";
import {
  clearProjectTerminals,
  peekProjectTerminals,
  publishProjectTerminals,
  publishProjectWorkspaceLifecycle,
} from "../workspace/project-terminals.js";
import type { WorkspaceCloseOutcome } from "../workspace/close-lifecycle.js";
import { STUDIO_WORKSPACE_KEEP_ALIVE_MAX } from "../workspace/keep-alive.js";
import { installStudioDomStubs, makeError, makeProject } from "./studio-fixtures.js";

const projectsListMock = vi.fn<() => Promise<Result<ProjectList>>>();

/**
 * The controller marker also plays its RETRY half of the contract.
 *
 * The real controller renders a failed close as an alert with a "Try closing
 * again" action, and that action must reach the CENTRE rather than the
 * controller's own close - a retry that succeeds has to leave the kept-alive
 * set, and the set is this component's. A marker with no such button could not
 * tell a wired retry from an unwired one.
 *
 * Projects whose controller must THROW on render.
 *
 * A workspace render throw is the failure the per-workspace boundary exists
 * for, and it is not otherwise reachable from this suite: the real one comes
 * out of a bad persisted layout deep inside the controller. Driving it from
 * outside React keeps the crash deterministic and lets a subject cross from
 * failing to healthy without remounting anything.
 */
const controllerCrash = { projectIds: new Set<string>() };

vi.mock("../terminal/StudioWorkspaceController.js", () => ({
  StudioWorkspaceController: ({
    projectId,
    onRetryClose,
  }: {
    projectId: string;
    onRetryClose?: () => void;
  }) => {
    if (controllerCrash.projectIds.has(projectId)) {
      throw new TypeError("workspace layout is not iterable");
    }
    return (
      <div data-testid={`workspace-${projectId}`}>
        <button type="button" onClick={onRetryClose}>
          {`Try closing ${projectId} again`}
        </button>
      </div>
    );
  },
}));

/**
 * The centre's DELETE REPORT, captured.
 *
 * `StudioProjectDialogs` is the surface that tells the centre a project was
 * deleted, and reaching that report through the real dialog would mean driving
 * the whole delete flow - its intent channel, its confirmation, its mutation -
 * to observe one callback the centre owns. The dialogs have their own suite;
 * this one is about what the CENTRE does when the report arrives, so the report
 * is delivered directly.
 */
const deleted = { report: null as ((projectId: string) => void) | null };

vi.mock("../projects/index.js", () => ({
  openProjectCreator: (): void => undefined,
  StudioProjectDialogs: ({
    onProjectDeleted,
  }: {
    onProjectDeleted: (projectId: string) => void;
  }) => {
    deleted.report = onProjectDeleted;
    return null;
  },
}));

const { StudioCenter } = await import("../StudioCenter.js");

/**
 * A REAL `TerminalRegistry` with its `dispose` recorded.
 *
 * A hand-written object would need a cast to satisfy the prop, and a cast is
 * exactly how a double drifts from the contract it stands in for. The real
 * class holds no records here, so `dispose` is a no-op beyond the recording.
 */
function makeRecordingTerminalRegistry(): {
  readonly disposed: string[];
  readonly registry: TerminalRegistry;
} {
  const disposed: string[] = [];
  const registry = new TerminalRegistry();
  const realDispose = registry.dispose.bind(registry);
  registry.dispose = (terminalId: string): void => {
    disposed.push(terminalId);
    realDispose(terminalId);
  };
  return { disposed, registry };
}

interface Harness {
  readonly explorers: ExplorerRegistry;
  readonly switchCalls: { next: string; previous: string | null }[];
  readonly disposedTerminals: string[];
  readonly client: QueryClient;
}

function renderCenter(): Harness {
  const explorers = new ExplorerRegistry();
  const switchCalls: { next: string; previous: string | null }[] = [];
  const realSwitchTo = explorers.switchTo.bind(explorers);
  explorers.switchTo = async (next: string, previous: string | null) => {
    switchCalls.push({ next, previous });
    return realSwitchTo(next, previous);
  };

  const terminals = makeRecordingTerminalRegistry();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={client}>
      <StudioCenter
        explorerRegistry={explorers}
        terminalRegistry={terminals.registry}
      />
    </QueryClientProvider>,
  );
  return { explorers, switchCalls, disposedTerminals: terminals.disposed, client };
}

function select(projectId: string | null): void {
  act(() => {
    useUiStore.getState().setActiveProjectId(projectId);
  });
}

beforeAll(() => {
  installStudioDomStubs();
});

beforeEach(() => {
  // The project index is a MODULE SINGLETON. Terminal ids or a close handler
  // left by the previous test would be taken by this one.
  clearProjectTerminals();
  controllerCrash.projectIds.clear();
  projectsListMock.mockReset();
  projectsListMock.mockResolvedValue({ ok: true, data: [] });
  useUiStore.setState({ activeProjectId: null, runtimeMode: "studio" });
  Object.defineProperty(window, "vex", {
    configurable: true,
    value: {
      projects: { list: projectsListMock },
      // A READY bridge, so the readiness panel renders nothing. Without the
      // stub the query rejects and the panel renders its honest "the check did
      // not answer" branch, which is a real alert and would make every
      // "no alert here" assertion in this suite pass or fail for the wrong
      // reason. `bridge-readiness` has its own suite.
      studio: {
        getBridgeReadiness: () =>
          Promise.resolve({ ok: true, data: { kind: "ready" } }),
      },
      files: {
        list: () => Promise.resolve({ ok: true, data: null }),
        watch: () => Promise.resolve({ ok: true, data: null }),
      },
    },
  });
});

describe("welcome versus workspace", () => {
  it("shows the welcome screen with nothing selected", async () => {
    renderCenter();
    expect(await screen.findByRole("heading", { name: "Vex Studio" })).not.toBeNull();
  });

  it("shows the project's workspace once one is selected", async () => {
    const project = makeProject({ name: "vex-core" });
    projectsListMock.mockResolvedValue({ ok: true, data: [project] });
    renderCenter();
    await screen.findByRole("heading", { name: "Vex Studio" });

    select(project.id);
    await screen.findByTestId(`workspace-${project.id}`);
  });
});

describe("the bridge diagnostic in the open-project view", () => {
  /**
   * A user with projects goes straight into a workspace and never sees the
   * welcome screen again, so a bridge that is missing would have been reported
   * once - at a moment they may not have been present for - and never after.
   */
  function unbuiltBridge(): void {
    Object.defineProperty(window, "vex", {
      configurable: true,
      value: {
        projects: { list: projectsListMock },
        studio: {
          getBridgeReadiness: () =>
            Promise.resolve({
              ok: true,
              data: {
                kind: "missing_dev",
                platform: "linux",
                requiredGoVersion: "go1.27.0",
                go: { kind: "absent" },
              },
            }),
        },
        files: {
          list: () => Promise.resolve({ ok: true, data: null }),
          watch: () => Promise.resolve({ ok: true, data: null }),
        },
      },
    });
  }

  it("reports a missing bridge beside an OPEN project, not only on welcome", async () => {
    unbuiltBridge();
    const project = makeProject({ name: "vex-core" });
    projectsListMock.mockResolvedValue({ ok: true, data: [project] });
    renderCenter();
    await screen.findByRole("heading", { name: "Vex Studio" });

    select(project.id);
    await screen.findByTestId(`workspace-${project.id}`);
    const panels = document.querySelectorAll(
      '[data-vex-area="studio-bridge-readiness"]',
    );
    // Exactly ONE: welcome and the open-project view are mutually exclusive,
    // so the panel is never in the tree twice.
    expect(panels).toHaveLength(1);
    expect(panels[0]?.textContent).toContain("has not been built yet");
    // And it is NOT inside a workspace subtree, so a workspace that falls over
    // cannot take the installation-level diagnostic down with it.
    expect(panels[0]?.closest("[data-vex-studio-workspace]")).toBeNull();
  });

  it("renders nothing at all when the bridge is there", async () => {
    const project = makeProject({ name: "vex-core" });
    projectsListMock.mockResolvedValue({ ok: true, data: [project] });
    renderCenter();
    await screen.findByRole("heading", { name: "Vex Studio" });
    select(project.id);
    await screen.findByTestId(`workspace-${project.id}`);

    expect(
      document.querySelector('[data-vex-area="studio-bridge-readiness"]'),
    ).toBeNull();
  });
});

describe("keep-alive", () => {
  it("keeps a switched-away workspace MOUNTED as the same DOM node", async () => {
    const first = makeProject({ name: "first" });
    const second = makeProject({ name: "second" });
    projectsListMock.mockResolvedValue({ ok: true, data: [first, second] });
    renderCenter();
    await screen.findByRole("heading", { name: "Vex Studio" });

    select(first.id);
    const firstNode = await screen.findByTestId(`workspace-${first.id}`);

    select(second.id);
    await screen.findByTestId(`workspace-${second.id}`);

    // THE SAME NODE, still in the document: hidden, never destroyed. A remount
    // would have thrown away the terminal screen the user was reading.
    const afterSwitch = screen.getByTestId(`workspace-${first.id}`);
    expect(afterSwitch).toBe(firstNode);
    expect(afterSwitch.closest("[data-vex-studio-workspace]")?.hasAttribute("hidden")).toBe(
      true,
    );
    expect(
      screen
        .getByTestId(`workspace-${second.id}`)
        .closest("[data-vex-studio-workspace]")
        ?.hasAttribute("hidden"),
    ).toBe(false);
  });

  it("opening a 5th project REFUSES with the close prompt, focused on Cancel", async () => {
    const projects = Array.from({ length: 5 }, (_, index) =>
      makeProject({ name: `p${String(index + 1)}` }),
    );
    const [firstProject] = projects;
    const fifth = projects[projects.length - 1];
    if (firstProject === undefined || fifth === undefined) throw new Error("fixture");
    projectsListMock.mockResolvedValue({ ok: true, data: projects });
    renderCenter();
    await screen.findByRole("heading", { name: "Vex Studio" });

    for (const project of projects.slice(0, STUDIO_WORKSPACE_KEEP_ALIVE_MAX)) {
      select(project.id);
      await screen.findByTestId(`workspace-${project.id}`);
    }

    select(fifth.id);
    await screen.findByText("Close a project workspace first");

    // No 5th workspace was mounted and nothing was evicted to make room.
    expect(screen.queryByTestId(`workspace-${fifth.id}`)).toBeNull();
    for (const project of projects.slice(0, STUDIO_WORKSPACE_KEEP_ALIVE_MAX)) {
      expect(screen.getByTestId(`workspace-${project.id}`)).not.toBeNull();
    }

    // The prompt lists the four, and focus defaults to the SAFE arm.
    const list = screen.getByLabelText("Open project workspaces");
    expect(list.querySelectorAll("li")).toHaveLength(
      STUDIO_WORKSPACE_KEEP_ALIVE_MAX,
    );
    expect(document.activeElement?.textContent).toBe("Cancel");
    // No suppression on the destructive path.
    expect(screen.queryByText(/do not ask again/i)).toBeNull();
  });

  it("closing a workspace disposes its terminals and unmounts it", async () => {
    const projects = Array.from({ length: 5 }, (_, index) =>
      makeProject({ name: `p${String(index + 1)}` }),
    );
    const [firstProject] = projects;
    const fifth = projects[projects.length - 1];
    if (firstProject === undefined || fifth === undefined) throw new Error("fixture");
    projectsListMock.mockResolvedValue({ ok: true, data: projects });
    const harness = renderCenter();
    await screen.findByRole("heading", { name: "Vex Studio" });

    for (const project of projects.slice(0, STUDIO_WORKSPACE_KEEP_ALIVE_MAX)) {
      select(project.id);
      await screen.findByTestId(`workspace-${project.id}`);
    }
    // The controller publishes these while it is mounted; the marker used here
    // does not, so the test plays the controller's part of that contract.
    publishProjectTerminals(firstProject.id, ["t-a", "t-b"]);

    select(fifth.id);
    await screen.findByText("Close a project workspace first");

    fireEvent.click(screen.getByRole("button", { name: "Close the p1 workspace" }));

    await waitFor(() => {
      expect(screen.queryByTestId(`workspace-${firstProject.id}`)).toBeNull();
    });
    // The xterm instances are destroyed through the registry seam - otherwise
    // they would be retained for the life of the window, named by nothing.
    expect(harness.disposedTerminals.toSorted()).toEqual(["t-a", "t-b"]);
  });

  /**
   * THE AWAIT IS THE CONTRACT.
   *
   * The controller's close commits the buffer-bearing snapshot with every pty
   * still running and only then kills them. The set transition unmounts that
   * controller and disposes its xterms, so performing it first would tear down
   * the only owner of the layout mid-commit - and the snapshot the reopen
   * revives from is what would be lost.
   */
  it("AWAITS the workspace's ordered close before unmounting it", async () => {
    const projects = Array.from({ length: 5 }, (_, index) =>
      makeProject({ name: `p${String(index + 1)}` }),
    );
    const [firstProject] = projects;
    const fifth = projects[projects.length - 1];
    if (firstProject === undefined || fifth === undefined) throw new Error("fixture");
    projectsListMock.mockResolvedValue({ ok: true, data: projects });
    const harness = renderCenter();
    await screen.findByRole("heading", { name: "Vex Studio" });

    for (const project of projects.slice(0, STUDIO_WORKSPACE_KEEP_ALIVE_MAX)) {
      select(project.id);
      await screen.findByTestId(`workspace-${project.id}`);
    }
    publishProjectTerminals(firstProject.id, ["t-a", "t-b"]);
    let commit = (): void => undefined;
    const committed = new Promise<void>((resolve) => {
      commit = resolve;
    });
    publishProjectWorkspaceLifecycle(firstProject.id, {
      close: async () => {
        await committed;
        return { ok: true };
      },
      discard: () => undefined,
    });

    select(fifth.id);
    await screen.findByText("Close a project workspace first");
    fireEvent.click(screen.getByRole("button", { name: "Close the p1 workspace" }));

    // Mid-commit: the workspace is STILL mounted and nothing has been disposed.
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId(`workspace-${firstProject.id}`)).not.toBeNull();
    expect(harness.disposedTerminals).toEqual([]);

    await act(async () => {
      commit();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.queryByTestId(`workspace-${firstProject.id}`)).toBeNull();
    });
    expect(harness.disposedTerminals.toSorted()).toEqual(["t-a", "t-b"]);
  });

  it("states per row how many running terminals the close would END", async () => {
    const projects = Array.from({ length: 5 }, (_, index) =>
      makeProject({ name: `p${String(index + 1)}` }),
    );
    const fifth = projects[projects.length - 1];
    if (fifth === undefined) throw new Error("fixture");
    projectsListMock.mockResolvedValue({ ok: true, data: projects });
    renderCenter();
    await screen.findByRole("heading", { name: "Vex Studio" });

    for (const project of projects.slice(0, STUDIO_WORKSPACE_KEEP_ALIVE_MAX)) {
      select(project.id);
      await screen.findByTestId(`workspace-${project.id}`);
    }
    const [p1, p2, p3] = projects;
    if (p1 === undefined || p2 === undefined || p3 === undefined) {
      throw new Error("fixture");
    }
    publishProjectTerminals(p1.id, ["t-a", "t-b"]);
    publishProjectTerminals(p2.id, ["t-c"]);
    publishProjectTerminals(p3.id, []);
    // p4 publishes NOTHING, which is a different fact from "none".

    select(fifth.id);
    await screen.findByText("Close a project workspace first");

    const rows = screen.getByLabelText("Open project workspaces").querySelectorAll("li");
    expect(rows[0]?.textContent).toContain("Closes 2 running terminals");
    // SINGULAR at one: the count is a consequence the user is choosing on.
    expect(rows[1]?.textContent).toContain("Closes 1 running terminal");
    expect(rows[2]?.textContent).toContain("No running terminals");
    // Nothing invented for the row whose workspace published no count.
    expect(rows[3]?.textContent).toBe("p4Close");
  });
});

describe("stale-selection repair", () => {
  it("a vanished project leaves the set and the shell falls back to welcome", async () => {
    const staying = makeProject({ name: "staying" });
    const vanishing = makeProject({ name: "vanishing" });
    projectsListMock.mockResolvedValue({ ok: true, data: [staying, vanishing] });
    const harness = renderCenter();
    await screen.findByRole("heading", { name: "Vex Studio" });

    select(staying.id);
    await screen.findByTestId(`workspace-${staying.id}`);
    select(vanishing.id);
    await screen.findByTestId(`workspace-${vanishing.id}`);

    // The next SETTLED read no longer carries it (deleted in another window).
    act(() => {
      harness.client.setQueryData(projectKeys.list(), {
        ok: true,
        data: [staying],
      });
    });

    await waitFor(() => {
      expect(screen.queryByTestId(`workspace-${vanishing.id}`)).toBeNull();
    });
    // Selection falls back to welcome rather than to a neighbour, and the id
    // is cleared in the store so the sidebar and the centre agree.
    expect(useUiStore.getState().activeProjectId).toBeNull();
    await screen.findByRole("heading", { name: "Vex Studio" });
    // The surviving workspace is untouched.
    expect(screen.getByTestId(`workspace-${staying.id}`)).not.toBeNull();
  });

  it("does NOT close workspaces while the read is in flight or failed", async () => {
    const project = makeProject({ name: "vex-core" });
    projectsListMock.mockResolvedValue({ ok: true, data: [project] });
    const harness = renderCenter();
    await screen.findByRole("heading", { name: "Vex Studio" });
    select(project.id);
    await screen.findByTestId(`workspace-${project.id}`);

    // A failed refetch is not evidence that the project is gone.
    act(() => {
      harness.client.setQueryData(projectKeys.list(), {
        ok: false,
        error: makeError("db down"),
      });
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId(`workspace-${project.id}`)).not.toBeNull();
    expect(useUiStore.getState().activeProjectId).toBe(project.id);
  });
});

describe("explorer sessions", () => {
  it("switchTo is called with (next, previous) in that order", async () => {
    const first = makeProject({ name: "first" });
    const second = makeProject({ name: "second" });
    projectsListMock.mockResolvedValue({ ok: true, data: [first, second] });
    const harness = renderCenter();
    await screen.findByRole("heading", { name: "Vex Studio" });

    select(first.id);
    await screen.findByTestId(`workspace-${first.id}`);
    select(second.id);
    await screen.findByTestId(`workspace-${second.id}`);

    expect(harness.switchCalls).toEqual([
      { next: first.id, previous: null },
      { next: second.id, previous: first.id },
    ]);
  });

  it("a kept-alive project keeps its session while another is shown", async () => {
    const first = makeProject({ name: "first" });
    const second = makeProject({ name: "second" });
    projectsListMock.mockResolvedValue({ ok: true, data: [first, second] });
    const harness = renderCenter();
    await screen.findByRole("heading", { name: "Vex Studio" });

    select(first.id);
    await screen.findByTestId(`workspace-${first.id}`);
    select(second.id);
    await screen.findByTestId(`workspace-${second.id}`);

    // The registry still holds BOTH: switching away stops the watcher, it does
    // not throw away the tree the user expanded.
    await waitFor(() => {
      expect(harness.explorers.has(first.id)).toBe(true);
    });
    expect(harness.explorers.has(second.id)).toBe(true);
    expect(harness.explorers.consumerCount(first.id)).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ *
 * B4 review, finding W1: the close must not be undone by reconciliation
 * ------------------------------------------------------------------ */

/** A lifecycle handle whose calls are recorded. */
function publishRecordingLifecycle(
  projectId: string,
  outcome: WorkspaceCloseOutcome = { ok: true },
): { closes: number; discards: number } {
  const calls = { closes: 0, discards: 0 };
  publishProjectWorkspaceLifecycle(projectId, {
    close: () => {
      calls.closes += 1;
      return Promise.resolve(outcome);
    },
    discard: () => {
      calls.discards += 1;
    },
  });
  return calls;
}

describe("closing the ACTIVE workspace", () => {
  /**
   * The close of the shown workspace used to be a no-op with an extra remount.
   *
   * `closeProject` drops it from the set and falls the CENTRE back to welcome,
   * but `uiStore.activeProjectId` still named it - and the reconciliation
   * effect exists precisely to mount a workspace for the selection, so its next
   * run put the project straight back. The two owners of "which project is
   * shown" have to agree at the same moment.
   */
  it("gives up the selection, so reconciliation does not re-add it", async () => {
    const projects = Array.from({ length: 5 }, (_, index) =>
      makeProject({ name: `p${String(index + 1)}` }),
    );
    const [first] = projects;
    const fifth = projects[projects.length - 1];
    if (first === undefined || fifth === undefined) throw new Error("fixture");
    projectsListMock.mockResolvedValue({ ok: true, data: projects });
    renderCenter();
    await screen.findByRole("heading", { name: "Vex Studio" });

    for (const project of projects.slice(0, STUDIO_WORKSPACE_KEEP_ALIVE_MAX)) {
      select(project.id);
      await screen.findByTestId(`workspace-${project.id}`);
    }
    // Back to p1, so the workspace about to be closed is the SHOWN one.
    select(first.id);
    await act(async () => {
      await Promise.resolve();
    });
    publishRecordingLifecycle(first.id);

    // The refusal returns the selection to where it was, which is p1.
    select(fifth.id);
    await screen.findByText("Close a project workspace first");
    await waitFor(() => {
      expect(useUiStore.getState().activeProjectId).toBe(first.id);
    });

    fireEvent.click(screen.getByRole("button", { name: "Close the p1 workspace" }));

    await waitFor(() => {
      expect(screen.queryByTestId(`workspace-${first.id}`)).toBeNull();
    });
    // THE ASSERTION. p1 is still in the project list and the reconciliation
    // effect runs on every render, so a selection left pointing at it would
    // have remounted the workspace by the next tick.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByTestId(`workspace-${first.id}`)).toBeNull();
    expect(useUiStore.getState().activeProjectId).toBeNull();
  });

  it("a FAILED close leaves the workspace mounted and the selection alone", async () => {
    const projects = Array.from({ length: 5 }, (_, index) =>
      makeProject({ name: `p${String(index + 1)}` }),
    );
    const [first] = projects;
    const fifth = projects[projects.length - 1];
    if (first === undefined || fifth === undefined) throw new Error("fixture");
    projectsListMock.mockResolvedValue({ ok: true, data: projects });
    const harness = renderCenter();
    await screen.findByRole("heading", { name: "Vex Studio" });

    for (const project of projects.slice(0, STUDIO_WORKSPACE_KEEP_ALIVE_MAX)) {
      select(project.id);
      await screen.findByTestId(`workspace-${project.id}`);
    }
    publishProjectTerminals(first.id, ["t-a"]);
    publishRecordingLifecycle(first.id, { ok: false, failure: "persist_refused" });

    select(fifth.id);
    await screen.findByText("Close a project workspace first");
    fireEvent.click(screen.getByRole("button", { name: "Close the p1 workspace" }));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // NOTHING moved. The snapshot was not committed, so the workspace is still
    // the only owner of a layout that exists nowhere else, and its xterms must
    // not be destroyed.
    expect(screen.queryByTestId(`workspace-${first.id}`)).not.toBeNull();
    expect(harness.disposedTerminals).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * B4 review round 2, finding W2d: a failed close of a HIDDEN workspace
 * put its alert where nobody was looking
 * ------------------------------------------------------------------ */

describe("a FAILED close of a workspace that is not the active one", () => {
  /** The four-project set, with the fifth left over to raise the prompt. */
  async function openFour(): Promise<{
    readonly projects: readonly ProjectDto[];
    readonly harness: Harness;
  }> {
    const projects = Array.from({ length: 5 }, (_, index) =>
      makeProject({ name: `p${String(index + 1)}` }),
    );
    projectsListMock.mockResolvedValue({ ok: true, data: projects });
    const harness = renderCenter();
    await screen.findByRole("heading", { name: "Vex Studio" });
    for (const project of projects.slice(0, STUDIO_WORKSPACE_KEEP_ALIVE_MAX)) {
      select(project.id);
      await screen.findByTestId(`workspace-${project.id}`);
    }
    return { projects, harness };
  }

  function projectAt(projects: readonly ProjectDto[], index: number): ProjectDto {
    const project = projects[index];
    if (project === undefined) throw new Error("fixture");
    return project;
  }

  /**
   * THE VISIBILITY PROOF.
   *
   * Every kept-alive workspace but the active one is CSS-hidden here, and the
   * controller renders a failed close as an alert inside its own subtree. So a
   * close that failed for a hidden workspace raised an error, and its retry,
   * in a subtree with `hidden` on it - while the prompt that started the
   * gesture had already closed on the click. The user saw nothing at all.
   */
  it("ACTIVATES it, so the alert and its retry are where the user is looking", async () => {
    const { projects } = await openFour();
    const first = projectAt(projects, 0);
    const fourth = projectAt(projects, STUDIO_WORKSPACE_KEEP_ALIVE_MAX - 1);
    const fifth = projectAt(projects, projects.length - 1);
    publishRecordingLifecycle(first.id, { ok: false, failure: "kill_incomplete" });

    select(fifth.id);
    await screen.findByText("Close a project workspace first");
    // p4 is the shown workspace; p1, the one about to be closed, is hidden.
    await waitFor(() => {
      expect(useUiStore.getState().activeProjectId).toBe(fourth.id);
    });
    expect(
      screen
        .getByTestId(`workspace-${first.id}`)
        .closest("[data-vex-studio-workspace]")
        ?.hasAttribute("hidden"),
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Close the p1 workspace" }));

    await waitFor(() => {
      expect(useUiStore.getState().activeProjectId).toBe(first.id);
    });
    // Still mounted - a failed close destroys nothing - and now SHOWN.
    expect(
      screen
        .getByTestId(`workspace-${first.id}`)
        .closest("[data-vex-studio-workspace]")
        ?.hasAttribute("hidden"),
    ).toBe(false);
  });

  it("leaves the selection alone when the failed workspace was already active", async () => {
    const { projects } = await openFour();
    const first = projectAt(projects, 0);
    const fifth = projectAt(projects, projects.length - 1);
    select(first.id);
    await act(async () => {
      await Promise.resolve();
    });
    publishRecordingLifecycle(first.id, { ok: false, failure: "persist_refused" });

    select(fifth.id);
    await screen.findByText("Close a project workspace first");
    fireEvent.click(screen.getByRole("button", { name: "Close the p1 workspace" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(useUiStore.getState().activeProjectId).toBe(first.id);
  });

  /**
   * The retry must go through THIS component, not the controller's own close.
   *
   * A retry answered inside the controller would commit the snapshot, end the
   * shells and leave a `closed` workspace mounted and shown here: a surface
   * that can no longer persist, open a terminal, or be closed again.
   */
  it("routes the notice's retry through the centre, so a second attempt leaves the set", async () => {
    const { projects, harness } = await openFour();
    const first = projectAt(projects, 0);
    const fifth = projectAt(projects, projects.length - 1);
    publishProjectTerminals(first.id, ["t-a"]);
    let outcome: WorkspaceCloseOutcome = {
      ok: false,
      failure: "kill_incomplete",
    };
    const calls = { closes: 0 };
    publishProjectWorkspaceLifecycle(first.id, {
      close: () => {
        calls.closes += 1;
        return Promise.resolve(outcome);
      },
      discard: () => undefined,
    });

    select(fifth.id);
    await screen.findByText("Close a project workspace first");
    fireEvent.click(screen.getByRole("button", { name: "Close the p1 workspace" }));
    await waitFor(() => {
      expect(calls.closes).toBe(1);
    });
    expect(screen.queryByTestId(`workspace-${first.id}`)).not.toBeNull();

    outcome = { ok: true };
    fireEvent.click(
      screen.getByRole("button", { name: `Try closing ${first.id} again` }),
    );

    await waitFor(() => {
      expect(screen.queryByTestId(`workspace-${first.id}`)).toBeNull();
    });
    expect(calls.closes).toBe(2);
    // The set transition ran, which is the half the controller cannot do.
    expect(harness.disposedTerminals).toEqual(["t-a"]);
    expect(useUiStore.getState().activeProjectId).toBeNull();
  });
});

describe("a DELETED project", () => {
  /**
   * The renderer half of the two-sided fix. The delete has already removed this
   * project's terminal snapshot in main, and the controller's teardown flush
   * would write a persist that RECREATES it - a file holding a deleted
   * project's terminal scrollback. The latch has to reach the controller BEFORE
   * the unmount, which is why `discard` is synchronous and why the centre calls
   * it first.
   */
  it("DISCARDS its workspace layout before unmounting the controller", async () => {
    const projects = [makeProject({ name: "p1" })];
    const [first] = projects;
    if (first === undefined) throw new Error("fixture");
    projectsListMock.mockResolvedValue({ ok: true, data: projects });
    renderCenter();
    await screen.findByRole("heading", { name: "Vex Studio" });
    select(first.id);
    const mounted = await screen.findByTestId(`workspace-${first.id}`);
    const calls = publishRecordingLifecycle(first.id);

    // What `StudioProjectDialogs` reports when a delete completes.
    const report = deleted.report;
    if (report === null) throw new Error("the dialogs never reported in");
    act(() => {
      report(first.id);
    });

    expect(calls.discards).toBe(1);
    // A DISCARD, never a close: there is nothing to commit for a project that
    // is gone, and main's delete has already ended its shells.
    expect(calls.closes).toBe(0);
    await waitFor(() => {
      expect(mounted.isConnected).toBe(false);
    });
  });
});

/**
 * PER-WORKSPACE CONTAINMENT.
 *
 * Before the boundary this suite's crash took the whole React root with it:
 * React 19 unmounts the root when a render throws with nothing above it, so one
 * project's bad layout blanked the window and every OTHER project's workspace
 * with it. Remove the `ErrorBoundary` from `StudioProjectWorkspace` and the
 * first test here goes red - nothing renders at all.
 *
 * The preservation half is the one that matters for the product: the terminal
 * instances and the ptys live OUTSIDE React (the registry and the pty host), so
 * a fallback and a retry must not cost the user a single running shell.
 */
describe("a workspace that throws", () => {
  beforeEach(() => {
    // React reports every caught error through console.error. The assertions
    // are about the surface, and the banner buries a real failure in noise.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("is contained: its own recovery surface, other workspaces untouched", async () => {
    const healthy = makeProject({ name: "healthy" });
    const broken = makeProject({ name: "broken" });
    projectsListMock.mockResolvedValue({ ok: true, data: [healthy, broken] });
    renderCenter();
    await screen.findByRole("heading", { name: "Vex Studio" });

    select(healthy.id);
    const healthyNode = await screen.findByTestId(`workspace-${healthy.id}`);

    controllerCrash.projectIds.add(broken.id);
    select(broken.id);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("TypeError");
    // Contained, not fatal: the healthy workspace is the SAME node it was.
    expect(screen.getByTestId(`workspace-${healthy.id}`)).toBe(healthyNode);
  });

  it("PRESERVES the project's terminals and ptys across fallback and retry", async () => {
    const project = makeProject({ name: "broken" });
    projectsListMock.mockResolvedValue({ ok: true, data: [project] });
    const harness = renderCenter();
    await screen.findByRole("heading", { name: "Vex Studio" });

    // The registry entries a live workspace owns. Killing these is what a
    // careless recovery (unmount, dispose, reload) would cost the user.
    publishProjectTerminals(project.id, ["term-a", "term-b"]);

    controllerCrash.projectIds.add(project.id);
    select(project.id);
    await screen.findByRole("alert");

    // NOTHING was disposed and no pty was killed: the terminal index still
    // names both shells, and the registry's dispose was never called.
    expect(peekProjectTerminals(project.id)).toEqual(["term-a", "term-b"]);
    expect(harness.disposedTerminals).toEqual([]);

    controllerCrash.projectIds.delete(project.id);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await screen.findByTestId(`workspace-${project.id}`);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(peekProjectTerminals(project.id)).toEqual(["term-a", "term-b"]);
    expect(harness.disposedTerminals).toEqual([]);
  });

  it("offers a route back to welcome that keeps the workspace alive", async () => {
    const project = makeProject({ name: "broken" });
    projectsListMock.mockResolvedValue({ ok: true, data: [project] });
    const harness = renderCenter();
    await screen.findByRole("heading", { name: "Vex Studio" });
    publishProjectTerminals(project.id, ["term-a"]);

    controllerCrash.projectIds.add(project.id);
    select(project.id);
    await screen.findByRole("alert");

    fireEvent.click(
      screen.getByRole("button", { name: "Return to Studio welcome" }),
    );

    // The selection moved; the project did NOT leave the kept-alive set, so
    // its shells keep running and reopening it costs nothing.
    await waitFor(() => {
      expect(useUiStore.getState().activeProjectId).toBeNull();
    });
    expect(
      document.querySelector(`[data-vex-studio-workspace="${project.id}"]`),
    ).not.toBeNull();
    expect(peekProjectTerminals(project.id)).toEqual(["term-a"]);
    expect(harness.disposedTerminals).toEqual([]);
  });
});
