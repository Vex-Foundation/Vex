/**
 * PROJECT card - the Studio rail's counterpart of the SESSION card.
 *
 * Pins:
 *  - the four rows, in the session card's vocabulary: Mode is "Studio", Access
 *    is the SAME word the session card prints for the same `permission`
 *    value, Started is the same date format, Path is the project's
 *    `displayPath` whole (the title carries it for the truncated case),
 *  - it reads the project by id through the detail query, never a session,
 *  - a read still in flight says Loading, and an absent project says
 *    Unavailable - the same states the session card has.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { makeProject } from "../../studio/__tests__/studio-fixtures.js";
import { formatSessionTime } from "../../sessionListModel.js";

const mockUseProject = vi.hoisted(() => vi.fn());
vi.mock("../../../../lib/api/projects.js", () => ({
  useProject: mockUseProject,
}));

const { ProjectBlock } = await import("../ProjectBlock.js");

const PROJECT = "9c1b0e8e-0000-4000-8000-0000000000ab";

beforeEach(() => {
  vi.clearAllMocks();
});

function rowValue(label: string): string {
  const labelNode = screen.getByText(label, { exact: true });
  const value = labelNode.nextElementSibling;
  if (value === null) throw new Error(`row ${label} has no value`);
  return value.textContent ?? "";
}

describe("ProjectBlock", () => {
  it("renders Mode, Access, Started and Path from the project, in the session card's words", () => {
    const project = makeProject({
      id: PROJECT,
      name: "vex-core",
      permission: "full",
      createdAt: "2026-08-26T09:30:00.000Z",
    });
    mockUseProject.mockReturnValue({
      isLoading: false,
      data: { ok: true, data: project },
    });
    render(<ProjectBlock projectId={PROJECT} />);

    expect(mockUseProject).toHaveBeenCalledWith(PROJECT);
    expect(screen.getByRole("region", { name: "Project" })).toBeTruthy();
    expect(rowValue("Mode")).toBe("Studio");
    expect(rowValue("Access")).toBe("Full");
    expect(rowValue("Started")).toBe(formatSessionTime("2026-08-26T09:30:00.000Z"));
    expect(rowValue("Path")).toBe("~/Vex/projects/vex-core");
    expect(screen.getByTitle("~/Vex/projects/vex-core")).toBeTruthy();
  });

  it("prints Restricted for a restricted project - the session card's word", () => {
    mockUseProject.mockReturnValue({
      isLoading: false,
      data: { ok: true, data: makeProject({ id: PROJECT, permission: "restricted" }) },
    });
    render(<ProjectBlock projectId={PROJECT} />);
    expect(rowValue("Access")).toBe("Restricted");
  });

  it("says Loading while the read is in flight", () => {
    mockUseProject.mockReturnValue({ isLoading: true, data: undefined });
    render(<ProjectBlock projectId={PROJECT} />);
    expect(screen.getByText(/Loading/)).toBeTruthy();
  });

  it("says Unavailable for a project main no longer knows", () => {
    mockUseProject.mockReturnValue({
      isLoading: false,
      data: { ok: true, data: null },
    });
    render(<ProjectBlock projectId={PROJECT} />);
    expect(screen.getByText("Unavailable.")).toBeTruthy();
    expect(screen.queryByText("Studio")).toBeNull();
  });
});
