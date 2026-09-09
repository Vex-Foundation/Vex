import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RailRow } from "../rail-list.js";

afterEach(cleanup);

describe("rail metadata and actions", () => {
  it("retains the quiet metadata replacement for ordinary rows", () => {
    render(<RailRow selected={false} title="Session" trailing="2m" actions={<button type="button">Actions</button>} actionsPinned onSelect={() => {}} />);
    expect(screen.getByText("2m").className).toContain("opacity-0");
    expect(screen.getByText("Actions").closest("[data-rail-actions]")?.className).toContain("absolute");
  });

  it("reserves separate action width for persistent state without nesting controls", () => {
    render(<RailRow selected={false} title="Project" persistentTrailing="State" actions={<button type="button">Actions</button>} actionsPinned onSelect={() => {}} />);
    expect(screen.getByText("State").className).not.toContain("opacity");
    expect(screen.getByText("Actions").closest("[data-rail-actions]")?.className).toContain("shrink-0");
    expect(screen.getByText("Actions").closest("[data-rail-actions]")?.className).not.toContain("absolute");
    expect(screen.getByText("Project").closest("button")?.querySelector("button")).toBeNull();
  });
});
