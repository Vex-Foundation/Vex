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
  /** Render the 56px icon spine instead of the wide column. */
  readonly collapsed?: boolean;
  readonly onToggleSidebar?: () => void;
}

/** Returns the client so a test can drive a real refetch through it. */
function renderSidebar(options: RenderOptions = {}): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const tree = (
    <QueryClientProvider client={client}>
      <StudioSidebar
        collapsed={options.collapsed ?? false}
        width={options.collapsed === true ? 56 : 300}
        onToggleSidebar={options.onToggleSidebar ?? (() => undefined)}
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

/**
 * THE ONE SEARCH (I2), over two kinds of thing.
 *
 * The old contract was "filter the project rows in place", and its control was
 * named `Search projects`. It searches FILES too now, so the results are their
 * own grouped list and the browsing region is HIDDEN behind it rather than
 * filtered - the same move deepseek's workspace browser makes
 * (`WorkspaceBrowser.tsx`, `SearchResults` replaces the tree body), and for the
 * same reason ours must: unmounting the region would release the explorer
 * session and lose every folder the user expanded.
 *
 * `hidden` is what makes that assertable. It removes the region from the
 * accessibility tree, so a ROLE query cannot see the project rows behind the
 * results while a text query still would - which is why every assertion below
 * about what is and is not offered goes through a role.
 */
describe("search", () => {
  /** Open the search and hand back its field. */
  async function openSearch(): Promise<HTMLElement> {
    fireEvent.click(
      screen.getByRole("button", { name: "Search projects and files" }),
    );
    return screen.getByRole("combobox", { name: "Search projects and files" });
  }

  it("narrows to the matching project and says so when nothing matches", async () => {
    projectsListMock.mockResolvedValue({
      ok: true,
      data: [makeProject({ name: "vex-core" }), makeProject({ name: "trading-agent" })],
    });
    renderSidebar();
    await screen.findByText("vex-core");

    const field = await openSearch();
    fireEvent.change(field, { target: { value: "trad" } });

    // The behaviour the old test protected, at the new contract: one project is
    // offered, the other is not - and neither the offered nor the hidden one is
    // reachable twice (the row behind the results is out of the a11y tree).
    expect(
      screen.getByRole("option", { name: /trading-agent/ }),
    ).not.toBeNull();
    expect(screen.queryByRole("option", { name: /vex-core/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /vex-core/ })).toBeNull();

    fireEvent.change(field, { target: { value: "nothing-matches" } });
    expect(
      screen.getByText("No project or file matches that name."),
    ).not.toBeNull();
    expect(screen.queryByRole("option")).toBeNull();
  });

  it("gives its open, clear and collapse controls three DISTINCT names", async () => {
    // I3: the header toggle and the field's own button both used to be called
    // "Close project search", so a screen reader offered two controls with one
    // name and no way to tell them apart. They do different things.
    renderSidebar();
    await screen.findByText("No projects yet.");

    const field = await openSearch();
    fireEvent.change(field, { target: { value: "x" } });

    const named = screen
      .getAllByRole("button")
      .map((node) => node.getAttribute("aria-label"))
      .filter((label): label is string => label !== null);
    expect(named).toContain("Close search");
    expect(named).toContain("Clear search");
    // Uniqueness by role, the assertion the copy module's own rule asks for.
    for (const label of ["Close search", "Clear search"]) {
      expect(screen.getAllByRole("button", { name: label })).toHaveLength(1);
    }
  });

  it("Escape clears a typed query first, and closes an empty one", async () => {
    renderSidebar();
    await screen.findByText("No projects yet.");
    const field = await openSearch();

    fireEvent.change(field, { target: { value: "vex" } });
    fireEvent.keyDown(field, { key: "Escape" });
    // One key, two jobs in order: the query is gone but the field is not, so a
    // user who mistyped does not lose the search by pressing Escape once.
    expect(
      screen.getByRole("combobox", { name: "Search projects and files" }),
    ).toHaveProperty("value", "");

    fireEvent.keyDown(field, { key: "Escape" });
    expect(
      screen.queryByRole("combobox", { name: "Search projects and files" }),
    ).toBeNull();
  });

  it("is a combobox: arrows move the active option, Enter opens it, focus never leaves the field", async () => {
    // listWidget's model, not a roving tabindex: the input keeps DOM focus and
    // NAMES the active row through aria-activedescendant, so a keystroke that
    // re-derives the whole list cannot drop the user's focus onto <body>.
    const onSelectProject = vi.fn();
    const alpha = makeProject({ name: "alpha-core" });
    const beta = makeProject({ name: "alpha-tools" });
    projectsListMock.mockResolvedValue({ ok: true, data: [alpha, beta] });
    renderSidebar({ onSelectProject });
    await screen.findByText("alpha-core");

    const field = await openSearch();
    fireEvent.change(field, { target: { value: "alpha" } });
    expect(screen.getAllByRole("option")).toHaveLength(2);
    expect(field.getAttribute("aria-expanded")).toBe("true");
    expect(field.getAttribute("aria-activedescendant")).toBeNull();

    fireEvent.keyDown(field, { key: "ArrowDown" });
    const first = screen.getAllByRole("option")[0];
    expect(field.getAttribute("aria-activedescendant")).toBe(first?.id);
    expect(first?.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(field);

    fireEvent.keyDown(field, { key: "ArrowDown" });
    expect(field.getAttribute("aria-activedescendant")).toBe(
      screen.getAllByRole("option")[1]?.id,
    );
    // Wrapping, and Home/End, are the same list model.
    fireEvent.keyDown(field, { key: "ArrowDown" });
    expect(field.getAttribute("aria-activedescendant")).toBe(first?.id);
    fireEvent.keyDown(field, { key: "End" });
    expect(field.getAttribute("aria-activedescendant")).toBe(
      screen.getAllByRole("option")[1]?.id,
    );

    fireEvent.keyDown(field, { key: "Enter" });
    expect(onSelectProject).toHaveBeenCalledWith(beta.id);
    // Opening a hit ends the search: the rail goes back to its rows.
    expect(
      screen.queryByRole("combobox", { name: "Search projects and files" }),
    ).toBeNull();
  });

  it("Enter with nothing highlighted opens the FIRST hit", async () => {
    const onSelectProject = vi.fn();
    const first = makeProject({ name: "alpha-core" });
    projectsListMock.mockResolvedValue({
      ok: true,
      data: [first, makeProject({ name: "alpha-tools" })],
    });
    renderSidebar({ onSelectProject });
    await screen.findByText("alpha-core");

    const field = await openSearch();
    fireEvent.change(field, { target: { value: "alpha" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onSelectProject).toHaveBeenCalledWith(first.id);
  });

  it("groups projects and files, and states the file half's scope", async () => {
    // The two halves are different KINDS of thing, so they are two groups, and
    // the file half's real extent is said on screen rather than left to be
    // inferred from a list that looks complete.
    const project = makeProject({ name: "notes-project" });
    projectsListMock.mockResolvedValue({ ok: true, data: [project] });
    const registry = new ExplorerRegistry();
    renderSidebar({ activeProjectId: project.id, registry });
    await screen.findByTestId("explorer-tree");

    const field = await openSearch();
    fireEvent.change(field, { target: { value: "notes" } });

    expect(
      screen.getByRole("group", { name: "Projects" }),
    ).not.toBeNull();
    expect(
      screen.getByText("Files cover the folders you have opened in this project."),
    ).not.toBeNull();
  });

  it("does not claim a file scope with NO project open", async () => {
    projectsListMock.mockResolvedValue({
      ok: true,
      data: [makeProject({ name: "vex-core" })],
    });
    renderSidebar({ activeProjectId: null });
    await screen.findByText("vex-core");

    const field = await openSearch();
    fireEvent.change(field, { target: { value: "vex" } });
    expect(
      screen.queryByText("Files cover the folders you have opened in this project."),
    ).toBeNull();
  });

  it("keeps the explorer tree MOUNTED behind a live search", async () => {
    // The whole reason the region is hidden and not replaced: unmounting the
    // tree releases its explorer session, drops the watcher, and throws away
    // every folder the user expanded.
    const project = makeProject({ name: "vex-core" });
    projectsListMock.mockResolvedValue({ ok: true, data: [project] });
    const registry = new ExplorerRegistry();
    renderSidebar({ activeProjectId: project.id, registry });
    const tree = await screen.findByTestId("explorer-tree");

    const field = await openSearch();
    fireEvent.change(field, { target: { value: "zzz-no-match" } });
    expect(screen.getByTestId("explorer-tree")).toBe(tree);
    // Hidden, though: it is not offered as a second answer beside the results.
    expect(tree.closest("[hidden]")).not.toBeNull();
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

/**
 * THE COLLAPSED RAIL IS ICONS ONLY (B4).
 *
 * deepseek's `SidebarRoot` states the contract: collapsing the column leaves one
 * icon per control and nothing else, with tooltips and accessible names carrying
 * the words (`SidebarRoot.tsx:130-170`, and `sidebar-root.client.spec.tsx:682`
 * asserts it by querying for the wide chrome and getting null). VS Code's
 * activity bar is the same rule. Ours used to render the PROJECTS disclosure at
 * 56px, which bled its chevron and the first letters of its title ("Pro") into
 * the spine.
 *
 * The assertion is deliberately in two halves, because either alone passes a
 * broken rail: NO WORDS are rendered, and the controls are still NAMED.
 */
describe("the collapsed rail", () => {
  /** Every word the wide rail renders that the spine must not. */
  const WIDE_WORDS = [
    "Projects",
    "Explorer",
    "New project",
    "Agent",
    "Studio",
    "No projects yet.",
    "Welcome",
  ] as const;

  it("renders no text at all, and still names every control", async () => {
    const project = makeProject({ name: "vex-core" });
    projectsListMock.mockResolvedValue({ ok: true, data: [project] });
    renderSidebar({ collapsed: true, activeProjectId: project.id });

    // Wait for the ROW first: the spine with nothing loaded in it is trivially
    // wordless, and that is not the state B4 was about.
    expect(await screen.findByRole("button", { name: /vex-core/ })).not.toBeNull();

    // The one structural assertion that covers the whole spine: a rail whose
    // text is a truncated section title fails here whatever the title is.
    const rail = screen.getByLabelText("Studio projects sidebar");
    expect(rail.textContent?.trim()).toBe("");
    for (const word of WIDE_WORDS) expect(screen.queryByText(word)).toBeNull();

    // ...and every control the user reaches for is still reachable by name.
    expect(screen.getByRole("button", { name: "New project" })).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Search projects and files" }),
    ).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Expand Studio sidebar" }),
    ).not.toBeNull();
  });

  it("renders no disclosure chevron and no explorer pane on the spine", async () => {
    const project = makeProject({ name: "vex-core" });
    projectsListMock.mockResolvedValue({ ok: true, data: [project] });
    renderSidebar({ collapsed: true, activeProjectId: project.id });
    await screen.findByRole("button", { name: /vex-core/ });

    // The disclosure itself, not just its title: the chevron is the other half
    // of what bled into the spine.
    expect(document.querySelector(".vex-disclosure-root")).toBeNull();
    // The tree needs width the spine does not have; the pane is wide-only.
    expect(screen.queryByTestId("explorer-tree")).toBeNull();
    expect(screen.queryByRole("separator")).toBeNull();
  });

  it("states a failed read as a NAMED glyph rather than an unreadable sentence", async () => {
    // Failure is not emptiness, and it is not silence either. At 56px the
    // sentence cannot fit, so the spine carries the warning glyph under the
    // sentence as its accessible name and the words arrive with the expansion.
    projectsListMock.mockResolvedValue({ ok: false, error: makeError("db down") });
    renderSidebar({ collapsed: true });

    const status = await screen.findByRole("status", {
      name: "Vex could not read your projects.",
    });
    expect(status).not.toBeNull();
    expect(status.textContent?.trim()).toBe("");
  });

  it("the magnifier EXPANDS the rail first - a field has no room on the spine", async () => {
    // deepseek's rail search does exactly this (`workspace-browser.client.spec`
    // "rail state renders icon controls that request expansion"): the icon asks
    // the shell to widen, and the field arrives with the width.
    const onToggleSidebar = vi.fn();
    renderSidebar({ collapsed: true, onToggleSidebar });
    fireEvent.click(
      await screen.findByRole("button", { name: "Search projects and files" }),
    );
    expect(onToggleSidebar).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("combobox", { name: "Search projects and files" }),
    ).toBeNull();
  });
});

/**
 * THE EXPLORER IS A PANE, NOT A BOX (I6).
 *
 * VS Code's explorer view hands the whole view height to its tree
 * (`explorerView.ts:293-296`, `layoutBody(height)` then `tree.layout(height)`).
 * Ours was a fixed 256px window inside a scrolling rail: half empty on a small
 * project, a keyhole on a real one. The React equivalent of that height
 * handoff is a flex chain that never stops at a fixed size, with a real
 * separator whose position is the user's own preference.
 */
describe("the explorer pane and its split", () => {
  it("gives the pane the rail's remaining height through an unbroken flex chain", async () => {
    const project = makeProject({ name: "vex-core" });
    projectsListMock.mockResolvedValue({ ok: true, data: [project] });
    renderSidebar({ activeProjectId: project.id });
    const tree = await screen.findByTestId("explorer-tree");

    // Walk from the tree up to the rail: no ancestor may pin a height, and each
    // one must be able to give its height away (`min-h-0`). A single `h-64` on
    // that path is exactly the defect, and it is invisible to jsdom layout - so
    // the class chain IS the contract here, checked on the real rendered tree
    // rather than by reading the source.
    const rail = screen.getByLabelText("Studio projects sidebar");
    let node: HTMLElement | null = tree.parentElement;
    let sawFlexGrow = false;
    while (node !== null && node !== rail) {
      const classes = node.className;
      expect(classes).not.toMatch(/(?:^|\s)h-\d/);
      if (/(?:^|\s)flex-1(?:\s|$)/.test(classes)) {
        sawFlexGrow = true;
        expect(classes).toMatch(/min-h-0/);
      }
      node = node.parentElement;
    }
    expect(node).toBe(rail);
    expect(sawFlexGrow).toBe(true);
  });

  it("puts a real, named separator between the two panes", async () => {
    const project = makeProject({ name: "vex-core" });
    projectsListMock.mockResolvedValue({ ok: true, data: [project] });
    renderSidebar({ activeProjectId: project.id });
    await screen.findByTestId("explorer-tree");

    const separator = screen.getByRole("separator", {
      name: "Resize the projects and explorer panes",
    });
    expect(separator.getAttribute("aria-orientation")).toBe("horizontal");
    expect(separator.tabIndex).toBe(0);
  });

  it("has no separator with no project: there is no second pane to size", async () => {
    projectsListMock.mockResolvedValue({
      ok: true,
      data: [makeProject({ name: "vex-core" })],
    });
    renderSidebar({ activeProjectId: null });
    await screen.findByText("vex-core");
    expect(screen.queryByRole("separator")).toBeNull();
  });

  it("a keyboard resize writes the PREFERENCE, and a remount restores it", async () => {
    const project = makeProject({ name: "vex-core" });
    projectsListMock.mockResolvedValue({ ok: true, data: [project] });
    const { useUiStore } = await import("../../../../../stores/uiStore.js");
    useUiStore.setState({ studioRailExplorerShare: 0.55 });

    renderSidebar({ activeProjectId: project.id });
    await screen.findByTestId("explorer-tree");
    const separator = screen.getByRole("separator", {
      name: "Resize the projects and explorer panes",
    });

    // The seam starts where the preference says: 45% of the pooled share above
    // it, the explorer's 55% below.
    expect(separator.getAttribute("aria-valuenow")).toBe("45");
    // ArrowDown grows the pane ABOVE the seam, so the explorer's share shrinks.
    fireEvent.keyDown(separator, { key: "ArrowDown" });
    const afterDown = useUiStore.getState().studioRailExplorerShare;
    expect(afterDown).toBeLessThan(0.55);

    fireEvent.keyDown(separator, { key: "ArrowUp" });
    expect(useUiStore.getState().studioRailExplorerShare).toBeGreaterThan(afterDown);
  });

  it("clamps the preference so NEITHER pane can be dragged to nothing", async () => {
    const { useUiStore } = await import("../../../../../stores/uiStore.js");
    const set = useUiStore.getState().setStudioRailExplorerShare;

    // A zero-height projects list is a rail with no way to another project; a
    // zero-height explorer is the keyhole the split exists to remove.
    set(5);
    expect(useUiStore.getState().studioRailExplorerShare).toBe(0.8);
    set(-2);
    expect(useUiStore.getState().studioRailExplorerShare).toBe(0.2);

    // A SHARE, not a pixel count: an in-range fraction survives unchanged. It
    // went through the whole-PIXEL clamp once, which rounded every drag to 0 or
    // 1 and then re-clamped that to an end of the range, so the seam could only
    // ever sit all the way up or all the way down.
    for (const share of [0.31, 0.5, 0.649]) {
      set(share);
      expect(useUiStore.getState().studioRailExplorerShare).toBe(share);
    }
  });
});
