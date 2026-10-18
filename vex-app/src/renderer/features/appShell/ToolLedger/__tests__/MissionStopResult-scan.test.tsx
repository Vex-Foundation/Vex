/**
 * The ended mission's result block links to the session's own Agent Scan
 * (the d2x-mission-completed render): every move the run made, verified on
 * chain. It names the active session, whose transcript is on screen, and is
 * not drawn without one.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useUiStore } from "../../../../stores/uiStore.js";
import { MissionStopResult } from "../MissionStopResult.js";

const SESSION = "33333333-3333-4333-8333-333333333333";
const RESULT = { reason: "goal_reached", summary: "TVL up 5%, the success criterion." } as const;

afterEach(() => {
  cleanup();
  useUiStore.setState({ activeSessionId: null, shellRoute: { kind: "none" } });
});

describe("MissionStopResult", () => {
  it("opens the session's own Agent Scan", () => {
    useUiStore.setState({ activeSessionId: SESSION });
    render(<MissionStopResult result={RESULT} />);
    expect(screen.getByText("Mission ended · Goal reached")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Agent Scan for this session" }));
    expect(useUiStore.getState().shellRoute).toEqual({
      kind: "agentScan",
      origin: null,
      sessionId: SESSION,
    });
  });

  it("draws no link without an active session", () => {
    useUiStore.setState({ activeSessionId: null });
    render(<MissionStopResult result={RESULT} />);
    expect(screen.queryByRole("button", { name: "Agent Scan for this session" })).toBeNull();
  });
});
