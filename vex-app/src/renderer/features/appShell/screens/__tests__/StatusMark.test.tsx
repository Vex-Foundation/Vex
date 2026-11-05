/**
 * StatusMark - H3's status for an activity row (docs/design/H3-DESKTOP.md
 * section 2.2, A.3): a word beside a small square with its own drawing for
 * each status (VEX Cloud's StateDot, PD-03). Pins the reading of the row
 * rules' answer into H3's families (filled solid green, running the blinking
 * hud, failed the refusal cross, Status unknown the concerned hatch, waiting
 * the target) and the quiet frame for a word this build has never heard of,
 * and that the square is decoration.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { SwatchState } from "../../../../components/ui/swatch.js";
import {
  STATUS_FAMILY_SQUARE,
  StatusMark,
  outcomeStatus,
  type StatusFamily,
} from "../agent-scan/StatusMark.js";

afterEach(() => {
  cleanup();
});

describe("outcomeStatus", () => {
  const CASES: ReadonlyArray<readonly [SwatchState, string, StatusFamily]> = [
    ["done", "Confirmed", "filled"],
    ["listening", "Submitted, awaiting confirmation", "running"],
    ["listening", "Pending", "running"],
    ["error", "Failed", "failed"],
    // Nobody knows the outcome: Cloud's concerned hatch, never the cross.
    ["error", "Status unknown", "concerned"],
    // The rules keep Refunded apart as idle; A.3 lists it under DID NOT EXECUTE.
    ["idle", "Refunded", "failed"],
    ["idle", "Quarantined", "unknown"],
  ];

  it.each(CASES)("%s / %s reads as %s", (state, word, family) => {
    expect(outcomeStatus(state, word)).toBe(family);
  });
});

describe("StatusMark", () => {
  it("draws the word in the DOM's sentence case beside a hidden square", () => {
    const { container } = render(<StatusMark status="filled" word="Confirmed" />);
    const mark = container.querySelector(".vex-status-mark");
    expect(mark?.getAttribute("data-status")).toBe("filled");
    expect(mark?.textContent).toBe("Confirmed");
    expect(mark?.querySelector(".vex-status-mark__sq")?.getAttribute("aria-hidden")).toBe("true");
  });

  it.each([
    ["filled", "done"],
    ["running", "ongoing"],
    ["failed", "error"],
    ["concerned", "concerned"],
    ["unknown", "idle"],
    ["waiting", "warning"],
  ] as const)("draws %s with the %s square, 6px in a row", (status, square) => {
    const { container } = render(<StatusMark status={status} word="Word" />);
    const sq = container.querySelector(".vex-sq");
    expect(sq?.getAttribute("data-state")).toBe(square);
    expect((sq as HTMLElement | null)?.style.width).toBe("6px");
  });

  it("gives every family a drawing of its own, so a colour never stands alone", () => {
    const squares = Object.values(STATUS_FAMILY_SQUARE);
    expect(new Set(squares).size).toBe(squares.length);
  });
});
