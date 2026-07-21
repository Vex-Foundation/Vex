/**
 * HyperliquidPositionsBlock — pins `deriveHyperliquidCoverage` (unaffected
 * by the workspace-mode gate below) PLUS the section's visibility rule
 * (owner report): the whole "Hyperliquid" section — header AND the
 * "No open Hyperliquid perpetual positions." empty state — renders ONLY
 * while the session's Hypervexing workspace mode is active. It is absent
 * (no header, no empty-state noise) for a normal-mode session, and fails
 * CLOSED (hidden) while the mode read is loading/erroring, matching
 * `HypervexingEnterButton`'s own fail-closed default on the same signal.
 *
 * `useHyperliquidWorkspaceModeRead` and `useHyperliquidPositions` are
 * mocked — this suite owns the block's gating/display rules, not the query
 * wiring.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { HyperliquidPositionDto } from "@shared/schemas/hyperliquid.js";

const mockUseHyperliquidPositions = vi.hoisted(() => vi.fn());
const mockUseHyperliquidWorkspaceModeRead = vi.hoisted(() => vi.fn());

vi.mock("../../../../lib/api/hyperliquid.js", () => ({
  useHyperliquidPositions: mockUseHyperliquidPositions,
  useHyperliquidWorkspaceModeRead: mockUseHyperliquidWorkspaceModeRead,
}));

const { HyperliquidPositionsBlock, deriveHyperliquidCoverage } = await import(
  "../HyperliquidPositionsBlock.js"
);

const SESSION = "00000000-0000-4000-8000-00000000ffff";

function mockMode(mode: "hypervexing" | "normal" | null): void {
  mockUseHyperliquidWorkspaceModeRead.mockReturnValue(
    mode === null
      ? { data: undefined }
      : { data: { ok: true, data: { mode, acknowledged: true, everEntered: true } } },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUseHyperliquidPositions.mockReturnValue({
    isLoading: false,
    isError: false,
    data: { ok: true, data: { positions: [] } },
  });
});

describe("HyperliquidPositionsBlock — workspace-mode gate", () => {
  it("renders the section when the active-signal mock is hypervexing", () => {
    mockMode("hypervexing");
    render(<HyperliquidPositionsBlock sessionId={SESSION} />);
    expect(screen.getByText("Hyperliquid")).not.toBeNull();
    expect(
      screen.getByText("No open Hyperliquid perpetual positions."),
    ).not.toBeNull();
  });

  it("renders nothing when the active-signal mock is normal", () => {
    mockMode("normal");
    const { container } = render(<HyperliquidPositionsBlock sessionId={SESSION} />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByText("Hyperliquid")).toBeNull();
    expect(
      screen.queryByText("No open Hyperliquid perpetual positions."),
    ).toBeNull();
  });

  it("fails closed (renders nothing) while the mode read has not resolved yet", () => {
    mockMode(null);
    const { container } = render(<HyperliquidPositionsBlock sessionId={SESSION} />);
    expect(container.firstChild).toBeNull();
  });

  it("fails closed (renders nothing) on a failed mode read", () => {
    mockUseHyperliquidWorkspaceModeRead.mockReturnValue({
      data: { ok: false, error: { code: "INTERNAL", message: "boom" } },
    });
    const { container } = render(<HyperliquidPositionsBlock sessionId={SESSION} />);
    expect(container.firstChild).toBeNull();
  });

  it("still shows open positions when hypervexing is active", () => {
    mockMode("hypervexing");
    mockUseHyperliquidPositions.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        ok: true,
        data: {
          positions: [
            {
              coin: "BTC",
              side: "long",
              size: "0.01",
              entryPx: "100000",
              markPx: "100100",
              leverage: "3",
              marginMode: "isolated",
              liquidationPx: "75000",
              unrealizedPnl: "1",
              fundingAccrued: "0",
              slPrice: "98000",
              tpPrice: null,
              protectionState: "PROTECTED",
              confirmedAt: "2026-07-11T12:00:30.000Z",
              updatedAt: "2026-07-11T12:00:30.000Z",
            },
          ],
        },
      },
    });
    render(<HyperliquidPositionsBlock sessionId={SESSION} />);
    expect(screen.getByText("1 open")).not.toBeNull();
    expect(screen.getByText("0.01 BTC")).not.toBeNull();
  });

  it("shows a live syncing state instead of claiming a recent trade is absent", () => {
    mockMode("hypervexing");
    mockUseHyperliquidPositions.mockReturnValue({
      isLoading: false,
      isError: false,
      data: { ok: true, data: { positions: [], syncStatus: "syncing" } },
    });

    render(<HyperliquidPositionsBlock sessionId={SESSION} />);

    expect(screen.getByRole("status").textContent).toContain("waiting for Hyperliquid");
    expect(screen.queryByText("No open Hyperliquid perpetual positions.")).toBeNull();
  });

  it("warns before another trade when venue confirmation is delayed", () => {
    mockMode("hypervexing");
    mockUseHyperliquidPositions.mockReturnValue({
      isLoading: false,
      isError: false,
      data: { ok: true, data: { positions: [], syncStatus: "delayed" } },
    });

    render(<HyperliquidPositionsBlock sessionId={SESSION} />);

    expect(screen.getByRole("alert").textContent).toContain("Verify your live exposure");
    expect(screen.queryByText("No open Hyperliquid perpetual positions.")).toBeNull();
  });
});

const NOW = Date.parse("2026-07-11T12:03:00.000Z");

function position(protectionState: HyperliquidPositionDto["protectionState"], confirmedAt = "2026-07-11T12:00:30.000Z"): HyperliquidPositionDto {
  return {
    coin: "BTC",
    side: "long",
    size: "0.01",
    entryPx: "100000",
    markPx: "100100",
    leverage: "3",
    marginMode: "isolated",
    liquidationPx: "75000",
    unrealizedPnl: "1",
    fundingAccrued: "0",
    slPrice: "98000",
    tpPrice: null,
    protectionState,
    confirmedAt,
    updatedAt: confirmedAt,
  };
}

describe("deriveHyperliquidCoverage", () => {
  it("renders reconciler-confirmed protection states truthfully", () => {
    expect(deriveHyperliquidCoverage(position("PROTECTED"), NOW)).toBe("protected");
    expect(deriveHyperliquidCoverage(position("CONSOLIDATING"), NOW)).toBe("consolidating");
    expect(deriveHyperliquidCoverage(position("UNPROTECTED"), NOW)).toBe("UNPROTECTED");
    expect(deriveHyperliquidCoverage(position("unprotected_by_user_choice"), NOW)).toBe("UNPROTECTED");
  });

  it("marks a confirmation older than roughly three minutes as stale", () => {
    expect(deriveHyperliquidCoverage(position("PROTECTED", "2026-07-11T11:59:59.000Z"), NOW)).toBe("stale");
  });
});
