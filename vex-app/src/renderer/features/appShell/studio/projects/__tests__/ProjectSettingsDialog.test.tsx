/**
 * THE SCOPE EDITOR: the expected version, the agent set, the render report,
 * and above all the SCOPE-CONFLICT path.
 *
 * RED ON REVERT for the conflict rule, two ways:
 *
 *  - make the conflict branch call `mutateAsync` again (an auto-retry) and
 *    "never resubmits on a scope conflict" fails: the mock is called twice;
 *  - delete the `result.error.code === SCOPE_CONFLICT_CODE` branch so a
 *    conflict falls through to `setSubmitError`, and "renders its own copy on a
 *    scope conflict" fails: the reload affordance is absent and Save is still
 *    the primary action.
 *
 * Matchers are plain Vitest/Chai (this repository installs no jest-dom).
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Result } from "@shared/ipc/result.js";
import type {
  ProjectDto,
  ProjectGetResult,
  ProjectUpdateScopeInput,
  ProjectUpdateScopeResult,
} from "@shared/schemas/projects.js";
import {
  installStudioDomStubs,
  makeProject,
} from "../../__tests__/studio-fixtures.js";
import { ProjectSettingsDialog } from "../ProjectSettingsDialog.js";
import { PROJECT_SCOPE_CONFLICT_RELOAD } from "../projects-copy.js";

const getMock = vi.fn<() => Promise<Result<ProjectGetResult>>>();
const updateMock =
  vi.fn<(input: ProjectUpdateScopeInput) => Promise<Result<ProjectUpdateScopeResult>>>();
const walletsMock = vi.fn();

const STORED: ProjectDto = makeProject({
  name: "atlas",
  permission: "restricted",
  agents: ["codex"],
  scopeVersion: 7,
});

function conflictError(): Result<ProjectUpdateScopeResult> {
  return {
    ok: false,
    error: {
      code: "projects.scope_conflict",
      domain: "projects",
      message: "This project changed since you loaded it.",
      retryable: false,
      userActionable: true,
      redacted: true,
      correlationId: "00000000-0000-4000-8000-000000000000",
    },
  };
}

beforeAll(() => {
  installStudioDomStubs();
});

beforeEach(() => {
  getMock.mockReset();
  getMock.mockResolvedValue({ ok: true, data: STORED });
  updateMock.mockReset();
  walletsMock.mockReset();
  walletsMock.mockResolvedValue({ ok: true, data: { evm: [], solana: [] } });
  Object.defineProperty(window, "vex", {
    configurable: true,
    value: {
      projects: { get: getMock, updateScope: updateMock },
      wallets: { listAvailable: walletsMock },
    },
  });
});

function renderSettings(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={client}>
      <ProjectSettingsDialog projectId={STORED.id} onClose={() => undefined} />
    </QueryClientProvider>,
  );
}

function saveButton(): HTMLButtonElement {
  const button = screen.getByRole("button", { name: /^(Save|Saving)$/ });
  if (!(button instanceof HTMLButtonElement)) throw new Error("no save button");
  return button;
}

/** Wait for the form to be seeded from the loaded project. */
async function loaded(): Promise<void> {
  await screen.findByRole("checkbox", { name: /Codex CLI/ });
}

describe("loading and the dirty gate", () => {
  it("seeds the form from the stored project and disables Save until it changes", async () => {
    renderSettings();
    await loaded();

    const codex = screen.getByRole("checkbox", { name: /Codex CLI/ });
    expect((codex as HTMLInputElement).checked).toBe(true);
    expect(saveButton().disabled).toBe(true);

    fireEvent.click(screen.getByRole("checkbox", { name: /Cursor/ }));
    expect(saveButton().disabled).toBe(false);
  });
});

describe("the wire input", () => {
  it("carries the LOADED scope version and the edited agent set", async () => {
    updateMock.mockResolvedValue({
      ok: true,
      data: {
        project: { ...STORED, scopeVersion: 8, agents: ["codex", "cursor"] },
        render: {
          scopeVersion: 8,
          completed: true,
          trigger: "scope_update",
          artifacts: [],
          warnings: [],
        },
      },
    });
    renderSettings();
    await loaded();

    fireEvent.click(screen.getByRole("checkbox", { name: /Cursor/ }));
    fireEvent.click(saveButton());

    await waitFor(() => {
      expect(updateMock).toHaveBeenCalled();
    });
    expect(updateMock.mock.calls[0]?.[0]).toEqual({
      projectId: STORED.id,
      expectedScopeVersion: 7,
      permission: "restricted",
      wallets: { evm: null, solana: null },
      agents: ["codex", "cursor"],
    });
  });

  it("sends a changed permission", async () => {
    updateMock.mockResolvedValue({
      ok: true,
      data: {
        project: { ...STORED, scopeVersion: 8, permission: "full" },
        render: {
          scopeVersion: 8,
          completed: true,
          trigger: "scope_update",
          artifacts: [],
          warnings: [],
        },
      },
    });
    renderSettings();
    await loaded();

    fireEvent.click(screen.getByRole("radio", { name: /Full access/ }));
    fireEvent.click(saveButton());
    await waitFor(() => {
      expect(updateMock).toHaveBeenCalled();
    });
    expect(updateMock.mock.calls[0]?.[0].permission).toBe("full");
  });
});

