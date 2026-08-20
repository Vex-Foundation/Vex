/**
 * SidebarHomeSigil — the small STATIC logo mark that crowns the sessions rail
 * as the sole brand AND doubles as the "Back to welcome" control.
 *
 * Contract:
 *   1. on the welcome stage (no active session — the center panel is always
 *      the session panel since the Chronos screens redesign) it is an INERT
 *      mark — there is nowhere to navigate to, so no button;
 *   2. once a session is open it becomes a real "Back to welcome" button that
 *      clears the active session (returning the panel to the welcome stage);
 *   3. it always renders a plain <img> logo mark (never a "VEX" wordmark, never
 *      a canvas): the clean monogram, static, no animation.
 */

import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SidebarHomeSigil } from "../SidebarHomeSigil.js";
import { useUiStore } from "../../../stores/uiStore.js";

afterEach(() => {
  useUiStore.setState({
    activeSessionId: null,
  });
});

describe("SidebarHomeSigil", () => {
  it("is an inert logo mark on the welcome stage (no Back-to-welcome button)", () => {
    useUiStore.setState({ activeSessionId: null });
    const { container } = render(<SidebarHomeSigil sidebarOpen />);
    expect(
      screen.queryByRole("button", { name: /Back to welcome/i }),
    ).toBeNull();
    // Carries the static logo mark (clean monogram), no wordmark.
    const mark = container.querySelector("[data-vex-home-mark]");
    expect(mark).not.toBeNull();
    expect(mark?.querySelector("svg path")).not.toBeNull();
    expect(screen.queryByText("VEX")).toBeNull();
  });

  it("becomes a Back-to-welcome button when a session is open and clears it", () => {
    useUiStore.setState({
      activeSessionId: "11111111-1111-4111-8111-111111111111",
    });
    render(<SidebarHomeSigil sidebarOpen />);
    const button = screen.getByRole("button", { name: /Back to welcome/i });
    fireEvent.click(button);
    expect(useUiStore.getState().activeSessionId).toBeNull();
  });

  it("sizes the mark down: 24px open, 20px collapsed (light rail crown)", () => {
    const { container, rerender } = render(<SidebarHomeSigil sidebarOpen />);
    expect(
      container
        .querySelector("[data-vex-home-mark] svg")
        ?.getAttribute("height"),
    ).toBe("24");

    rerender(<SidebarHomeSigil sidebarOpen={false} />);
    expect(
      container
        .querySelector("[data-vex-home-mark] svg")
        ?.getAttribute("height"),
    ).toBe("20");
  });
});
