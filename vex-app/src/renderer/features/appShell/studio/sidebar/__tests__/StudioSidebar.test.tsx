/**
 * The Studio rail: rows, their metadata, the action menu, the two other
 * sections, the search, and every state the project list can be in.
 *
 * The explorer registry is INJECTED here (a fresh `ExplorerRegistry` per test)
 * rather than shared, so one suite's sessions cannot leak into another's - the
 * class is exported for exactly this, and it is also how the StrictMode
 * double-mount assertion below can count acquires at all.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Result } from "@shared/ipc/result.js";
import type { ProjectList } from "@shared/schemas/projects.js";
import { ExplorerRegistry } from "../../explorer/index.js";
import {
  installStudioDomStubs,
  makeArtifact,
  makeError,
  makeProject,
} from "../../__tests__/studio-fixtures.js";

const projectsListMock = vi.fn<() => Promise<Result<ProjectList>>>();

// The tree has its own suite (and its own virtualizer seam); this file asserts
// the SECTION around it, so the tree itself is a marker.
vi.mock("../../explorer/ExplorerTree.js", () => ({
  ExplorerTree: ({ projectId }: { projectId: string }) => (
    <div data-testid="explorer-tree" data-project={projectId} />
  ),
}));
vi.mock("../../../market/VexTokenCardCompact.js", () => ({
  VexTokenCardCompact: () => null,
}));
vi.mock("../../../SidebarProfile.js", () => ({
  SidebarProfile: () => <div data-testid="sidebar-profile" />,
}));

const { StudioSidebar } = await import("../StudioSidebar.js");

interface RenderOptions {
  readonly activeProjectId?: string | null;
  readonly onSelectProject?: (id: string) => void;
  readonly onSelectWelcome?: () => void;
  readonly onCreateProject?: () => void;
  readonly registry?: ExplorerRegistry;
  readonly strict?: boolean;
}

/** Returns the client so a test can drive a real refetch through it. */
function renderSidebar(options: RenderOptions = {}): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const tree = (
    <QueryClientProvider client={client}>
      <StudioSidebar
        collapsed={false}
        width={300}
        onToggleSidebar={() => undefined}
        activeProjectId={options.activeProjectId ?? null}
        onSelectProject={options.onSelectProject ?? (() => undefined)}
        onSelectWelcome={options.onSelectWelcome ?? (() => undefined)}
        onCreateProject={options.onCreateProject}
        explorerRegistry={options.registry ?? new ExplorerRegistry()}
      />
    </QueryClientProvider>
  );
  render(options.strict === true ? <StrictMode>{tree}</StrictMode> : tree);
  return client;
}

beforeAll(() => {
  installStudioDomStubs();
});

beforeEach(() => {
  projectsListMock.mockReset();
  projectsListMock.mockResolvedValue({ ok: true, data: [] });
  Object.defineProperty(window, "vex", {
    configurable: true,
    value: {
      projects: { list: projectsListMock },
      files: {
        list: () => Promise.resolve({ ok: true, data: null }),
        watch: () => Promise.resolve({ ok: true, data: null }),
      },
    },
  });
});

