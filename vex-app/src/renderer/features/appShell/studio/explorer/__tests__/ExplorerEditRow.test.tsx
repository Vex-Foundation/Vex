/**
 * THE NAME BOX as a component: focus, keys, and the blur decision.
 *
 * These are behaviours a model test cannot reach and that a user meets on every
 * single create and rename. The three that would go unnoticed:
 *
 *  - FOCUS AND PRESELECTION on mount. Without it a rename starts with an empty
 *    caret somewhere and the user has to select the stem by hand.
 *  - ESCAPE AND ENTER NOT REACHING THE TREE. The tree's own key table moves
 *    focus on arrows and activates on Enter; if the input let them through, a
 *    keystroke inside a name would move the row out from under it.
 *  - BLUR CANCELS. The departure from VS Code, which commits on blur. It is
 *    load-bearing: this surface has no undo, so a stray click must not write a
 *    half-typed name into a user's repository.
 */

// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach } from "vitest";
import { ExplorerEditRow } from "../ExplorerEditRow.js";

afterEach(cleanup);

function renderRow(
  overrides: Partial<Parameters<typeof ExplorerEditRow>[0]> = {},
): {
  readonly input: HTMLInputElement;
  readonly onCommit: ReturnType<typeof vi.fn>;
  readonly onCancel: ReturnType<typeof vi.fn>;
} {
  const onCommit = vi.fn();
  const onCancel = vi.fn();
  render(
    <ExplorerEditRow
      domId="explorer-p1-root::edit"
      intent="rename"
      level={0}
      posInSet={1}
      setSize={3}
      initialName="notes.md"
      message={null}
      submitting={false}
      validate={() => null}
      onCommit={onCommit}
      onCancel={onCancel}
      {...overrides}
    />,
  );
  return {
    input: screen.getByRole("textbox") as HTMLInputElement,
    onCommit,
    onCancel,
  };
}

describe("focus and preselection", () => {
  it("takes focus on mount and preselects the STEM of a renamed file", () => {
    const { input } = renderRow();

    expect(document.activeElement).toBe(input);
    // "notes" is selected and ".md" is not: renaming `notes.md` to `agenda.md`
    // is the common case and retyping the extension is not part of it.
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe("notes".length);
  });

  it("selects a dotfile WHOLE, because a leading dot is not an extension", () => {
    const { input } = renderRow({ initialName: ".gitignore" });
    expect(input.selectionEnd).toBe(".gitignore".length);
  });

  it("starts empty for a create", () => {
    const { input } = renderRow({ intent: "createFile", initialName: "" });
    expect(input.value).toBe("");
    expect(document.activeElement).toBe(input);
  });
});

describe("committing and cancelling", () => {
  it("Enter commits the typed name", () => {
    const { input, onCommit } = renderRow();
    fireEvent.change(input, { target: { value: "agenda.md" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledWith("agenda.md");
  });

  it("Enter does NOT commit a name the live rule refuses", () => {
    const { input, onCommit } = renderRow({
      validate: (name) => (name.includes("/") ? "A name cannot contain a slash." : null),
    });
    fireEvent.change(input, { target: { value: "a/b.txt" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("slash");
  });

  it("Escape cancels and writes nothing", () => {
    const { input, onCommit, onCancel } = renderRow();
    fireEvent.change(input, { target: { value: "half-typed" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(onCancel).toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("BLUR CANCELS rather than committing", () => {
    // The departure from VS Code, and the reason for it: there, a
    // commit-on-blur creates a file the workbench undo stack can take back.
    // Here nothing can, so a stray click must not write.
    const { input, onCommit, onCancel } = renderRow();
    fireEvent.change(input, { target: { value: "half-typed" } });
    fireEvent.blur(input);

    expect(onCancel).toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("does not commit twice while a commit is in flight", () => {
    const { input, onCommit } = renderRow({ submitting: true });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).not.toHaveBeenCalled();
    // The input stays MOUNTED and read-only, so the typed name is still on
    // screen if the commit is refused.
    expect(input.readOnly).toBe(true);
  });
});

describe("the tree does not see the box's keys", () => {
  it.each(["Enter", "Escape", "ArrowDown", "ArrowUp", "Delete", "F2"])(
    "stops %s from reaching the tree's key handler",
    (key) => {
      const onTreeKeyDown = vi.fn();
      const onCommit = vi.fn();
      render(
        <div onKeyDown={onTreeKeyDown}>
          <ExplorerEditRow
            domId="edit"
            intent="rename"
            level={0}
            posInSet={1}
            setSize={1}
            initialName="a.txt"
            message={null}
            submitting={false}
            validate={() => null}
            onCommit={onCommit}
            onCancel={vi.fn()}
          />
        </div>,
      );

      fireEvent.keyDown(screen.getByRole("textbox"), { key });

      // A tree that moved focus or deleted a row under a caret would take the
      // row out from under what is being typed.
      expect(onTreeKeyDown).not.toHaveBeenCalled();
    },
  );
});

describe("the refusal is the row's own state", () => {
  it("shows main's refusal, marks the input invalid and describes it", () => {
    const { input } = renderRow({ message: "Vex writes this file." });
    const alert = screen.getByRole("alert");

    expect(alert.textContent).toContain("Vex writes this file.");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    // The sentence is REACHABLE from the input, not merely next to it: a screen
    // reader on the box hears why the name was refused.
    expect(input.getAttribute("aria-describedby")).toBe(alert.id);
  });

  it("keeps its place in the tree's accessibility model", () => {
    renderRow({ posInSet: 2, setSize: 4, level: 1 });
    const row = screen.getByRole("treeitem");
    expect(row.getAttribute("aria-level")).toBe("2");
    expect(row.getAttribute("aria-posinset")).toBe("2");
    expect(row.getAttribute("aria-setsize")).toBe("4");
  });

  it("names the two keys, because the input replaced the row it names", () => {
    const { input } = renderRow();
    const label = input.getAttribute("aria-label") ?? "";
    expect(label).toContain("Enter");
    expect(label).toContain("Escape");
  });
});
