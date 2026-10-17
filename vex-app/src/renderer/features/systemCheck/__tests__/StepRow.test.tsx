/**
 * Pin status → badge wording mapping. Drift here would silently mislead
 * the user about whether a probe passed.
 *
 * `badgeLabel` decouples the visible chip text from `StepStatus` so screens
 * can surface contextual wording (READY, SETUP, etc.) without changing the
 * semantic state value; the default mapping is asserted here for the four
 * canonical states.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { StepRow, type StepStatus } from "../StepRow.js";

function dummyIcon(): JSX.Element {
  return <svg aria-hidden data-testid="icon" />;
}

describe("StepRow", () => {
  afterEach(cleanup);

  it.each<[StepStatus, string]>([
    ["loading", "CHECKING…"],
    ["ok", "OK"],
    ["warn", "WARN"],
    ["fail", "FAIL"],
  ])("renders default status badge for %s", (status, expectedText) => {
    const { getByText } = render(
      <StepRow label="Probe" status={status} detail={null} icon={dummyIcon()} />,
    );
    expect(getByText(expectedText)).toBeDefined();
  });

  it("renders explicit badgeLabel overriding the default for the status", () => {
    const { getByText, queryByText } = render(
      <StepRow
        label="Local runtime"
        status="ok"
        detail={null}
        icon={dummyIcon()}
        badgeLabel="READY"
      />,
    );
    expect(getByText("READY")).toBeDefined();
    expect(queryByText("OK")).toBeNull();
  });

  it("renders detail line when provided", () => {
    const { getByText } = render(
      <StepRow
        label="Operating system"
        status="ok"
        detail="Linux / x64"
        icon={dummyIcon()}
      />,
    );
    expect(getByText("Linux / x64")).toBeDefined();
  });

  it("omits the detail span when detail is null", () => {
    const { container } = render(
      <StepRow
        label="Network"
        status="loading"
        detail={null}
        icon={dummyIcon()}
      />,
    );
    // Detail line is the only `text-[11px]` span in the row; label is the
    // standard `text-sm` and the badge uses `text-[10px]`.
    expect(container.querySelectorAll(".text-\\[11px\\]").length).toBe(0);
  });

  it("exposes status as data attribute (CSS hooks + e2e selectors)", () => {
    const { container } = render(
      <StepRow label="x" status="warn" detail={null} icon={dummyIcon()} />,
    );
    expect(container.querySelector('[data-step-status="warn"]')).not.toBeNull();
  });

  it("renders the supplied icon inside the icon slot", () => {
    const { getByTestId } = render(
      <StepRow label="x" status="ok" detail={null} icon={dummyIcon()} />,
    );
    expect(getByTestId("icon")).toBeDefined();
  });
});