describe("the project rows", () => {
  it("renders one row per project, in list order", async () => {
    projectsListMock.mockResolvedValue({
      ok: true,
      data: [makeProject({ name: "vex-core" }), makeProject({ name: "trading-agent" })],
    });
    renderSidebar();
    await screen.findByText("vex-core");
    expect(screen.getByText("trading-agent")).not.toBeNull();
  });

  it("shows the active dot on the ACTIVE row only", async () => {
    const active = makeProject({ name: "vex-core" });
    projectsListMock.mockResolvedValue({
      ok: true,
      data: [active, makeProject({ name: "trading-agent" })],
    });
    renderSidebar({ activeProjectId: active.id });
    // `findAllByText`: with a project active the EXPLORER pane header also
    // carries the project's name, which is the point of that header.
    await screen.findAllByText("vex-core");

    const activeRow = screen.getByRole("button", { current: true });
    expect(activeRow.textContent).toContain("vex-core");
    expect(activeRow.querySelector(".vex-state-dot")).not.toBeNull();

    const otherRow = screen
      .getAllByRole("button")
      .find(
        (el) =>
          el.textContent?.includes("trading-agent") === true &&
          el.getAttribute("aria-current") === null,
      );
    expect(otherRow).toBeDefined();
    expect(otherRow?.querySelector(".vex-state-dot")).toBeNull();
  });

  it("shows the permission tag on EVERY row, always", async () => {
    projectsListMock.mockResolvedValue({
      ok: true,
      data: [
        makeProject({ name: "restricted-one", permission: "restricted" }),
        makeProject({ name: "full-one", permission: "full" }),
      ],
    });
    renderSidebar();
    await screen.findByText("restricted-one");
    expect(screen.getByText("restricted")).not.toBeNull();
    expect(screen.getByText("full")).not.toBeNull();
  });

  it.each([
    ["drifted", "Edited since Vex wrote it"],
    ["missing", "Missing from the project folder"],
    ["stale", "Older than the current project scope"],
    ["unreadable", "Could not be read from disk"],
  ] as const)("badges %s drift and names it", async (state, sentence) => {
    projectsListMock.mockResolvedValue({
      ok: true,
      data: [
        makeProject({
          name: "vex-core",
          files: {
            lastRenderedScopeVersion: 1,
            generatorFingerprint: "test",
            artifacts: [makeArtifact(state)],
          },
        }),
      ],
    });
    renderSidebar();
    await screen.findByText("vex-core");
    expect(screen.getByLabelText(`vex-core: ${sentence}`)).not.toBeNull();
  });

  it("shows ONE badge and the WORST state wins", async () => {
    projectsListMock.mockResolvedValue({
      ok: true,
      data: [
        makeProject({
          name: "vex-core",
          files: {
            lastRenderedScopeVersion: 1,
            generatorFingerprint: "test",
            artifacts: [
              makeArtifact("stale"),
              makeArtifact("drifted"),
              makeArtifact("missing"),
            ],
          },
        }),
      ],
    });
    renderSidebar();
    await screen.findByText("vex-core");
    expect(
      screen.getByLabelText("vex-core: Edited since Vex wrote it"),
    ).not.toBeNull();
    expect(screen.getAllByRole("img")).toHaveLength(1);
  });

  it("does NOT badge a clean project, nor an `unsupported` artifact", async () => {
    projectsListMock.mockResolvedValue({
      ok: true,
      data: [
        makeProject({
          name: "vex-core",
          files: {
            lastRenderedScopeVersion: 1,
            generatorFingerprint: "test",
            artifacts: [makeArtifact("current"), makeArtifact("unsupported")],
          },
        }),
      ],
    });
    renderSidebar();
    await screen.findByText("vex-core");
    expect(screen.queryAllByRole("img")).toHaveLength(0);
  });

  it("selects the project when the row is clicked", async () => {
    const project = makeProject({ name: "vex-core" });
    projectsListMock.mockResolvedValue({ ok: true, data: [project] });
    const onSelectProject = vi.fn();
    renderSidebar({ onSelectProject });
    fireEvent.click(await screen.findByText("vex-core"));
    expect(onSelectProject).toHaveBeenCalledWith(project.id);
  });
});

describe("the row action menu", () => {
  it("opens from the KEYBOARD and lists the three live items", async () => {
    projectsListMock.mockResolvedValue({
      ok: true,
      data: [makeProject({ name: "vex-core" })],
    });
    renderSidebar();
    await screen.findByText("vex-core");

    const trigger = screen.getByRole("button", { name: "Actions for vex-core" });
    // Reachable by Tab (the actions cluster reveals on group-focus-within), and
    // activated by the keyboard rather than a pointer.
    trigger.focus();
    expect(document.activeElement).toBe(trigger);
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.click(trigger);

    const items = await screen.findAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "Settings",
      "Repair",
      "Delete",
    ]);
    // STATED CONTRACT CHANGE (B4b). B4a asserted all three were `disabled`,
    // because their handlers did not exist and a live-looking control wired to
    // nothing would have been a lie. B4b built the dialogs, so the three items
    // are now ENABLED and each publishes a project-dialog intent. What they
    // publish is asserted by
    // `projects/__tests__/project-dialog-wiring.test.tsx`, which owns that
    // contract; this file owns the KEYBOARD path to them.
    for (const item of items) {
      expect(item).toHaveProperty("disabled", false);
      expect(item.getAttribute("aria-disabled")).not.toBe("true");
    }
    // No roadmap copy anywhere on the menu.
    expect(screen.queryByText(/coming soon/i)).toBeNull();
  });
});

