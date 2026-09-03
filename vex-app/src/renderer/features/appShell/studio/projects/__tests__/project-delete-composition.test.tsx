/**
 * THE DELETE DIALOG INSIDE ITS REAL COMPOSITION.
 *
 * `ProjectDeleteDialog.test.tsx` drives the dialog alone and cannot see the
 * thing that decided both of the defects this suite exists for: the LIST. The
 * chain only exists when all three parts are real together -
 * `useDeleteProject` invalidates `projects.list` on every ok Result, the list
 * refetches, and `StudioProjectDialogs`' settled-list guard closes a request
 * whose row has gone. So everything below mounts the real host, the real
 * dialog and the real query hooks over a scripted `window.vex`, exactly the way
 * `agents-colab/vscode`'s own dialog suite drives `Dialog` through `show()`
 * rather than around it.
 *
 * WHAT IT PROVES, and each is red when the fix is reverted:
 *
 *  1. `not_found` claims nothing (finding 5a). Revert - put `not_found` back in
 *     `CLOSING_OUTCOMES` - and "leaves a renamed project alone" fails on
 *     `expect(onProjectDeleted).not.toHaveBeenCalled()`.
 *  2. `not_found` still reconciles: a project that is really gone takes the
 *     dialog with it, through the list rather than through a false claim.
 *  3. `cleanup_pending` keeps its Retry reachable after the invalidation
 *     (finding 5b). Revert the pin and "keeps the cleanup retry reachable"
 *     fails: the request is closed and the dialog is off screen.
 *  4. A pending cleanup's retry carries the RECORDED folder choice, not the
 *     one the user toggled afterwards. Revert the freeze and "resumes a
 *     pending cleanup with the folder choice as first asked" fails on the
 *     retry's `alsoTrashFolder`.
 *  5. The ratified guard is INTACT: a project that vanishes while the user is
 *     typing the confirmation name still closes the dialog.
 *
 * Matchers are plain Vitest/Chai (this repository installs no jest-dom).
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Result } from "@shared/ipc/result.js";
import type {
  ProjectDeleteInput,
  ProjectDeleteResult,
  ProjectDto,
  ProjectList,
} from "@shared/schemas/projects.js";
import { projectKeys } from "../../../../../lib/api/projects.js";
import { notifications } from "../../../../../lib/notifications/index.js";
import {
  installStudioDomStubs,
  makeProject,
} from "../../__tests__/studio-fixtures.js";
import { StudioProjectDialogs } from "../StudioProjectDialogs.js";
import {
  openProjectDelete,
  useProjectDialogStore,
} from "../project-dialog-intent.js";
import {
  PROJECT_DELETE_OUTCOME_SENTENCES,
  PROJECT_DELETE_TRASH_LABEL,
  PROJECT_DELETE_TRASH_LOCKED_NOTE,
  PROJECT_TRASH_SENTENCES,
} from "../projects-copy.js";

const listMock = vi.fn<() => Promise<Result<ProjectList>>>();
const deleteMock =
  vi.fn<(input: ProjectDeleteInput) => Promise<Result<ProjectDeleteResult>>>();

const ATLAS: ProjectDto = makeProject({ name: "atlas" });

beforeAll(() => {
  installStudioDomStubs();
});

beforeEach(() => {
  listMock.mockReset();
  listMock.mockResolvedValue({ ok: true, data: [ATLAS] });
  deleteMock.mockReset();
  useProjectDialogStore.setState({ request: null });
  // The notification model is module state; a toast raised by a previous case
  // would make "no toast was shown" pass for the wrong reason.
  notifications.reset();
  Object.defineProperty(window, "vex", {
    configurable: true,
    value: { projects: { list: listMock, delete: deleteMock } },
  });
});

interface Harness {
  readonly onProjectDeleted: ReturnType<typeof vi.fn>;
  /** The real cache, so a test can invalidate the list the way main's own
   * events do when another window changes a project. */
  readonly client: QueryClient;
}

function renderHost(): Harness {
  const onProjectDeleted = vi.fn();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={client}>
      <StudioProjectDialogs
        onProjectCreated={() => undefined}
        onProjectDeleted={onProjectDeleted}
      />
    </QueryClientProvider>,
  );
  return { onProjectDeleted, client };
}

