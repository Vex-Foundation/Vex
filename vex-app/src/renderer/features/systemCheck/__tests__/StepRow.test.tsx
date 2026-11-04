/**
 * Pin status → state word mapping. Drift here would silently mislead
 * the user about whether a probe passed.
 *
 * `badgeLabel` decouples the visible word from `StepStatus` so screens
 * can surface contextual wording (Ready, Setup, etc.) without changing the
 * semantic state value; the default mapping is asserted here for the four
 * canonical states, each with H3's square (docs/design/H3-DESKTOP.md section
 * 2.2): grey while checking, green ok, ink a warning, red a failure.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { StepRow, type StepStatus } from "../StepRow.js";

describe("StepRow", () => {
  afterEach(cleanup);

  it.each<[StepStatus, string, string]>([
    ["loading", "Checking", "running"],
    ["ok", "OK", "done"],
    ["warn", "Warning", "ink"],
    ["fail", "Failed", "failed"],
  ])("renders the default word and square for %s", (status, expectedText, square) => {
    const { getByText, container } = render(
      <StepRow label="Probe" status={status} detail={null} />,
    );
    expect(getByText(expectedText)).toBeDefined();
    expect(container.querySelector(`.vex-pre-sq[data-sq="${square}"]`)).not.toBeNull();
    expect(container.querySelector(".vex-swatch")).toBeNull();
  });

  it("renders explicit badgeLabel overriding the default for the status", () => {
    const { getByText, queryByText } = render(
      <StepRow label="Local runtime" status="ok" detail={null} badgeLabel="Ready" />,
    );
    expect(getByText("Ready")).toBeDefined();
    expect(queryByText("OK")).toBeNull();
  });

  it("renders detail line when provided, in the figure face", () => {
    const { getByText } = render(
      <StepRow label="Operating system" status="ok" detail="Linux / x64" />,
    );
    const detail = getByText("Linux / x64");
    expect(detail.className).toContain("vex-fr-probe__d");
    expect(detail.className).toContain("vex-num");
  });

  it("omits the detail span when detail is null", () => {
    const { container } = render(
      <StepRow label="Network" status="loading" detail={null} />,
    );
    expect(container.querySelectorAll(".vex-fr-probe__d")).toHaveLength(0);
  });

  it("exposes status as data attribute (CSS hooks + e2e selectors)", () => {
    const { container } = render(<StepRow label="x" status="warn" detail={null} />);
    expect(container.querySelector('[data-step-status="warn"]')).not.toBeNull();
  });

  it("marks only a probe in flight as live", () => {
    const loading = render(<StepRow label="x" status="loading" detail={null} />);
    expect(loading.container.querySelector("[data-live]")).not.toBeNull();
    cleanup();
    const done = render(<StepRow label="x" status="ok" detail={null} />);
    expect(done.container.querySelector("[data-live]")).toBeNull();
  });
});
