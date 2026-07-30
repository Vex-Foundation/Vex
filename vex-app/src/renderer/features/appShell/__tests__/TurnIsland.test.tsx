/**
 * The Turn Island's freeze reaches the SHELL, not just the loading bar.
 *
 * `islandTurnState.test.ts` proves the state machine produces `animated:false`
 * while a signature is pending; this asserts the component actually threads
 * that stillness into the island primitive, which is where the earlier defect
 * lived — the derivation was right and nothing consumed it, so the shell kept
 * springing into the awaiting state.
 */

import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { createElement } from "react";
import { TurnIsland } from "../TurnIsland/TurnIsland.js";
import type { StreamPreview } from "../../../stores/streamStore.js";

const PREVIEW: StreamPreview = {
  streamId: "s1",
  text: "",
  phase: "streaming",
  toolName: "wallet_send",
  reasoningText: "",
  reasoningTokens: null,
  startedAtMs: 0,
  errorType: null,
  status: "calling",
};

function island(awaitingApproval: boolean): Element | null {
  const { container } = render(
    createElement(TurnIsland, { preview: PREVIEW, awaitingApproval }),
  );
  return container.querySelector("#vex-turn-island");
}

describe("TurnIsland freeze", () => {
  it("freezes the island shell while a signature is pending", () => {
    const el = island(true);
    expect(el?.hasAttribute("data-vex-island-still")).toBe(true);
  });

  it("leaves the shell animating during ordinary work", () => {
    const el = island(false);
    expect(el?.hasAttribute("data-vex-island-still")).toBe(false);
  });
});