/** Raise the delete intent for atlas and wait for its dialog. */
async function openDelete(): Promise<void> {
  openProjectDelete(ATLAS.id);
  await screen.findByText("Type the project name to confirm: atlas");
}

function confirmButton(): HTMLButtonElement {
  const button = screen.getByRole("button", {
    name: /^(Delete|Try again|Deleting)$/,
  });
  if (!(button instanceof HTMLButtonElement)) throw new Error("no confirm button");
  return button;
}

function trashCheckbox(): HTMLInputElement {
  const box = screen.getByLabelText(PROJECT_DELETE_TRASH_LABEL, {
    exact: false,
  });
  if (!(box instanceof HTMLInputElement)) throw new Error("no trash checkbox");
  return box;
}

async function confirmDelete(): Promise<void> {
  fireEvent.change(screen.getByLabelText("Project name"), {
    target: { value: "atlas" },
  });
  fireEvent.click(confirmButton());
  await waitFor(() => {
    expect(deleteMock).toHaveBeenCalled();
  });
}

describe("a not_found answer", () => {
  it("leaves a renamed project alone and re-reads the list", async () => {
    // The rename half of `not_found`: the project is still there, under a name
    // this dialog's `expectedName` no longer matches.
    deleteMock.mockResolvedValue({ ok: true, data: { outcome: "not_found" } });
    listMock.mockResolvedValueOnce({ ok: true, data: [ATLAS] });
    listMock.mockResolvedValue({
      ok: true,
      data: [{ ...ATLAS, name: "atlas-2" }],
    });

    const { onProjectDeleted } = renderHost();
    await openDelete();
    await confirmDelete();

    await screen.findByText(PROJECT_DELETE_OUTCOME_SENTENCES.not_found);
    // Nothing was claimed about a project that still exists.
    expect(onProjectDeleted).not.toHaveBeenCalled();
    expect(notifications.getSnapshot().items).toHaveLength(0);
    // And the dialog is standing on the FRESH row, found by id.
    await screen.findByText("Type the project name to confirm: atlas-2");
    expect(useProjectDialogStore.getState().request).not.toBeNull();
  });

  it("closes through the reloaded list when the project really is gone", async () => {
    // The absent half. The dialog claims nothing here either; the LIST is what
    // ends the interaction, which is the honest order.
    deleteMock.mockResolvedValue({ ok: true, data: { outcome: "not_found" } });
    listMock.mockResolvedValueOnce({ ok: true, data: [ATLAS] });
    listMock.mockResolvedValue({ ok: true, data: [] });

    const { onProjectDeleted } = renderHost();
    await openDelete();
    await confirmDelete();

    await waitFor(() => {
      expect(useProjectDialogStore.getState().request).toBeNull();
    });
    expect(onProjectDeleted).not.toHaveBeenCalled();
    expect(notifications.getSnapshot().items).toHaveLength(0);
  });
});

