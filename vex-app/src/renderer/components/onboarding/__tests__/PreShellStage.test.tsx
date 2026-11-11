/**
 * Her stage before the shell (`PreShellStage.tsx`, docs/design/H3-DESKTOP.md section 4.9): every
 * pre-shell view but the unlock stands beside her H3 column (the shell's own Vex key, Kimm's
 * section and the tagline); the unlock is the lock screen's own split (section 4.13), so her stage
 * stands over it only while the gate lifts away. What she shows follows the stage store (the wake,
 * a concern, a screen's face), her choice is the shell's stored one, the chord is bound once, and
 * the stage holds under the shell until its exit.
 *
 * jsdom paints no canvas, so her glyph field draws nothing here; her art is the app's shipped art
 * (VEX Cloud's renders in `public/art/kimm/`), so her section draws her real still.
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
  it("stands every pre-shell view but the unlock on H3's stage, and the shell on nothing", () => {
    for (const view of [
      "splash",
      "systemCheck",
      "runtimeMigration",
      "runtimeBootstrap",
      "migrations",
      "wizard",
    ] as const) {
      expect(stageLayoutFor(view, false)).toBe("stage");
    }
    // The lock screen is its own split (section 4.13): no stage beside it.
    expect(stageLayoutFor("unlock", false)).toBeNull();
    expect(stageLayoutFor("appShell", false)).toBeNull();
  });

  it("holds the stage over the shell or the unlock only while the gate lifts it away", () => {
    expect(stageLayoutFor("appShell", true)).toBe("stage");
    expect(stageLayoutFor("unlock", true)).toBe("stage");
  });
});

describe("StagePlate", () => {
  it("stands the wake beside her column: Waking up and at rest, then Ready and hi once the desk is", () => {
    stand("splash");
    const { container } = render(<StagePlate />);
    const root = container.querySelector("[data-vex-stage-plate]");
    expect(root?.getAttribute("data-vex-stage-plate")).toBe("stage");
    expect(root?.hasAttribute("data-vex-motion-opacity")).toBe(true);
    // No K2, no print, no plate: the only pictures are Kimm's own, from her seam.
    expect(container.querySelector("[data-vex-k2]")).toBeNull();
    for (const img of container.querySelectorAll("img")) {
      expect(img.getAttribute("src")).toMatch(/^\/art\/kimm\/(?:chip|still)-[a-z]+\.webp$/);
    }
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

  it("stands nothing beside the unlock after Lock Vex, and keeps the desk locked", () => {
    stageVexEnd();
    stand("unlock");
    const { container } = render(<StagePlate />);
    expect(container.querySelector("[data-vex-stage-plate]")).toBeNull();
    expect(getStageVex().launching).toBe(false);
  });

  it("stands nothing beside the launch's own unlock, and keeps the launch", () => {
    stand("unlock");
    const { container } = render(<StagePlate />);
    expect(container.querySelector("[data-vex-stage-plate]")).toBeNull();
    // "Welcome back.", not "Vex is locked.": the unlock still belongs to the launch.
    expect(getStageVex().launching).toBe(true);
  });

  it("lifts away with the gate over the unlock, then settles the spent crossfade and keeps the launch", () => {
    stand("splash");
    const view = render(<StagePlate />);
    // The gate hands off to the unlock beneath itself and lifts away: her stage goes with it.
    act(() => useUiStore.setState({ currentView: "unlock" }));
    const root = view.container.querySelector("[data-vex-stage-plate]");
    expect(root?.getAttribute("data-vex-stage-plate")).toBe("stage");
    act(() => stageVexExit());
    expect(
      view.container.querySelector("[data-vex-stage-plate]")?.getAttribute("data-vex-stage-exit"),
    ).toBe("reveal");
    act(() => useUiStore.setState({ setupGateActive: false }));
    expect(view.container.querySelector("[data-vex-stage-plate]")).toBeNull();
    expect(getStageVex().exit).toBe("idle");
    expect(getStageVex().launching).toBe(true);
    expect(getStageVex().woken).toBe(true);
  });

  it("is concerned over a wrong password or a throttle, the seconds beside the word", () => {
    // Only while the gate still lifts her stage away over the unlock does the concern reach her column.
    stageVexEnd();
    stand("unlock", true);
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
    // Her art is the app's shipped art: her real still for her mood.
    expect(section?.getAttribute("data-kimm-art")).toBe("ready");
    expect(section?.querySelector("img.vex-kimm__figure")?.getAttribute("src")).toBe(
      `/art/kimm/still-${section?.getAttribute("data-kimm-mood") ?? ""}.webp`,
    );
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

  it("draws her real art on every stage before the shell: the wake, the checks and the wizard", () => {
    for (const view of ["splash", "systemCheck", "runtimeMigration", "runtimeBootstrap", "migrations", "wizard"] as const) {
      stand(view);
      const { container, unmount } = render(<StagePlate />);
      const section = sectionOf(container);
      const mood = section?.getAttribute("data-kimm-mood") ?? "";
      const drawn = mood === "held" ? "offer" : mood;
      // Her section is open on the stage: her still for her mood, on the field's baked frame.
      expect({ view, art: section?.getAttribute("data-kimm-art") }).toEqual({ view, art: "ready" });
      expect(section?.querySelector("img.vex-kimm__figure")?.getAttribute("src"), view).toBe(
        `/art/kimm/still-${drawn}.webp`,
      );
      expect(section?.style.getPropertyValue("--vex-kimm-baked"), view).toBe('url("/art/kimm/field-still.webp")');
      expect(container.innerHTML, view).not.toMatch(/kimm-standin-/);
      unmount();
      resetStageVex();
    }
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

  it("keeps her glyph field under her strip while she is closed: the stage's column is never empty", () => {
    useUiStore.setState({ vexOpenChat: false });
    stand("migrations");
    const { container } = render(<StagePlate />);
    expect(sectionOf(container)?.getAttribute("data-kimm-open")).toBe("false");
    const ground = container.querySelector<HTMLElement>("[data-vex-area='vex-stage-ground']");
    expect(ground).not.toBeNull();
    // Her field's baked frame, drawn as her section draws its ground, and no figure.
    expect(ground?.classList.contains("vex-kimm__ground")).toBe(true);
    expect(ground?.getAttribute("aria-hidden")).toBe("true");
    expect(ground?.style.getPropertyValue("--vex-kimm-baked")).toBe('url("/art/kimm/field-still.webp")');
    expect(ground?.querySelector("img")).toBeNull();
    // Under her section, in the column she stands in.
    expect(ground?.parentElement?.getAttribute("data-vex-area")).toBe("vex-sidebar");
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
    act(() => useUiStore.setState({ currentView: "appShell", setupGateActive: true }));
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

  it("does not stand under the unlock's handoff to the shell: the lock screen had no stage to lift", () => {
    stand("unlock");
    const view = render(<StagePlate />);
    act(() => useUiStore.setState({ currentView: "appShell", unlockCurtainActive: true }));
    expect(view.container.querySelector("[data-vex-stage-plate]")).toBeNull();
    // The shell ends the launch: the next unlock, after Lock Vex, is the locked one.
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
