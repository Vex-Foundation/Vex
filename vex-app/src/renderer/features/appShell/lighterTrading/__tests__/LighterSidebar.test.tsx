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
    render(<LighterSidebar collapsed onToggleSidebar={vi.fn()} />);

    const navigation = screen.getByRole("complementary", { name: "Lighter navigation" });
    const group = within(navigation).getByRole("radiogroup", { name: "Lighter environment" });
    expect(within(group).getByRole("radio", { name: "Robinhood Chain" }).getAttribute("aria-checked")).toBe("true");

    fireEvent.click(within(group).getByRole("radio", { name: "Lighter Core" }));

    expect(useLighterAnalysisStore.getState().desk.environment).toBe("core");
    expect(useLighterAnalysisStore.getState().desk.marketId).toBeNull();
  });
});