describe("the scope conflict", () => {
  it("renders its own copy and offers a reload, not a resubmit", async () => {
    updateMock.mockResolvedValue(conflictError());
    renderSettings();
    await loaded();

    fireEvent.click(screen.getByRole("checkbox", { name: /Cursor/ }));
    fireEvent.click(saveButton());

    // Its OWN pane: the reload is the primary action and Save is gone.
    expect(
      await screen.findByRole("button", { name: PROJECT_SCOPE_CONFLICT_RELOAD }),
    ).not.toBeNull();
    expect(screen.queryByRole("button", { name: /^Save$/ })).toBeNull();
    expect(screen.getByText(/wrote nothing/)).not.toBeNull();
  });

  it("never resubmits on a scope conflict", async () => {
    updateMock.mockResolvedValue(conflictError());
    renderSettings();
    await loaded();

    fireEvent.click(screen.getByRole("checkbox", { name: /Cursor/ }));
    fireEvent.click(saveButton());
    await screen.findByRole("button", { name: PROJECT_SCOPE_CONFLICT_RELOAD });

    // Let every timer and microtask the mutation could have scheduled run.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it("reloads from a FRESH read rather than reusing the consumed version", async () => {
    updateMock.mockResolvedValue(conflictError());
    renderSettings();
    await loaded();

    fireEvent.click(screen.getByRole("checkbox", { name: /Cursor/ }));
    fireEvent.click(saveButton());
    await screen.findByRole("button", { name: PROJECT_SCOPE_CONFLICT_RELOAD });

    // The project as it now stands: a newer version, and a permission the user
    // never chose in this dialog.
    getMock.mockResolvedValue({
      ok: true,
      data: { ...STORED, scopeVersion: 9, permission: "full", agents: [] },
    });
    fireEvent.click(
      screen.getByRole("button", { name: PROJECT_SCOPE_CONFLICT_RELOAD }),
    );

    await loaded();
    // Re-seeded from what is STORED: the user's unsaved edit is gone, which is
    // the honest outcome - it was composed against a project that no longer
    // exists in that shape.
    expect(
      (screen.getByRole("checkbox", { name: /Codex CLI/ }) as HTMLInputElement)
        .checked,
    ).toBe(false);
    expect(saveButton().disabled).toBe(true);

    // And the NEXT save carries the fresh version, never the consumed 7.
    updateMock.mockResolvedValue({
      ok: true,
      data: {
        project: { ...STORED, scopeVersion: 10 },
        render: {
          scopeVersion: 10,
          completed: true,
          trigger: "scope_update",
          artifacts: [],
          warnings: [],
        },
      },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: /Cursor/ }));
    fireEvent.click(saveButton());
    await waitFor(() => {
      expect(updateMock).toHaveBeenCalledTimes(2);
    });
    expect(updateMock.mock.calls[1]?.[0].expectedScopeVersion).toBe(9);
  });
});

describe("the render report", () => {
  it("surfaces a refused file after a successful save", async () => {
    updateMock.mockResolvedValue({
      ok: true,
      data: {
        project: { ...STORED, scopeVersion: 8 },
        render: {
          scopeVersion: 8,
          completed: false,
          trigger: "scope_update",
          artifacts: [
            {
              status: "refused",
              kind: "agent-config",
              agentId: "codex",
              path: ".codex/config.toml",
              reason: "provenance_collision",
              detail: "Another tool owns the entry at this path.",
            },
          ],
          warnings: [
            {
              kind: "launch_required",
              agentId: "kimi",
              detail: "Pass --mcp-config-file when you start Kimi.",
            },
          ],
        },
      },
    });
    renderSettings();
    await loaded();

    fireEvent.click(screen.getByRole("checkbox", { name: /Cursor/ }));
    fireEvent.click(saveButton());

    // The save SUCCEEDED and a file was refused. Both are reported.
    expect(
      await screen.findByText(
        /Something already sits at this path and Vex cannot prove it wrote it/,
      ),
    ).not.toBeNull();
    expect(
      screen.getByText("Another tool owns the entry at this path."),
    ).not.toBeNull();
    // The incomplete run says the project is still owed a reconciliation.
    expect(screen.getByText(/still owes this project a reconciliation/)).not.toBeNull();
    // And the warning is not swallowed either.
    expect(
      screen.getByText("Pass --mcp-config-file when you start Kimi."),
    ).not.toBeNull();
  });
});
