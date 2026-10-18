/**
 * THE LEFT SIDEBAR'S HEAD ROW (docs/design/R3-MINIMAL.md sections 2.2 and 4):
 * the vx wordmark at the left, the collapse key at the right, a window drag
 * region clear of the macOS traffic lights.
 *
 * What moved out, pinned so it does not creep back: the `Agent | Studio`
 * capsule. The way into Studio is the sidebar nav's Studio row now, open and
 * on the rail alike (`AppShell/shell-sidebar.test.tsx` walks it in the
 * assembled shell), so this row carries no radiogroup at all.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useUiStore } from "../../../stores/uiStore.js";
import { AgentSidebarHeader } from "../AgentSidebarHeader.js";

beforeEach(() => {
  useUiStore.setState({ runtimeMode: "agent", activeSessionId: null });
});

describe("AgentSidebarHeader (the head row)", () => {
  it("carries the inert vx mark on the welcome stage", () => {
    const { container } = render(<AgentSidebarHeader onCollapse={vi.fn()} />);
    // On the welcome stage the mark has nowhere to go: decoration, not a button.
    expect(container.querySelector("[data-vex-home-mark] svg path")).not.toBeNull();
    expect(screen.queryByRole("button", { name: /Back to welcome/i })).toBeNull();
  });

  it("turns the mark into Back to welcome with a session open", () => {
    useUiStore.setState({ activeSessionId: "session-1" });
    render(<AgentSidebarHeader onCollapse={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Back to welcome/i })).not.toBeNull();
  });

  it("collapses the sidebar from its key, which says the sidebar is open", () => {
    const onCollapse = vi.fn();
    render(<AgentSidebarHeader onCollapse={onCollapse} />);
    const key = screen.getByRole("button", { name: "Collapse sessions sidebar" });
    expect(key.getAttribute("aria-expanded")).toBe("true");
    expect(key.querySelector("svg")).not.toBeNull();
    fireEvent.click(key);
    expect(onCollapse).toHaveBeenCalledTimes(1);
  });

  it("carries no mode capsule: the nav is the way into Studio", () => {
    render(<AgentSidebarHeader onCollapse={vi.fn()} />);
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.queryByRole("radio", { name: "Studio" })).toBeNull();
  });

  it("is the sidebar's head row: a drag region clear of the traffic lights", () => {
    const { container } = render(<AgentSidebarHeader onCollapse={vi.fn()} />);
    const head = container.querySelector("header");
    expect(head?.classList.contains("vex-drag")).toBe(true);
    expect(head?.classList.contains("vex-lights-start")).toBe(true);
    expect(head?.classList.contains("vex-ls-head")).toBe(true);
  });

  it("leaves search to the body: the head row holds the mark and one key", () => {
    render(<AgentSidebarHeader onCollapse={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /Search sessions/i })).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });
});
