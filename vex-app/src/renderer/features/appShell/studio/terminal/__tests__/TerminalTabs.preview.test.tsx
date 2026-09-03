/**
 * THE PREVIEW TAB, as the strip actually renders and answers it.
 *
 * Separate from `TerminalTabs.test.tsx` (which owns keep-alive, activation and
 * the strip's keyboard reachability) because this is a different contract with
 * its own risk: a state that exists only as ITALICS is a state a screen-reader
 * user cannot perceive, and a promotion gesture that fires on the wrong tab
 * silently keeps a file the user was browsing past.
 *
 * The gestures are VS Code's, read out of the checkout before this was written
 * (`browser/parts/editor/multiEditorTabsControl.ts`): italics for preview at
 * :1730, double click promotes at :1126-1150, middle click closes at :1051-1066.
 *
 * RED ON REVERT: drop the `sr-only` preview word and "names its state in words"
 * fails while the italics still pass; drop the button check in `onAuxClick` and
 * "a RIGHT click never closes a tab" fails.
 */

import type { JSX } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalTabs } from "../TerminalTabs.js";
import type { WorkspaceFileTab, WorkspaceState } from "../../workspace/types.js";
import {
  installMatchMedia,
  installResizeObserver,
  installTerminalBridge,
} from "./terminal-harness.js";

beforeEach(() => {
  installMatchMedia();
  installResizeObserver();
  installTerminalBridge();
  document.body.innerHTML = "";
});

const noop = (): void => undefined;

/**
 * A real `auxclick`, which is what a middle click IS.
 *
 * Testing Library has no helper for it, and `fireEvent.click` with `button: 1`
 * is a different event that React's `onAuxClick` never sees - so a test written
 * that way would pass against a component with no middle-click handling at all.
 */
function auxClick(element: HTMLElement, button: number): void {
  fireEvent(element, new MouseEvent("auxclick", { bubbles: true, cancelable: true, button }));
}

const SHELLS = [{ id: "system_default", label: "Default shell", available: true }] as const;

function fileTab(tabId: string, title: string, preview: boolean): WorkspaceFileTab {
  return {
    kind: "file",
    tabId,
    title,
    relativePath: `src/${title}`,
    nodeId: `node:${title}`,
    dirty: false,
    preview,
  };
}

/** A kept file and a previewed one, so every assertion has a control beside it. */
function twoFiles(activeTabId = "kept"): WorkspaceState {
  return {
    projectId: "p1",
    activeTabId,
    tabs: [fileTab("kept", "kept.ts", false), fileTab("preview", "browsed.ts", true)],
  };
}

function renderFileTabStub(tab: WorkspaceFileTab): JSX.Element {
  return <div data-testid={`file-panel-${tab.tabId}`}>{tab.relativePath}</div>;
}

function renderTabs(state: WorkspaceState, overrides: Record<string, unknown> = {}) {
  return render(
    <TerminalTabs
      state={state}
      onSelectTab={noop}
      onCloseTab={noop}
      onNewTerminal={noop}
      onSplit={noop}
      onResizePanes={noop}
      onActivatePane={noop}
      onClosePane={noop}
      onRenameTab={noop}
      onShellTitle={noop}
      onDisplayCwdChange={noop}
      onPaneExit={noop}
      shellId="system_default"
      shells={SHELLS}
      onSelectShell={noop}
      renderFileTab={renderFileTabStub}
      {...overrides}
    />,
  );
}

describe("how a preview tab reads", () => {
  it("names its state IN WORDS, not only in italics", () => {
    renderTabs(twoFiles(), { onPinTab: noop });

    // The accessible name carries the state, which is the half italics cannot
    // deliver. It comes AFTER the title, as the terminal state word does.
    expect(screen.getByRole("tab", { name: /browsed\.ts\s*Preview/ })).toBeTruthy();
    // And the kept tab is NOT described as one, so the word means something.
    expect(screen.getByRole("tab", { name: /^kept\.ts$/ })).toBeTruthy();
  });

  it("italicises only the preview tab's title", () => {
    renderTabs(twoFiles(), { onPinTab: noop });

    const previewTitle = screen.getByText("browsed.ts");
    const keptTitle = screen.getByText("kept.ts");
    expect(previewTitle.className).toContain("italic");
    expect(keptTitle.className).not.toContain("italic");
  });
});

describe("promotion", () => {
  it("offers Keep open only on the preview tab, and only when an owner answers", () => {
    const onPinTab = vi.fn();
    const { unmount } = renderTabs(twoFiles(), { onPinTab });

    expect(screen.getByRole("button", { name: "Keep browsed.ts open" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Keep kept.ts open" })).toBeNull();
    unmount();

    // With no `onPinTab` the strip draws NO promotion affordance rather than a
    // control that does nothing when pressed.
    document.body.innerHTML = "";
    renderTabs(twoFiles());
    expect(screen.queryByRole("button", { name: /^Keep/ })).toBeNull();
  });

  it("keeps the tab open from the button and from a double click, naming the right tab", () => {
    const onPinTab = vi.fn();
    renderTabs(twoFiles(), { onPinTab });

    fireEvent.click(screen.getByRole("button", { name: "Keep browsed.ts open" }));
    expect(onPinTab).toHaveBeenCalledWith("preview");

    onPinTab.mockClear();
    fireEvent.doubleClick(screen.getByRole("tab", { name: /browsed\.ts\s*Preview/ }));
    expect(onPinTab).toHaveBeenCalledWith("preview");

    // A double click on a KEPT file tab promotes nothing: there is nothing to
    // promote, and a call here would mean the gesture reads the wrong tab.
    onPinTab.mockClear();
    fireEvent.doubleClick(screen.getByRole("tab", { name: /^kept\.ts$/ }));
    expect(onPinTab).not.toHaveBeenCalled();
  });

  it("reaches Keep open by KEYBOARD and shows the focus it is on", () => {
    const onPinTab = vi.fn();
    renderTabs(twoFiles(), { onPinTab });

    const keep = screen.getByRole("button", { name: "Keep browsed.ts open" });
    // Hover-revealed is not keyboard-hidden: the control stays in the layout
    // and in the tab order, and paints on its own focus ring.
    expect(keep.className).toContain("focus-visible:opacity-100");
    keep.focus();
    expect(document.activeElement).toBe(keep);

    fireEvent.keyDown(keep, { key: "Enter" });
    fireEvent.click(keep);
    expect(onPinTab).toHaveBeenCalledWith("preview");
  });
});

describe("middle click", () => {
  it("closes the tab it was pressed on", () => {
    const onCloseTab = vi.fn();
    renderTabs(twoFiles(), { onCloseTab });

    auxClick(screen.getByRole("tab", { name: /browsed\.ts\s*Preview/ }), 1);

    expect(onCloseTab).toHaveBeenCalledWith("preview");
  });

  it("a RIGHT click never closes a tab", () => {
    const onCloseTab = vi.fn();
    renderTabs(twoFiles(), { onCloseTab });

    // `auxclick` fires for button 2 as well, so the button check is the whole
    // guard between a context menu and a destroyed tab.
    auxClick(screen.getByRole("tab", { name: /browsed\.ts\s*Preview/ }), 2);

    expect(onCloseTab).not.toHaveBeenCalled();
  });
});
