/**
 * BookPanel chrome — the collapse header bar that now carries the version
 * stamp (relocated from the DESK RULE) + the collapse/expand chevron.
 *
 * Pins:
 *   - the version stamp renders in the header when expanded, and is hidden
 *     when collapsed (the panel still mounts a chevron-only spine),
 *   - the chevron's accessible label flips with bookOpen and calls onToggle,
 *   - the instrument blocks render only when expanded (CSS collapse, the panel
 *     itself stays mounted in both states).
 *
 * The child instrument blocks are mocked — this suite owns the panel's own
 * chrome, not the blocks' data wiring.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

vi.mock("@hugeicons/react", () => ({
  HugeiconsIcon: () => null,
}));
vi.mock("../book/PositionBlock.js", () => ({
  PositionBlock: () => <div data-testid="position-block" />,
}));
vi.mock("../book/MovesBlock.js", () => ({
  MovesBlock: () => <div data-testid="moves-block" />,
}));
vi.mock("../book/SessionBlock.js", () => ({
  SessionBlock: () => <div data-testid="session-block" />,
}));
vi.mock("../book/HyperliquidPositionsBlock.js", () => ({
  HyperliquidPositionsBlock: () => <div data-testid="hyperliquid-positions-block" />,
}));
// The zero-token re-entry door runs a react-query read — mocked out like
// the other instrument blocks (its own gating has dedicated coverage).
vi.mock("../workspace/HypervexingEnterButton.js", () => ({
  HypervexingEnterButton: () => <div data-testid="hypervexing-enter-button" />,
}));

vi.mock("../book/HyperliquidRiskBlock.js", () => ({
  HyperliquidRiskBlock: () => <div data-testid="hyperliquid-risk-block" />,
}));
vi.mock("../SessionRuntimeBar.js", () => ({
  SessionRuntimeBar: () => <div data-testid="runtime-bar" />,
}));

const { BookPanel } = await import("../BookPanel.js");

const SESSION = "00000000-0000-4000-8000-00000000dddd";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("BookPanel chrome", () => {
  it("shows the version stamp + Collapse chevron when expanded", () => {
    render(
      <BookPanel activeSessionId={SESSION} bookOpen onToggle={() => {}} />,
    );
    expect(screen.getByText(/^v/)).not.toBeNull();
    expect(
      screen.getByRole("button", { name: /Collapse the BOOK panel/i }),
    ).not.toBeNull();
    // Instrument blocks render when expanded. The risk block MOUNT exists on
    // an active session — the real component self-gates to pending proposals
    // (see HyperliquidRiskBlock.test.tsx); the mock here always renders.
    expect(screen.queryByTestId("position-block")).not.toBeNull();
    expect(screen.queryByTestId("moves-block")).not.toBeNull();
    expect(screen.queryByTestId("hyperliquid-positions-block")).not.toBeNull();
    expect(screen.queryByTestId("hyperliquid-risk-block")).not.toBeNull();
  });

  it("hides the version + blocks when collapsed, keeping the Expand chevron", () => {
    render(
      <BookPanel activeSessionId={SESSION} bookOpen={false} onToggle={() => {}} />,
    );
    expect(screen.queryByText(/^v/)).toBeNull();
    expect(
      screen.getByRole("button", { name: /Expand the BOOK panel/i }),
    ).not.toBeNull();
    expect(screen.queryByTestId("position-block")).toBeNull();
    expect(screen.queryByTestId("moves-block")).toBeNull();
    expect(screen.queryByTestId("hyperliquid-positions-block")).toBeNull();
    expect(screen.queryByTestId("hyperliquid-risk-block")).toBeNull();
  });

  it("invokes onToggle from the chevron", () => {
    const onToggle = vi.fn();
    render(
      <BookPanel activeSessionId={SESSION} bookOpen onToggle={onToggle} />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /Collapse the BOOK panel/i }),
    );
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("shows the global portfolio (no active session) when expanded", () => {
    render(<BookPanel activeSessionId={null} bookOpen onToggle={() => {}} />);
    expect(screen.queryByTestId("position-block")).not.toBeNull();
    // No session-scoped blocks for the global view.
    expect(screen.queryByTestId("moves-block")).toBeNull();
    expect(screen.queryByTestId("session-block")).toBeNull();
    expect(screen.queryByTestId("hyperliquid-positions-block")).toBeNull();
    // Owner decree (round 3): no Hyperliquid block on the global/welcome
    // view — risk setup arrives as a confirmable card only when proposed.
    expect(screen.queryByTestId("hyperliquid-risk-block")).toBeNull();
  });
});
