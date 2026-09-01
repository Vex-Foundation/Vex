/**
 * The Studio welcome screen: what it says, what it lists, and the ONE thing it
 * deliberately does not render without a real handler.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Result } from "@shared/ipc/result.js";
import type { ProjectList } from "@shared/schemas/projects.js";
import type { StudioBridgeReadiness } from "@shared/schemas/studio-bridge-readiness.js";
import { makeError, makeProject } from "../../__tests__/studio-fixtures.js";

const projectsListMock = vi.fn<() => Promise<Result<ProjectList>>>();
const bridgeReadinessMock =
  vi.fn<() => Promise<Result<StudioBridgeReadiness>>>();

const { StudioWelcome } = await import("../StudioWelcome.js");
const { useUiStore } = await import("../../../../../stores/uiStore.js");

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
  useUiStore.setState({ runtimeMode: "studio" });
  projectsListMock.mockReset();
  projectsListMock.mockResolvedValue({ ok: true, data: [] });
  // The healthy default, so every existing case describes a machine whose
  // bridge is fine and the readiness panel renders nothing.
  bridgeReadinessMock.mockReset();
  bridgeReadinessMock.mockResolvedValue({ ok: true, data: { kind: "ready" } });
  Object.defineProperty(window, "vex", {
    configurable: true,
    value: {
      projects: { list: projectsListMock },
      studio: { getBridgeReadiness: bridgeReadinessMock },
    },
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

describe("the way back to the agent shell", () => {
  it("renders the SAME runtime-mode capsule the agent hero renders", () => {
    renderWelcome({});
    const group = screen.getByRole("radiogroup", { name: "Runtime mode" });
    const segments = screen.getAllByRole("radio");
    expect(group.contains(segments[0] ?? null)).toBe(true);
    expect(segments.map((el) => el.textContent)).toEqual(["Agent", "Studio"]);
    // Studio is the mode we are in, so Studio is the checked segment.
    expect(
      screen.getByRole("radio", { name: "Studio" }).getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("choosing Agent leaves Studio - without it the screen is a one-way door", () => {
    renderWelcome({});
    fireEvent.click(screen.getByRole("radio", { name: "Agent" }));
    expect(useUiStore.getState().runtimeMode).toBe("agent");
  });
});

describe("a REJECTED projects read", () => {
  it("reports the failure instead of the empty state", async () => {
    // Not an `ok: false` Result - the call itself rejects, which is what a
    // preload bridge throwing or a window tearing down mid-call looks like.
    // That leaves no Result at all, and the row list falls back to [].
    projectsListMock.mockRejectedValue(new Error("bridge gone"));
    renderWelcome({});
    const line = await screen.findByRole("status");
    expect(line.textContent).toBe("Vex could not read your projects.");
    expect(screen.queryByText("No projects yet.")).toBeNull();
  });
});

describe("the bridge diagnostic", () => {
  it("is checked on entry, without the user asking for it", async () => {
    renderWelcome({});
    await waitFor(() => {
      expect(bridgeReadinessMock).toHaveBeenCalled();
    });
  });

  it("is absent when the bridge is there", async () => {
    renderWelcome({});
    await screen.findByText("No projects yet.");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("appears above the create CTA when the bridge is missing", async () => {
    bridgeReadinessMock.mockResolvedValue({
      ok: true,
      data: {
        kind: "missing_dev",
        platform: "linux",
        requiredGoVersion: "go1.27.0",
        go: { kind: "present" },
      },
    });
    renderWelcome({ onCreateProject: () => undefined });

    const alert = await screen.findByRole("alert");
    const cta = screen.getByRole("button", { name: "New project" });
    // A project created without a bridge gets no coding-agent config files at
    // all, so the diagnostic has to be readable BEFORE the button that makes
    // one. DOCUMENT_POSITION_FOLLOWING means the CTA comes after the alert.
    expect(
      alert.compareDocumentPosition(cta) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeGreaterThan(0);
  });

  it("does not steal the project list's own status line", async () => {
    projectsListMock.mockResolvedValue({
      ok: false,
      error: makeError("db down"),
    });
    bridgeReadinessMock.mockResolvedValue({
      ok: true,
      data: { kind: "missing_packaged" },
    });
    renderWelcome({});

    // Two independent failures, two independent surfaces: the bridge alert and
    // the project list's status line. Neither replaces the other.
    const line = await screen.findByRole("status");
    expect(line.textContent).toBe("Vex could not read your projects.");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Reinstall Vex");
  });
});
