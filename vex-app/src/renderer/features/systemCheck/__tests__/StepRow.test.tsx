/**
 * Pin status → state word mapping. Drift here would silently mislead
 * the user about whether a probe passed.
 *
 * `badgeLabel` decouples the visible word from `StepStatus` so screens
 * can surface contextual wording (Ready, Setup, etc.) without changing the
 * semantic state value; the default mapping is asserted here for the four
 * canonical states, each with its fill (a state is a fill and a word).
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { StepRow, type StepStatus } from "../StepRow.js";

describe("StepRow", () => {
  afterEach(cleanup);

  it.each<[StepStatus, string, string]>([
    ["loading", "Checking", "ongoing"],
    ["ok", "OK", "done"],
    ["warn", "Warning", "warning"],
    ["fail", "Failed", "error"],
  ])("renders the default word and fill for %s", (status, expectedText, fill) => {
    const { getByText, container } = render(
      <StepRow label="Probe" status={status} detail={null} />,
    );
    expect(getByText(expectedText)).toBeDefined();
    expect(container.querySelector(`.vex-swatch[data-s="${fill}"]`)).not.toBeNull();
  });

  it("renders explicit badgeLabel overriding the default for the status", () => {
    const { getByText, queryByText } = render(
      <StepRow label="Docker" status="ok" detail={null} badgeLabel="Ready" />,
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

  it("reads blue only while the probe is in flight", () => {
    const loading = render(<StepRow label="x" status="loading" detail={null} />);
    expect(loading.container.querySelector("[data-live]")).not.toBeNull();
    cleanup();
    const done = render(<StepRow label="x" status="ok" detail={null} />);
    expect(done.container.querySelector("[data-live]")).toBeNull();
  });
});
