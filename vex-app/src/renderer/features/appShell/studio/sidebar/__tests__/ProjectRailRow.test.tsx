import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ProjectRailRow } from "../ProjectRailRow.js";
import { projectDriftLabel, projectPermissionDescription, STUDIO_DRIFT_SENTENCES } from "../../studio-copy.js";
import { makeArtifact, makeProject } from "../../__tests__/studio-fixtures.js";
import { clearAllProjectLive, clearProjectLive, publishProjectLive } from "../../workspace/project-live.js";

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
  it("says full access in the row's description and tooltip, with no tag on the row (the H3 plate)", () => {
    const project = makeProject({ name: "An exceptionally long project name that must truncate", permission: "full" });
    render(
      <ProjectRailRow project={project} selected onSelect={() => {}} actions={<button type="button">Actions</button>} />,
    );
    const row = screen.getByText(project.name).closest("button");
    if (row === null) throw new Error("Project selection control is missing");
    // Our approved Studio plate draws no access tag on a row: the open
    // project's access is the header's line and the console's This project.
    // The standing authority stays where it is asked for, on every row.
    expect(screen.queryByText("Full access")).toBeNull();
    expect(row.querySelector("[data-vex-project-permission]")).toBeNull();
    expect(screen.getByText(project.name).className).toContain("truncate");
    expect(row.getAttribute("aria-description")).toBe(projectPermissionDescription("full"));
    act(() => row.focus());
    expect(screen.getByRole("tooltip").textContent).toBe(projectPermissionDescription("full"));
    // The actions stay beside the select control, never over it.
    const actions = screen.getByText("Actions").closest("[data-rail-actions]");
    expect(actions?.className).toContain("shrink-0");
    expect(actions?.className).not.toContain("absolute");
  });

  it("omits a visual restricted badge and preserves its accessible description", () => {
    renderRow([]);
    expect(screen.queryByText("Restricted")).toBeNull();
    expect(document.querySelector("[data-vex-project-permission]")).toBeNull();
    expect(screen.getByRole("button", { name: "atlas" }).getAttribute("aria-description")).toBe("Restricted");
  });
});

describe("the RUNNING tag", () => {
  afterEach(() => {
    clearAllProjectLive();
  });

  it("stands while the project's mounted workspace has a live shell, and goes with it", () => {
    const project = makeProject({ name: "vex-core" });
    render(<ProjectRailRow project={project} selected={false} onSelect={() => {}} />);
    // No workspace mounted: the renderer does not know, so the row claims nothing.
    expect(screen.queryByText("Running")).toBeNull();

    act(() => publishProjectLive(project.id, true));
    const word = screen.getByText("Running");
    const tag = word.closest("[data-vex-project-running]");
    expect(tag?.className).toContain("vex-st-proj__run");
    // The square is the running grey, beside an ink word (section 2.2).
    expect(tag?.querySelector(".vex-swatch")?.className).toContain("text-running-mark");
    // The word is part of the row's name, after the project's.
    expect(screen.getByRole("button", { name: "vex-core Running" })).not.toBeNull();

    act(() => publishProjectLive(project.id, false));
    expect(screen.queryByText("Running")).toBeNull();
    act(() => publishProjectLive(project.id, true));
    act(() => clearProjectLive(project.id));
    expect(screen.queryByText("Running")).toBeNull();
  });
});
