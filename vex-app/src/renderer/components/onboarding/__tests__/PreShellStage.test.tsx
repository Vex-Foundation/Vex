/**
 * Her stage before the shell (`PreShellStage.tsx`, docs/design/H3-DESKTOP.md section 4.9): every
 * pre-shell view stands beside her H3 column (the shell's own Vex key, Kimm's section and the
 * tagline), what she shows follows the stage store (the wake, the unlock after a launch and after
 * Lock Vex, a concern, a screen's face), her choice is the shell's stored one, the chord is bound
 * once, and the stage holds under the shell until its exit.
 *
 * jsdom paints no canvas, so her glyph field draws nothing here; her art is the app's shipped art,
 * every piece missing until it arrives.
 */

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useUiStore, type View } from "../../../stores/uiStore.js";
import { StagePlate, stageLayoutFor } from "../PreShellStage.js";
import {
  getStageVex,
  resetStageVex,
  stageVexConcerned,
  stageVexEnd,
  stageVexExit,
  stageVexFace,
  stageVexPipelineReady,
} from "../stage-vex.js";

function stand(view: View, holding = false): void {
  useUiStore.setState({
    currentView: view,
    setupGateActive: view === "splash" ? true : holding,
    unlockCurtainActive: false,
  });
}

function keyOf(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>("[data-vex-area='vex-key']");
}

function sectionOf(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>("[data-vex-area='kimm-section']");
}

beforeEach(() => {
  resetStageVex();
  useUiStore.setState({ vexOpenChat: true, kimmHintShown: true });
});

afterEach(() => {
  cleanup();
  resetStageVex();
  useUiStore.setState({ currentView: "splash", setupGateActive: true });
});

describe("stageLayoutFor", () => {
  it("stands every pre-shell view on H3's stage, and the shell on nothing", () => {
    for (const view of [
      "splash",
      "unlock",
      "systemCheck",
      "runtimeMigration",
      "runtimeBootstrap",
      "migrations",
      "wizard",
    ] as const) {
      expect(stageLayoutFor(view, false)).toBe("stage");
    }
    expect(stageLayoutFor("appShell", false)).toBeNull();
  });

  it("holds the stage under the shell while the gate or the handoff lifts it away", () => {
    expect(stageLayoutFor("appShell", true)).toBe("stage");
  });
});

