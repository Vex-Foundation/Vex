/**
 * THE WIRING: the sidebar row menu and the create key publish intents, and
 * `StudioProjectDialogs` is the one thing that turns an intent into a dialog.
 *
 * Asserted on the INTENT rather than on a rendered dialog, because the intent
 * is the contract between the two columns: the sidebar cannot see the dialogs
 * and must not, and a test that mounted both would stop proving that.
 *
 * Matchers are plain Vitest/Chai (this repository installs no jest-dom).
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Result } from "@shared/ipc/result.js";
import type { ProjectList } from "@shared/schemas/projects.js";
import { ExplorerRegistry } from "../../explorer/index.js";
import {
  installStudioDomStubs,
  makeProject,
} from "../../__tests__/studio-fixtures.js";
import { useProjectDialogStore } from "../project-dialog-intent.js";
import {
  STUDIO_PROJECT_MENU_DELETE,
  STUDIO_PROJECT_MENU_REPAIR,
  STUDIO_PROJECT_MENU_SETTINGS,
  projectRowMenuLabel,
} from "../../studio-copy.js";

const projectsListMock = vi.fn<() => Promise<Result<ProjectList>>>();

vi.mock("../../explorer/ExplorerTree.js", () => ({
  ExplorerTree: () => <div data-testid="explorer-tree" />,
}));
vi.mock("../../../market/VexTokenCardCompact.js", () => ({
  VexTokenCardCompact: () => null,
}));
vi.mock("../../../SidebarProfile.js", () => ({
  SidebarProfile: () => <div data-testid="sidebar-profile" />,
}));

const { StudioSidebar } = await import("../../sidebar/StudioSidebar.js");

const PROJECT = makeProject({ name: "atlas" });

beforeAll(() => {
  installStudioDomStubs();
});

beforeEach(() => {
  projectsListMock.mockReset();
  projectsListMock.mockResolvedValue({ ok: true, data: [PROJECT] });
  useProjectDialogStore.setState({ request: null });
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

function renderSidebar(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={client}>
      <StudioSidebar
        collapsed={false}
        width={300}
        onToggleSidebar={() => undefined}
        activeProjectId={null}
        onSelectProject={() => undefined}
        onSelectWelcome={() => undefined}
        explorerRegistry={new ExplorerRegistry()}
      />
    </QueryClientProvider>,
  );
}

async function openRowMenu(): Promise<void> {
  const trigger = await screen.findByRole("button", {
    name: projectRowMenuLabel("atlas"),
  });
  fireEvent.click(trigger);
}

describe("the sidebar row menu", () => {
  it.each([
    [STUDIO_PROJECT_MENU_SETTINGS, "settings"],
    [STUDIO_PROJECT_MENU_REPAIR, "repair"],
    [STUDIO_PROJECT_MENU_DELETE, "delete"],
  ])("%s publishes a %s intent for that project", async (label, kind) => {
    renderSidebar();
    await openRowMenu();
    fireEvent.click(await screen.findByText(label));

    await waitFor(() => {
      expect(useProjectDialogStore.getState().request).toEqual({
        kind,
        projectId: PROJECT.id,
      });
    });
  });

  it("closes the menu when an item is chosen", async () => {
    // A menu left open behind a modal would still be focusable and would
    // outlive the dialog it launched.
    renderSidebar();
    await openRowMenu();
    fireEvent.click(await screen.findByText(STUDIO_PROJECT_MENU_SETTINGS));
    await waitFor(() => {
      expect(screen.queryByText(STUDIO_PROJECT_MENU_REPAIR)).toBeNull();
    });
  });

  it("no longer renders the actions as disabled", async () => {
    // B4a shipped them `aria-disabled`; B4b's contract is that they act.
    renderSidebar();
    await openRowMenu();
    const item = await screen.findByText(STUDIO_PROJECT_MENU_DELETE);
    const row = item.closest("[aria-disabled]");
    expect(row).toBeNull();
  });
});

describe("the create key", () => {
  it("publishes a create intent with no prop wired", async () => {
    // The key renders by DEFAULT now: B4a hid it because the creator did not
    // exist, and the honest default once it does is the key that opens it.
    renderSidebar();
    fireEvent.click(await screen.findByRole("button", { name: "New project" }));
    expect(useProjectDialogStore.getState().request).toEqual({ kind: "create" });
  });

  it("lets an explicit prop win over the default publisher", async () => {
    const onCreateProject = vi.fn();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    render(
      <QueryClientProvider client={client}>
        <StudioSidebar
          collapsed={false}
          width={300}
          onToggleSidebar={() => undefined}
          activeProjectId={null}
          onSelectProject={() => undefined}
          onSelectWelcome={() => undefined}
          onCreateProject={onCreateProject}
          explorerRegistry={new ExplorerRegistry()}
        />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "New project" }));
    expect(onCreateProject).toHaveBeenCalled();
    expect(useProjectDialogStore.getState().request).toBeNull();
  });
});
