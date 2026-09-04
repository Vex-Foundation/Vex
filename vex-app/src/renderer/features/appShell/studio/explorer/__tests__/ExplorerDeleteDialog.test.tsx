/**
 * THE DELETE CONFIRMATION: the consent grammar, the register, and the second
 * decision.
 *
 * What is asserted here is what the USER is shown before an irreversible act,
 * which is the part of this surface that must not regress quietly:
 *
 *  - all three lines of the grammar are present and change with the
 *    disposition, so the sentence the user agreed to is the one that happened;
 *  - the safer choice takes focus;
 *  - a trash that refused does NOT become a permanent delete, and the entry is
 *    reported as still present.
 */

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { FileNode } from "@shared/schemas/files.js";
import { ExplorerDeleteDialog } from "../ExplorerDeleteDialog.js";

afterEach(cleanup);

const FILE: FileNode = {
  nodeId: "f1.node.sig",
  name: "notes.md",
  path: "docs/notes.md",
  kind: "file",
  size: 12,
  modifiedMs: 1,
};

const FOLDER: FileNode = { ...FILE, name: "docs", path: "docs", kind: "directory", size: null };

function open(
  overrides: {
    node?: FileNode;
    mode?: "trash" | "permanent";
    onConfirm?: Parameters<typeof ExplorerDeleteDialog>[0]["onConfirm"];
  } = {},
): { readonly onClose: ReturnType<typeof vi.fn> } {
  const onClose = vi.fn();
  render(
    <ExplorerDeleteDialog
      request={{ node: overrides.node ?? FILE, mode: overrides.mode ?? "trash" }}
      onClose={onClose}
      onConfirm={overrides.onConfirm ?? vi.fn().mockResolvedValue({ ok: true })}
    />,
  );
  return { onClose };
}

/** The consent strip's text, as one string. */
function consentText(): string {
  return document.querySelector('[data-vex-consent="delete-file"]')?.textContent ?? "";
}

describe("the consent grammar", () => {
  it("states WHAT, WHERE it goes, and that it can be undone", () => {
    open();
    const text = consentText();

    expect(text).toContain('Delete "notes.md"');
    // The path, so a user with two `notes.md` open knows which one this is.
    expect(text).toContain("docs/notes.md");
    expect(text).toContain("trash");
    expect(text).toContain("restore it from the trash");
  });

  it("says a FOLDER takes its contents with it", () => {
    // The whole difference between deleting a file and deleting a folder, and
    // the half a user skimming the title would otherwise miss.
    open({ node: FOLDER });
    expect(consentText()).toContain("everything inside it");
  });

  it("says PERMANENT deletion cannot be undone, and takes the warning register", () => {
    open({ mode: "permanent" });

    expect(consentText()).toContain("removed from disk immediately");
    expect(consentText()).toContain("cannot be undone");
    expect(
      document.querySelector('[data-vex-explorer-delete-mode="permanent"]'),
    ).not.toBeNull();
  });

  it("names the disposition on the button rather than saying OK", () => {
    open();
    expect(screen.getByRole("button", { name: "Move to trash" })).toBeTruthy();
    cleanup();
    open({ mode: "permanent" });
    expect(screen.getByRole("button", { name: "Delete permanently" })).toBeTruthy();
  });
});

describe("focus and consent", () => {
  it("gives the SAFER choice the initial focus", async () => {
    open();
    // Rule 08: a dangerous action defaults to the safer choice. The dialog
    // primitive moves focus after `showModal()`.
    await waitFor(() => {
      expect(document.activeElement?.textContent).toBe("Cancel");
    });
  });

  it("deletes NOTHING until the confirm is pressed", () => {
    const onConfirm = vi.fn().mockResolvedValue({ ok: true });
    open({ onConfirm });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("sends the disposition the request carried, never a different one", async () => {
    const onConfirm = vi.fn().mockResolvedValue({ ok: true });
    const { onClose } = open({ mode: "permanent", onConfirm });

    fireEvent.click(screen.getByRole("button", { name: "Delete permanently" }));

    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledWith(FILE, "permanent");
    });
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });
});

describe("a trash that refused", () => {
  it("OFFERS permanent deletion as a second decision instead of taking it", async () => {
    const onConfirm = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        code: "trash_unavailable",
        message: "no trash",
      })
      .mockResolvedValue({ ok: true });
    const { onClose } = open({ onConfirm });

    fireEvent.click(screen.getByRole("button", { name: "Move to trash" }));

    // ONE call, and the dialog is still open: the entry is untouched and the
    // user has to agree to the harsher disposition themselves.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Delete permanently" })).toBeTruthy();
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    // And the register has changed with it: the undo line is now the
    // irreversible one.
    expect(consentText()).toContain("cannot be undone");

    fireEvent.click(screen.getByRole("button", { name: "Delete permanently" }));
    await waitFor(() => {
      expect(onConfirm).toHaveBeenLastCalledWith(FILE, "permanent");
    });
  });

  it("keeps the dialog open and shows the reason for any other refusal", async () => {
    const onConfirm = vi.fn().mockResolvedValue({
      ok: false,
      code: "vex_managed",
      message: "Vex writes this file, so it cannot be deleted here.",
    });
    const { onClose } = open({ onConfirm });

    fireEvent.click(screen.getByRole("button", { name: "Move to trash" }));

    await waitFor(() => {
      expect(document.body.textContent).toContain("Vex writes this file");
    });
    expect(onClose).not.toHaveBeenCalled();
    // The disposition did NOT change: only a trash refusal raises it.
    expect(screen.getByRole("button", { name: "Move to trash" })).toBeTruthy();
  });
});
