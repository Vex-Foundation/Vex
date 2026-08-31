/**
 * The Studio welcome screen: what it says, what it lists, and the ONE thing it
 * deliberately does not render without a real handler.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Result } from "@shared/ipc/result.js";
import type { ProjectList } from "@shared/schemas/projects.js";
import { makeError, makeProject } from "../../__tests__/studio-fixtures.js";

const projectsListMock = vi.fn<() => Promise<Result<ProjectList>>>();

const { StudioWelcome } = await import("../StudioWelcome.js");

function renderWelcome(props: {
  readonly onCreateProject?: () => void;
  readonly onSelectProject?: (id: string) => void;
}): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <StudioWelcome
          onCreateProject={props.onCreateProject}
          onSelectProject={props.onSelectProject ?? (() => undefined)}
        />
      </QueryClientProvider>
    </StrictMode>,
  );
}

beforeEach(() => {
  projectsListMock.mockReset();
  projectsListMock.mockResolvedValue({ ok: true, data: [] });
  Object.defineProperty(window, "vex", {
    configurable: true,
    value: { projects: { list: projectsListMock } },
  });
});

describe("what Studio is", () => {
  it("states it in two sentences, with no roadmap copy", () => {
    renderWelcome({});
    expect(screen.getByRole("heading", { name: "Vex Studio" })).not.toBeNull();
    expect(
      screen.getByText(/A Studio project is a folder on your disk/),
    ).not.toBeNull();
    expect(screen.getByText(/nothing runs until you start it/)).not.toBeNull();
    expect(screen.queryByText(/coming soon/i)).toBeNull();
  });
});

describe("the first-project CTA", () => {
  it("is ABSENT when no handler is supplied", () => {
    renderWelcome({});
    expect(screen.queryByRole("button", { name: "New project" })).toBeNull();
  });

  it("is present and calls the handler when one is supplied", () => {
    const onCreateProject = vi.fn();
    renderWelcome({ onCreateProject });
    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    expect(onCreateProject).toHaveBeenCalledTimes(1);
  });
});

describe("the project list", () => {
  it("renders the rows in the order the list returned them", async () => {
    projectsListMock.mockResolvedValue({
      ok: true,
      data: [
        makeProject({ name: "vex-core" }),
        makeProject({ name: "trading-agent" }),
        makeProject({ name: "wallet-tools" }),
      ],
    });
    renderWelcome({});
    await screen.findByText("vex-core");

    const titles = screen
      .getAllByRole("button")
      .map((el) => el.textContent ?? "")
      .filter((text) => text.includes("vex-core") || text.includes("trading-agent") || text.includes("wallet-tools"));
    expect(titles[0]).toContain("vex-core");
    expect(titles[1]).toContain("trading-agent");
    expect(titles[2]).toContain("wallet-tools");
  });

  it("selects a project when its row is clicked", async () => {
    const project = makeProject({ name: "vex-core" });
    projectsListMock.mockResolvedValue({ ok: true, data: [project] });
    const onSelectProject = vi.fn();
    renderWelcome({ onSelectProject });

    fireEvent.click(await screen.findByText("vex-core"));
    expect(onSelectProject).toHaveBeenCalledWith(project.id);
  });

  it("says so when there are no projects", async () => {
    renderWelcome({});
    expect(await screen.findByText("No projects yet.")).not.toBeNull();
  });

  it("reports a failed read instead of showing an empty list", async () => {
    projectsListMock.mockResolvedValue({
      ok: false,
      error: makeError("db down"),
    });
    renderWelcome({});
    const line = await screen.findByRole("status");
    expect(line.textContent).toBe("Vex could not read your projects.");
    // NOT the empty state: "you have none" and "we could not look" are
    // different facts and must not collapse into one.
    expect(screen.queryByText("No projects yet.")).toBeNull();
  });
});
