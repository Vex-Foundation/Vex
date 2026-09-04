/**
 * THE STUDIO KEYBOARD HOOK, through a real `StudioCenter` mount.
 *
 * The table has its own table test (`keybindings.test.ts`); this proves the
 * EFFECTS, and it proves them by observing the owners rather than the hook: a
 * `Ctrl+B` here reaches the uiStore's own `sidebarOpen`, and a `Ctrl+Shift+N`
 * reaches the same `openProjectCreator` the sidebar and the centre publish
 * through. Asserting that an injected callback was invoked would prove the hook
 * called what it was handed, which is not the contract.
 *
 * Three properties beyond the happy path, each a way keyboard handling goes
 * wrong in shipped software:
 *
 *  - an UNBOUND intent leaves the event completely alone, so Studio intercepts
 *    exactly the list its watermark advertises;
 *  - an open modal dialog suspends every binding without swallowing the key;
 *  - the listener is gone after unmount.
 *
 * The controller and the dialogs are replaced for the same reason
 * `StudioCenter.test.tsx` replaces them: mounting real terminal workspaces
 * would test the terminal.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Result } from "@shared/ipc/result.js";
import type { ProjectList } from "@shared/schemas/projects.js";
import { useUiStore } from "../../../../stores/uiStore.js";
import {
  clearComposerFocus,
  publishComposerFocus,
} from "../../composer-focus.js";
import { ExplorerRegistry } from "../explorer/index.js";
import { TerminalRegistry } from "../terminal/index.js";
import { EmptyWorkspaceWatermark } from "../terminal/TerminalTabs.js";
import {
  studioBoundIntents,
  studioSurfaceOf,
  useStudioKeybindings,
} from "../useStudioKeybindings.js";
import { studioWatermarkRows } from "../keybindings-labels.js";
import { publishProjectWorkspaceCommands } from "../workspace/workspace-handles.js";
import { installStudioDomStubs, makeProject } from "./studio-fixtures.js";

/**
 * Two real projects, the first of them ACTIVE.
 *
 * They have to be real rows in the list the centre reads: its stale-selection
 * repair gives up any selection that names a project the settled list does not
 * hold, so a made-up id would be cleared before a key could reach it.
 */
async function renderWithTwoProjects(): Promise<{ active: string; hidden: string }> {
  const active = makeProject({ name: "vex-active" });
  const hidden = makeProject({ name: "vex-hidden" });
  projectsListMock.mockResolvedValue({ ok: true, data: [active, hidden] });
  renderCenter();
  await screen.findByRole("heading", { name: "Vex Studio" });
  await act(async () => {
    useUiStore.setState({ activeProjectId: active.id });
    await Promise.resolve();
  });
  return { active: active.id, hidden: hidden.id };
}

/**
 * Put focus INSIDE the active project's workspace.
 *
 * The tab chords apply on the workspace and its two panels and nowhere else,
 * so a test pressing `Ctrl+W` at the document body is pressing it on the
 * `none` surface, where the table correctly declines. The element focused here
 * is the workspace container the centre really renders, found by the same
 * marker `studioSurfaceOf` resolves against.
 */
function focusActiveWorkspace(projectId: string): void {
  const host = document.querySelector<HTMLElement>(
    `[data-vex-studio-workspace="${projectId}"]`,
  );
  if (host === null) throw new Error(`no workspace element for ${projectId}`);
  host.tabIndex = -1;
  host.focus();
}

/**
 * A workspace that answers every command, unless a case says otherwise.
 *
 * `true` is the default because "the workspace acted" is the ordinary outcome;
 * the interesting case is a command that DECLINES, which is what proves the
 * hook leaves an unanswered keystroke alone.
 */
