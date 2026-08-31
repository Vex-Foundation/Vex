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
 *  - the FOLDER CHOICE freezes once an outcome proves the tombstone exists,
 *    because main resumes the recorded request and ignores the retry's input;
 *  - the TERMINAL LINE is present only when the renderer actually knows;
 *  - each of the SEVEN outcomes renders distinctly, and the TWO that end the
 *    interaction are the only ones that close;
 *  - `trash: "failed"` keeps the dialog open even on `removed`;
 *  - `not_found` claims NOTHING: no `onDeleted`, no toast, no close. What the
 *    real composition then does with it is `project-delete-composition.test.tsx`;
 *  - an outcome that leaves the dialog open about a tombstoned row raises
 *    `onHoldOpen`, and the row survives the list dropping it;
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
import {
  cleanup as cleanupTrees,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { JSX } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Result } from "@shared/ipc/result.js";
import type {
  ProjectDeleteInput,
  ProjectDeleteResult,
  ProjectDto,
} from "@shared/schemas/projects.js";
import { clearToast, getToastSnapshot } from "../../../../../lib/toast.js";
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
  PROJECT_DELETE_TRASH_LOCKED_NOTE,
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
  // The toast store is module state; a toast raised by a previous case would
  // make "no toast was shown" pass for the wrong reason.
  const standing = getToastSnapshot();
  if (standing !== null) clearToast(standing.id);
  Object.defineProperty(window, "vex", {
    configurable: true,
    value: { projects: { delete: deleteMock } },
  });
});

interface Harness {
  readonly project: ProjectDto;
  readonly onClose: ReturnType<typeof vi.fn>;
  readonly onDeleted: ReturnType<typeof vi.fn>;
  readonly onHoldOpen: ReturnType<typeof vi.fn>;
  /** Re-render with a different `project` prop, as the host does. */
  readonly setProject: (next: ProjectDto | null) => void;
}

