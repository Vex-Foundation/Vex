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
  const onSplit = vi.fn();
  const onKill = vi.fn();
  const onRename = vi.fn();
  const view = render(
    <TerminalPanelHeader
      title="Terminal 1"
      displayCwd="src/lib"
      shellLabel="bash"
      shellId="bash"
      shells={SHELLS}
      onSelectShell={onSelectShell}
      onSplit={onSplit}
      onKill={onKill}
      onRename={onRename}
      {...overrides}
    />,
  );
  return { view, onSelectShell, onSplit, onKill, onRename };
}

describe("what the header shows", () => {
  it("shows the panel title and the directory LABEL", () => {
    renderHeader();
    expect(screen.getByRole("heading", { name: "Terminal 1" })).toBeTruthy();
    expect(screen.getByLabelText("Working directory: src/lib")).toBeTruthy();
  });

  it("names the TAB, in sentence case, and puts the shell on the second line", () => {
    // The heading used to be the shell's own path with `text-transform:
    // uppercase` over it, so a terminal introduced itself as `/BIN/BASH`. The
    // name is the tab's now; the shell is a fact beside the directory.
    renderHeader();
    const name = screen.getByRole("heading", { name: "Terminal 1" });
    expect(name.className).not.toContain("uppercase");
    expect(name.textContent).toBe("Terminal 1");
    expect(document.querySelector("[data-vex-terminal-shell]")?.textContent).toBe("bash");
  });

  /**
   * N4: the same shell, spelled one way.
   *
   * The host polls node-pty's `process`, which reports the shell as the path it
   * was launched from, so the line read `bash` from the create reply and then
   * `/bin/bash` a fifth of a second later - and `/bin/bash` for every restored
   * terminal. VS Code titles a terminal with the process name; so does this.
   */
  it("shows the PROCESS NAME when the host reports a path", () => {
    renderHeader({ shellLabel: "/bin/bash" });
    expect(document.querySelector("[data-vex-terminal-shell]")?.textContent).toBe("bash");
  });

  it("leaves a foreground process that is already a name alone", () => {
    // The poll is the FOREGROUND process, so this line says `vim` while vim
    // runs. Reducing a path must not reduce that to something else.
    renderHeader({ shellLabel: "vim" });
    expect(document.querySelector("[data-vex-terminal-shell]")?.textContent).toBe("vim");
  });

  it("shows a Windows launch path as its executable", () => {
    renderHeader({ shellLabel: "C:\\Windows\\System32\\cmd.exe" });
    expect(document.querySelector("[data-vex-terminal-shell]")?.textContent).toBe(
      "cmd.exe",
    );
  });

  it("names the unreported shell rather than leaving the line blank", () => {
    renderHeader({ shellLabel: null });
    expect(document.querySelector("[data-vex-terminal-shell]")?.textContent).toBe(
      "Shell not reported yet",
    );
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
    expect(screen.getByRole("button", { name: "Shell for the next terminal" }).textContent)
      .toContain("zsh");
  });
});

