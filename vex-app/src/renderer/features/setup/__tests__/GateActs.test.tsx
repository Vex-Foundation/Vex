/**
 * The Chronos Gate's content (`ChronosGate/GateActs.tsx`, docs/design/H3-DESKTOP.md section 4.9;
 * the plate `stage-wake`): the wake on H3's stage, bound to the REAL launch pipeline. Regressions
 * this catches: a step that is not one of the orchestrator's five, a meter that is not the stage's,
 * a title that does not carry the live detail, a missing version, a frame that covers her column,
 * or an R3 plate, counter or ground row coming back.
 */

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { GateActs, WAKE_SEGMENTS } from "../ChronosGate/GateActs.js";
import { GATE_STEPS, STAGE_PROGRESS } from "../ChronosGate/gate-timeline.js";
import type { SetupStatusLine } from "../useSetupOrchestrator.js";

afterEach(cleanup);

function line(key: SetupStatusLine["key"], label?: string): SetupStatusLine {
  const name = GATE_STEPS.find((step) => step.key === key)?.name ?? key;
  return { key, label: label ?? name };
}

function stepsOf(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>("nav li[data-vex-gate-step]")];
}

describe("GateActs", () => {
  it("names the five real stages, in order", () => {
    expect(GATE_STEPS.map((step) => step.key)).toEqual([
      "probing",
      "services",
      "schema",
      "ledger",
      "ready",
    ]);
    expect(GATE_STEPS.map((step) => step.name)).toEqual([
      "Waking the desk",
      "Starting services",
      "Preparing the ledger",
      "Reading your setup",
      "Ready",
    ]);
  });

  it("stands on the stage frame over her column: the title cell, the lead row, the steps and the version", () => {
    const { container, getByRole, getByText } = render(<GateActs status={line("probing")} />);
    const frame = container.querySelector('main[data-vex-screen="wake"]');
    expect(frame?.classList.contains("vex-pre")).toBe(true);
    // Laid over her column: its middle column is left to her.
    expect(frame?.classList.contains("vex-pre--over")).toBe(true);
    expect(getByRole("heading", { name: "Waking the desk" })).toBeTruthy();
    expect(container.querySelector(".vex-pre__sub")?.textContent).toBe("Step 1 of 5");
    expect(getByText("Vex is starting the local services on this machine.")).toBeTruthy();
    expect(getByRole("navigation", { name: "Waking the desk" })).toBeTruthy();
    expect(stepsOf(container).map((li) => li.querySelector(".vex-pre__step-name")?.textContent)).toEqual(
      GATE_STEPS.map((step) => step.name),
    );
    expect(container.querySelector("[data-vex-version-stamp]")?.textContent).toBe("v0.0.0-test");
    expect(container.querySelector(".vex-stage-counter")).toBeNull();
    expect(container.querySelector(".vex-stage-ground")).toBeNull();
  });

  it("marks the current stage: done behind it, the grey square on it, an outline ahead", () => {
    const { container } = render(<GateActs status={line("schema")} />);
    const items = stepsOf(container);
    expect(items.map((li) => li.getAttribute("aria-current"))).toEqual([
      null,
      null,
      "step",
      null,
      null,
    ]);
    expect(items.map((li) => li.querySelector(".vex-pre-sq")?.getAttribute("data-sq"))).toEqual([
      "done",
      "done",
      "running",
      "none",
      "none",
    ]);
    expect(items.map((li) => li.querySelector(".vex-pre__step-word")?.textContent ?? null)).toEqual([
      "Done",
      "Done",
      null,
      null,
      null,
    ]);
    expect(container.querySelector(".vex-pre__sub")?.textContent).toBe("Step 3 of 5");
  });

  it("carries the live detail in the title cell, the step's own name in the column", () => {
    const { container } = render(
      <GateActs status={line("services", "Starting services · pulling images")} />,
    );
    expect(container.querySelector(".vex-pre__title h1")?.textContent).toBe(
      "Starting services · pulling images",
    );
    expect(stepsOf(container)[1]?.querySelector(".vex-pre__step-name")?.textContent).toBe(
      "Starting services",
    );
  });

  it("lights the meter as far as the stage has come, as a labelled progressbar", () => {
    for (const step of GATE_STEPS) {
      const { container, unmount } = render(<GateActs status={line(step.key)} />);
      const percent = Math.round(STAGE_PROGRESS[step.key] * 100);
      const bar = container.querySelector('[role="progressbar"]');
      expect(bar?.getAttribute("aria-valuenow")).toBe(String(percent));
      expect(bar?.getAttribute("aria-label")).toBe("Waking the desk");
      const segments = [...container.querySelectorAll(".vex-pre-meter__segments > i")];
      expect(segments).toHaveLength(WAKE_SEGMENTS);
      expect(segments.filter((i) => i.hasAttribute("data-on"))).toHaveLength(
        Math.round((percent / 100) * WAKE_SEGMENTS),
      );
      expect(container.querySelector(".vex-pre-meter__figure")?.textContent).toBe(`${String(percent)}%`);
      unmount();
    }
  });

  it("announces the stage politely once, as a status", () => {
    const { getByRole } = render(<GateActs status={line("ledger")} />);
    const status = getByRole("status");
    expect(status.textContent).toBe("Reading your setup");
    expect(status.getAttribute("aria-live")).toBe("polite");
  });

  it("only ever advances the meter", () => {
    const values = GATE_STEPS.map((step) => STAGE_PROGRESS[step.key]);
    expect([...values].sort((a, b) => a - b)).toEqual(values);
    expect(values[values.length - 1]).toBe(1);
  });
});
