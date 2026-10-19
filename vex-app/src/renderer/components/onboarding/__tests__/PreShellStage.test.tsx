/**
 * The stage's persistent plate (`PreShellStage.tsx`, `docs/design/R3-MINIMAL.md section 10`): which
 * layout each view takes, that the wake, the unlock and the first run screens stand on the plate
 * with no state word under Vex (the owner, 2026-10-18: the state lives in the title bar chip and
 * the Vex sidebar), that the wizard keeps a plain print, and that the plate leaves with the stage.
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
  stageVexConcerned,
  stageVexEnd,
  stageVexExit,
  stageVexFace,
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
  it("puts the wake, the unlock and the first run on the plate, the wizard on the print, the shell on nothing", () => {
    for (const view of [
      "splash",
      "unlock",
      "systemCheck",
      "runtimeMigration",
      "runtimeBootstrap",
      "migrations",
    ] as const) {
      expect(stageLayoutFor(view, false)).toBe("plate");
    }
    expect(stageLayoutFor("wizard", false)).toBe("print");
    expect(stageLayoutFor("appShell", false)).toBeNull();
  });

  it("holds the plate under the shell while the gate or the handoff lifts it away", () => {
    expect(stageLayoutFor("appShell", true)).toBe("plate");
  });
});

describe("StagePlate", () => {
  it("stands the wake on a 720 plate: both prints, the grain and her host, no word under her", () => {
    stand("splash");
    const { container, queryByText } = render(<StagePlate />);
    const root = container.querySelector("[data-vex-stage-plate]");
    expect(root?.getAttribute("data-vex-stage-plate")).toBe("plate");
    expect(root?.hasAttribute("data-vex-motion-opacity")).toBe(true);
    expect(container.querySelectorAll(".vex-stage-plate__img")).toHaveLength(2);
    expect(container.querySelector("[data-vex-print-grain]")).not.toBeNull();
    const host = container.querySelector("[data-vex-k2]");
    expect(host?.getAttribute("data-vex-k2")).toBe("stage");
    expect(host?.getAttribute("data-vex-k2-ground")).toBe("print");
    // The owner: no state word on the plate, not even while she wakes.
    expect(queryByText("Waking up")).toBeNull();
    expect(container.querySelector(".vex-stage-plate__word")).toBeNull();
    expect(container.querySelector("[data-s]")).toBeNull();
    expect(container.textContent).toBe("");
    // There is no eagle and no flock canvas of the old print plate.
    expect(container.querySelector("[data-vex-print-plate]")).toBeNull();
  });

  it("says no Ready once she has woken and the desk is ready", () => {
    stand("unlock");
    const { container, queryByText } = render(<StagePlate />);
    expect(queryByText("Waking up")).toBeNull();
    act(() => {
      stageVexWoken();
      stageVexPipelineReady();
    });
    expect(queryByText("Ready")).toBeNull();
    expect(container.querySelector("[data-vex-k2]")).not.toBeNull();
    expect(container.textContent).toBe("");
  });

  it("sleeps on a locked desk with no 'Sleeping · Locked' under her", () => {
    stageVexEnd();
    stand("unlock");
    const { container, queryByText } = render(<StagePlate />);
    expect(queryByText("Sleeping")).toBeNull();
    expect(queryByText("Locked")).toBeNull();
    expect(container.querySelector("[data-s]")).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("draws no word for a wrong password or a throttle either (the form says it)", () => {
    stageVexEnd();
    stand("unlock");
    const { container, queryByText } = render(<StagePlate />);
    act(() => stageVexConcerned(true, 28));
    expect(queryByText("Concerned")).toBeNull();
    expect(queryByText("0:28")).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("keeps the wizard on a plain print with no animal and no state word", () => {
    stand("wizard");
    const { container } = render(<StagePlate />);
    expect(container.querySelector("[data-vex-stage-plate]")?.getAttribute("data-vex-stage-plate")).toBe(
      "print",
    );
    expect(container.querySelector(".vex-stage-plate__full")).not.toBeNull();
    expect(container.querySelector("[data-vex-k2]")).toBeNull();
    expect(container.querySelector(".vex-stage-plate__word")).toBeNull();
  });

  it("stands a first run screen on the plate with no word for what she shows", () => {
    stageVexEnd();
    stand("runtimeBootstrap");
    const { container, queryByText } = render(<StagePlate />);
    expect(container.querySelector("[data-vex-stage-plate]")?.getAttribute("data-vex-stage-plate")).toBe(
      "plate",
    );
    expect(container.querySelector("[data-vex-k2]")?.getAttribute("data-vex-k2")).toBe("stage");
    expect(container.querySelector(".vex-stage-plate__full")).toBeNull();
    expect(queryByText("Sleeping")).toBeNull();
    act(() =>
      stageVexFace({ emotion: "working", swatch: "done", word: "Working", note: "0:14" }),
    );
    // Her face works; no word or timer stands under her on the print.
    expect(queryByText("Working")).toBeNull();
    expect(queryByText("0:14")).toBeNull();
    expect(container.querySelector("[data-s]")).toBeNull();
    expect(container.textContent).toBe("");
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
