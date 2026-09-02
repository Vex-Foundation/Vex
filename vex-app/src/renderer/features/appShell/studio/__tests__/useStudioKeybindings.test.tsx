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
import { ExplorerRegistry } from "../explorer/index.js";
import { TerminalRegistry } from "../terminal/index.js";
import { EmptyWorkspaceWatermark } from "../terminal/TerminalTabs.js";
import { studioBoundIntents, studioSurfaceOf } from "../useStudioKeybindings.js";
import { studioWatermarkRows } from "../keybindings-labels.js";
import { installStudioDomStubs } from "./studio-fixtures.js";

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

  it("Ctrl+Shift+A returns to Agent mode", async () => {
    renderCenter();
    await screen.findByRole("heading", { name: "Vex Studio" });

    act(() => {
      expect(press("KeyA", { ctrl: true, shift: true })).toBe(false);
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

    // `newTerminal` resolves in the table and has no owner wired yet: the
    // event must reach whatever else is listening, unprevented.
    expect(studioBoundIntents().has("newTerminal")).toBe(false);
    act(() => {
      expect(press("Backquote", { ctrl: true, shift: true })).toBe(true);
    });
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
      { action: "Toggle sidebar", keys: "Ctrl+B" },
      { action: "Back to Agent mode", keys: "Ctrl+Shift+A" },
      { action: "New project", keys: "Ctrl+Shift+N" },
    ]);
  });

  it("spells the same rows for macOS", () => {
    expect(studioWatermarkRows("darwin", studioBoundIntents()).map((r) => r.keys)).toEqual([
      "⌘B",
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
