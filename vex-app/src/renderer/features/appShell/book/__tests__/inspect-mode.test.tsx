/**
 * The inspect view (docs/design/R3-MINIMAL.md section 5.1): behaviour pins
 * for the additive tool-call view, which takes over the Vex sidebar's body.
 * Opening hides the body (her state, Needs you, the plate) WITHOUT
 * unmounting it, Back restores it, a session switch or a foreign-session
 * payload never renders, and hostile payloads (BigInt, circular) degrade
 * instead of crashing. The transcript's tool row drives `openToolInspect`
 * (board contract, 2026-08-20); this suite drives the store directly at the
 * same seam. It moved here from the BOOK rail with the inspect view.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { VexPresence } from "../../../vex/useVexPresence.js";

const PRESENCE: VexPresence = {
  state: "ready",
  word: "Ready",
  fill: "idle",
  scope: "This chat:",
  timerStartedAt: null,
  narration: null,
  background: { count: 0, items: [], label: null, summary: null },
  needsYou: { status: "ready", unknownCopy: null, count: 0, items: [], retry: () => {}, retrying: false },
  live: false,
};

vi.mock("../../../vex/useVexPresence.js", () => ({
  useVexPresence: () => PRESENCE,
}));
vi.mock("../../../../lib/api/shell-backdrop.js", () => ({
  useShellBackdrop: () => ({ data: undefined }),
  currentShellBackdrop: () => null,
}));

const { VexSidebar } = await import("../../../vex/VexSidebar.js");
const { useUiStore } = await import("../../../../stores/uiStore.js");
const { useToolInspectStore } = await import("../inspect/inspect-store.js");

/** The box the inspect view hides: the sidebar's body, still mounted. */
function body(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-vex-area="vex-sidebar-body"]');
}

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
  useUiStore.setState({ runtimeMode: "agent", activeSessionId: SESSION, showAvatar: true });
  act(() => useToolInspectStore.getState().closeToolInspect());
});

describe("the inspect view in the Vex sidebar", () => {
  it("opening a tool call takes over the body while everything in it stays mounted", () => {
    render(<VexSidebar open onHide={() => {}} />);
    expect(screen.queryByLabelText(/Tool call:/)).toBeNull();

    openCall(SESSION);

    const panel = screen.getByLabelText("Tool call: portfolio_read");
    expect(panel.textContent).toContain("portfolio_read");
    expect(panel.textContent).toContain("Done");
    expect(panel.textContent).toContain('"scope": "global"');
    expect(panel.textContent).toContain('"totalUsd": 12.5');
    // Additive: the body hides but nothing in it unmounts, her plate included.
    expect(body()?.hidden).toBe(true);
    expect(body()?.querySelector('[data-vex-area="vex-state"]')).not.toBeNull();
    expect(body()?.querySelector('[data-vex-area="vex-needs-you"]')).not.toBeNull();
    expect(body()?.querySelector("[data-vex-k2]")).not.toBeNull();
  });

  it("Back returns to the body with nothing missing", () => {
    render(<VexSidebar open onHide={() => {}} />);
    openCall(SESSION);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.queryByLabelText(/Tool call:/)).toBeNull();
    expect(body()?.hidden).toBe(false);
    expect(body()?.querySelector('[data-vex-area="vex-state"]')).not.toBeNull();
  });

  it("a payload from another session never renders, and a session switch closes the view", () => {
    render(<VexSidebar open onHide={() => {}} />);
    openCall(OTHER_SESSION);
    expect(screen.queryByLabelText(/Tool call:/)).toBeNull();
    expect(body()?.hidden).toBe(false);

    openCall(SESSION);
    expect(screen.getByLabelText("Tool call: portfolio_read")).toBeTruthy();
    act(() => useUiStore.setState({ activeSessionId: OTHER_SESSION }));
    expect(screen.queryByLabelText(/Tool call:/)).toBeNull();
    expect(useToolInspectStore.getState().inspect).toBeNull();
  });

  it("running calls show the status word without a result section; hostile payloads degrade instead of crashing", () => {
    render(<VexSidebar open onHide={() => {}} />);
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
