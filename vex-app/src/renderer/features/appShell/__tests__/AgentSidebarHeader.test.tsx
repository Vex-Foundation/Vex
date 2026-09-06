/**
 * THE AGENT RAIL HEADER, and the one thing it exists to guarantee: once a
 * session is active the door into Studio is in the header, so it is on screen
 * in every agent state that has no welcome hero.
 *
 * The defect this pins (UX after-audit, N1): the `Agent | Studio` capsule
 * rendered only on the agent welcome hero, so opening a session took the mode
 * control off the screen entirely and Studio became reachable only by going
 * back to welcome. The header is the surface whose controls do not depend on
 * whether a session is open, which is why the capsule lives here in that state
 * - the same reason VS Code keeps its activity switches in the activity bar
 * Part rather than in a view, and deepseek-harness's `SidebarRoot` renders its
 * upper controls itself in both column widths.
 *
 * THE OTHER HALF (owner decree 2026-09-04): while NO session is active the
 * welcome hero carries the capsule under the wordmark and this header mounts
 * none, so the page keeps exactly ONE `Runtime mode` radiogroup. One store
 * fact, `activeSessionId`, decides the seat; the two cases below are the two
 * values of it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useUiStore } from "../../../stores/uiStore.js";
import { AgentSidebarHeader } from "../AgentSidebarHeader.js";

function mount(
  overrides: Partial<{
    wide: boolean;
    collapsed: boolean;
    searchOpen: boolean;
  }> = {},
): { toggleSearch: () => void; toggleSidebar: () => void } {
  const toggleSearch = vi.fn();
  const toggleSidebar = vi.fn();
  render(
    <AgentSidebarHeader
      wide={overrides.wide ?? true}
      collapsed={overrides.collapsed ?? false}
      searchOpen={overrides.searchOpen ?? false}
      onToggleSearch={toggleSearch}
      onToggleSidebar={toggleSidebar}
    />,
  );
  return { toggleSearch, toggleSidebar };
}

beforeEach(() => {
  useUiStore.setState({ runtimeMode: "agent", activeSessionId: null });
});

describe("AgentSidebarHeader", () => {
  it("mounts NO capsule on the welcome stage - the hero under the wordmark is the seat then", () => {
    // Owner decree 2026-09-04. Put the capsule back here unconditionally and
    // the page would carry two radiogroups on welcome; this case goes red.
    mount();
    expect(screen.queryByRole("radiogroup", { name: "Runtime mode" })).toBeNull();
    expect(screen.getByRole("button", { name: "Search sessions" })).not.toBeNull();
  });

  it("carries the capsule with a session open - the door does not close", () => {
    // The regression itself: with a session selected, the hero's copy is gone
    // and this header is the only control left that can leave agent mode.
    // Revert the capsule out of the header and this case is the one that goes
    // red.
    useUiStore.setState({ activeSessionId: "session-1" });
    mount();
    expect(
      screen.getByRole("radiogroup", { name: "Runtime mode" }),
    ).not.toBeNull();
    expect(
      screen.getByRole("radio", { name: "Agent" }).getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("switches the shell to Studio, and back", () => {
    useUiStore.setState({ activeSessionId: "session-1" });
    mount();
    fireEvent.click(screen.getByRole("radio", { name: "Studio" }));
    expect(useUiStore.getState().runtimeMode).toBe("studio");
    fireEvent.click(screen.getByRole("radio", { name: "Agent" }));
    expect(useUiStore.getState().runtimeMode).toBe("agent");
  });

  it("renders exactly ONE radiogroup with a session open - the page-wide count is one control", () => {
    useUiStore.setState({ activeSessionId: "session-1" });
    mount();
    expect(screen.getAllByRole("radiogroup")).toHaveLength(1);
  });

  it("drops the capsule on the collapsed spine, keeping the two icon controls", () => {
    // Words do not fit a 56px rail (the Studio rail header makes the same
    // call). The way into Studio from a collapsed rail is to expand it; the
    // expand control is right here, and it keeps its name.
    useUiStore.setState({ activeSessionId: "session-1" });
    mount({ wide: false, collapsed: true });
    expect(screen.queryByRole("radiogroup", { name: "Runtime mode" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Expand sessions sidebar" }),
    ).not.toBeNull();
    expect(screen.getByRole("button", { name: "Search sessions" })).not.toBeNull();
  });

  it("names and wires the search and collapse controls from its own state", () => {
    const { toggleSearch, toggleSidebar } = mount({ searchOpen: true });
    fireEvent.click(screen.getByRole("button", { name: "Close session search" }));
    expect(toggleSearch).toHaveBeenCalledTimes(1);
    fireEvent.click(
      screen.getByRole("button", { name: "Collapse sessions sidebar" }),
    );
    expect(toggleSidebar).toHaveBeenCalledTimes(1);
  });
});
