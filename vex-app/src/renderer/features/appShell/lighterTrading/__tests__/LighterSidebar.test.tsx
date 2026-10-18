// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useLighterAnalysisStore } from "../../../../stores/lighterAnalysisStore.js";
import { useUiStore } from "../../../../stores/uiStore.js";
import { LighterSidebar } from "../LighterSidebar.js";

vi.mock("../../../../lib/api/lighter-trading.js", () => ({
  useLighterTradingMarkets: () => ({ data: { ok: true, data: { markets: [] } } }),
}));

vi.mock("../../../../lib/api/sessions.js", () => ({
  useSessionsList: () => ({ data: { ok: true, data: [] }, isLoading: false, isError: false }),
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

describe("LighterSidebar title row", () => {
  beforeEach(() => {
    useLighterAnalysisStore.getState().saveDesk({ environment: "rhc", marketId: 7 });
  });

  it("is the centre's head row: Lighter and its network, the desk keys, then the title bar's slot", () => {
    const { container } = render(
      <LighterSidebar
        collapsed
        onToggleSidebar={vi.fn()}
        zenMode={false}
        zenAssistantOpen={false}
        zenControlsOpen={false}
        onToggleZen={vi.fn()}
        onToggleZenControls={vi.fn()}
        onToggleZenAssistant={vi.fn()}
      />,
    );

    const navigation = screen.getByRole("complementary", { name: "Lighter navigation" });
    expect(within(navigation).getByText("Lighter")).toBeTruthy();
    expect(within(navigation).getByText("Robinhood Chain")).toBeTruthy();
    expect(within(navigation).getByRole("button", { name: "Markets & sessions" }).getAttribute("aria-expanded")).toBe("false");
    expect(within(navigation).getByRole("button", { name: "New session" })).toBeTruthy();
    // Settings, the theme and the account live in the left rail.
    expect(within(navigation).queryByRole("button", { name: "Settings" })).toBeNull();
    expect(within(navigation).queryByRole("button", { name: /Switch to the (light|dark) theme/ })).toBeNull();
    // The Zen key leads the left cell, before "Lighter".
    const header = container.querySelector(".lit-desk-topbar-header");
    expect(header?.firstElementChild?.getAttribute("aria-label")).toBe("Enter Zen Mode");
    // The title bar's cluster lands at the row's right end, and the way out
    // holds the corner past it.
    const slot = container.querySelector(".lit-desk-top-shell");
    expect(slot?.parentElement).toBe(header);
    expect(slot?.hasAttribute("hidden")).toBe(false);
    expect(header?.lastElementChild?.getAttribute("aria-label")).toBe("Exit Lighter");
  });

  it("leaves the desk for the mode it was entered from", () => {
    useUiStore.setState({ runtimeMode: "lighter", lighterReturn: { mode: "studio", sessionId: null } });
    render(
      <LighterSidebar
        collapsed
        onToggleSidebar={vi.fn()}
        zenMode={false}
        zenAssistantOpen={false}
        zenControlsOpen={false}
        onToggleZen={vi.fn()}
        onToggleZenControls={vi.fn()}
        onToggleZenAssistant={vi.fn()}
      />,
    );

    const exit = screen.getByRole("button", { name: "Exit Lighter" });
    expect(exit.getAttribute("title")).toBe("Exit Lighter, back to Studio");
    fireEvent.click(exit);
    expect(useUiStore.getState().runtimeMode).toBe("studio");
  });

  it("keeps the title bar's slot mounted, only hidden, while Zen folds the row", () => {
    const props = {
      collapsed: true,
      onToggleSidebar: vi.fn(),
      zenAssistantOpen: false,
      onToggleZen: vi.fn(),
      onToggleZenControls: vi.fn(),
      onToggleZenAssistant: vi.fn(),
    } as const;
    const { container, rerender } = render(
      <LighterSidebar {...props} zenMode={false} zenControlsOpen={false} />,
    );
    const slot = container.querySelector(".lit-desk-top-shell");

    rerender(<LighterSidebar {...props} zenMode zenControlsOpen={false} />);
    expect(container.querySelector(".lit-desk-top-shell")).toBe(slot);
    expect(slot?.hasAttribute("hidden")).toBe(true);

    rerender(<LighterSidebar {...props} zenMode zenControlsOpen />);
    expect(container.querySelector(".lit-desk-top-shell")).toBe(slot);
    expect(slot?.hasAttribute("hidden")).toBe(false);
  });
});

describe("LighterSidebar environment switch", () => {
  beforeEach(() => {
    useLighterAnalysisStore.getState().saveDesk({ environment: "rhc", marketId: 7 });
  });

  it("keeps Core and RHC in the top bar and clears the old market on switch", () => {
    render(
      <LighterSidebar
        collapsed
        onToggleSidebar={vi.fn()}
        zenMode={false}
        zenAssistantOpen={false}
        zenControlsOpen={false}
        onToggleZen={vi.fn()}
        onToggleZenControls={vi.fn()}
        onToggleZenAssistant={vi.fn()}
      />,
    );

    const navigation = screen.getByRole("complementary", { name: "Lighter navigation" });
    const group = within(navigation).getByRole("radiogroup", { name: "Lighter environment" });
    expect(within(group).getByRole("radio", { name: "Robinhood Chain" }).getAttribute("aria-checked")).toBe("true");

    fireEvent.click(within(group).getByRole("radio", { name: "Lighter Core" }));

    expect(useLighterAnalysisStore.getState().desk.environment).toBe("core");
    expect(useLighterAnalysisStore.getState().desk.marketId).toBeNull();
  });

  it("keeps Zen Mode centered and reveals the contextual Vex control only while focused", () => {
    const onToggleZen = vi.fn();
    const onToggleZenControls = vi.fn();
    const onToggleZenAssistant = vi.fn();
    const { rerender } = render(
      <LighterSidebar
        collapsed
        onToggleSidebar={vi.fn()}
        zenMode={false}
        zenAssistantOpen={false}
        zenControlsOpen={false}
        onToggleZen={onToggleZen}
        onToggleZenControls={onToggleZenControls}
        onToggleZenAssistant={onToggleZenAssistant}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Enter Zen Mode" }));
    expect(onToggleZen).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Ask Vex" })).toBeNull();

    rerender(
      <LighterSidebar
        collapsed
        onToggleSidebar={vi.fn()}
        zenMode
        zenAssistantOpen={false}
        zenControlsOpen={false}
        onToggleZen={onToggleZen}
        onToggleZenControls={onToggleZenControls}
        onToggleZenAssistant={onToggleZenAssistant}
      />,
    );
    expect(screen.getByRole("button", { name: "Show Zen controls" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Ask Vex" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Exit Lighter" })).toBeNull();
    // Folded, the way out of Zen still holds the corner.
    fireEvent.click(screen.getByRole("button", { name: "Exit Zen Mode" }));
    expect(onToggleZen).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Show Zen controls" }));
    expect(onToggleZenControls).toHaveBeenCalledTimes(1);

    rerender(
      <LighterSidebar
        collapsed
        onToggleSidebar={vi.fn()}
        zenMode
        zenAssistantOpen={false}
        zenControlsOpen
        onToggleZen={onToggleZen}
        onToggleZenControls={onToggleZenControls}
        onToggleZenAssistant={onToggleZenAssistant}
      />,
    );
    // Open, Exit Zen holds the corner beside the hide key; the Zen key goes.
    expect(screen.queryByRole("button", { name: "Enter Zen Mode" })).toBeNull();
    const exitZen = screen.getByRole("button", { name: "Exit Zen Mode" });
    expect(exitZen.previousElementSibling?.getAttribute("aria-label")).toBe("Hide Zen controls");
    expect(exitZen.parentElement?.lastElementChild).toBe(exitZen);
    fireEvent.click(screen.getByRole("button", { name: "Ask Vex" }));
    expect(onToggleZenAssistant).toHaveBeenCalledTimes(1);
  });
});