function renderDialog(overrides: Partial<ProjectDto> = {}): Harness {
  const project = makeProject({ name: "atlas", ...overrides });
  const onClose = vi.fn();
  const onDeleted = vi.fn();
  const onHoldOpen = vi.fn();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const tree = (next: ProjectDto | null): JSX.Element => (
    <QueryClientProvider client={client}>
      <ProjectDeleteDialog
        project={next}
        onClose={onClose}
        onDeleted={onDeleted}
        onHoldOpen={onHoldOpen}
      />
    </QueryClientProvider>
  );
  const view = render(tree(project));
  return {
    project,
    onClose,
    onDeleted,
    onHoldOpen,
    setProject: (next) => {
      view.rerender(tree(next));
    },
  };
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

describe("the frozen folder choice", () => {
  const cleanup = { cleanup: [], trash: "not_requested" as const };

  function trashCheckbox(): HTMLInputElement {
    const box = screen.getByLabelText(PROJECT_DELETE_TRASH_LABEL, {
      exact: false,
    });
    if (!(box instanceof HTMLInputElement)) throw new Error("no trash checkbox");
    return box;
  }

  it("freezes the submitted choice once a cleanup is pending, and retries send it", async () => {
    // The defect this exists for: main records the trash intent on the
    // TOMBSTONE and its `already_tombstoned` branch RESUMES that recorded
    // request, ignoring the retry's own input. A checkbox that still moved
    // would tell the user their folder was spared while it went to the trash.
    deleteMock.mockResolvedValue({
      ok: true,
      data: { outcome: "cleanup_pending", ...cleanup, attempts: 2 },
    });
    renderDialog();

    fireEvent.click(trashCheckbox());
    expect(trashCheckbox().checked).toBe(true);
    await confirmDelete();
    await screen.findByText("Vex has attempted this cleanup 2 times.");

    // The user tries to take it back. The control does not move.
    expect(trashCheckbox().disabled).toBe(true);
    fireEvent.click(trashCheckbox());
    expect(trashCheckbox().checked).toBe(true);
    // And the dialog SAYS why, rather than presenting a dead control.
    expect(screen.getByText(PROJECT_DELETE_TRASH_LOCKED_NOTE)).not.toBeNull();

    // RED ON REVERT: drop the freeze (send `alsoTrashFolder` instead of the
    // recorded value, or leave the checkbox enabled) and this assertion fails
    // with `alsoTrashFolder: false` - the retry carrying the toggled value.
    fireEvent.click(confirmButton());
    await waitFor(() => {
      expect(deleteMock).toHaveBeenCalledTimes(2);
    });
    expect(deleteMock.mock.calls[1]?.[0].alsoTrashFolder).toBe(true);
  });

  it("keeps the warning treatment on the recorded choice", async () => {
    // The wash is the visible half of the same fact: the action that is
    // pending IS the one that moves the folder.
    deleteMock.mockResolvedValue({
      ok: true,
      data: { outcome: "cleanup_pending", ...cleanup, attempts: 1 },
    });
    renderDialog();
    fireEvent.click(trashCheckbox());
    await confirmDelete();
    await screen.findByText("Vex has attempted this cleanup once.");

    fireEvent.click(trashCheckbox());
    expect(
      document.querySelector('[data-vex-delete-warned="true"]'),
    ).not.toBeNull();
  });

  it("freezes an UNCHECKED choice just as hard", async () => {
    // The symmetric lie: checking the box after the tombstone recorded
    // `false` would promise a trash that never happens.
    deleteMock.mockResolvedValue({
      ok: true,
      data: { outcome: "cleanup_pending", ...cleanup, attempts: 1 },
    });
    renderDialog();
    await confirmDelete();
    await screen.findByText("Vex has attempted this cleanup once.");

    fireEvent.click(trashCheckbox());
    expect(trashCheckbox().checked).toBe(false);
    fireEvent.click(confirmButton());
    await waitFor(() => {
      expect(deleteMock).toHaveBeenCalledTimes(2);
    });
    expect(deleteMock.mock.calls[1]?.[0].alsoTrashFolder).toBe(false);
  });

  it("holds the FIRST recorded choice across a cleanup_resumed", async () => {
    // `cleanup_resumed` reports on the SAME tombstone, so it must not
    // re-record: the value that created the tombstone is the only true one.
    deleteMock.mockResolvedValueOnce({
      ok: true,
      data: { outcome: "cleanup_pending", ...cleanup, attempts: 1 },
    });
    deleteMock.mockResolvedValue({
      ok: true,
      data: { outcome: "cleanup_resumed", ...cleanup },
    });
    renderDialog();
    fireEvent.click(trashCheckbox());
    await confirmDelete();
    await screen.findByText("Vex has attempted this cleanup once.");

    fireEvent.click(confirmButton());
    await screen.findByText(PROJECT_DELETE_OUTCOME_SENTENCES.cleanup_resumed);
    fireEvent.click(confirmButton());
    await waitFor(() => {
      expect(deleteMock).toHaveBeenCalledTimes(3);
    });
    expect(deleteMock.mock.calls[2]?.[0].alsoTrashFolder).toBe(true);
  });

  it("leaves the choice editable after a blocked outcome, which wrote nothing", async () => {
    // No tombstone, so no recorded decision: the retry is a first attempt and
    // its checkbox is still a real choice. Freezing here would take away a
    // decision the user still owns.
    deleteMock.mockResolvedValue({
      ok: true,
      data: { outcome: "blocked_active_calls", count: 1 },
    });
    renderDialog();
    await confirmDelete();
    await screen.findByText(
      PROJECT_DELETE_OUTCOME_SENTENCES.blocked_active_calls,
    );

    expect(trashCheckbox().disabled).toBe(false);
    expect(screen.queryByText(PROJECT_DELETE_TRASH_LOCKED_NOTE)).toBeNull();
    fireEvent.click(trashCheckbox());
    expect(trashCheckbox().checked).toBe(true);
    fireEvent.click(confirmButton());
    await waitFor(() => {
      expect(deleteMock).toHaveBeenCalledTimes(2);
    });
    expect(deleteMock.mock.calls[1]?.[0].alsoTrashFolder).toBe(true);
  });

  it("lifts the freeze when a NEW delete opens the dialog", async () => {
    // A new request is a new decision. The freeze belongs to the tombstone the
    // dialog created, not to the dialog.
    deleteMock.mockResolvedValue({
      ok: true,
      data: { outcome: "cleanup_pending", ...cleanup, attempts: 1 },
    });
    const { setProject } = renderDialog();
    fireEvent.click(trashCheckbox());
    await confirmDelete();
    await screen.findByText("Vex has attempted this cleanup once.");
    expect(trashCheckbox().disabled).toBe(true);

    setProject(null);
    setProject(makeProject({ name: "borealis" }));
    await screen.findByText("Type the project name to confirm: borealis");

    expect(trashCheckbox().disabled).toBe(false);
    expect(trashCheckbox().checked).toBe(false);
    expect(screen.queryByText(PROJECT_DELETE_TRASH_LOCKED_NOTE)).toBeNull();
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
          onHoldOpen={() => undefined}
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
          onHoldOpen={() => undefined}
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
    [{ outcome: "not_found" }, false],
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

  it("claims NOTHING on not_found: no onDeleted, no toast, no close", async () => {
    // `not_found` is "no such project OR the name did not match", and the
    // second half is a project that still exists under a new name. Every one
    // of the three things a delete used to do here would be a false claim
    // about it.
    deleteMock.mockResolvedValue({ ok: true, data: { outcome: "not_found" } });
    const { onClose, onDeleted } = renderDialog();
    await confirmDelete();

    await screen.findByText(PROJECT_DELETE_OUTCOME_SENTENCES.not_found);
    expect(onDeleted).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(getToastSnapshot()).toBeNull();
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

describe("the pinned row", () => {
  const cleanup = { cleanup: [], trash: "not_requested" as const };

  it("holds the request open and survives the row leaving the list", async () => {
    // The production sequence: `useDeleteProject` invalidates the list on this
    // ok Result, the tombstoned row leaves it, and the host hands this dialog
    // `project={null}`. Without the pin there is no name, no retry and no
    // report left on screen.
    deleteMock.mockResolvedValue({
      ok: true,
      data: { outcome: "cleanup_pending", ...cleanup, attempts: 2 },
    });
    const { onHoldOpen, setProject } = renderDialog();
    await confirmDelete();
    await screen.findByText("Vex has attempted this cleanup 2 times.");
    await waitFor(() => {
      expect(onHoldOpen).toHaveBeenLastCalledWith(true);
    });

    setProject(null);

    expect(
      document.querySelector('[data-vex-delete-outcome="cleanup_pending"]'),
    ).not.toBeNull();
    expect(screen.getByText("Type the project name to confirm: atlas")).not.toBeNull();

    // And the retry still goes to the row this dialog acted on.
    fireEvent.click(confirmButton());
    await waitFor(() => {
      expect(deleteMock).toHaveBeenCalledTimes(2);
    });
    expect(deleteMock.mock.calls[1]?.[0].expectedName).toBe("atlas");
  });

  it("does not hold the request open for not_found", async () => {
    // The one open outcome whose remedy IS the reloaded list: a project that
    // really is gone must still take the dialog with it.
    deleteMock.mockResolvedValue({ ok: true, data: { outcome: "not_found" } });
    const { onHoldOpen } = renderDialog();
    await confirmDelete();
    await screen.findByText(PROJECT_DELETE_OUTCOME_SENTENCES.not_found);
    expect(onHoldOpen).not.toHaveBeenCalledWith(true);
  });

  it("holds the request open on a removed whose trash failed", async () => {
    // Same defect class: the project IS gone, so the list drops it, and the
    // folder-still-on-disk report would be swept off screen with it.
    deleteMock.mockResolvedValue({
      ok: true,
      data: { outcome: "removed", cleanup: [], trash: "failed" },
    });
    const { onHoldOpen, setProject } = renderDialog();
    await confirmDelete();
    await screen.findByText(PROJECT_TRASH_SENTENCES.failed);
    await waitFor(() => {
      expect(onHoldOpen).toHaveBeenLastCalledWith(true);
    });

    setProject(null);
    expect(screen.getByText(PROJECT_TRASH_SENTENCES.failed)).not.toBeNull();
  });

  it("releases the hold when the dialog goes away", async () => {
    deleteMock.mockResolvedValue({
      ok: true,
      data: { outcome: "cleanup_pending", ...cleanup, attempts: 1 },
    });
    const { onHoldOpen } = renderDialog();
    await confirmDelete();
    await waitFor(() => {
      expect(onHoldOpen).toHaveBeenLastCalledWith(true);
    });

    cleanupTrees();
    expect(onHoldOpen).toHaveBeenLastCalledWith(false);
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
