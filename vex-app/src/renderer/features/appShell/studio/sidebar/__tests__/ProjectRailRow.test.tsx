import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ProjectRailRow } from "../ProjectRailRow.js";
import { projectDriftLabel, projectPermissionDescription, STUDIO_DRIFT_SENTENCES } from "../../studio-copy.js";
import { makeArtifact, makeProject } from "../../__tests__/studio-fixtures.js";

afterEach(cleanup);

function renderRow(artifacts: readonly ReturnType<typeof makeArtifact>[]) {
  const project = makeProject({
    name: "atlas",
    files: {
      lastRenderedScopeVersion: 1,
      generatorFingerprint: "test",
      artifacts: [...artifacts],
    },
  });
  render(
    <ProjectRailRow project={project} selected={false} onSelect={() => {}} />,
  );
  return project;
}

describe("the drift badge", () => {
  it("is absent when nothing has drifted, so the badge that matters stays meaningful", () => {
    renderRow([]);
    expect(document.querySelector("[data-vex-project-drift]")).toBeNull();
  });

  it("says the same sentence to a pointer as it does to a screen reader", () => {
    renderRow([makeArtifact("drifted")]);
    const expected = projectDriftLabel("atlas", STUDIO_DRIFT_SENTENCES.drifted ?? "");
    const badge = screen.getByRole("img", { name: expected });

    // The pointer half: hovering the glyph reveals the identical sentence.
    fireEvent.mouseEnter(badge);
    expect(screen.getByRole("tooltip").textContent).toContain(expected);

    // And it goes away again rather than pinning itself over the rail.
    fireEvent.mouseLeave(badge);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("exposes drift through the existing keyboard control, including after pointer leave", () => {
    renderRow([makeArtifact("drifted")]);
    const row = screen.getByText("atlas").closest("button");
    expect(row).not.toBeNull();
    if (row === null) throw new Error("Project selection control is missing");
    act(() => row?.focus());
    const expected = projectDriftLabel("atlas", STUDIO_DRIFT_SENTENCES.drifted ?? "");
    expect(document.activeElement).toBe(row);
    expect(row?.getAttribute("aria-description")).toContain(expected);
    expect(screen.getByRole("tooltip").textContent).toContain(expected);
    fireEvent.mouseLeave(row);
    expect(screen.getByRole("tooltip").textContent).toContain(expected);
    act(() => row?.blur());
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(row?.querySelector("button")).toBeNull();
  });

  it("names the WORST drift, so one row makes one claim", () => {
    // `drifted` outranks `stale` because a repair there overwrites the user's
    // own edit - the only outcome in this set that can lose work.
    renderRow([makeArtifact("stale"), makeArtifact("drifted")]);
    const badge = screen.getByRole("img", { name: /atlas:/ });
    expect(badge.getAttribute("data-vex-project-drift")).toBe("drifted");
    expect(badge.getAttribute("aria-label")).toBe(
      projectDriftLabel("atlas", STUDIO_DRIFT_SENTENCES.drifted ?? ""),
    );
  });
});

describe("standing project permission", () => {
  it.each(["chronos", "celeris"])("keeps the full-access state outside action replacement in %s", (theme) => {
    const project = makeProject({ name: "An exceptionally long project name that must truncate before permission", permission: "full" });
    const view = render(
      <div data-vex-theme={theme}>
        <ProjectRailRow project={project} selected onSelect={() => {}} actions={<button type="button">Actions</button>} />
      </div>,
    );
    const row = screen.getByText(project.name).closest("button");
    if (row === null) throw new Error("Project selection control is missing");
    const permission = screen.getByText("FULL ACCESS");
    expect(permission.className).toContain("vex-micro-label");
    expect(permission.className).toContain("text-warning-label");
    expect(screen.getByText(project.name).className).toContain("truncate");
    expect(row.getAttribute("aria-description")).toBe(projectPermissionDescription("full"));
    // JSDOM does not paint Tailwind: pin the layout seam here, then measure
    // computed opacity and nonoverlapping boxes in the Electron capture.
    const assertPersistentLayout = () => {
      const badge = screen.getByText("FULL ACCESS");
      const state = badge.closest("[data-rail-persistent-state]");
      expect(state).not.toBeNull();
      for (let node: Element | null = badge; node !== null; node = node.parentElement) {
        expect(node.className).not.toMatch(/opacity-0|\bhidden\b/);
      }
      const actions = screen.getByText("Actions").closest("[data-rail-actions]");
      expect(actions?.className).toContain("shrink-0");
      expect(actions?.className).not.toContain("absolute");
    };
    assertPersistentLayout();
    fireEvent.mouseEnter(row);
    assertPersistentLayout();
    act(() => row.focus());
    assertPersistentLayout();
    expect(screen.getByRole("tooltip").textContent).toBe(projectPermissionDescription("full"));
    view.rerender(
      <div data-theme={theme}>
        <ProjectRailRow project={project} selected onSelect={() => {}} actions={<button type="button">Actions</button>} actionsPinned />
      </div>,
    );
    assertPersistentLayout();
  });

  it("retains a compact warning and the complete accessible permission and drift description", () => {
    const project = makeProject({ permission: "full", files: { lastRenderedScopeVersion: 1, generatorFingerprint: "test", artifacts: [makeArtifact("drifted")] } });
    render(<ProjectRailRow project={project} selected={false} collapsed onSelect={() => {}} />);
    const row = screen.getByRole("button", { name: project.name });
    expect(screen.queryByText("FULL ACCESS")).toBeNull();
    const warning = row.querySelector('[data-vex-project-permission="full"] svg');
    expect(warning?.getAttribute("width")).toBe("13");
    expect(row.querySelector("[data-vex-project-drift]")).not.toBeNull();
    expect(row.getAttribute("aria-description")).toBe(`${projectPermissionDescription("full")} ${projectDriftLabel(project.name, STUDIO_DRIFT_SENTENCES.drifted ?? "")}`);
    act(() => row.focus());
    expect(screen.getByRole("tooltip").textContent).toBe(row.getAttribute("aria-description"));
  });

  it("omits a visual restricted badge and preserves its accessible description", () => {
    renderRow([]);
    expect(screen.queryByText("Restricted")).toBeNull();
    expect(document.querySelector("[data-vex-project-permission]")).toBeNull();
    expect(screen.getByRole("button", { name: "atlas" }).getAttribute("aria-description")).toBe("Restricted");
  });
});
