/**
 * THE DELETE DIALOG: the typed-name gate, the checkbox upgrade, the terminal
 * line, and all seven outcomes.
 *
 * The delete is the most consequential thing this feature does, so every rule
 * that stands between a click and it has its own case:
 *
 *  - the TYPED-NAME GATE arms the confirm and nothing else does;
 *  - the CHECKBOX upgrades the dialog to the warning treatment AND is what
 *    puts `alsoTrashFolder: true` on the wire;
 *  - the TERMINAL LINE is present only when the renderer actually knows;
 *  - each of the SEVEN outcomes renders distinctly, and the three that end the
 *    interaction are the only ones that close;
 *  - `trash: "failed"` keeps the dialog open even on `removed`;
 *  - FOCUS lands on Cancel.
 *
 * Matchers are plain Vitest/Chai: this repository does not install
 * `@testing-library/jest-dom` (see `components/ui/__tests__/select-menu.test.tsx`).
 *
 * RED ON REVERT for the gate: change `typedName.trim() === project.name` to
 * `true`, or drop `!nameMatches` from `confirmDisabled`, and "keeps the confirm
 * disabled until the name matches exactly" fails on the first assertion - the
 * button is enabled with an empty field.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Result } from "@shared/ipc/result.js";
import type {
  ProjectDeleteInput,
  ProjectDeleteResult,
  ProjectDto,
} from "@shared/schemas/projects.js";
import {
  installStudioDomStubs,
  makeProject,
} from "../../__tests__/studio-fixtures.js";
import {
  clearProjectTerminals,
  publishProjectTerminals,
} from "../../workspace/project-terminals.js";
import { ProjectDeleteDialog } from "../ProjectDeleteDialog.js";
import {
  PROJECT_DELETE_OUTCOME_SENTENCES,
  PROJECT_DELETE_TRASH_LABEL,
  PROJECT_TRASH_SENTENCES,
} from "../projects-copy.js";

const deleteMock = vi.fn<(input: ProjectDeleteInput) => Promise<Result<ProjectDeleteResult>>>();

beforeAll(() => {
  installStudioDomStubs();
});

beforeEach(() => {
  deleteMock.mockReset();
  deleteMock.mockResolvedValue({ ok: true, data: { outcome: "already_removed" } });
  clearProjectTerminals();
  Object.defineProperty(window, "vex", {
    configurable: true,
    value: { projects: { delete: deleteMock } },
  });
});

interface Harness {
  readonly project: ProjectDto;
  readonly onClose: ReturnType<typeof vi.fn>;
  readonly onDeleted: ReturnType<typeof vi.fn>;
}

function renderDialog(overrides: Partial<ProjectDto> = {}): Harness {
  const project = makeProject({ name: "atlas", ...overrides });
  const onClose = vi.fn();
  const onDeleted = vi.fn();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={client}>
      <ProjectDeleteDialog
        project={project}
        onClose={onClose}
        onDeleted={onDeleted}
      />
    </QueryClientProvider>,
  );
  return { project, onClose, onDeleted };
}

function confirmButton(): HTMLButtonElement {
  const button = screen.getByRole("button", { name: /^(Delete|Try again|Deleting)$/ });
  if (!(button instanceof HTMLButtonElement)) throw new Error("no confirm button");
  return button;
}

function typeName(value: string): void {
  fireEvent.change(screen.getByLabelText("Project name"), {
    target: { value },
  });
}

/** Type the name and press the confirm, waiting for the call to settle. */
async function confirmDelete(name = "atlas"): Promise<void> {
  typeName(name);
  fireEvent.click(confirmButton());
  await waitFor(() => {
    expect(deleteMock).toHaveBeenCalled();
  });
}

describe("the typed-name gate", () => {
  it("keeps the confirm disabled until the name matches exactly", () => {
    renderDialog();
    expect(confirmButton().disabled).toBe(true);

    typeName("atla");
    expect(confirmButton().disabled).toBe(true);

    // Case is part of the name: a case-insensitive match would arm the button
    // for a name the user did not actually read.
    typeName("ATLAS");
    expect(confirmButton().disabled).toBe(true);

    typeName("atlas");
    expect(confirmButton().disabled).toBe(false);
  });

  it("tolerates surrounding whitespace from a paste", () => {
    renderDialog();
    typeName("  atlas  ");
    expect(confirmButton().disabled).toBe(false);
  });

  it("sends the stored name as expectedName, not the typed text", async () => {
    renderDialog();
    await confirmDelete("  atlas ");
    expect(deleteMock).toHaveBeenCalledWith(
      expect.objectContaining({ expectedName: "atlas" }),
    );
  });

  it("never dispatches a delete while the field is empty", () => {
    renderDialog();
    fireEvent.click(confirmButton());
    expect(deleteMock).not.toHaveBeenCalled();
  });
});

describe("the trash checkbox", () => {
  it("defaults to off and puts alsoTrashFolder:false on the wire", async () => {
    renderDialog();
    const checkbox = screen.getByLabelText(PROJECT_DELETE_TRASH_LABEL, {
      exact: false,
    });
    expect((checkbox as HTMLInputElement).checked).toBe(false);
    await confirmDelete();
    expect(deleteMock).toHaveBeenCalledWith(
      expect.objectContaining({ alsoTrashFolder: false }),
    );
  });

  it("upgrades the dialog to the warning treatment when checked", () => {
    renderDialog();
    const dialog = document.querySelector("[data-vex-delete-warned]");
    expect(dialog).toBeNull();

    fireEvent.click(
      screen.getByLabelText(PROJECT_DELETE_TRASH_LABEL, { exact: false }),
    );
    expect(
      document.querySelector('[data-vex-delete-warned="true"]'),
    ).not.toBeNull();
  });

  it("carries the checkbox to the wire when checked", async () => {
    renderDialog();
    fireEvent.click(
      screen.getByLabelText(PROJECT_DELETE_TRASH_LABEL, { exact: false }),
    );
    await confirmDelete();
    expect(deleteMock).toHaveBeenCalledWith(
      expect.objectContaining({ alsoTrashFolder: true }),
    );
  });
});