describe("StagePlate", () => {
  it("stands the wake beside her column: Waking up and at rest, then Ready and hi once the desk is", () => {
    stand("splash");
    const { container } = render(<StagePlate />);
    const root = container.querySelector("[data-vex-stage-plate]");
    expect(root?.getAttribute("data-vex-stage-plate")).toBe("stage");
    expect(root?.hasAttribute("data-vex-motion-opacity")).toBe(true);
    // No K2, no print, no plate.
    expect(container.querySelector("[data-vex-k2]")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(keyOf(container)?.textContent).toContain("Waking up");
    expect(sectionOf(container)?.getAttribute("data-kimm-mood")).toBe("rest");
    // She has no wake episode: her stage calls her awake as it stands, so the
    // pipeline's handoff alone makes the desk ready.
    expect(getStageVex().woken).toBe(true);
    act(() => stageVexPipelineReady());
    expect(keyOf(container)?.textContent).toContain("Ready");
    expect(sectionOf(container)?.getAttribute("data-kimm-mood")).toBe("hi");
    // The launch's own unlock keeps the launch.
    act(() => stand("unlock"));
    expect(getStageVex().launching).toBe(true);
  });

  it("sleeps and rests beside the unlock after Lock Vex; the lock is the title cell's word", () => {
    stageVexEnd();
    stand("unlock");
    const { container } = render(<StagePlate />);
    const key = keyOf(container);
    expect(key?.textContent).toContain("Sleeping");
    expect(key?.textContent).not.toContain("Locked");
    expect(key?.getAttribute("data-vex-state")).toBe("sleeping");
    expect(sectionOf(container)?.getAttribute("data-kimm-mood")).toBe("rest");
  });

  it("is concerned over a wrong password or a throttle, the seconds beside the word", () => {
    stageVexEnd();
    stand("unlock");
    const { container } = render(<StagePlate />);
    act(() => stageVexConcerned(true, 28));
    expect(keyOf(container)?.textContent).toContain("Concerned");
    expect(keyOf(container)?.textContent).toContain("0:28");
    // Concerned beside her section rests, as Cloud's chat seat does.
    expect(sectionOf(container)?.getAttribute("data-kimm-mood")).toBe("rest");
  });

  it("stands a first run screen beside her H3 column: the Vex key, her section and the tagline", () => {
    stand("runtimeBootstrap");
    const { container } = render(<StagePlate />);
    // The first run is past the launch.
    expect(getStageVex().launching).toBe(false);
    const key = keyOf(container);
    expect(key?.getAttribute("aria-label")).toBe("Hide Vex");
    const section = sectionOf(container);
    expect(section?.getAttribute("data-kimm-open")).toBe("true");
    // Her art is the app's shipped art: missing until it arrives, so her ground alone.
    expect(section?.getAttribute("data-kimm-art")).toBe("missing");
    expect(section?.querySelector("img")).toBeNull();
    // The tagline, on every stage screen.
    expect(container.querySelector("[data-vex-tagline]")?.textContent).toBe(
      "An AI trading agent, on your computer.",
    );
    // A face set by the screen reaches the key (the word, the timer) and her mood.
    act(() => stageVexFace({ state: "working", word: "Working", note: "0:14", mood: "think" }));
    expect(key?.textContent).toContain("Working");
    expect(key?.textContent).toContain("0:14");
    expect(key?.getAttribute("data-vex-state")).toBe("working");
    expect(section?.getAttribute("data-kimm-mood")).toBe("think");
  });

  it("hides and shows her through the shell's own stored choice, from the key and from her corner", () => {
    useUiStore.setState({ vexOpenPages: false });
    stand("systemCheck");
    const { container } = render(<StagePlate />);
    act(() => keyOf(container)?.click());
    expect(useUiStore.getState().vexOpenChat).toBe(false);
    // The table pages' choice is not hers on the stage.
    expect(useUiStore.getState().vexOpenPages).toBe(false);
    expect(sectionOf(container)?.getAttribute("data-kimm-open")).toBe("false");
    act(() => container.querySelector<HTMLElement>("[data-vex-area='kimm-key']")?.click());
    expect(useUiStore.getState().vexOpenChat).toBe(true);
  });

  it("binds the chord once while her stage stands, and leaves it to the shell under the crossfade", () => {
    stand("systemCheck");
    render(<StagePlate />);
    // One of the platform's two spellings: Ctrl on Windows and Linux, Cmd on a Mac.
    const press = (mods: { readonly ctrlKey: boolean; readonly metaKey: boolean }): void => {
      act(() => {
        document.dispatchEvent(
          new KeyboardEvent("keydown", { code: "KeyB", key: "B", shiftKey: true, ...mods, bubbles: true }),
        );
      });
    };
    press({ ctrlKey: true, metaKey: false });
    press({ ctrlKey: false, metaKey: true });
    // Exactly one of the two spellings is this platform's: she closed once.
    expect(useUiStore.getState().vexOpenChat).toBe(false);
    // The shell takes over under the crossfade: the stage binds nothing then.
    act(() => useUiStore.setState({ currentView: "appShell", unlockCurtainActive: true }));
    press({ ctrlKey: true, metaKey: false });
    press({ ctrlKey: false, metaKey: true });
    expect(useUiStore.getState().vexOpenChat).toBe(false);
  });

  it("renders nothing while the shell stands, and ends the launch when it has gone", () => {
    stand("splash");
    const view = render(<StagePlate />);
    expect(getStageVex().launching).toBe(true);
    act(() => stand("appShell"));
    expect(view.container.querySelector("[data-vex-stage-plate]")).toBeNull();
    expect(getStageVex().launching).toBe(false);
  });

  it("holds under the shell until the exit, and marks the exit for the crossfade", () => {
    stand("splash");
    const view = render(<StagePlate />);
    act(() => useUiStore.setState({ currentView: "appShell" }));
    const root = view.container.querySelector("[data-vex-stage-plate]");
    expect(root?.getAttribute("data-vex-stage-exit")).toBe("idle");
    act(() => stageVexExit());
    expect(
      view.container.querySelector("[data-vex-stage-plate]")?.getAttribute("data-vex-stage-exit"),
    ).toBe("reveal");
    act(() => useUiStore.setState({ setupGateActive: false }));
    expect(view.container.querySelector("[data-vex-stage-plate]")).toBeNull();
    expect(getStageVex().exit).toBe("idle");
  });
});
