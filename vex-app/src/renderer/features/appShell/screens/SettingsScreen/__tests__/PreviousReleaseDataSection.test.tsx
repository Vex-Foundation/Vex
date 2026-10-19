/**
 * Settings → Local runtime: removing the previous release's data.
 *
 * Pins:
 *   - nothing is shown while main says no old data may exist;
 *   - after a completed move the copy says the data was imported, the typed
 *     phrase gates the confirm, and `allowWithoutImport` is false;
 *   - after a start-fresh the copy says it is the only copy, never imported,
 *     and only then is `allowWithoutImport` true;
 *   - every refusal and failure is said in words, and the dialog stays;
 *   - a removal closes the dialog and replaces the row with "removed".
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Result } from "@shared/ipc/result.js";
import type { RuntimeMigrationRemoveOldDataResult } from "@shared/schemas/runtime-migration.js";
import type { PreviousReleaseData } from "@shared/schemas/system.js";
import { removeOldDataProblem } from "../../../../runtime/migration/copy.js";
import { PreviousReleaseDataSection } from "../PreviousReleaseDataSection.js";

const remove = vi.fn<(input: { allowWithoutImport: boolean }) => Promise<Result<RuntimeMigrationRemoveOldDataResult>>>();

function renderSection(data: PreviousReleaseData): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <PreviousReleaseDataSection data={data} />
    </QueryClientProvider>,
  );
}

async function confirmWith(phrase: string): Promise<HTMLButtonElement> {
  fireEvent.click(screen.getByRole("button", { name: "Remove old Docker data…" }));
  await screen.findByRole("dialog", { name: "Remove old Docker data?" });
  fireEvent.change(screen.getByLabelText("Confirmation"), { target: { value: phrase } });
  return screen.getByRole("button", { name: "Remove old data" }) as HTMLButtonElement;
}

beforeEach(() => {
  remove.mockReset();
  remove.mockResolvedValue({ ok: true, data: { kind: "removed", message: "Removed." } });
  Object.defineProperty(window, "vex", {
    configurable: true,
    value: { system: { runtimeMigrationRemoveOldData: remove } },
  });
});

afterEach(() => {
  cleanup();
});

describe("PreviousReleaseDataSection", () => {
  it("shows nothing while no old data may exist", () => {
    renderSection({ kind: "none" });
    expect(document.querySelector("[data-vex-previous-release-data]")).toBeNull();
  });

  it("after a move, removes behind the typed phrase without allowing an unimported removal", async () => {
    renderSection({ kind: "kept", imported: true });
    expect(screen.getByText(/Your data was moved into the database on this computer/)).not.toBeNull();
    const confirm = await confirmWith("remove");
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Confirmation"), { target: { value: "REMOVE" } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(remove).toHaveBeenCalledWith({ allowWithoutImport: false }));
    await screen.findByText("The old Docker data was removed.");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Remove old Docker data?" })).toBeNull());
    expect(screen.queryByRole("button", { name: "Remove old Docker data…" })).toBeNull();
  });

  it("after a start-fresh, says it deletes the only copy and only then allows an unimported removal", async () => {
    renderSection({ kind: "kept", imported: false });
    expect(screen.getByText(/never imported\. That data is still in Docker, and it is the only copy/)).not.toBeNull();
    const confirm = await confirmWith("REMOVE");
    const dialog = screen.getByRole("dialog", { name: "Remove old Docker data?" });
    expect(dialog.textContent).toContain("Deletes the only copy of your data from before this version");
    fireEvent.click(confirm);
    await waitFor(() => expect(remove).toHaveBeenCalledWith({ allowWithoutImport: true }));
  });

  it.each<[string, RuntimeMigrationRemoveOldDataResult]>([
    ["not completed", { kind: "refused", reason: "not_completed", message: "x" }],
    ["not imported", { kind: "refused", reason: "not_imported", message: "x" }],
    ["another install", { kind: "refused", reason: "install_changed", message: "x" }],
    ["busy", { kind: "refused", reason: "busy", message: "x" }],
    ["the old stack offline", { kind: "failed", reason: "source_offline", message: "x" }],
    ["a failure", { kind: "failed", reason: "failed", message: "volume in use" }],
  ])("says what %s means and keeps the dialog", async (_label, outcome) => {
    remove.mockResolvedValue({ ok: true, data: outcome });
    renderSection({ kind: "kept", imported: true });
    fireEvent.click(await confirmWith("REMOVE"));
    if (outcome.kind === "removed") throw new Error("unreachable");
    await screen.findByText(removeOldDataProblem(outcome));
    expect(screen.getByRole("dialog", { name: "Remove old Docker data?" })).not.toBeNull();
    expect(screen.queryByText("The old Docker data was removed.")).toBeNull();
  });
});

describe("removeOldDataProblem", () => {
  it("has its own words for every refusal and failure", () => {
    const lines = [
      removeOldDataProblem({ kind: "refused", reason: "not_completed" }),
      removeOldDataProblem({ kind: "refused", reason: "not_imported" }),
      removeOldDataProblem({ kind: "refused", reason: "install_changed" }),
      removeOldDataProblem({ kind: "refused", reason: "busy" }),
      removeOldDataProblem({ kind: "failed", reason: "source_offline", message: "x" }),
      removeOldDataProblem({ kind: "failed", reason: "failed", message: "volume in use" }),
    ];
    expect(new Set(lines).size).toBe(lines.length);
    expect(lines.at(-1)).toBe("Nothing was removed: volume in use");
  });
});
