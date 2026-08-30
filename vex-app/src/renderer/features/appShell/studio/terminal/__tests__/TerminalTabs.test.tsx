/**
 * TerminalTabs: keep-alive, activation, and keyboard reachability.
 *
 * The defect this suite is built around is the one a tab strip makes very easy
 * to ship: unmounting the inactive panel. It looks correct - React's default,
 * less DOM, nothing on screen - and it silently destroys the scrollback the user
 * was reading, then hides the damage behind a replay that makes the terminal
 * flicker and scroll. So the first two cases assert the DOM survives a switch and
 * the terminal instance is the same one afterwards.
 *
 * The second half is the consequence of that choice: a hidden panel is
 * `display: none` and therefore measures 0x0, so activation MUST re-measure.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalRegistry } from "../terminal-registry.js";
import { TerminalTabs } from "../TerminalTabs.js";
import type { WorkspaceState } from "../../workspace/types.js";
import {
  installMatchMedia,
  installResizeObserver,
  installTerminalBridge,
} from "./terminal-harness.js";

const noWebgl = { webglLoader: () => Promise.reject(new Error("no gl in jsdom")) };

let registry: TerminalRegistry;

beforeEach(() => {
  installMatchMedia();
  installResizeObserver();
  installTerminalBridge();
  registry = new TerminalRegistry(noWebgl);
  document.body.innerHTML = "";
});

function twoTabs(activeTabId: string): WorkspaceState {
  return {
    projectId: "p1",
    activeTabId,
    tabs: [
      {
        kind: "terminalGroup",
        tabId: "g1",
        title: "bash",
        orientation: "horizontal",
        panes: [{ paneId: "g1:0", terminalId: "t1", relativeSize: 1 }],
        activePaneId: "g1:0",
      },
      {
        kind: "terminalGroup",
        tabId: "g2",
        title: "zsh",
        orientation: "horizontal",
        panes: [{ paneId: "g2:0", terminalId: "t2", relativeSize: 1 }],
        activePaneId: "g2:0",
      },
    ],
  };
}

const noop = (): void => undefined;

function renderTabs(state: WorkspaceState, overrides: Record<string, unknown> = {}) {
  return render(
    <TerminalTabs
      state={state}
      registry={registry}
      onSelectTab={noop}
      onCloseTab={noop}
      onNewTerminal={noop}
      onSplit={noop}
      onResizePanes={noop}
      onActivatePane={noop}
      onClosePane={noop}
      onTitleChange={noop}
      onPaneExit={noop}
      {...overrides}
    />,
  );
}

function panelFor(tabId: string): HTMLElement {
  const panel = document.querySelector<HTMLElement>(`[data-tab-id="${tabId}"]`);
  if (panel === null) throw new Error(`no panel for ${tabId}`);
  return panel;
}

describe("TerminalTabs keep-alive", () => {
  it("HIDES the inactive panel rather than unmounting it", () => {
    const view = renderTabs(twoTabs("g1"));

    const inactive = panelFor("g2");
    expect(inactive.hidden).toBe(true);
    // Still MOUNTED: the terminal's DOM is present behind the hidden panel.
    expect(inactive.querySelector(".vex-terminal-surface")).not.toBeNull();
    expect(registry.has("t1")).toBe(true);
    expect(registry.has("t2")).toBe(true);

    const terminalBeforeSwitch = registry.acquire("t2").terminal;
    registry.release("t2");

    view.rerender(
      <TerminalTabs
        state={twoTabs("g2")}
        registry={registry}
        onSelectTab={noop}
        onCloseTab={noop}
        onNewTerminal={noop}
        onSplit={noop}
        onResizePanes={noop}
        onActivatePane={noop}
        onClosePane={noop}
        onTitleChange={noop}
        onPaneExit={noop}
      />,
    );

    expect(panelFor("g2").hidden).toBe(false);
    expect(panelFor("g1").hidden).toBe(true);
    // The same terminal, not a rebuilt one: a remount would have replaced it
    // and taken the scrollback with it.
    expect(registry.acquire("t2").terminal).toBe(terminalBeforeSwitch);
    registry.release("t2");
  });

  it("REFITS the panel that becomes visible, and only that one", () => {
    const setVisible = vi.spyOn(registry, "setVisible");
    const view = renderTabs(twoTabs("g1"));
    setVisible.mockClear();

    view.rerender(
      <TerminalTabs
        state={twoTabs("g2")}
        registry={registry}
        onSelectTab={noop}
        onCloseTab={noop}
        onNewTerminal={noop}
        onSplit={noop}
        onResizePanes={noop}
        onActivatePane={noop}
        onClosePane={noop}
        onTitleChange={noop}
        onPaneExit={noop}
      />,
    );

    // A hidden panel measured 0x0 for as long as it was hidden, so the geometry
    // it holds is stale by construction.
    expect(setVisible.mock.calls).toContainEqual(["t2", true]);
    expect(setVisible.mock.calls).toContainEqual(["t1", false]);
  });

  it("keeps the panel semantics wired to the strip's generated ids", () => {
    renderTabs(twoTabs("g1"));
    const trigger = screen.getByRole("tab", { name: /bash/ });
    const panel = panelFor("g1");

    expect(trigger.getAttribute("aria-controls")).toBe(panel.id);
    expect(panel.getAttribute("aria-labelledby")).toBe(trigger.id);
  });
});

describe("TerminalTabs keyboard and controls", () => {
  it("navigates the strip with the arrow keys, through the shared primitive", () => {
    const onSelectTab = vi.fn();
    renderTabs(twoTabs("g1"), { onSelectTab });

    const first = screen.getByRole("tab", { name: /bash/ });
    // Roving tabindex: only the selected tab is in the tab order.
    expect(first.tabIndex).toBe(0);
    expect(screen.getByRole("tab", { name: /zsh/ }).tabIndex).toBe(-1);

    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(onSelectTab).toHaveBeenLastCalledWith("g2");

    fireEvent.keyDown(first, { key: "End" });
    expect(onSelectTab).toHaveBeenLastCalledWith("g2");
  });

  it("gives every control a name and reaches all of them without a pointer", () => {
    const onCloseTab = vi.fn();
    const onSplit = vi.fn();
    const onNewTerminal = vi.fn();
    renderTabs(twoTabs("g1"), { onCloseTab, onSplit, onNewTerminal });

    // Named per tab, so two tabs' close buttons are distinguishable.
    screen.getByRole("button", { name: "Close bash" }).click();
    expect(onCloseTab).toHaveBeenLastCalledWith("g1");

    screen.getByRole("button", { name: "Split zsh side by side" }).click();
    expect(onSplit).toHaveBeenLastCalledWith("g2", "horizontal");

    screen.getByRole("button", { name: "Split zsh top and bottom" }).click();
    expect(onSplit).toHaveBeenLastCalledWith("g2", "vertical");

    screen.getByRole("button", { name: "New terminal" }).click();
    expect(onNewTerminal).toHaveBeenCalled();

    // Every control is a real button, so all of them are in the tab order.
    for (const button of screen.getAllByRole("button")) {
      expect(button.tabIndex).not.toBe(-1);
      expect(button.getAttribute("type")).toBe("button");
    }
  });

  it("renders a split group through the resizable primitive", () => {
    const state = twoTabs("g1");
    const split: WorkspaceState = {
      ...state,
      tabs: [
        {
          kind: "terminalGroup",
          tabId: "g1",
          title: "bash",
          orientation: "vertical",
          panes: [
            { paneId: "g1:0", terminalId: "t1", relativeSize: 0.6 },
            { paneId: "g1:1", terminalId: "t3", relativeSize: 0.4 },
          ],
          activePaneId: "g1:0",
        },
        ...state.tabs.slice(1),
      ],
    };
    renderTabs(split);

    const separator = screen.getByRole("separator");
    expect(separator.getAttribute("aria-orientation")).toBe("horizontal");
    expect(separator.getAttribute("aria-valuenow")).toBe("60");
    // A split group gets a per-pane close affordance; a single-pane one does not.
    expect(screen.getByRole("button", { name: "Close terminal 2 in bash" })).toBeTruthy();
  });

  it("shows a file tab in the same strip without pretending it is a terminal", () => {
    const state: WorkspaceState = {
      projectId: "p1",
      activeTabId: "f1",
      tabs: [
        {
          kind: "file",
          tabId: "f1",
          title: "README.md",
          relativePath: "docs/README.md",
          nodeId: "node-readme",
          dirty: false,
        },
      ],
    };
    renderTabs(state);

    expect(screen.getByRole("tab", { name: /README.md/ })).toBeTruthy();
    // No split affordance on a file tab, and no terminal mounted for it.
    expect(screen.queryByRole("button", { name: /^Split/ })).toBeNull();
    expect(panelFor("f1").querySelector(".vex-terminal-surface")).toBeNull();
  });
});