function makeCommands(
  answers: Partial<
    Record<
      | "newTerminal"
      | "splitActiveTerminal"
      | "closeActiveTab"
      | "selectTabAtOffset"
      | "pinActiveTab",
      boolean
    >
  > = {},
): {
  newTerminal: ReturnType<typeof vi.fn<() => boolean>>;
  splitActiveTerminal: ReturnType<typeof vi.fn<() => boolean>>;
  closeActiveTab: ReturnType<typeof vi.fn<() => boolean>>;
  selectTabAtOffset: ReturnType<typeof vi.fn<(offset: number) => boolean>>;
  pinActiveTab: ReturnType<typeof vi.fn<() => boolean>>;
} {
  return {
    newTerminal: vi.fn<() => boolean>(() => answers.newTerminal ?? true),
    splitActiveTerminal: vi.fn<() => boolean>(() => answers.splitActiveTerminal ?? true),
    closeActiveTab: vi.fn<() => boolean>(() => answers.closeActiveTab ?? true),
    selectTabAtOffset: vi.fn<(offset: number) => boolean>(
      () => answers.selectTabAtOffset ?? true,
    ),
    pinActiveTab: vi.fn<() => boolean>(() => answers.pinActiveTab ?? true),
  };
}

const projectsListMock = vi.fn<() => Promise<Result<ProjectList>>>();
const openProjectCreatorMock = vi.fn<() => void>();

vi.mock("../terminal/StudioWorkspaceController.js", () => ({
  StudioWorkspaceController: ({ projectId }: { projectId: string }) => (
    <div data-testid={`workspace-${projectId}`} />
  ),
}));

vi.mock("../projects/index.js", () => ({
  openProjectCreator: (): void => {
    openProjectCreatorMock();
  },
  StudioProjectDialogs: () => null,
}));

const { StudioCenter } = await import("../StudioCenter.js");

function renderCenter(): { unmount: () => void } {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <StudioCenter
        explorerRegistry={new ExplorerRegistry()}
        terminalRegistry={new TerminalRegistry()}
      />
    </QueryClientProvider>,
  );
  return { unmount: view.unmount };
}

/**
 * Press a chord at the document.
 *
 * @returns `false` when a listener called `preventDefault` - `dispatchEvent`'s
 * own answer for a cancelled event, which is how this suite tells "Studio took
 * this key" from "Studio let it through".
 */
function press(
  code: string,
  modifiers: { ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean } = {},
): boolean {
  return fireEvent.keyDown(document, {
    code,
    ctrlKey: modifiers.ctrl ?? false,
    metaKey: modifiers.meta ?? false,
    shiftKey: modifiers.shift ?? false,
    altKey: modifiers.alt ?? false,
  });
}

beforeAll(() => {
  installStudioDomStubs();
});

beforeEach(() => {
  // A MODULE SINGLETON: a handle or a pending request left by the previous
  // test would be taken by this one.
  clearComposerFocus();
  projectsListMock.mockReset();
  projectsListMock.mockResolvedValue({ ok: true, data: [] });
  openProjectCreatorMock.mockReset();
  useUiStore.setState({
    activeProjectId: null,
    runtimeMode: "studio",
    sidebarOpen: true,
  });
  Object.defineProperty(window, "vex", {
    configurable: true,
    value: {
      projects: { list: projectsListMock },
      studio: {
        getBridgeReadiness: () =>
          Promise.resolve({ ok: true, data: { kind: "ready" } }),
      },
      files: {
        list: () => Promise.resolve({ ok: true, data: null }),
        watch: () => Promise.resolve({ ok: true, data: null }),
      },
    },
  });
});

