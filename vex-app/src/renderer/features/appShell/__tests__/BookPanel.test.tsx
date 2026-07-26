/**
 * BookPanel — the right-edge STAGE ROUTER (welcome redesign, 2026-07-20)
 * plus the session rail's own chrome.
 *
 * Pins:
 *   - WELCOME stage (activeSessionId null): the rail is REPLACED by the
 *     floating Portfolio tab (WelcomePortfolioPanel, mocked here — its own
 *     collapsed/expanded behavior has a dedicated suite) receiving the SAME
 *     persisted bookOpen flag; no rail chrome (version stamp / chevron /
 *     instrument blocks) mounts at all,
 *   - SESSION stage: today's rail, unchanged — the version stamp renders in
 *     the header when expanded and hides when collapsed (chevron-only
 *     spine), the chevron's accessible label flips with bookOpen and calls
 *     onToggle, the instrument blocks render only when expanded.
 *
 * The child instrument blocks are mocked — this suite owns the router and
 * the rail's chrome, not the blocks' data wiring.
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
vi.mock("../SessionRuntimeBar.js", () => ({
  SessionRuntimeBar: () => <div data-testid="runtime-bar" />,
}));
// The welcome-stage floating Portfolio tab has its own suite
// (WelcomePortfolioPanel.test.tsx); here the router only needs to prove it
// mounts with the shared bookOpen flag.
vi.mock("../book/portfolio/WelcomePortfolioPanel.js", () => ({
  WelcomePortfolioPanel: ({ bookOpen }: { readonly bookOpen: boolean }) => (
    <div
      data-testid="welcome-portfolio-panel"
      data-book-open={bookOpen ? "true" : "false"}
    />
  ),
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
    // Instrument blocks render when expanded.
    expect(screen.queryByTestId("position-block")).not.toBeNull();
    expect(screen.queryByTestId("moves-block")).not.toBeNull();
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

  it("routes the WELCOME stage to the floating Portfolio tab — no rail chrome at all", () => {
    render(<BookPanel activeSessionId={null} bookOpen onToggle={() => {}} />);
    const tab = screen.getByTestId("welcome-portfolio-panel");
    expect(tab.getAttribute("data-book-open")).toBe("true");
    // The rail's chrome and instrument blocks never mount on welcome.
    expect(screen.queryByText(/^v/)).toBeNull();
    expect(
      screen.queryByRole("button", { name: /the BOOK panel/i }),
    ).toBeNull();
    expect(screen.queryByTestId("position-block")).toBeNull();
    expect(screen.queryByTestId("moves-block")).toBeNull();
    expect(screen.queryByTestId("session-block")).toBeNull();
  });

  it("passes the persisted bookOpen=false through to the welcome tab (collapsed handle)", () => {
    render(
      <BookPanel activeSessionId={null} bookOpen={false} onToggle={() => {}} />,
    );
    expect(
      screen.getByTestId("welcome-portfolio-panel").getAttribute("data-book-open"),
    ).toBe("false");
  });

  it("keeps the SESSION rail on session stage — the welcome tab never mounts there", () => {
    render(
      <BookPanel activeSessionId={SESSION} bookOpen onToggle={() => {}} />,
    );
    expect(screen.queryByTestId("welcome-portfolio-panel")).toBeNull();
    // Pinned rail assertion (no regression): the expanded rail still carries
    // its version stamp + collapse chevron + the session instrument blocks.
    expect(screen.getByText(/^v/)).not.toBeNull();
    expect(
      screen.getByRole("button", { name: /Collapse the BOOK panel/i }),
    ).not.toBeNull();
    expect(screen.queryByTestId("position-block")).not.toBeNull();
  });
});
