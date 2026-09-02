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

import type { JSX } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalRegistry } from "../terminal-registry.js";
import { TerminalTabs } from "../TerminalTabs.js";
import type { WorkspaceFileTab, WorkspaceState } from "../../workspace/types.js";
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
  renderFileTabCalls.length = 0;
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
        panes: [{ paneId: "g1:0", terminalId: "t1", relativeSize: 1, displayCwd: null }],
        activePaneId: "g1:0",
      },
      {
        kind: "terminalGroup",
        tabId: "g2",
        title: "zsh",
        orientation: "horizontal",
        panes: [{ paneId: "g2:0", terminalId: "t2", relativeSize: 1, displayCwd: null }],
        activePaneId: "g2:0",
      },
    ],
  };
}

const noop = (): void => undefined;

/**
 * The file-tab render prop, as a recording stub.
 *
 * `TerminalTabs` deliberately does not know what fills a file panel - the
 * viewer needs a `projectId` this component has no business holding - so the
 * contract to test HERE is that the panel loop calls the prop with the tab and
 * with whether the panel is the visible one. The viewer's own behaviour is
 * `viewer/__tests__/FileViewer.test.tsx`.
 */
/** A minimal catalogue: the shell that always exists, plus one that does not. */
const SHELLS = [
  { id: "system_default", label: "Default shell", available: true },
  { id: "fish", label: "fish", available: false },
] as const;

const renderFileTabCalls: { tabId: string; isActive: boolean }[] = [];

function renderFileTabStub(tab: WorkspaceFileTab, isActive: boolean): JSX.Element {
  renderFileTabCalls.push({ tabId: tab.tabId, isActive });
  return (
    <div data-testid={`file-panel-${tab.tabId}`} data-active={String(isActive)}>
      {tab.relativePath}
    </div>
  );
}

function fileTab(tabId: string, relativePath: string): WorkspaceFileTab {
  return {
    kind: "file",
    tabId,
    title: relativePath.slice(relativePath.lastIndexOf("/") + 1),
    relativePath,
    nodeId: `node:${relativePath}`,
    dirty: false,
  };
}

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
        onDisplayCwdChange={noop}
        onPaneExit={noop}
        shellId="system_default"
      shells={SHELLS}
      onSelectShell={noop}
      renderFileTab={renderFileTabStub}
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
        onDisplayCwdChange={noop}
        onPaneExit={noop}
        shellId="system_default"
      shells={SHELLS}
      onSelectShell={noop}
      renderFileTab={renderFileTabStub}
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
            { paneId: "g1:0", terminalId: "t1", relativeSize: 0.6, displayCwd: null },
            { paneId: "g1:1", terminalId: "t3", relativeSize: 0.4, displayCwd: null },
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

/**
 * The file-panel seam (stage B3c).
 *
 * `renderFileTab` is REQUIRED rather than optional on purpose: an optional
 * prop would leave a code path in which a file tab appears in the strip with an
 * empty panel behind it, and nothing would catch that but a person looking.
 */