describe("the other sections", () => {
  it("the WELCOME row selects null and is current when nothing is active", async () => {
    const onSelectWelcome = vi.fn();
    renderSidebar({ activeProjectId: null, onSelectWelcome });
    const welcome = await screen.findByRole("button", { name: /Welcome/ });
    expect(welcome.getAttribute("aria-current")).toBe("true");
    fireEvent.click(welcome);
    expect(onSelectWelcome).toHaveBeenCalledTimes(1);
  });

  it("the EXPLORER section names the active project and mounts its tree", async () => {
    const project = makeProject({ name: "vex-core" });
    projectsListMock.mockResolvedValue({ ok: true, data: [project] });
    renderSidebar({ activeProjectId: project.id });

    await screen.findByTestId("explorer-tree");
    expect(screen.getByTestId("explorer-tree").getAttribute("data-project")).toBe(
      project.id,
    );
    // The section says "Explorer"; the PANE inside it says which folder, which
    // is VS Code's own explorer view-pane title (`explorerView.ts:250`).
    const section = screen
      .getByTestId("explorer-tree")
      .closest(".vex-disclosure-root");
    expect(section).not.toBeNull();
    expect(section?.querySelector(".vex-disclosure-title")?.textContent).toBe(
      "Explorer",
    );
    expect(section?.textContent).toContain("vex-core");
  });

  it("has NO explorer section without an active project", async () => {
    projectsListMock.mockResolvedValue({
      ok: true,
      data: [makeProject({ name: "vex-core" })],
    });
    renderSidebar({ activeProjectId: null });
    await screen.findByText("vex-core");
    expect(screen.queryByText("Explorer")).toBeNull();
    expect(screen.queryByTestId("explorer-tree")).toBeNull();
    expect(screen.queryByLabelText("Refresh")).toBeNull();
  });

  it("mounts the $VEX widget slot and the profile footer, like the sessions rail", async () => {
    renderSidebar();
    await screen.findByTestId("sidebar-profile");
  });
});

describe("search", () => {
  it("filters the project rows by name and says so when nothing matches", async () => {
    projectsListMock.mockResolvedValue({
      ok: true,
      data: [makeProject({ name: "vex-core" }), makeProject({ name: "trading-agent" })],
    });
    renderSidebar();
    await screen.findByText("vex-core");

    fireEvent.click(screen.getByRole("button", { name: "Search projects" }));
    const field = screen.getByRole("searchbox", { name: "Search projects" });

    fireEvent.change(field, { target: { value: "trad" } });
    expect(screen.queryByText("vex-core")).toBeNull();
    expect(screen.getByText("trading-agent")).not.toBeNull();

    fireEvent.change(field, { target: { value: "nothing-matches" } });
    expect(screen.getByText("No project matches that name.")).not.toBeNull();
  });
});

describe("list states", () => {
  it("shows a loading strip before the read settles", () => {
    projectsListMock.mockReturnValue(new Promise(() => undefined));
    renderSidebar();
    expect(screen.getByText("Loading projects")).not.toBeNull();
  });

  it("shows the empty line when the list is empty", async () => {
    renderSidebar();
    expect(await screen.findByText("No projects yet.")).not.toBeNull();
  });

  it("shows a status line with Retry on a failed read, never a blank rail", async () => {
    projectsListMock.mockResolvedValue({
      ok: false,
      error: makeError("db down"),
    });
    renderSidebar();
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("Vex could not read your projects.");

    const retry = screen.getByRole("button", { name: "Retry" });
    projectsListMock.mockResolvedValue({
      ok: true,
      data: [makeProject({ name: "vex-core" })],
    });
    fireEvent.click(retry);
    await screen.findByText("vex-core");
  });

  it("a REJECTED read is a failure, not an empty list", async () => {
    // The other failure shape: the call rejects rather than settling to an
    // `ok: false` Result, which is what a preload bridge throwing or a window
    // tearing down mid-call looks like. There is no Result to inspect, so the
    // rows fall back to [] - and "you have no projects" is a different fact
    // from "Vex could not look".
    projectsListMock.mockRejectedValue(new Error("bridge gone"));
    renderSidebar();
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("Vex could not read your projects.");
    expect(screen.queryByText("No projects yet.")).toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).not.toBeNull();
  });

  it("keeps the rows on screen when a REFETCH fails over a good list", async () => {
    // The other direction of the same rule: a failed refetch that still has a
    // real earlier list must not replace those rows with the failure line.
    // Those projects exist; the read that failed was the newer one.
    projectsListMock.mockResolvedValue({
      ok: true,
      data: [makeProject({ name: "vex-core" })],
    });
    const client = renderSidebar();
    await screen.findByText("vex-core");

    projectsListMock.mockRejectedValue(new Error("bridge gone"));
    await client.refetchQueries({ queryKey: ["projects", "list"] });
    await waitFor(() => {
      expect(projectsListMock).toHaveBeenCalledTimes(2);
    });
    expect(screen.getByText("vex-core")).not.toBeNull();
    expect(screen.queryByText("Vex could not read your projects.")).toBeNull();
  });
});

describe("the explorer session under StrictMode", () => {
  it("acquires it ONCE across the double mount", async () => {
    const project = makeProject({ name: "vex-core" });
    projectsListMock.mockResolvedValue({ ok: true, data: [project] });
    const registry = new ExplorerRegistry();

    // The real tree is mocked above, so the sidebar's own explorer usage is
    // what is measured: it must never create a session it does not need.
    renderSidebar({ activeProjectId: project.id, registry, strict: true });
    await screen.findByTestId("explorer-tree");
    await waitFor(() => {
      expect(registry.sessionCount()).toBeLessThanOrEqual(1);
    });
    expect(registry.consumerCount(project.id)).toBeLessThanOrEqual(1);
  });
});
