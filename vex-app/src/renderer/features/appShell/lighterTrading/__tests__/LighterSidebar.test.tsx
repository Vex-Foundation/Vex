// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useLighterAnalysisStore } from "../../../../stores/lighterAnalysisStore.js";
import { useUiStore } from "../../../../stores/uiStore.js";
import { LighterSidebar } from "../LighterSidebar.js";

vi.mock("../../../../lib/api/lighter-trading.js", () => ({
  useLighterTradingMarkets: () => ({ data: { ok: true, data: { markets: [] } } }),
}));

vi.mock("../../../../lib/api/sessions.js", () => ({
  useSessionModel: () => ({ data: undefined }),
  useSessionsList: () => ({ data: { ok: true, data: [] }, isLoading: false, isError: false }),
}));

vi.mock("../../../../lib/api/projects.js", () => ({
  useProject: () => ({ data: undefined }),
}));

vi.mock("../../SessionDeleteDialog.js", () => ({ SessionDeleteDialog: () => null }));
vi.mock("../../SidebarProfile.js", () => ({ SidebarProfile: () => <div /> }));
vi.mock("../../useSessionRowActions.js", () => ({
  useSessionRowActions: () => ({
    removeTarget: null,
    removeBlocked: null,
    removePending: false,
    handleCancelRemove: vi.fn(),
    handleConfirmRemove: vi.fn(),
    handleTogglePin: vi.fn(),
    handleRequestRemove: vi.fn(),
    handleRename: vi.fn(),
    pendingPinId: null,
  }),
}));
vi.mock("../../SessionRows.js", () => ({
  SessionGroups: () => null,
  SessionsEmptyPlaceholder: () => null,
  SessionsErrorPlaceholder: () => null,
  SessionsLoadingPlaceholder: () => null,
  SidebarIconButton: ({ label, children }: { readonly label: string; readonly children: ReactNode }) => (
    <button type="button" aria-label={label}>{children}</button>
  ),
}));


type Props = Parameters<typeof LighterSidebar>[0];

function props(over: Partial<Props> = {}): Props {
  return {
    collapsed: true,
    onToggleSidebar: vi.fn(),
    zenMode: false,
    zenAssistantOpen: false,
    zenControlsOpen: false,
    onToggleZen: vi.fn(),
    onToggleZenControls: vi.fn(),
    onToggleZenAssistant: vi.fn(),
    ...over,
  };
}

describe("LighterSidebar: the desk's cells in the header (H3-DESKTOP.md section 4.9)", () => {
  beforeEach(() => {
    useLighterAnalysisStore.getState().saveDesk({ environment: "rhc", marketId: 7 });
  });

  it("says where you are, then the desk's three icon keys, and no way out of its own", () => {
    const { container } = render(<LighterSidebar {...props()} />);
    const navigation = screen.getByRole("complementary", { name: "Lighter navigation" });
    expect(within(navigation).getByText("Lighter")).toBeTruthy();
    expect(within(navigation).getByText("Robinhood Chain")).toBeTruthy();
    const keys = container.querySelector(".lit-desk-head__keys");
    expect(Array.from(keys?.children ?? []).map((key) => key.getAttribute("aria-label"))).toEqual([
      "Markets and sessions",
      "New desk session",
      "Enter Zen Mode",
    ]);
    expect(within(navigation).getByRole("button", { name: "Markets and sessions" }).getAttribute("aria-expanded")).toBe("false");
    // Exit Lighter left the row: the nav is the way out. Needs you is the
    // console's and Core | RHC the market bar's.
    expect(within(navigation).queryByRole("button", { name: "Exit Lighter" })).toBeNull();
    expect(within(navigation).queryByRole("radiogroup", { name: "Lighter environment" })).toBeNull();
    expect(within(navigation).queryByRole("button", { name: "Settings" })).toBeNull();
  });

  it("names a page that stands over the desk, as the title bar does elsewhere", () => {
    useUiStore.setState({ shellRoute: { kind: "settings", origin: null, section: null } });
    try {
      render(<LighterSidebar {...props()} />);
      const navigation = screen.getByRole("complementary", { name: "Lighter navigation" });
      const title = navigation.querySelector('[data-vex-area="title-bar-title"]');
      expect(title?.textContent).toBe("Settings");
      expect(within(navigation).queryByText("Lighter")).toBeNull();
      expect(title?.closest(".lit-desk-head__title")).not.toBeNull();
      // the desk's own keys stay in the row
      expect(within(navigation).getByRole("button", { name: "Markets and sessions" })).toBeTruthy();
      expect(within(navigation).getByRole("button", { name: "Enter Zen Mode" })).toBeTruthy();
    } finally {
      useUiStore.setState({ shellRoute: { kind: "none" } });
    }
  });

  it("opens the drawer from Markets and sessions, and under 1024 moves New desk session into it", () => {
    const onToggleSidebar = vi.fn();
    const { rerender } = render(<LighterSidebar {...props({ onToggleSidebar })} />);
    fireEvent.click(screen.getByRole("button", { name: "Markets and sessions" }));
    expect(onToggleSidebar).toHaveBeenCalledTimes(1);

    rerender(<LighterSidebar {...props({ onToggleSidebar, collapsed: false })} />);
    const key = screen.getByRole("button", { name: "Markets and sessions" });
    expect(key.getAttribute("aria-expanded")).toBe("true");
    const drawer = document.getElementById(key.getAttribute("aria-controls") ?? "");
    expect(drawer?.classList.contains("lit-desk-nav-drawer")).toBe(true);
    expect(within(drawer as HTMLElement).queryByRole("button", { name: "New desk session" })).toBeNull();

    rerender(<LighterSidebar {...props({ onToggleSidebar, collapsed: false, band: true })} />);
    const keys = document.querySelector(".lit-desk-head__keys");
    expect(within(keys as HTMLElement).queryByRole("button", { name: "New desk session" })).toBeNull();
    const banded = document.querySelector(".lit-desk-nav-drawer") as HTMLElement;
    fireEvent.click(within(banded).getByRole("button", { name: "New desk session" }));
    expect(useUiStore.getState().createSessionOpen).toBe(true);
    act(() => useUiStore.getState().closeCreateSession());
  });

  it("folds to the reveal handle and Exit Zen in Zen, and opens to Ask Vex and the hide key", () => {
    const onToggleZen = vi.fn();
    const onToggleZenControls = vi.fn();
    const onToggleZenAssistant = vi.fn();
    const base = { onToggleZen, onToggleZenControls, onToggleZenAssistant };
    const { rerender } = render(<LighterSidebar {...props(base)} />);
    fireEvent.click(screen.getByRole("button", { name: "Enter Zen Mode" }));
    expect(onToggleZen).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Ask Vex" })).toBeNull();

    rerender(<LighterSidebar {...props({ ...base, zenMode: true })} />);
    expect(screen.getByRole("button", { name: "Show Zen controls" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Ask Vex" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Exit Zen Mode" }));
    expect(onToggleZen).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Show Zen controls" }));
    expect(onToggleZenControls).toHaveBeenCalledTimes(1);

    rerender(<LighterSidebar {...props({ ...base, zenMode: true, zenControlsOpen: true })} />);
    expect(screen.queryByRole("button", { name: "Enter Zen Mode" })).toBeNull();
    expect(screen.getByRole("button", { name: "Hide Zen controls" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ask Vex" }));
    expect(onToggleZenAssistant).toHaveBeenCalledTimes(1);
  });
});