describe("an outcome the user still has to act on", () => {
  const cleanup = { cleanup: [], trash: "not_requested" as const };

  it("keeps the cleanup retry reachable after the list drops the row", async () => {
    // The project IS tombstoned, so the invalidated list no longer carries it.
    // The retry is the only way its unfinished cleanup ever resumes.
    deleteMock.mockResolvedValue({
      ok: true,
      data: {
        outcome: "cleanup_pending",
        ...cleanup,
        trashRequested: false,
        attempts: 2,
      },
    });
    listMock.mockResolvedValueOnce({ ok: true, data: [ATLAS] });
    listMock.mockResolvedValue({ ok: true, data: [] });

    renderHost();
    await openDelete();
    await confirmDelete();

    await screen.findByText("Vex has attempted this cleanup 2 times.");
    // Let the invalidation's refetch land and the guard get its chance.
    await waitFor(() => {
      expect(listMock.mock.calls.length).toBeGreaterThan(1);
    });
    expect(useProjectDialogStore.getState().request).not.toBeNull();
    expect(
      document.querySelector('[data-vex-delete-outcome="cleanup_pending"]'),
    ).not.toBeNull();

    // And pressing it resumes the SAME cleanup, against the pinned row.
    fireEvent.click(confirmButton());
    await waitFor(() => {
      expect(deleteMock).toHaveBeenCalledTimes(2);
    });
    expect(deleteMock.mock.calls[1]?.[0]).toEqual({
      projectId: ATLAS.id,
      alsoTrashFolder: false,
      expectedName: "atlas",
    });
  });

  it("resumes a pending cleanup with the folder choice as first asked", async () => {
    // The whole chain, real: the user asks for the trash, the tombstone
    // records it, the list drops the row, the user changes their mind, and the
    // retry still carries what main will actually honour. Reverting the freeze
    // fails the last assertion with `alsoTrashFolder: false`.
    //
    // This dialog IS the attempt that created the tombstone, so main's echo of
    // that tombstone's intent is the same `true` this dialog sent.
    deleteMock.mockResolvedValue({
      ok: true,
      data: {
        outcome: "cleanup_pending",
        ...cleanup,
        trashRequested: true,
        attempts: 1,
      },
    });
    listMock.mockResolvedValueOnce({ ok: true, data: [ATLAS] });
    listMock.mockResolvedValue({ ok: true, data: [] });

    renderHost();
    await openDelete();
    fireEvent.click(trashCheckbox());
    await confirmDelete();

    await screen.findByText("Vex has attempted this cleanup once.");
    await waitFor(() => {
      expect(listMock.mock.calls.length).toBeGreaterThan(1);
    });
    expect(deleteMock.mock.calls[0]?.[0].alsoTrashFolder).toBe(true);

    // The row is gone from the list, the dialog stands on its pin, and the
    // folder choice is now main's to keep.
    expect(trashCheckbox().disabled).toBe(true);
    expect(screen.getByText(PROJECT_DELETE_TRASH_LOCKED_NOTE)).not.toBeNull();
    fireEvent.click(trashCheckbox());
    expect(trashCheckbox().checked).toBe(true);

    fireEvent.click(confirmButton());
    await waitFor(() => {
      expect(deleteMock).toHaveBeenCalledTimes(2);
    });
    expect(deleteMock.mock.calls[1]?.[0]).toEqual({
      projectId: ATLAS.id,
      alsoTrashFolder: true,
      expectedName: "atlas",
    });
  });

  it("keeps a failed trash on screen after the list drops the row", async () => {
    deleteMock.mockResolvedValue({
      ok: true,
      data: { outcome: "removed", cleanup: [], trash: "failed" },
    });
    listMock.mockResolvedValueOnce({ ok: true, data: [ATLAS] });
    listMock.mockResolvedValue({ ok: true, data: [] });

    const { onProjectDeleted } = renderHost();
    await openDelete();
    await confirmDelete();

    await screen.findByText(PROJECT_TRASH_SENTENCES.failed);
    await waitFor(() => {
      expect(listMock.mock.calls.length).toBeGreaterThan(1);
    });
    // The project IS gone, so the shell was told; the report stays because the
    // folder is still on disk.
    expect(onProjectDeleted).toHaveBeenCalledWith(ATLAS.id);
    expect(screen.getByText(PROJECT_TRASH_SENTENCES.failed)).not.toBeNull();
  });
});

describe("the settled-list guard", () => {
  it("still closes a delete whose project vanishes while the user types", async () => {
    // The ratified behaviour, unweakened: no outcome is being reported, so
    // nothing holds the request open and a row that goes takes the action with
    // it. The project disappears the way it really would - another window
    // deleted it and the list was invalidated - not through this dialog.
    const { client } = renderHost();
    await openDelete();
    fireEvent.change(screen.getByLabelText("Project name"), {
      target: { value: "atl" },
    });

    listMock.mockResolvedValue({ ok: true, data: [] });
    await client.invalidateQueries({ queryKey: projectKeys.list() });

    await waitFor(() => {
      expect(useProjectDialogStore.getState().request).toBeNull();
    });
    // Nothing was deleted by this: the row simply stopped existing.
    expect(deleteMock).not.toHaveBeenCalled();
  });
});
