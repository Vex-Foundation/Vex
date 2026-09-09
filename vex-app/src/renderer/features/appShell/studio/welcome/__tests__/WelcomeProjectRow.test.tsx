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
    const row = screen.getByRole("button");
    const label = screen.getByText("FULL ACCESS");
    expect(label.className).toContain("vex-micro-label");
    expect(label.className).toContain("text-warning-label");
    expect(screen.getByText(project.name).className).toContain("truncate");
    expect(label.closest("[data-vex-project-permission]")?.className).toContain("shrink-0");
    expect(row.getAttribute("aria-description")).toBe(projectPermissionDescription("full"));
    act(() => row.focus());
    expect(document.activeElement).toBe(row);
    expect(screen.getByRole("tooltip").textContent).toBe(projectPermissionDescription("full"));
    fireEvent.mouseLeave(row);
    expect(screen.getByRole("tooltip").textContent).toBe(projectPermissionDescription("full"));
    expect(row.querySelector("button")).toBeNull();
    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it("keeps restricted accessible without presenting a baseline badge", () => {
    render(<WelcomeProjectRow project={makeProject()} onSelect={() => {}} />);
    expect(screen.getByRole("button").getAttribute("aria-description")).toBe("Restricted");
    expect(document.querySelector("[data-vex-project-permission]")).toBeNull();
    expect(screen.queryByText("Restricted")).toBeNull();
  });
});
