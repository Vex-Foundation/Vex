/**
 * Ack-gating + theme-derivation logic for the Hypervexing workspace mode.
 * These are the product-locked decision rules; they stay pure so they can be
 * pinned without React/store/bridge.
 */

import { describe, expect, it } from "vitest";
import type { HyperliquidWorkspaceModeEvent } from "@shared/schemas/hyperliquid.js";
import {
  deriveShellTheme,
  resolveWorkspaceModeEvent,
} from "../workspaceModeGate.js";

function event(
  mode: "hypervexing" | "normal",
  acknowledged: boolean,
): HyperliquidWorkspaceModeEvent {
  return {
    sessionId: "00000000-0000-4000-8000-000000000001",
    mode,
    requestedBy: "agent",
    acknowledged,
  };
}

describe("resolveWorkspaceModeEvent", () => {
  it("enters directly when the agent asks for the mode and risk is acknowledged", () => {
    expect(resolveWorkspaceModeEvent(event("hypervexing", true))).toEqual({
      type: "enter",
    });
  });

  it("gates on the acknowledgment when the mode is requested but not yet acknowledged", () => {
    expect(resolveWorkspaceModeEvent(event("hypervexing", false))).toEqual({
      type: "acknowledge",
    });
  });

  it("exits when the agent asks for normal (regardless of the ack flag)", () => {
    expect(resolveWorkspaceModeEvent(event("normal", true))).toEqual({
      type: "exit",
    });
    expect(resolveWorkspaceModeEvent(event("normal", false))).toEqual({
      type: "exit",
    });
  });
});

describe("deriveShellTheme", () => {
  it("reads 'hypervexing' while the mode is active, whatever the user's theme", () => {
    expect(deriveShellTheme("hypervexing", "vex")).toBe("hypervexing");
    expect(deriveShellTheme("hypervexing", "robinhood")).toBe("hypervexing");
  });

  it("restores the user's own theme when the mode is normal (EXIT is lossless)", () => {
    expect(deriveShellTheme("normal", "vex")).toBe("vex");
    expect(deriveShellTheme("normal", "robinhood")).toBe("robinhood");
  });
});
