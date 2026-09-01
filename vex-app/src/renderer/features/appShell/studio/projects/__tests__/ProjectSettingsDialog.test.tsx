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
 *    the primary action;
 *  - collapse the `reloading` state back to "clear the conflict, then await the
 *    refetch" and "keeps the stale form off screen for the whole reload"
 *    fails on its first assertion: a Save button is mounted inside the window,
 *    and the submission it accepts carries the consumed version 7.
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
import {
  PROJECT_SCOPE_CONFLICT_RELOAD,
  PROJECT_SCOPE_CONFLICT_RELOADING,
  PROJECT_SCOPE_CONFLICT_TITLE,
} from "../projects-copy.js";

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
          runFailure: null,
        },
        refreshFailure: null,
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
          runFailure: null,
        },
        refreshFailure: null,
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
          runFailure: null,
        },
        refreshFailure: null,
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

describe("the reload window", () => {
  /**
   * The window between pressing Reload and the fresh row landing. The refetch
   * is held open deliberately - the same shape `agents-colab/vscode`'s dialog
   * suite uses when it keeps `dialog.show()`'s promise pending across its
   * assertions - because the defect only exists for the length of one IPC
   * roundtrip and a resolved mock would step straight over it.
   */
  it("keeps the stale form off screen for the whole reload", async () => {
    updateMock.mockResolvedValue(conflictError());
    renderSettings();
    await loaded();

    fireEvent.click(screen.getByRole("checkbox", { name: /Cursor/ }));
    fireEvent.click(saveButton());
    await screen.findByRole("button", { name: PROJECT_SCOPE_CONFLICT_RELOAD });

    let releaseRead = (): void => undefined;
    getMock.mockReturnValue(
      new Promise<Result<ProjectGetResult>>((resolve) => {
        releaseRead = () => {
          resolve({
            ok: true,
            data: { ...STORED, scopeVersion: 9, permission: "full" },
          });
        };
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: PROJECT_SCOPE_CONFLICT_RELOAD }),
    );

    // THE WINDOW, and the assertion that matters most goes first: a submission
    // dispatched here - a stray Enter, an event already queued behind the
    // click - must not reach the mutation, because the only version it could
    // carry is the 7 the refused attempt already consumed.
    const form = document.querySelector("form");
    if (form === null) throw new Error("no settings form");
    fireEvent.submit(form);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Asserted as the VERSIONS rather than a call count, so a regression names
    // the stale number it sent instead of only how many times it sent it.
    expect(
      updateMock.mock.calls.map((call) => call[0].expectedScopeVersion),
    ).toEqual([7]);

    // And the pane is still up, with the busy label and no editable form.
    await screen.findByRole("button", { name: PROJECT_SCOPE_CONFLICT_RELOADING });
    expect(screen.queryByRole("button", { name: /^Save$/ })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /Codex CLI/ })).toBeNull();
    expect(screen.getByText(PROJECT_SCOPE_CONFLICT_TITLE)).not.toBeNull();

    // And the reload is single-flight while it is in the air.
    fireEvent.click(
      screen.getByRole("button", { name: PROJECT_SCOPE_CONFLICT_RELOADING }),
    );
    expect(getMock).toHaveBeenCalledTimes(2);

    releaseRead();
    await loaded();
    // One transition out: the pane is gone and the form is the FRESH row.
    expect(screen.queryByText(PROJECT_SCOPE_CONFLICT_TITLE)).toBeNull();
    expect(
      (screen.getByRole("radio", { name: /Full access/ }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(saveButton().disabled).toBe(true);
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
          runFailure: null,
        },
        refreshFailure: null,
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
