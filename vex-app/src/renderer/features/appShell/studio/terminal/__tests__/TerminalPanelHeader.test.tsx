/**
 * The panel header: what it says, and whether a keyboard can operate it.
 *
 * Two properties carry this suite.
 *
 * The FIRST is a negative one and it is the reason the whole `displayCwd`
 * change exists: the header must be incapable of showing a filesystem path. It
 * is asserted by driving the component with the labels the wire can actually
 * carry and checking that no absolute path or home directory appears in the
 * rendered DOM. It cannot be asserted by passing a path in - the type does not
 * allow one and the wire does not carry one - so what is proven here is that
 * the header renders the LABEL and adds nothing of its own.
 *
 * The SECOND is that the shell picker is operable without a pointer, which
 * rule 08 makes product behavior rather than polish. VS Code's terminal tab
 * list (`terminalTabsList.ts`) is the reference for deriving an option's
 * accessible name from the same identity the row renders from, which is why
 * "not installed" is asserted on the accessible NAME and not on the text node.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TerminalShellOption } from "@shared/schemas/terminal.js";
import { TerminalPanelHeader } from "../TerminalPanelHeader.js";

const SHELLS: readonly TerminalShellOption[] = [
  { id: "system_default", label: "Default shell", available: true },
  { id: "bash", label: "bash", available: true },
  { id: "zsh", label: "zsh", available: true },
  { id: "fish", label: "fish", available: false },
];

function renderHeader(
  overrides: Partial<React.ComponentProps<typeof TerminalPanelHeader>> = {},
) {
  const onSelectShell = vi.fn();
  const view = render(
    <TerminalPanelHeader
      title="bash"
      displayCwd="src/lib"
      shellId="bash"
      shells={SHELLS}
      onSelectShell={onSelectShell}
      {...overrides}
    />,
  );
  return { view, onSelectShell };
}

describe("what the header shows", () => {
  it("shows the panel title and the directory LABEL", () => {
    renderHeader();
    expect(screen.getByRole("heading", { name: "bash" })).toBeTruthy();
    expect(screen.getByLabelText("Working directory: src/lib")).toBeTruthy();
  });

  it("shows the project's own label when the shell sits at the project root", () => {
    renderHeader({ displayCwd: "vex-core" });
    expect(screen.getByLabelText("Working directory: vex-core")).toBeTruthy();
  });

  it("names the not-yet-known state rather than rendering an empty control", () => {
    renderHeader({ displayCwd: null });
    expect(screen.getByLabelText("Working directory not known yet")).toBeTruthy();
  });

  it("NEVER renders an absolute path or a home directory, for any label the wire can carry", () => {
    for (const label of ["src/lib", "vex-core", "outside project", "location unknown"]) {
      const { view } = renderHeader({ displayCwd: label });
      const html = document.body.innerHTML;
      expect(html).not.toContain("/home/");
      expect(html).not.toContain("/Users/");
      expect(html).not.toContain("C:\\");
      // The label itself is shown verbatim; the header adds no path of its own.
      expect(screen.getByLabelText(`Working directory: ${label}`)).toBeTruthy();
      view.unmount();
    }
  });

  it("shows the SELECTED shell on the picker button", () => {
    renderHeader({ shellId: "zsh" });
    expect(screen.getByRole("button", { name: "Shell for new terminals" }).textContent)
      .toContain("zsh");
  });
});

describe("the shell picker is operable without a pointer", () => {
  it("opens, and reports its expanded state to assistive technology", () => {
    renderHeader();
    const button = screen.getByRole("button", { name: "Shell for new terminals" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("listbox", { name: "Shell for new terminals" })).toBeTruthy();
  });

  it("opens with the CURRENT shell focused, not the first row", () => {
    renderHeader({ shellId: "zsh" });
    fireEvent.click(screen.getByRole("button", { name: "Shell for new terminals" }));
    expect(document.activeElement?.getAttribute("aria-label")).toBe("zsh");
  });

  it("moves with ArrowDown, ArrowUp, Home and End", () => {
    renderHeader({ shellId: "system_default" });
    const button = screen.getByRole("button", { name: "Shell for new terminals" });
    fireEvent.click(button);
    const list = screen.getByRole("listbox");

    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(document.activeElement?.getAttribute("aria-label")).toBe("bash");
    fireEvent.keyDown(list, { key: "End" });
    expect(document.activeElement?.getAttribute("aria-label")).toBe("fish (not installed)");
    // WRAPS, so a user holding ArrowDown is never stuck at the end.
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Default shell");
    fireEvent.keyDown(list, { key: "ArrowUp" });
    expect(document.activeElement?.getAttribute("aria-label")).toBe("fish (not installed)");
    fireEvent.keyDown(list, { key: "Home" });
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Default shell");
  });

  it("chooses with Enter and reports the ID, never a path or a label", () => {
    const { onSelectShell } = renderHeader({ shellId: "system_default" });
    fireEvent.click(screen.getByRole("button", { name: "Shell for new terminals" }));
    const list = screen.getByRole("listbox");
    fireEvent.keyDown(list, { key: "ArrowDown" });
    fireEvent.keyDown(list, { key: "Enter" });
    expect(onSelectShell).toHaveBeenCalledWith("bash");
  });

  it("RESTORES focus to the button on Escape, so Tab does not restart at the top", () => {
    renderHeader();
    const button = screen.getByRole("button", { name: "Shell for new terminals" });
    fireEvent.click(button);
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("marks the selected row, so a screen reader can say which one is current", () => {
    renderHeader({ shellId: "zsh" });
    fireEvent.click(screen.getByRole("button", { name: "Shell for new terminals" }));
    const selected = screen
      .getAllByRole("option")
      .filter((option) => option.getAttribute("aria-selected") === "true");
    expect(selected.map((option) => option.getAttribute("aria-label"))).toEqual(["zsh"]);
  });
});

describe("a shell this machine does not have", () => {
  it("is LISTED and reachable by keyboard, so the user learns it exists", () => {
    renderHeader();
    fireEvent.click(screen.getByRole("button", { name: "Shell for new terminals" }));
    const fish = screen.getByRole("option", { name: "fish (not installed)" });
    expect(fish.getAttribute("aria-disabled")).toBe("true");
    // `aria-disabled` rather than `disabled`: still in the keyboard order.
    expect(fish.getAttribute("tabindex")).not.toBeNull();
  });

  it("cannot be chosen, and choosing it does not close the list", () => {
    const { onSelectShell } = renderHeader();
    fireEvent.click(screen.getByRole("button", { name: "Shell for new terminals" }));
    fireEvent.click(screen.getByRole("option", { name: "fish (not installed)" }));
    expect(onSelectShell).not.toHaveBeenCalled();
    // Closing would read as "it worked" for an action that did nothing.
    expect(screen.getByRole("listbox")).toBeTruthy();
  });
});

/**
 * The header does NOT duplicate the tab strip's `+`.
 *
 * A regression guard for a decision, not for a bug: the mockup draws a `+`
 * here, and re-adding one that opens a terminal would put two controls with
 * the accessible name "New terminal" on the same screen, which the copy module
 * has already ruled out once. If a future change adds a header action, this
 * test forces it to be a DIFFERENT action with its own honest name.
 */
describe("the header does not duplicate the strip's action", () => {
  it("offers exactly one control, the shell picker", () => {
    renderHeader();
    expect(screen.queryByRole("button", { name: "New terminal" })).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });
});
