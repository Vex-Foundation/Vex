import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeProject } from "../../__tests__/studio-fixtures.js";
import { projectPermissionDescription } from "../../studio-copy.js";
import { WelcomeProjectRow } from "../WelcomeProjectRow.js";

afterEach(cleanup);

describe("welcome project permission", () => {
  it.each(["dark", "light"])("exposes the full-access explanation on the existing control in %s", (theme) => {
    const project = makeProject({ name: "A long project name retains its full accessible reading", permission: "full" });
    const onSelect = vi.fn();
    render(<div data-theme={theme}><WelcomeProjectRow project={project} onSelect={onSelect} /></div>);
    const row = screen.getByText(project.name).closest("button");
    if (row === null) throw new Error("Project open control is missing");
    // The outlined caps tag (docs/design/R3-MINIMAL.md section 1.3).
    const label = screen.getByText("Full access");
    expect(label.className).toContain("vex-tag");
    expect(screen.getByText(project.name).className).toContain("truncate");
    // The tag never shrinks (`.vex-st-tag` is `flex: none` in left-sidebar.css).
    expect(label.closest("[data-vex-project-permission]")?.className).toContain("vex-st-tag");
    expect(row.getAttribute("aria-description")).toBe(projectPermissionDescription("full"));
    act(() => row.focus());
    expect(document.activeElement).toBe(row);
    expect(screen.getByRole("tooltip").textContent).toBe(projectPermissionDescription("full"));
    fireEvent.mouseLeave(row);
    expect(screen.getByRole("tooltip").textContent).toBe(projectPermissionDescription("full"));
    expect(row.querySelector("button")).toBeNull();
    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledOnce();
    // The row menu sits beside the open control, never inside it.
    const menu = screen.getByRole("button", { name: `Actions for ${project.name}` });
    expect(row.contains(menu)).toBe(false);
  });

  it("keeps restricted accessible without presenting a baseline badge", () => {
    const project = makeProject();
    render(<WelcomeProjectRow project={project} onSelect={() => {}} />);
    expect(
      screen.getByText(project.name).closest("button")?.getAttribute("aria-description"),
    ).toBe("Restricted");
    expect(document.querySelector("[data-vex-project-permission]")).toBeNull();
    expect(screen.queryByText("Restricted")).toBeNull();
  });
});
