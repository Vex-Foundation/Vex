import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LighterSetupHandoffEvent } from "@shared/schemas/lighter-setup-handoff.js";

const ACTIVE_SESSION = "00000000-0000-4000-8000-0000000000a1";
const INTENT = "11111111-1111-4111-8111-111111111111";
let listener: ((event: LighterSetupHandoffEvent) => void) | null = null;
const settleAgentSetup = vi.fn();
const getPendingAgentSetup = vi.fn();

vi.mock("../LighterAccountSetupModal.js", () => ({
  LighterAccountSetupModal: (props: {
    environment: string;
    externalError?: string | null;
    onCancel: () => void;
    onDone: () => Promise<boolean>;
  }) => (
    <div data-testid="setup-modal" data-environment={props.environment}>
      {props.externalError === null || props.externalError === undefined
        ? null
        : <p role="alert">{props.externalError}</p>}
      <button onClick={() => { void props.onCancel(); }}>Cancel</button>
      <button onClick={() => { void props.onDone(); }}>Done</button>
    </div>
  ),
}));

import { AgentLighterSetupHost } from "../AgentLighterSetupHost.js";

function event(sessionId = ACTIVE_SESSION): LighterSetupHandoffEvent {
  return {
    type: "engine.lighter.setup",
    sessionId,
    intentId: INTENT,
    environment: "core",
    kind: "requested",
    occurredAt: "2026-09-20T13:00:00.000Z",
  };
}

beforeEach(() => {
  listener = null;
  settleAgentSetup.mockReset().mockResolvedValue({
    ok: true,
    data: { settled: true, resumedAgentTurn: true },
  });
  getPendingAgentSetup.mockReset().mockResolvedValue({
    ok: true,
    data: { interaction: null },
  });
  Object.defineProperty(window, "vex", {
    configurable: true,
    value: {
      engine: {
        onLighterSetupRequested: (next: typeof listener) => {
          listener = next;
          return vi.fn();
        },
      },
      lighterTrading: { settleAgentSetup, getPendingAgentSetup },
    },
  });
});

describe("AgentLighterSetupHost", () => {
  it("opens over the same session without redirecting the workspace", async () => {
    render(<AgentLighterSetupHost sessionId={ACTIVE_SESSION} />);
    act(() => listener?.(event()));

    expect(screen.getByTestId("setup-modal").getAttribute("data-environment")).toBe("core");
    expect(getPendingAgentSetup).toHaveBeenCalledWith({ sessionId: ACTIVE_SESSION });
  });

  it("ignores setup events owned by another session", () => {
    render(<AgentLighterSetupHost sessionId={ACTIVE_SESSION} />);
    act(() => listener?.(event("00000000-0000-4000-8000-0000000000b2")));
    expect(screen.queryByTestId("setup-modal")).toBeNull();
  });

  it("removes the modal immediately while cancellation settles", async () => {
    let resolveSettlement!: (value: unknown) => void;
    settleAgentSetup.mockReturnValueOnce(new Promise((resolve) => {
      resolveSettlement = resolve;
    }));
    render(<AgentLighterSetupHost sessionId={ACTIVE_SESSION} />);
    act(() => listener?.(event()));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByTestId("setup-modal")).toBeNull();
    await waitFor(() => expect(settleAgentSetup).toHaveBeenCalledWith({
      sessionId: ACTIVE_SESSION,
      intentId: INTENT,
      outcome: "cancelled",
    }));
    resolveSettlement({ ok: true, data: { settled: true, resumedAgentTurn: false } });
  });

  it("restores the modal with a retry message when cancellation is refused", async () => {
    settleAgentSetup.mockResolvedValueOnce({
      ok: true,
      data: { settled: false, resumedAgentTurn: false },
    });
    render(<AgentLighterSetupHost sessionId={ACTIVE_SESSION} />);
    act(() => listener?.(event()));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByTestId("setup-modal")).toBeNull();
    expect((await screen.findByRole("alert")).textContent).toContain(
      "could not record the cancellation",
    );
  });

  it("recovers a pending modal after remount", async () => {
    getPendingAgentSetup.mockResolvedValueOnce({
      ok: true,
      data: {
        interaction: {
          intentId: INTENT,
          sessionId: ACTIVE_SESSION,
          environment: "rhc",
          status: "pending",
          createdAt: "2026-09-20T13:00:00.000Z",
        },
      },
    });
    render(<AgentLighterSetupHost sessionId={ACTIVE_SESSION} />);
    await waitFor(() => expect(
      screen.getByTestId("setup-modal").getAttribute("data-environment"),
    ).toBe("rhc"));
  });
});
