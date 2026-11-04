/**
 * StatusMark - H3's status for an activity row (docs/design/H3-DESKTOP.md
 * section 2.2, A.3): an ink word beside a small square that alone carries the
 * colour. Pins the reading of the row rules' answer into H3's three colours
 * (filled green, running grey, did-not-execute red) and the quiet outline for
 * a word this build has never heard of, and that the square is decoration.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { SwatchState } from "../../../../components/ui/swatch.js";
import { StatusMark, outcomeStatus, type StatusFamily } from "../agent-scan/StatusMark.js";

afterEach(() => {
  cleanup();
});

describe("outcomeStatus", () => {
  const CASES: ReadonlyArray<readonly [SwatchState, string, StatusFamily]> = [
    ["done", "Confirmed", "filled"],
    ["listening", "Submitted, awaiting confirmation", "running"],
    ["listening", "Pending", "running"],
    ["error", "Failed", "failed"],
    ["error", "Status unknown", "failed"],
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
});