describe("the running-terminal line", () => {
  it("is omitted when the renderer does not know the count", () => {
    // No workspace mounted for this project, so nothing was published.
    renderDialog();
    expect(screen.queryByText(/running terminal/)).toBeNull();
  });

  it("names the count when a mounted workspace published one", () => {
    const project = makeProject({ name: "atlas" });
    publishProjectTerminals(project.id, ["t1", "t2"]);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    render(
      <QueryClientProvider client={client}>
        <ProjectDeleteDialog
          project={project}
          onClose={() => undefined}
          onDeleted={() => undefined}
        />
      </QueryClientProvider>,
    );
    expect(
      screen.getByText("2 running terminals in this project will be closed."),
    ).not.toBeNull();
  });

  it("says zero rather than nothing when the workspace is mounted and empty", () => {
    // The distinction the `null`/`[]` contract exists for: this project's
    // workspace IS mounted, so zero is a fact rather than an absence.
    const project = makeProject({ name: "atlas" });
    publishProjectTerminals(project.id, []);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    render(
      <QueryClientProvider client={client}>
        <ProjectDeleteDialog
          project={project}
          onClose={() => undefined}
          onDeleted={() => undefined}
        />
      </QueryClientProvider>,
    );
    expect(
      screen.getByText("0 running terminals in this project will be closed."),
    ).not.toBeNull();
  });
});

describe("every delete outcome", () => {
  const cleanup = { cleanup: [], trash: "not_requested" as const };

  it.each<[ProjectDeleteResult, boolean]>([
    [{ outcome: "removed", ...cleanup }, true],
    [{ outcome: "already_removed" }, true],
    [{ outcome: "not_found" }, true],
    [{ outcome: "cleanup_resumed", ...cleanup }, false],
    [{ outcome: "cleanup_pending", ...cleanup, attempts: 2 }, false],
    [{ outcome: "blocked_active_calls", count: 3 }, false],
    [{ outcome: "blocked_pending_dispatch" }, false],
  ])("renders %o and closes only when it should", async (outcome, closes) => {
    deleteMock.mockResolvedValue({ ok: true, data: outcome });
    const { onClose } = renderDialog();
    await confirmDelete();

    if (closes) {
      await waitFor(() => {
        expect(onClose).toHaveBeenCalled();
      });
      return;
    }
    // Still open, and saying WHICH outcome it is - never a generic failure.
    await waitFor(() => {
      expect(
        document.querySelector(`[data-vex-delete-outcome="${outcome.outcome}"]`),
      ).not.toBeNull();
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(
      screen.getByText(PROJECT_DELETE_OUTCOME_SENTENCES[outcome.outcome]),
    ).not.toBeNull();
  });

  it("names the running-call count on blocked_active_calls", async () => {
    deleteMock.mockResolvedValue({
      ok: true,
      data: { outcome: "blocked_active_calls", count: 3 },
    });
    renderDialog();
    await confirmDelete();
    expect(await screen.findByText("3 calls were still running.")).not.toBeNull();
  });

  it("reports the attempt count on cleanup_pending", async () => {
    deleteMock.mockResolvedValue({
      ok: true,
      data: { outcome: "cleanup_pending", ...cleanup, attempts: 2 },
    });
    renderDialog();
    await confirmDelete();
    expect(
      await screen.findByText("Vex has attempted this cleanup 2 times."),
    ).not.toBeNull();
  });

  it("reports a FAILED trash and keeps the dialog open even on removed", async () => {
    deleteMock.mockResolvedValue({
      ok: true,
      data: { outcome: "removed", cleanup: [], trash: "failed" },
    });
    const { onClose, onDeleted } = renderDialog();
    await confirmDelete();

    expect(
      await screen.findByText(PROJECT_TRASH_SENTENCES.failed),
    ).not.toBeNull();
    // The project IS gone, so the shell is told; the dialog stays because the
    // folder is still on disk and that is the user's problem to finish.
    expect(onDeleted).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("tells the shell the project is gone on removed", async () => {
    deleteMock.mockResolvedValue({
      ok: true,
      data: { outcome: "removed", ...cleanup },
    });
    const { onDeleted, project } = renderDialog();
    await confirmDelete();
    await waitFor(() => {
      expect(onDeleted).toHaveBeenCalledWith(project.id);
    });
  });

  it("renders a refusal Result by name rather than as a generic error", async () => {
    deleteMock.mockResolvedValue({
      ok: false,
      error: {
        code: "projects.wallet_drift",
        domain: "projects",
        message: "A wallet selected by this project no longer matches its stored address.",
        retryable: true,
        userActionable: true,
        redacted: true,
        correlationId: "00000000-0000-4000-8000-000000000000",
      },
    });
    renderDialog();
    await confirmDelete();
    expect(
      await screen.findByText(
        "A wallet selected by this project no longer matches its stored address.",
      ),
    ).not.toBeNull();
  });
});

describe("focus", () => {
  it("defaults to Cancel, the safer choice", async () => {
    renderDialog();
    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Cancel" }),
      );
    });
  });
});
