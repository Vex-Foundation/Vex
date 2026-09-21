// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useLighterAnalysisStore } from "../../../../stores/lighterAnalysisStore.js";
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
    expect(screen.queryByRole("button", { name: "Exit Zen Mode" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Ask Vex" })).toBeNull();
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
    expect(screen.getByRole("button", { name: "Exit Zen Mode" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Hide Zen controls" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ask Vex" }));
    expect(onToggleZenAssistant).toHaveBeenCalledTimes(1);
  });
});
