/**
 * The Studio welcome screen: what it says, what it lists, and the ONE thing it
 * deliberately does not render without a real handler.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Result } from "@shared/ipc/result.js";
import type { ProjectList } from "@shared/schemas/projects.js";
import type { StudioBridgeReadiness } from "@shared/schemas/studio-bridge-readiness.js";
import {
  makeArtifact,
  makeError,
  makeProject,
} from "../../__tests__/studio-fixtures.js";
import {
  STUDIO_WELCOME_AGENT_POINTER,
  STUDIO_WELCOME_LEAD,
  STUDIO_WELCOME_NEXT,
} from "../../studio-copy.js";

const projectsListMock = vi.fn<() => Promise<Result<ProjectList>>>();
const bridgeReadinessMock =
  vi.fn<() => Promise<Result<StudioBridgeReadiness>>>();

const { StudioWelcome } = await import("../StudioWelcome.js");
const { useUiStore } = await import("../../../../../stores/uiStore.js");

function renderWelcome(props: {
  readonly onCreateProject?: () => void;
  readonly onSelectProject?: (id: string) => void;
}): { container: HTMLElement } {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
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
  it("states it in THREE hero lines, with no roadmap copy", () => {
    renderWelcome({});
    expect(screen.getByRole("heading", { name: "Vex Studio" })).not.toBeNull();
    // 1. what a project is, 2. what creating one does, 3. the way back.
    expect(screen.getByText(STUDIO_WELCOME_LEAD)).not.toBeNull();
    expect(screen.getByText(STUDIO_WELCOME_NEXT)).not.toBeNull();
    expect(screen.getByText(STUDIO_WELCOME_AGENT_POINTER)).not.toBeNull();
    expect(screen.queryByText(/coming soon/i)).toBeNull();
  });
});

describe("the second action", () => {
  it("opens the project the list returned FIRST", async () => {
    const first = makeProject({ name: "vex-core" });
    projectsListMock.mockResolvedValue({
      ok: true,
      data: [first, makeProject({ name: "trading-agent" })],
    });
    const onSelectProject = vi.fn();
    renderWelcome({ onSelectProject });

    fireEvent.click(await screen.findByRole("button", { name: "Open vex-core" }));
    expect(onSelectProject).toHaveBeenCalledWith(first.id);
  });

  it("is absent when there is nothing to open", async () => {
    renderWelcome({});
    await screen.findByText("No projects yet.");
    expect(screen.queryByRole("button", { name: /^Open / })).toBeNull();
  });
});

describe("a row's state", () => {
  it("hears the drift sentence where the dot is the only signal", async () => {
    projectsListMock.mockResolvedValue({
      ok: true,
      data: [
        makeProject({
          name: "vex-core",
          files: {
            lastRenderedScopeVersion: 1,
            generatorFingerprint: "test",
            artifacts: [makeArtifact("drifted")],
          },
        }),
      ],
    });
    renderWelcome({});
    // The dot is colour-only and aria-hidden, so the words are what assistive
    // technology gets - and they are the SAME sentence the rail row uses.
    expect(
      await screen.findByText("vex-core: Edited since Vex wrote it"),
    ).not.toBeNull();
  });

  it("says so when Vex's files are untouched", async () => {
    projectsListMock.mockResolvedValue({
      ok: true,
      data: [makeProject({ name: "vex-core" })],
    });
    renderWelcome({});
    expect(
      await screen.findByText(
        "Vex's files in this project are as Vex wrote them",
      ),
    ).not.toBeNull();
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

    // Scoped to the LIST: the hero's second action is also a button naming a
    // project, and it is not part of the list's order.
    const titles = within(screen.getByRole("list"))
      .getAllByRole("button")
      .map((el) => el.textContent ?? "");
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
  it("is the mode capsule itself, seated directly under the wordmark, and NOT a plain button", () => {
    // Owner decree 2026-09-04: the Agent | Studio switch sits under the vex
    // wordmark on the welcome screen. This screen renders only while no
    // project is active, and the Studio rail header mounts its capsule only
    // while one is, so the page keeps exactly one radiogroup named "Runtime
    // mode" (e2e/studio.spec.ts pins the count). The stand-in button is gone.
    const { container } = renderWelcome({});
    const group = screen.getByRole("radiogroup", { name: "Runtime mode" });
    expect(
      screen.getByRole("radio", { name: "Studio" }).getAttribute("aria-checked"),
    ).toBe("true");
    // The seat, not merely the presence: mark -> capsule -> heading.
    const heading = container.querySelector('[data-vex-area="studio-welcome"] h1');
    expect(heading?.previousElementSibling).toBe(group);
    expect(group.previousElementSibling?.tagName.toLowerCase()).toBe("svg");
    expect(screen.queryByRole("button", { name: "Back to Agent mode" })).toBeNull();
  });

  it("the capsule leaves Studio - without it the screen is a one-way door", () => {
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