describe("file tabs", () => {
  function mixed(activeTabId: string): WorkspaceState {
    const base = twoTabs(activeTabId);
    return { ...base, tabs: [...base.tabs, fileTab("f1", "src/deep/service.ts")] };
  }

  it("fills a file panel through the render prop, with the tab and its visibility", () => {
    renderTabs(mixed("f1"));

    expect(screen.getByTestId("file-panel-f1").textContent).toBe("src/deep/service.ts");
    expect(renderFileTabCalls).toContainEqual({ tabId: "f1", isActive: true });
    // A file tab creates no terminal and offers no split.
    expect(registry.has("f1")).toBe(false);
  });

  it("keeps a hidden file panel MOUNTED and tells the prop it is not active", () => {
    renderTabs(mixed("g1"));

    const panel = panelFor("f1");
    expect(panel.hidden).toBe(true);
    // Mounted behind the hidden panel: unmounting it would throw away the
    // viewer's session and re-read the file on every tab switch.
    expect(panel.querySelector('[data-testid="file-panel-f1"]')).not.toBeNull();
    expect(screen.getByTestId("file-panel-f1").getAttribute("data-active")).toBe("false");
  });

  it("gives a file tab a tabpanel and a close control like any other", () => {
    renderTabs(mixed("f1"));
    expect(screen.getByRole("tab", { name: /service\.ts/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close service.ts" })).toBeTruthy();
  });
});

/**
 * THE EMPTY PANEL AREA, which used to be an unlabelled black rectangle.
 *
 * Opening a project auto-creates its first terminal, so this is a FALLBACK: it
 * is what remains when that bootstrap deliberately declined (a restore Vex could
 * not read) or when the user closed every tab. Either way the surface must say
 * what it is and offer something to do, because a dark rectangle with no
 * affordance reads as broken rather than as empty.
 */
describe("TerminalTabs with no tabs", () => {
  const empty: WorkspaceState = { projectId: "p1", activeTabId: null, tabs: [] };

  it("offers a named, keyboard-reachable action instead of a blank panel", () => {
    const opens: number[] = [];
    renderTabs(empty, { onNewTerminal: () => opens.push(1) });

    expect(screen.getByText("No terminals or files are open in this project.")).toBeTruthy();

    const action = screen.getByRole("button", { name: "Open a terminal" });
    // Reachable without a pointer, and it invokes the same callback the strip's
    // `+` does.
    action.focus();
    expect(document.activeElement).toBe(action);
    fireEvent.click(action);
    expect(opens).toHaveLength(1);
  });

  it("names its action DIFFERENTLY from the strip's `+`, which is still there", () => {
    renderTabs(empty);

    // Two controls sharing one accessible name cannot be told apart by anyone
    // navigating by name, and both are on screen at once in this state.
    expect(screen.getByRole("button", { name: "New terminal" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open a terminal" })).toBeTruthy();
  });

  it("is GONE the moment a tab exists, so it cannot cover a live terminal", () => {
    renderTabs(twoTabs("g1"));

    expect(screen.queryByRole("button", { name: "Open a terminal" })).toBeNull();
    expect(
      screen.queryByText("No terminals or files are open in this project."),
    ).toBeNull();
  });
});

/**
 * ONE OWNER for a terminal's directory.
 *
 * `TerminalPaneGroup` used to hold a second store of this fact - a
 * `useState<Map<terminalId, displayCwd>>` fed only by `onDisplayCwdChange` -
 * beside the workspace model that holds the rest of a pane. It was not a
 * duplicate of the model, which is exactly why it was a defect: the model knew
 * nothing, so a reattached terminal had no entry in the map either, and its
 * header read "not known yet" for a shell that had been sitting in a known
 * directory the whole time.
 *
 * The behavioural half of this is asserted end to end in the controller suite
 * ("shows the reattached terminal's directory WITHOUT waiting for a property
 * event"). This half is STRUCTURAL, because a behavioural test cannot see a
 * second store being reintroduced beside a working one - it would keep passing
 * while the two copies drifted.
 */
describe("the panel header reads ONE directory field", () => {
  it("keeps no local state in TerminalPaneGroup", () => {
    // Read the way `shell-design-guard` reads sources: Vite inlines the file at
    // build time, so the assertion needs no filesystem access in jsdom.
    const sources = import.meta.glob<string>("../TerminalPaneGroup.tsx", {
      query: "?raw",
      import: "default",
      eager: true,
    });
    const source = Object.values(sources)[0];
    if (source === undefined) throw new Error("TerminalPaneGroup.tsx was not found");
    // The component is a pure projection of `group` plus its callbacks. Any
    // hook that remembers something across renders is a second source of truth
    // for a pane's own fields.
    expect(source).not.toMatch(/\buseState\b/);
    expect(source).not.toMatch(/\buseReducer\b/);
    expect(source).not.toMatch(/\buseRef\b/);
  });

  it("renders the directory the PANE carries, with no property event", () => {
    const state = twoTabs("g1");
    const first = state.tabs[0];
    if (first?.kind !== "terminalGroup") throw new Error("expected a group");
    renderTabs({
      ...state,
      tabs: [
        {
          ...first,
          panes: first.panes.map((pane) => ({ ...pane, displayCwd: "vex-app/src/lib" })),
        },
        ...state.tabs.slice(1),
      ],
    });

    expect(screen.getByLabelText("Working directory: vex-app/src/lib")).toBeTruthy();
  });

  it("names the unknown when the pane carries none", () => {
    renderTabs(twoTabs("g1"));
    // BOTH panels are mounted - the inactive one is hidden, never unmounted -
    // so both headers answer, and both must name the unknown rather than
    // rendering an empty control.
    expect(screen.getAllByLabelText("Working directory not known yet")).toHaveLength(2);
  });
});
