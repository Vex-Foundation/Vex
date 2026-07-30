/**
 * `MissionRestartAffordance` — the post-stop restart disclosure.
 *
 * The outcome→copy mapping is unit-covered; this covers the render and
 * interaction contract around it. Two properties earn their keep:
 *
 *  - a REFUSAL keeps the typed instruction on screen. A user sent to
 *    Review/Edit by a drifted contract must not lose what they wrote — losing
 *    it is how someone retypes a shortened version and restarts a funded
 *    mission with worse instructions than they meant;
 *  - Restart is unreachable with an empty field, so the disclosure cannot
 *    dispatch a run carrying nothing.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

import { MissionRestartAffordance } from "../MissionRestartAffordance.js";

const SESSION = "00000000-0000-4000-8000-000000000001";
const MISSION = "00000000-0000-4000-8000-0000000000aa";

const restartWithInstruction = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: { mission: { restartWithInstruction } },
  });
});

afterEach(() => {
  Reflect.deleteProperty(window, "vex");
});

function renderAffordance(disabled = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(MissionRestartAffordance, {
        sessionId: SESSION,
        missionId: MISSION,
        disabled,
      }),
    ) as ReactNode,
  );
}

function openDisclosure(): HTMLTextAreaElement {
  fireEvent.click(
    screen.getByRole("button", { name: /tell vex what to do differently/i }),
  );
  return screen.getByLabelText(/what should be different/i) as HTMLTextAreaElement;
}

describe("MissionRestartAffordance", () => {
  it("starts collapsed and opens on click", () => {
    renderAffordance();
    expect(screen.queryByLabelText(/what should be different/i)).toBeNull();

    openDisclosure();

    expect(screen.getByLabelText(/what should be different/i)).not.toBeNull();
  });

  it("keeps Restart unreachable until something is typed", () => {
    renderAffordance();
    openDisclosure();

    const submit = screen.getByRole("button", { name: /restart with instruction/i });
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/what should be different/i), {
      target: { value: "Skip the SOL leg." },
    });
    expect((submit as HTMLButtonElement).disabled).toBe(false);
  });

  it("sends the trimmed instruction and collapses on a dispatched restart", async () => {
    restartWithInstruction.mockResolvedValue({
      ok: true,
      data: { outcome: "dispatched", missionRunId: "run-2", sessionId: SESSION },
    });
    renderAffordance();
    const field = openDisclosure();
    fireEvent.change(field, { target: { value: "  Rebalance into USDC  " } });

    fireEvent.click(screen.getByRole("button", { name: /restart with instruction/i }));

    await waitFor(() => {
      expect(restartWithInstruction).toHaveBeenCalledWith({
        sessionId: SESSION,
        missionId: MISSION,
        instruction: "Rebalance into USDC",
      });
    });
    await waitFor(() => {
      expect(screen.queryByLabelText(/what should be different/i)).toBeNull();
    });
  });

  it("keeps the typed instruction when the contract is dirty", async () => {
    restartWithInstruction.mockResolvedValue({
      ok: true,
      data: { outcome: "contract_dirty", reason: "stale_acceptance" },
    });
    renderAffordance();
    const field = openDisclosure();
    fireEvent.change(field, { target: { value: "Skip the SOL leg." } });

    fireEvent.click(screen.getByRole("button", { name: /restart with instruction/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toMatch(
        /contract changed since you accepted it/i,
      );
    });
    // Still open, still holding what the user wrote.
    expect(
      (screen.getByLabelText(/what should be different/i) as HTMLTextAreaElement)
        .value,
    ).toBe("Skip the SOL leg.");
  });

  it("surfaces a transport failure instead of failing silently", async () => {
    restartWithInstruction.mockRejectedValue(new Error("ipc down"));
    renderAffordance();
    const field = openDisclosure();
    fireEvent.change(field, { target: { value: "Do it differently." } });

    fireEvent.click(screen.getByRole("button", { name: /restart with instruction/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toMatch(
        /couldn't restart the mission/i,
      );
    });
  });

  it("is inert while the control strip has an action in flight", () => {
    renderAffordance(true);
    const trigger = screen.getByRole("button", {
      name: /tell vex what to do differently/i,
    });
    expect((trigger as HTMLButtonElement).disabled).toBe(true);
  });
});