describe("the shell picker is operable without a pointer", () => {
  it("opens, and reports its expanded state to assistive technology", () => {
    renderHeader();
    const button = screen.getByRole("button", { name: "Shell for the next terminal" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("listbox", { name: "Shell for the next terminal" })).toBeTruthy();
  });

  it("opens with the CURRENT shell focused, not the first row", () => {
    renderHeader({ shellId: "zsh" });
    fireEvent.click(screen.getByRole("button", { name: "Shell for the next terminal" }));
    expect(document.activeElement?.getAttribute("aria-label")).toBe("zsh");
  });

  it("moves with ArrowDown, ArrowUp, Home and End", () => {
    renderHeader({ shellId: "system_default" });
    const button = screen.getByRole("button", { name: "Shell for the next terminal" });
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
    fireEvent.click(screen.getByRole("button", { name: "Shell for the next terminal" }));
    const list = screen.getByRole("listbox");
    fireEvent.keyDown(list, { key: "ArrowDown" });
    fireEvent.keyDown(list, { key: "Enter" });
    expect(onSelectShell).toHaveBeenCalledWith("bash");
  });

  it("RESTORES focus to the button on Escape, so Tab does not restart at the top", () => {
    renderHeader();
    const button = screen.getByRole("button", { name: "Shell for the next terminal" });
    fireEvent.click(button);
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("marks the selected row, so a screen reader can say which one is current", () => {
    renderHeader({ shellId: "zsh" });
    fireEvent.click(screen.getByRole("button", { name: "Shell for the next terminal" }));
    const selected = screen
      .getAllByRole("option")
      .filter((option) => option.getAttribute("aria-selected") === "true");
    expect(selected.map((option) => option.getAttribute("aria-label"))).toEqual(["zsh"]);
  });
});

describe("a shell this machine does not have", () => {
  it("is LISTED and reachable by keyboard, so the user learns it exists", () => {
    renderHeader();
    fireEvent.click(screen.getByRole("button", { name: "Shell for the next terminal" }));
    const fish = screen.getByRole("option", { name: "fish (not installed)" });
    expect(fish.getAttribute("aria-disabled")).toBe("true");
    // `aria-disabled` rather than `disabled`: still in the keyboard order.
    expect(fish.getAttribute("tabindex")).not.toBeNull();
  });

  it("cannot be chosen, and choosing it does not close the list", () => {
    const { onSelectShell } = renderHeader();
    fireEvent.click(screen.getByRole("button", { name: "Shell for the next terminal" }));
    fireEvent.click(screen.getByRole("option", { name: "fish (not installed)" }));
    expect(onSelectShell).not.toHaveBeenCalled();
    // Closing would read as "it worked" for an action that did nothing.
    expect(screen.getByRole("listbox")).toBeTruthy();
  });
});

/**
 * The header does NOT duplicate the tab strip's `+`.
 *
 * A regression guard for a decision, not for a bug. The owner settled that the
 * mockup's header `+` means "new terminal as a tab" (2026-09-02), which is
 * exactly what the strip's `+` already does a few pixels above - so rendering
 * it would put two controls with the accessible name "New terminal" on one
 * screen, which the audit files as its own defect. Everything the cluster DOES
 * carry acts on this one terminal and says so in its name.
 */
describe("the header's action cluster", () => {
  it("never adds a second control named New terminal", () => {
    renderHeader();
    expect(screen.queryByRole("button", { name: "New terminal" })).toBeNull();
  });

  it("names every action for the terminal it acts on, and reaches it by keyboard", () => {
    const { onSplit, onKill } = renderHeader();

    screen.getByRole("button", { name: "Split Terminal 1 side by side" }).click();
    expect(onSplit).toHaveBeenLastCalledWith("horizontal");
    screen.getByRole("button", { name: "Split Terminal 1 top and bottom" }).click();
    expect(onSplit).toHaveBeenLastCalledWith("vertical");
    screen.getByRole("button", { name: "Kill the shell in Terminal 1" }).click();
    expect(onKill).toHaveBeenCalledTimes(1);

    for (const button of screen.getAllByRole("button")) {
      expect(button.tabIndex).not.toBe(-1);
      expect(button.getAttribute("type")).toBe("button");
    }
  });

  it("KILL and CLOSE keep different names, because they are different actions", () => {
    // On a split tab, kill ends the one shell this header describes while the
    // strip's close ends the whole tab. Two controls with one name would be
    // indistinguishable to anyone navigating by name.
    renderHeader();
    expect(screen.queryByRole("button", { name: /^Close / })).toBeNull();
    expect(screen.getByRole("button", { name: "Kill the shell in Terminal 1" })).toBeTruthy();
  });
});

describe("renaming from the header", () => {
  it("opens a named field on the title, commits on Enter and restores focus", () => {
    const { onRename } = renderHeader();
    const button = screen.getByRole("button", { name: "Rename Terminal 1" });
    fireEvent.click(button);

    const field = screen.getByRole("textbox", { name: "Terminal name" });
    expect(document.activeElement).toBe(field);
    fireEvent.change(field, { target: { value: "build watch" } });
    fireEvent.keyDown(field, { key: "Enter" });

    expect(onRename).toHaveBeenCalledWith("build watch");
    expect(screen.queryByRole("textbox", { name: "Terminal name" })).toBeNull();
  });

  it("CANCELS on Escape without renaming anything", () => {
    const { onRename } = renderHeader();
    fireEvent.click(screen.getByRole("button", { name: "Rename Terminal 1" }));
    const field = screen.getByRole("textbox", { name: "Terminal name" });
    fireEvent.change(field, { target: { value: "discarded" } });
    fireEvent.keyDown(field, { key: "Escape" });

    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Terminal 1" })).toBeTruthy();
  });

  it("refuses to blank a tab's name", () => {
    const { onRename } = renderHeader();
    fireEvent.click(screen.getByRole("button", { name: "Rename Terminal 1" }));
    const field = screen.getByRole("textbox", { name: "Terminal name" });
    fireEvent.change(field, { target: { value: "   " } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onRename).not.toHaveBeenCalled();
  });
});

/**
 * THE POPUP PAINTS A SURFACE.
 *
 * The light theme shipped a picker in which the AVAILABLE shells were the
 * unreadable ones. The cause was not a colour choice: the popup asked for
 * `bg-surface-raised`, there is no `--color-surface-raised` in the theme, so
 * Tailwind emitted nothing and the rows sat directly on the terminal's canvas.
 * A class name cannot be contrast-tested, but its ABSENCE can be pinned, and
 * this is the assertion that would have caught it.
 */
describe("the picker's popup has a surface under it", () => {
  it("uses a surface utility the theme actually defines", () => {
    renderHeader();
    fireEvent.click(screen.getByRole("button", { name: "Shell for the next terminal" }));
    const list = screen.getByRole("listbox");
    expect(list.className).not.toContain("surface-raised");
    expect(list.className).toContain("bg-surface-2");
  });

  it("marks the current row with a glyph, not by fill alone", () => {
    renderHeader({ shellId: "zsh" });
    fireEvent.click(screen.getByRole("button", { name: "Shell for the next terminal" }));
    const selected = screen.getByRole("option", { name: "zsh" });
    expect(selected.querySelector("svg")).not.toBeNull();
    expect(screen.getByRole("option", { name: "bash" }).querySelector("svg")).toBeNull();
  });
});
