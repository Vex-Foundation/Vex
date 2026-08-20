/**
 * BOOK inspect mode (A32/E13) — behavior pins for the additive tool-call
 * view: opening swaps the rail's stack for the inspect panel WITHOUT
 * unmounting a single card, closing restores the stack, a session switch or
 * a foreign-session payload never renders, and hostile payloads (BigInt,
 * circular) degrade instead of crashing. The transcript's tool row drives
 * `openToolInspect` (board contract, 2026-08-20); this suite drives the
 * store directly at the same seam.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

vi.mock("../PositionBlock.js", () => ({
  PositionBlock: () => <div data-testid="card-position" />,
}));
vi.mock("../SessionWalletsCard.js", () => ({
  SessionWalletsCard: () => <div data-testid="card-wallets" />,
}));
vi.mock("../portfolio/BalancesCard.js", () => ({
  BalancesCard: () => <div data-testid="card-balances" />,
}));
vi.mock("../SessionActivityCard.js", () => ({
  SessionActivityCard: () => <div data-testid="card-activity" />,
}));
vi.mock("../SessionRuntimeCard.js", () => ({
  SessionRuntimeCard: () => <div data-testid="card-runtime" />,
}));
vi.mock("../SessionBlock.js", () => ({
  SessionBlock: () => <div data-testid="card-session" />,
}));
vi.mock("../ImageLockerCard.js", () => ({
  ImageLockerCard: () => <div data-testid="card-images" />,
}));
vi.mock("../../../../lib/api/sessions.js", () => ({
  useSession: () => ({ data: undefined }),
}));
vi.mock("../portfolio/WelcomePortfolioPanel.js", () => ({
  WelcomePortfolioPanel: () => <div data-testid="welcome-portfolio-panel" />,
}));

const { BookPanel } = await import("../../BookPanel.js");
const { useUiStore } = await import("../../../../stores/uiStore.js");
const { useToolInspectStore } = await import("../inspect/inspect-store.js");

const SESSION = "00000000-0000-4000-8000-00000000dddd";
const OTHER_SESSION = "00000000-0000-4000-8000-00000000eeee";

function openCall(sessionId: string, overrides: Record<string, unknown> = {}) {
  act(() => {
    useToolInspectStore.getState().openToolInspect({
      sessionId,
      callKey: "msg-1:0",
      toolName: "portfolio_read",
      status: "done",
      args: { scope: "global" },
      result: { totalUsd: 12.5 },
      ...overrides,
    });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  useUiStore.setState({ bookSectionOrder: [] });
  act(() => useToolInspectStore.getState().closeToolInspect());
});

describe("BOOK inspect mode", () => {
  it("opening a tool call swaps in the inspect panel while every card stays mounted", () => {
    render(<BookPanel activeSessionId={SESSION} bookOpen onToggle={() => {}} />);
    expect(screen.queryByLabelText(/Tool call:/)).toBeNull();

    openCall(SESSION);

    const panel = screen.getByLabelText("Tool call: portfolio_read");
    expect(panel.textContent).toContain("portfolio_read");
    expect(panel.textContent).toContain("Done");
    expect(panel.textContent).toContain('"scope": "global"');
    expect(panel.textContent).toContain('"totalUsd": 12.5');
    // Additive mode: the stack hides via CSS but no card unmounts.
    for (const card of [
      "card-position",
      "card-wallets",
      "card-balances",
      "card-activity",
      "card-runtime",
      "card-session",
      "card-images",
    ]) {
      expect(screen.getByTestId(card)).toBeTruthy();
    }
    expect(screen.getByRole("list").classList.contains("hidden")).toBe(true);
  });

  it("closing returns to the card stack with nothing missing", () => {
    render(<BookPanel activeSessionId={SESSION} bookOpen onToggle={() => {}} />);
    openCall(SESSION);
    fireEvent.click(screen.getByRole("button", { name: "Close inspect" }));
    expect(screen.queryByLabelText(/Tool call:/)).toBeNull();
    expect(screen.getByRole("list").classList.contains("hidden")).toBe(false);
    expect(screen.getByTestId("card-position")).toBeTruthy();
  });

  it("a payload from another session never renders, and a session switch closes the view", () => {
    const view = render(
      <BookPanel activeSessionId={SESSION} bookOpen onToggle={() => {}} />,
    );
    openCall(OTHER_SESSION);
    expect(screen.queryByLabelText(/Tool call:/)).toBeNull();

    openCall(SESSION);
    expect(screen.getByLabelText("Tool call: portfolio_read")).toBeTruthy();
    view.rerender(
      <BookPanel activeSessionId={OTHER_SESSION} bookOpen onToggle={() => {}} />,
    );
    expect(screen.queryByLabelText(/Tool call:/)).toBeNull();
    expect(useToolInspectStore.getState().inspect).toBeNull();
  });

  it("running calls show the status word without a result section; hostile payloads degrade instead of crashing", () => {
    render(<BookPanel activeSessionId={SESSION} bookOpen onToggle={() => {}} />);
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    openCall(SESSION, {
      status: "running",
      args: { amount: 10n, loop: circular },
      result: undefined,
    });
    const panel = screen.getByLabelText("Tool call: portfolio_read");
    expect(panel.textContent).toContain("Running");
    expect(panel.textContent).toContain("Arguments");
    expect(panel.textContent).not.toContain("Result");
    // Circular JSON falls back to String(value); the panel still stands.
    expect(panel.textContent).toContain("[object Object]");
  });
});
