/**
 * THE LEFT PAGE'S MAST, and the one thing it exists to guarantee: while the
 * page is open the door into Studio is in its head row, beside the vx mark,
 * in every agent state, the welcome stage included
 * (docs/design/V10-SPREAD.md section 3).
 *
 * The defect this pins (UX after-audit, N1): the `Agent | Studio` capsule
 * once rendered only on the agent welcome hero, so opening a session took the
 * mode control off the screen entirely. The mast is the surface whose
 * controls do not depend on whether a session is open, which is why the
 * capsule lives here. While the page is a spine the mast is not mounted and
 * the welcome hero carries the capsule instead (`useLeftPageOpen`), so the
 * page keeps exactly ONE `Runtime mode` radiogroup;
 * `AppShell/shell-sidebar.test.tsx` walks that edge in the assembled shell.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useUiStore } from "../../../stores/uiStore.js";
import { AgentSidebarHeader } from "../AgentSidebarHeader.js";

beforeEach(() => {
  useUiStore.setState({ runtimeMode: "agent", activeSessionId: null });
});

describe("AgentSidebarHeader (the mast)", () => {
  it("carries the capsule on the welcome stage, beside the inert vx mark", () => {
    const { container } = render(<AgentSidebarHeader />);
    expect(screen.getByRole("radiogroup", { name: "Runtime mode" })).not.toBeNull();
    expect(screen.getByRole("radio", { name: "Agent" }).getAttribute("aria-checked")).toBe("true");
    // On the welcome stage the mark has nowhere to go: decoration, not a button.
    expect(container.querySelector("[data-vex-home-mark] svg path")).not.toBeNull();
    expect(screen.queryByRole("button", { name: /Back to welcome/i })).toBeNull();
  });

  it("keeps the capsule with a session open - the door does not close", () => {
    useUiStore.setState({ activeSessionId: "session-1" });
    render(<AgentSidebarHeader />);
    expect(screen.getByRole("radiogroup", { name: "Runtime mode" })).not.toBeNull();
    expect(screen.getByRole("button", { name: /Back to welcome/i })).not.toBeNull();
  });

  it("switches the shell to Studio, and back", () => {
    useUiStore.setState({ activeSessionId: "session-1" });
    render(<AgentSidebarHeader />);
    fireEvent.click(screen.getByRole("radio", { name: "Studio" }));
    expect(useUiStore.getState().runtimeMode).toBe("studio");
    fireEvent.click(screen.getByRole("radio", { name: "Agent" }));
    expect(useUiStore.getState().runtimeMode).toBe("agent");
  });

  it("renders exactly ONE radiogroup - the page-wide count is one control", () => {
    render(<AgentSidebarHeader />);
    expect(screen.getAllByRole("radiogroup")).toHaveLength(1);
  });

  it("is the page's head row: a drag region clear of the traffic lights", () => {
    const { container } = render(<AgentSidebarHeader />);
    const head = container.querySelector("header");
    expect(head?.classList.contains("vex-drag")).toBe(true);
    expect(head?.classList.contains("vex-lights-start")).toBe(true);
  });

  it("leaves search and collapse to the tabs row: the head row would overflow the page", () => {
    // Lights (96) + mark + capsule + two 28px tools ran about 40px past the
    // 300px page on macOS; the tools moved down into the tabs row.
    render(<AgentSidebarHeader />);
    expect(screen.queryByRole("button", { name: /Search sessions/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /sessions sidebar/i })).toBeNull();
  });
});