describe("the mounted table dispatches through the owners", () => {
  it("Ctrl+B toggles the rail in the uiStore, both ways", async () => {
    renderCenter();
    await screen.findByRole("heading", { name: "Vex Studio" });

    expect(useUiStore.getState().sidebarOpen).toBe(true);
    act(() => {
      expect(press("KeyB", { ctrl: true })).toBe(false);
    });
    expect(useUiStore.getState().sidebarOpen).toBe(false);
    act(() => {
      press("KeyB", { ctrl: true });
    });
    expect(useUiStore.getState().sidebarOpen).toBe(true);
  });

  it("Ctrl+Shift+A leaves Studio for Agent mode AND lands focus in the composer", async () => {
    renderCenter();
    await screen.findByRole("heading", { name: "Vex Studio" });

    // No composer is mounted while Studio is the column on screen, so the
    // request is latched and the composer that the mode switch brings on
    // screen consumes it. Without this the chord left `document.activeElement`
    // on `document.body` and the user tabbed in from the top of the window.
    const focus = vi.fn();
    act(() => {
      expect(press("KeyA", { ctrl: true, shift: true })).toBe(false);
    });
    expect(useUiStore.getState().runtimeMode).toBe("agent");

    expect(focus).not.toHaveBeenCalled();
    publishComposerFocus(focus);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  /**
   * THE RETURN DIRECTION of the same chord.
   *
   * It is one row and one handler that reads the mode, rather than two rows:
   * the user thinks of it as "the other mode", and a second chord would be a
   * second thing to learn for one gesture. What this proves is that the
   * handler does not assume the mode it was written in - the half the product
   * cannot exercise yet, because the only listener is mounted by
   * `StudioCenter` and `AppShell` renders that only in Studio (see the hook's
   * module note). The hook is mounted DIRECTLY here for exactly that reason.
   */
  it("Ctrl+Shift+A comes back INTO Studio when the mode is agent", () => {
    useUiStore.setState({ runtimeMode: "agent" });
    function OnlyTheTable(): null {
      useStudioKeybindings(undefined, "linux");
      return null;
    }
    render(<OnlyTheTable />);

    act(() => {
      expect(press("KeyA", { ctrl: true, shift: true })).toBe(false);
    });
    expect(useUiStore.getState().runtimeMode).toBe("studio");

    // And once more, back out: it is a toggle, not a one-way door with two
    // names.
    act(() => {
      press("KeyA", { ctrl: true, shift: true });
    });
    expect(useUiStore.getState().runtimeMode).toBe("agent");
  });

  it("Ctrl+Shift+N opens the project creator through its intent publisher", async () => {
    renderCenter();
    await screen.findByRole("heading", { name: "Vex Studio" });

    act(() => {
      expect(press("KeyN", { ctrl: true, shift: true })).toBe(false);
    });
    expect(openProjectCreatorMock).toHaveBeenCalledTimes(1);
  });

  it("takes no key while a modal dialog is open", async () => {
    renderCenter();
    await screen.findByRole("heading", { name: "Vex Studio" });

    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    document.body.appendChild(dialog);
    try {
      act(() => {
        // Not swallowed - the dialog's own handlers still see it - just not
        // acted on by Studio.
        expect(press("KeyB", { ctrl: true })).toBe(true);
      });
      expect(useUiStore.getState().sidebarOpen).toBe(true);
    } finally {
      dialog.remove();
    }
  });

  it("leaves an UNBOUND intent's key completely alone", async () => {
    renderCenter();
    await screen.findByRole("heading", { name: "Vex Studio" });

    // `toggleTerminal` resolves in the table and has NO owner: Studio has no
    // terminal panel to fold away, so the row is reserved and unwired. The
    // event must reach whatever else is listening, unprevented.
    expect(studioBoundIntents().has("toggleTerminal")).toBe(false);
    act(() => {
      expect(press("Backquote", { ctrl: true })).toBe(true);
    });
  });

  /**
   * BOUND IS NOT THE SAME AS ANSWERABLE, and this is the case that proves the
   * difference matters. `newTerminal` has an owner - a mounted workspace - and
   * the welcome screen has no workspace mounted. The honest outcome is that
   * Studio took nothing, so `Ctrl+Shift+\`` travels on rather than being eaten
   * by a shortcut that did not happen.
   */
  it("leaves a BOUND intent's key alone when no owner is on screen", async () => {
    renderCenter();
    await screen.findByRole("heading", { name: "Vex Studio" });

    expect(studioBoundIntents().has("newTerminal")).toBe(true);
    act(() => {
      expect(press("Backquote", { ctrl: true, shift: true })).toBe(true);
    });
  });

  /**
   * `Ctrl+Shift+E` reaches the explorer through its own public function, and
   * the observation is the one a user makes: DOM focus lands on the tree.
   * There is no tree on the welcome screen, so the key is left alone there -
   * the same honesty rule as the workspace commands above.
   */
  it("Ctrl+Shift+E focuses the project tree, and declines when there is none", async () => {
    renderCenter();
    await screen.findByRole("heading", { name: "Vex Studio" });

    act(() => {
      expect(press("KeyE", { ctrl: true, shift: true })).toBe(true);
    });

    const tree = document.createElement("div");
    tree.setAttribute("role", "tree");
    tree.setAttribute("aria-label", "Project files");
    tree.tabIndex = 0;
    document.body.appendChild(tree);
    try {
      act(() => {
        expect(press("KeyE", { ctrl: true, shift: true })).toBe(false);
      });
      expect(document.activeElement).toBe(tree);
    } finally {
      tree.remove();
    }
  });

  /**
   * THE WORKSPACE COMMANDS, through the registry the real controller publishes
   * into.
   *
   * A fake handle rather than a mounted workspace, because what is under test
   * here is the ROUTING - which project answers, and that the keystroke is
   * taken only when one did. That the controller publishes commands which
   * really open, split and close is proved against the real controller in
   * `terminal/__tests__/StudioWorkspaceController.test.tsx`.
   */
  it("routes the terminal and tab chords to the ACTIVE project's workspace", async () => {
    const ids = await renderWithTwoProjects();

    const active = makeCommands();
    const hidden = makeCommands();
    const unpublishActive = publishProjectWorkspaceCommands(ids.active, active);
    const unpublishHidden = publishProjectWorkspaceCommands(ids.hidden, hidden);
    focusActiveWorkspace(ids.active);
    try {
      act(() => {
        expect(press("Backquote", { ctrl: true, shift: true })).toBe(false);
        expect(press("KeyW", { ctrl: true })).toBe(false);
        expect(press("Tab", { ctrl: true })).toBe(false);
        expect(press("Tab", { ctrl: true, shift: true })).toBe(false);
      });
      expect(active.newTerminal).toHaveBeenCalledTimes(1);
      expect(active.closeActiveTab).toHaveBeenCalledTimes(1);
      expect(active.selectTabAtOffset.mock.calls).toEqual([[1], [-1]]);
      // A hidden kept-alive workspace publishes too, and must never answer: a
      // Ctrl+W in one project may not close a tab in another.
      expect(hidden.newTerminal).not.toHaveBeenCalled();
      expect(hidden.closeActiveTab).not.toHaveBeenCalled();
      expect(hidden.selectTabAtOffset).not.toHaveBeenCalled();
    } finally {
      unpublishActive();
      unpublishHidden();
    }
  });

  /**
   * `Ctrl+Enter` KEEPS THE PREVIEW TAB, and only when there is one to keep.
   *
   * The second half is the load-bearing one and is why this is its own case
   * rather than another chord in the walk above. `Enter` is a key the rest of
   * the app uses constantly, so a `Ctrl+Enter` over a workspace whose active
   * tab is a terminal or an already-pinned file must leave the keystroke
   * completely alone - which is exactly what the command answering `false`
   * buys, and what `dispatchEvent` returning `true` here proves.
   */
  it("Ctrl+Enter keeps the preview tab, and declines when there is none", async () => {
    const ids = await renderWithTwoProjects();

    const nothingToKeep = makeCommands({ pinActiveTab: false });
    const unpublishFirst = publishProjectWorkspaceCommands(ids.active, nothingToKeep);
    focusActiveWorkspace(ids.active);
    try {
      act(() => {
        expect(press("Enter", { ctrl: true })).toBe(true);
      });
      expect(nothingToKeep.pinActiveTab).toHaveBeenCalledTimes(1);
    } finally {
      unpublishFirst();
    }

    const keeps = makeCommands();
    const unpublishSecond = publishProjectWorkspaceCommands(ids.active, keeps);
    focusActiveWorkspace(ids.active);
    try {
      act(() => {
        expect(press("Enter", { ctrl: true })).toBe(false);
      });
      expect(keeps.pinActiveTab).toHaveBeenCalledTimes(1);
      // A BARE Enter is never Studio's: the chord needs the modifier, or every
      // Enter in the workspace would reach this command.
      act(() => {
        expect(press("Enter")).toBe(true);
      });
      expect(keeps.pinActiveTab).toHaveBeenCalledTimes(1);
    } finally {
      unpublishSecond();
    }
  });

  /**
   * A command that DECLINED does not get the keystroke. The workspace is
   * mounted, so the intent is bound and the owner is on screen - and the strip
   * still has no tab to close, which is a real state (every tab closed) and the
   * one the empty watermark is drawn for.
   */
  it("leaves the key alone when the workspace declines the command", async () => {
    const ids = await renderWithTwoProjects();

    const commands = makeCommands({ closeActiveTab: false });
    const unpublish = publishProjectWorkspaceCommands(ids.active, commands);
    focusActiveWorkspace(ids.active);
    try {
      act(() => {
        expect(press("KeyW", { ctrl: true })).toBe(true);
      });
      expect(commands.closeActiveTab).toHaveBeenCalledTimes(1);
    } finally {
      unpublish();
    }
  });

  /**
   * `Ctrl+Shift+5` is terminal-only, as in VS Code: there is no answer to
   * "split which one?" when no terminal has focus. The surface is decided by
   * `document.activeElement`, so this puts focus in a real terminal wrapper.
   */
  it("takes Split terminal only when a terminal has focus", async () => {
    const ids = await renderWithTwoProjects();

    const commands = makeCommands();
    const unpublish = publishProjectWorkspaceCommands(ids.active, commands);
    const wrapper = document.createElement("div");
    wrapper.className = "vex-terminal-surface";
    const focusable = document.createElement("textarea");
    wrapper.appendChild(focusable);
    document.body.appendChild(wrapper);
    try {
      act(() => {
        expect(press("Digit5", { ctrl: true, shift: true })).toBe(true);
      });
      expect(commands.splitActiveTerminal).not.toHaveBeenCalled();

      focusable.focus();
      act(() => {
        expect(press("Digit5", { ctrl: true, shift: true })).toBe(false);
      });
      expect(commands.splitActiveTerminal).toHaveBeenCalledTimes(1);
    } finally {
      wrapper.remove();
      unpublish();
    }
  });

  it("ignores a key with no row", async () => {
    renderCenter();
    await screen.findByRole("heading", { name: "Vex Studio" });
    act(() => {
      expect(press("KeyZ", { ctrl: true })).toBe(true);
    });
  });

  it("stops listening after unmount", async () => {
    const view = renderCenter();
    await screen.findByRole("heading", { name: "Vex Studio" });
    act(() => {
      view.unmount();
    });
    act(() => {
      expect(press("KeyB", { ctrl: true })).toBe(true);
    });
    expect(useUiStore.getState().sidebarOpen).toBe(true);
  });
});

describe("studioSurfaceOf", () => {
  function inside(html: string): Element {
    const host = document.createElement("div");
    host.innerHTML = html;
    document.body.appendChild(host);
    const target = host.querySelector("[data-target]");
    if (target === null) throw new Error(`no [data-target] in ${html}`);
    return target;
  }

  it("answers none for an element outside every Studio surface", () => {
    expect(studioSurfaceOf(inside("<span data-target></span>"))).toBe("none");
  });

  it("answers none for nothing at all", () => {
    expect(studioSurfaceOf(null)).toBe("none");
  });

  it("answers rail inside the sidebar", () => {
    expect(
      studioSurfaceOf(
        inside('<aside data-vex-area="studio-sidebar"><b data-target></b></aside>'),
      ),
    ).toBe("rail");
  });

  it("answers terminal inside a terminal wrapper", () => {
    expect(
      studioSurfaceOf(inside('<div class="vex-terminal-surface"><b data-target></b></div>')),
    ).toBe("terminal");
  });

  it("answers viewer inside the file viewer", () => {
    expect(
      studioSurfaceOf(
        inside('<div data-vex-key-surface="viewer"><b data-target></b></div>'),
      ),
    ).toBe("viewer");
  });

  it("prefers the INNER surface over the workspace that holds it", () => {
    expect(
      studioSurfaceOf(
        inside(
          '<div data-vex-studio-workspace="p1"><div class="vex-terminal-surface"><b data-target></b></div></div>',
        ),
      ),
    ).toBe("terminal");
  });

  it("answers workspace for the tab strip between them", () => {
    expect(
      studioSurfaceOf(inside('<div data-vex-studio-workspace="p1"><b data-target></b></div>')),
    ).toBe("workspace");
  });
});

/**
 * THE WATERMARK ROWS the empty workspace renders.
 *
 * `EmptyWorkspaceWatermark` (owned by the terminal surface) takes a `rows`
 * prop; these are the rows this lane supplies for it. The invariant asserted
 * here is the one that keeps the panel honest: the rows are exactly the bound
 * intents, so nothing is advertised that no owner answers.
 */
describe("the watermark rows come from the table", () => {
  it("lists exactly the bound intents, spelled for the platform", () => {
    const rows = studioWatermarkRows("linux", studioBoundIntents());
    expect(rows).toEqual([
      { action: "New terminal", keys: "Ctrl+Shift+`" },
      { action: "Split terminal", keys: "Ctrl+Shift+5" },
      { action: "Focus explorer", keys: "Ctrl+Shift+E" },
      { action: "Go to file", keys: "Ctrl+P" },
      { action: "Toggle sidebar", keys: "Ctrl+B" },
      { action: "Close tab", keys: "Ctrl+W" },
      { action: "Keep tab open", keys: "Ctrl+Enter" },
      { action: "Next tab", keys: "Ctrl+Tab" },
      { action: "Previous tab", keys: "Ctrl+Shift+Tab" },
      { action: "Switch Agent and Studio", keys: "Ctrl+Shift+A" },
      { action: "New project", keys: "Ctrl+Shift+N" },
    ]);
  });

  /**
   * `Toggle terminal panel` is the one row the watermark must NOT carry: it
   * resolves in the table and no owner answers it, because Studio has no
   * terminal panel to fold away. A watermark that listed it would teach a
   * shortcut that does nothing.
   */
  it("leaves out the intent with no owner", () => {
    const actions = studioWatermarkRows("linux", studioBoundIntents()).map((r) => r.action);
    expect(actions).not.toContain("Toggle terminal panel");
  });

  it("spells the same rows for macOS, overrides and all", () => {
    expect(studioWatermarkRows("darwin", studioBoundIntents()).map((r) => r.keys)).toEqual([
      "⌃⇧`",
      "⌘\\",
      "⇧⌘E",
      "⌘P",
      "⌘B",
      "⌘W",
      "⌘Enter",
      "⌃Tab",
      "⌃⇧Tab",
      "⇧⌘A",
      "⇧⌘N",
    ]);
  });

  /**
   * THE SEAM, proved through the real component.
   *
   * `EmptyWorkspaceWatermark` belongs to the terminal surface and takes its
   * rows as a prop; this lane supplies them. Rendering the real component with
   * the real rows is what proves the two halves fit - the row type, the label
   * left, the keys right - rather than a type assertion that would still
   * compile if the component stopped reading `keys`.
   */
  it("renders through the terminal surface's watermark, label left and keys right", () => {
    const rows = studioWatermarkRows("linux", studioBoundIntents());
    render(<EmptyWorkspaceWatermark rows={rows} />);
    const list = document.querySelector("[data-vex-empty-watermark]");
    expect(list).not.toBeNull();
    const terms = [...(list?.querySelectorAll("dt") ?? [])].map((n) => n.textContent);
    const keys = [...(list?.querySelectorAll("dd") ?? [])].map((n) => n.textContent);
    expect(terms).toEqual(rows.map((row) => row.action));
    expect(keys).toEqual(rows.map((row) => row.keys));
  });

  it("renders nothing when no intent is bound", () => {
    render(<EmptyWorkspaceWatermark rows={studioWatermarkRows("linux", new Set())} />);
    expect(document.querySelector("[data-vex-empty-watermark]")).toBeNull();
  });
});
