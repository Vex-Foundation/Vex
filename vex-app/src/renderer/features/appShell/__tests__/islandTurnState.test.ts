/**
 * The Turn Island's state machine, tested without rendering anything.
 *
 * The precedence order is the safety property: an ERROR is never dressed as
 * work, and a pending signature FREEZES the island over whatever the stream
 * was doing — motion in this shell means verifiable work is happening, and
 * waiting on the user's pen is not work.
 */

import { describe, expect, it } from "vitest";
import type { StreamPreview } from "../../../stores/streamStore.js";
import { resolveTurnIslandView } from "../TurnIsland/islandTurnState.js";

function preview(overrides: Partial<StreamPreview> = {}): StreamPreview {
  return {
    streamId: "s1",
    text: "",
    phase: "streaming",
    toolName: null,
    reasoningText: "",
    reasoningTokens: null,
    startedAtMs: 0,
    errorType: null,
    status: "working",
    ...overrides,
  };
}

describe("resolveTurnIslandView — the four working states", () => {
  it("working → compact pill", () => {
    const view = resolveTurnIslandView(preview({ status: "working" }), false);
    expect(view).toMatchObject({ state: "working", size: "pill", label: "Working" });
  });

  it("thinking → the expanded panel in the accent tone", () => {
    const view = resolveTurnIslandView(preview({ status: "thinking" }), false);
    expect(view).toMatchObject({
      state: "thinking",
      size: "panel",
      label: "Thinking",
      tone: "accent",
    });
  });

  it("calling → a tool row naming the tool", () => {
    const view = resolveTurnIslandView(
      preview({ status: "calling", toolName: "swap_execute_uniswap" }),
      false,
    );
    expect(view.state).toBe("calling");
    expect(view.size).toBe("row");
    expect(view.label).toBe("Calling swap_execute_uniswap");
  });

  it("calling with no tool name yet still reads honestly", () => {
    expect(resolveTurnIslandView(preview({ status: "calling" }), false).label).toBe(
      "Calling tool",
    );
  });

  it("writing → the Reasoned stamp when reasoning happened, else 'Writing'", () => {
    const withTrace = resolveTurnIslandView(
      preview({ status: "writing", reasoningText: "t", reasoningTokens: 1234 }),
      false,
    );
    expect(withTrace).toMatchObject({ state: "writing", size: "stamp" });
    expect(withTrace.label).toBe("Reasoned · 1.2K tokens");

    const noTrace = resolveTurnIslandView(preview({ status: "writing" }), false);
    expect(noTrace.label).toBe("Writing");
  });
});

describe("resolveTurnIslandView — precedence", () => {
  it("an error outranks everything and never animates", () => {
    const view = resolveTurnIslandView(
      preview({ phase: "error", status: "thinking", reasoningText: "trace" }),
      true,
    );
    expect(view).toMatchObject({
      state: "error",
      label: "The provider call failed",
      tone: "error",
      animated: false,
    });
  });

  it("a pending approval FREEZES the island over any working status", () => {
    for (const status of ["working", "thinking", "calling", "writing"] as const) {
      const view = resolveTurnIslandView(preview({ status }), true);
      expect(view.state).toBe("awaiting");
      expect(view.label).toBe("Awaiting signature");
      expect(view.tone).toBe("pin");
      // Trust is stillness — nothing may move while we wait for the pen.
      expect(view.animated).toBe(false);
    }
  });

  it("a settled turn keeps only the stamp, and disappears entirely without one", () => {
    const withTrace = resolveTurnIslandView(
      preview({ phase: "done", reasoningText: "t", reasoningTokens: 900 }),
      false,
    );
    expect(withTrace).toMatchObject({ state: "settled", size: "stamp" });
    expect(withTrace.label).toBe("Reasoned · 900 tokens");

    const bare = resolveTurnIslandView(preview({ phase: "done" }), false);
    expect(bare).toMatchObject({ state: "settled", size: "hidden", label: "" });
  });

  it("a DONE turn with a pending signature is awaiting, not settled", () => {
    // The stream ends the moment a tool call needs approval, so `done` +
    // pending is the ORDINARY shape of a blocked turn. Ranking settled first
    // dressed it as finished and dropped the one label that says the pen is
    // with the user.
    const view = resolveTurnIslandView(
      preview({ phase: "done", reasoningText: "t", reasoningTokens: 900 }),
      true,
    );
    expect(view.state).toBe("awaiting");
    expect(view.label).toBe("Awaiting signature");
    expect(view.animated).toBe(false);
  });

  it("an error still outranks a pending signature", () => {
    expect(
      resolveTurnIslandView(preview({ phase: "error" }), true).state,
    ).toBe("error");
  });

  it("the elapsed counter runs only while the turn is live", () => {
    expect(resolveTurnIslandView(preview(), false).showElapsed).toBe(true);
    expect(resolveTurnIslandView(preview(), true).showElapsed).toBe(true);
    expect(
      resolveTurnIslandView(preview({ phase: "done" }), false).showElapsed,
    ).toBe(false);
    expect(
      resolveTurnIslandView(preview({ phase: "error" }), false).showElapsed,
    ).toBe(false);
  });
});
