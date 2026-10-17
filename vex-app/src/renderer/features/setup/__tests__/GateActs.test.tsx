/**
 * The Chronos Gate's content (`ChronosGate/GateActs.tsx`, `docs/design/R3-MINIMAL.md section 10.2`):
 * the wake screen's type, bound to the REAL launch pipeline. Regressions this catches: a stage line
 * that is not one of the orchestrator's five, a progress line that is not the stage's, a current
 * line that does not carry the live detail, a missing version stamp, or an eagle and a giant
 * counter coming back.
 */

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { GateActs } from "../ChronosGate/GateActs.js";
import { GATE_STEPS, STAGE_PROGRESS } from "../ChronosGate/gate-timeline.js";
import type { SetupStatusLine } from "../useSetupOrchestrator.js";

afterEach(cleanup);

function line(key: SetupStatusLine["key"], label?: string): SetupStatusLine {
  const name = GATE_STEPS.find((step) => step.key === key)?.name ?? key;
  return { key, label: label ?? name };
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

  it("shows the title, the lead, the stage lines and the version stamp, with no counter", () => {
    const { container, getByRole, getByText } = render(<GateActs status={line("probing")} />);
    expect(getByRole("heading", { name: "Waking the desk" })).toBeTruthy();
    expect(getByText("Vex is starting the local services on this machine.")).toBeTruthy();
    const items = [...container.querySelectorAll(".vex-gate-steps li")];
    expect(items.map((li) => li.textContent)).toEqual(GATE_STEPS.map((step) => step.name));
    expect(container.querySelector("[data-vex-version-stamp]")?.textContent).toBe("v0.0.0-test");
    expect(container.querySelector(".vex-stage-counter")).toBeNull();
    expect(container.querySelector(".vex-stage-ground")).toBeNull();
  });

  it("marks the current stage, solid behind it and an outline ahead of it", () => {
    const { container } = render(<GateActs status={line("schema")} />);
    const items = [...container.querySelectorAll(".vex-gate-steps li")];
    expect(items.map((li) => li.getAttribute("aria-current"))).toEqual([
      null,
      null,
      "step",
      null,
      null,
    ]);
    expect(items.map((li) => li.querySelector(".vex-swatch")?.getAttribute("data-s"))).toEqual([
      "done",
      "done",
      "done",
      "idle",
      "idle",
    ]);
  });

  it("carries the live detail on the current line only", () => {
    const { container } = render(
      <GateActs status={line("services", "Starting services · pulling images")} />,
    );
    const items = [...container.querySelectorAll(".vex-gate-steps li")];
    expect(items[1]?.textContent).toBe("Starting services · pulling images");
    expect(items[2]?.textContent).toBe("Preparing the ledger");
  });

  it("fills the progress line as far as the stage has come, as a labelled progressbar", () => {
    for (const step of GATE_STEPS) {
      const { container, unmount } = render(<GateActs status={line(step.key)} />);
      const bar = container.querySelector('[role="progressbar"]');
      expect(bar?.getAttribute("aria-valuenow")).toBe(String(Math.round(STAGE_PROGRESS[step.key] * 100)));
      expect(bar?.getAttribute("aria-label")).toBe("Waking the desk");
      const fill = container.querySelector<HTMLElement>(".vex-gate-progress__fill");
      expect(fill?.style.getPropertyValue("--chronos-progress")).toBe(String(STAGE_PROGRESS[step.key]));
      unmount();
    }
  });

  it("announces the stage politely once, as a status", () => {
    const { getByRole } = render(<GateActs status={line("ledger")} />);
    const status = getByRole("status");
    expect(status.textContent).toBe("Reading your setup");
    expect(status.getAttribute("aria-live")).toBe("polite");
  });

  it("only ever advances the progress line", () => {
    const values = GATE_STEPS.map((step) => STAGE_PROGRESS[step.key]);
    expect([...values].sort((a, b) => a - b)).toEqual(values);
    expect(values[values.length - 1]).toBe(1);
  });
});
