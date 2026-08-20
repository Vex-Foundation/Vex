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
import { fireEvent, render } from "@testing-library/react";
import { createElement } from "react";
import { TurnIsland } from "../TurnIsland/TurnIsland.js";
import type { StreamPreview } from "../../../stores/streamStore.js";

const PREVIEW: StreamPreview = {
  streamId: "s1",
  text: "",
  phase: "streaming",
  toolName: "wallet_send",
  reasoningSegments: [],
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

/**
 * SEGMENTED INLINE REASONING (owner decree 2026-07-30): "reasoning pokazuje
 * się jako Thinking: i streamuje jako normalna wiadomość; po zakończeniu lub
 * wywołaniu toola zwija się do rozwinięcia; po toolu znowu Thinking: […] bez
 * cięć; po rozwinięciu cały reasoning; inna czcionka".
 *
 * The store's half (when a segment opens and settles) is pinned in
 * `stores/__tests__/streamStore.test.ts`; this is the presentation half.
 */
describe("TurnIsland reasoning segments", () => {
  function renderIsland(over: Partial<StreamPreview>) {
    return render(
      createElement(TurnIsland, {
        preview: { ...PREVIEW, ...over },
        awaitingApproval: false,
      }),
    ).container;
  }

  it("streams the ACTIVE segment inline under a Thinking: caption, with no height cut", () => {
    const container = renderIsland({
      status: "thinking",
      reasoningText: "weighing the route",
    });
    const label = container.querySelector("[data-vex-island-label]");
    expect(label?.textContent).toBe("Thinking:");

    const body = container.querySelector("[data-vex-island-reasoning]");
    expect(body?.textContent).toContain("weighing the route");
    // No window, no clipping, no independent scroll box — a thought is read
    // whole or it is not read.
    expect(body?.className).not.toMatch(/max-h-|overflow-y-auto/);
    // The reasoning register: serif italic, muted (`.vex-reasoning-prose`).
    expect(body?.className).toContain("vex-reasoning-prose");
  });

  it("stacks SETTLED segments as collapsed stamps that expand to the full text", () => {
    const container = renderIsland({
      status: "thinking",
      reasoningSegments: ["first thought", "second thought"],
      reasoningText: "third thought",
    });
    const stamps = container.querySelectorAll("[data-vex-reasoning-segment]");
    expect(stamps).toHaveLength(2);
    // Ordered, and numbered because the order carries information (what Vex
    // thought before the tool answered versus after).
    const buttons = container.querySelectorAll(
      "[data-vex-reasoning-segment] button",
    );
    expect(buttons[0]?.textContent).toBe("Thought 1");
    expect(buttons[1]?.textContent).toBe("Thought 2");
    // Collapsed by default — a settled thought never buries the live one.
    expect(container.textContent).not.toContain("first thought");

    fireEvent.click(buttons[0] as HTMLElement);
    expect(container.textContent).toContain("first thought");
    expect(buttons[0]?.getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps the settled stamps mounted while a TOOL is being called", () => {
    // The whole point of settling on `tool_call`: the thought that produced
    // the call stays readable while the call runs.
    const container = renderIsland({
      status: "calling",
      reasoningSegments: ["why I am calling this"],
      reasoningText: "",
    });
    expect(
      container.querySelectorAll("[data-vex-reasoning-segment]"),
    ).toHaveLength(1);
  });

  it("a single thought is not numbered", () => {
    const container = renderIsland({
      status: "writing",
      reasoningSegments: ["the only thought"],
    });
    expect(
      container.querySelector("[data-vex-reasoning-segment] button")?.textContent,
    ).toBe("Thought");
  });

  /**
   * The island's one motion is the sanctioned cobalt shimmer on the status
   * word — the same class the reasoning-effort selector and the VEX speaker
   * caption wear. The freeze must take it away, because motion while a
   * signature is pending reads as progress that is not happening.
   */
  it("shimmers the live status word and stills it under the freeze", () => {
    const live = renderIsland({ status: "working" }).querySelector(
      "[data-vex-island-label]",
    );
    expect(live?.className).toContain("vex-turn-shimmer");

    const frozen = render(
      createElement(TurnIsland, { preview: PREVIEW, awaitingApproval: true }),
    ).container.querySelector("[data-vex-island-label]");
    expect(frozen?.className).not.toContain("vex-turn-shimmer");
  });
});
