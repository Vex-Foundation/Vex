/**
 * The stage's persistent plate (`PreShellStage.tsx`, `docs/design/R3-MINIMAL.md section 10`): which
 * layout each view takes, that the wake and the unlock stand on the plate with Vex's word on it,
 * that the first run screens keep a plain print, and that the plate leaves with the stage.
 *
 * jsdom paints no canvas and gives her host no size, so the K2 engine loads no art here.
 */

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useUiStore, type View } from "../../../stores/uiStore.js";
import {
  StagePlate,
  stageLayoutFor,
  StageHead,
  VersionStamp,
} from "../PreShellStage.js";
import {
  getStageVex,
  resetStageVex,
  stageVexEnd,
  stageVexExit,
  stageVexPipelineReady,
  stageVexWoken,
} from "../stage-vex.js";

function stand(view: View, holding = false): void {
  useUiStore.setState({
    currentView: view,
    setupGateActive: view === "splash" ? true : holding,
    unlockCurtainActive: false,
  });
}

beforeEach(() => {
  resetStageVex();
});

afterEach(() => {
  cleanup();
  resetStageVex();
  useUiStore.setState({ currentView: "splash", setupGateActive: true });
});

describe("stageLayoutFor", () => {
  it("puts the wake and the unlock on the plate, the first run on the print, the shell on nothing", () => {
    expect(stageLayoutFor("splash", false)).toBe("plate");
    expect(stageLayoutFor("unlock", false)).toBe("plate");
    for (const view of [
      "systemCheck",
      "dockerBootstrap",
      "composeBootstrap",
      "migrations",
      "wizard",
    ] as const) {
      expect(stageLayoutFor(view, false)).toBe("print");
    }
    expect(stageLayoutFor("appShell", false)).toBeNull();
  });

  it("holds the plate under the shell while the gate or the handoff lifts it away", () => {
    expect(stageLayoutFor("appShell", true)).toBe("plate");
  });
});

describe("StagePlate", () => {
  it("stands the wake on a 720 plate: both prints, the grain, her host and her word", () => {
    stand("splash");
    const { container, getByText } = render(<StagePlate />);
    const root = container.querySelector("[data-vex-stage-plate]");
    expect(root?.getAttribute("data-vex-stage-plate")).toBe("plate");
    expect(root?.hasAttribute("data-vex-motion-opacity")).toBe(true);
    expect(container.querySelectorAll(".vex-stage-plate__img")).toHaveLength(2);
    expect(container.querySelector("[data-vex-print-grain]")).not.toBeNull();
    const host = container.querySelector("[data-vex-k2]");
    expect(host?.getAttribute("data-vex-k2")).toBe("stage");
    expect(host?.getAttribute("data-vex-k2-ground")).toBe("print");
    // A state is a fill and a word: she is waking up.
    expect(getByText("Waking up")).toBeTruthy();
    expect(container.querySelector('.vex-stage-plate__word [data-s="listening"]')).not.toBeNull();
    // There is no eagle and no flock canvas of the old print plate.
    expect(container.querySelector("[data-vex-print-plate]")).toBeNull();
  });

  it("says Ready once she has woken and the desk is ready", () => {
    stand("unlock");
    const { getByText, queryByText } = render(<StagePlate />);
    expect(getByText("Waking up")).toBeTruthy();
    act(() => {
      stageVexWoken();
      stageVexPipelineReady();
    });
    expect(getByText("Ready")).toBeTruthy();
    expect(queryByText("Waking up")).toBeNull();
  });

  it("sleeps on a locked desk with 'Locked' beside the word, and never wakes from the token", () => {
    stageVexEnd();
    stand("unlock");
    const { container, getByText } = render(<StagePlate />);
    expect(getByText("Sleeping")).toBeTruthy();
    expect(getByText("Locked")).toBeTruthy();
    expect(container.querySelector('.vex-stage-plate__word [data-s="sleeping"]')).not.toBeNull();
  });

  it("keeps the first run screens on a plain print with no animal and no state word", () => {
    stand("systemCheck");
    const { container } = render(<StagePlate />);
    expect(container.querySelector("[data-vex-stage-plate]")?.getAttribute("data-vex-stage-plate")).toBe(
      "print",
    );
    expect(container.querySelector(".vex-stage-plate__full")).not.toBeNull();
    expect(container.querySelector("[data-vex-k2]")).toBeNull();
    expect(container.querySelector(".vex-stage-plate__word")).toBeNull();
  });

  it("renders nothing while the shell stands, and ends the launch's wake when it leaves the plate", () => {
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

describe("VersionStamp and StageHead", () => {
  it("stamps the running version in mono, small", () => {
    const { container } = render(<VersionStamp />);
    const stamp = container.querySelector("[data-vex-version-stamp]");
    expect(stamp?.textContent).toBe("v0.0.0-test");
    expect(stamp?.classList.contains("vex-num")).toBe(true);
  });

  it("keeps the head row as a drag region with no mark", () => {
    const { container } = render(<StageHead />);
    const head = container.firstElementChild;
    expect(head?.classList.contains("vex-drag")).toBe(true);
    expect(head?.getAttribute("aria-hidden")).toBe("true");
    expect(head?.childElementCount).toBe(0);
  });
});
