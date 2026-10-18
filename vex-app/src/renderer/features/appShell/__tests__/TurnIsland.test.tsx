/**
 * The turn's live row (docs/design/R3-MINIMAL.md section 6): its freeze
 * reaches the SHELL, not just the loading bar, and its fills, scope and clock
 * wear the R3 grammar.
 *
 * `islandTurnState.test.ts` proves the state machine produces `animated:false`
 * while an approval is pending; this asserts the component actually threads
 * that stillness into the island primitive, which is where the earlier defect
 * lived: the derivation was right and nothing consumed it, so the shell kept
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
  errorDetail: null,
  status: "calling",
};

function island(awaitingApproval: boolean): Element | null {
  const { container } = render(
    createElement(TurnIsland, { preview: PREVIEW, awaitingApproval }),
  );
  return container.querySelector("#vex-turn-island");
}

describe("TurnIsland freeze", () => {
  it("freezes the island shell while an approval is pending", () => {
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

  it("streams the ACTIVE segment inline under a Thinking: row, with no height cut", () => {
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
    // The reasoning register: sans, muted (`.vex-reasoning-prose`).
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
   * Status is shown by FILL (docs/design/R3-MINIMAL.md sections 1.6 and 6):
   * live work is the solid fill, thinking the hatch, the awaiting freeze the
   * target (it never moves), an error the ink cross. Nothing in the island
   * uses the old stepping "ongoing" screen or the "warning" target now,
   * and no shimmer or sweep survives anywhere on it.
   */
  it("leads the live status word with the solid fill and swaps it for the target under the freeze", () => {
    const working = renderIsland({ status: "working" });
    const live = working.querySelector("[data-vex-island-label]");
    expect(live?.textContent).toBe("Working");
    const liveSwatch = live?.parentElement?.querySelector(".vex-swatch");
    expect(liveSwatch?.getAttribute("data-s")).toBe("done");
    expect(working.querySelector(".vex-turn-shimmer, .vex-row-sweep")).toBeNull();

    const frozen = render(
      createElement(TurnIsland, { preview: PREVIEW, awaitingApproval: true }),
    ).container;
    const frozenLabel = frozen.querySelector("[data-vex-island-label]");
    expect(frozenLabel?.textContent).toBe("Waiting for approval");
    expect(
      frozenLabel?.parentElement?.querySelector(".vex-swatch")?.getAttribute("data-s"),
    ).toBe("awaiting");
    // The awaiting row takes the blue line (reference d4).
    expect(
      frozen.querySelector("[data-vex-island-size]")?.getAttribute("data-vex-island-tone"),
    ).toBe("pin");
  });

  it.each([
    ["working", { status: "working" }, "done"],
    ["thinking", { status: "thinking", reasoningText: "x" }, "thinking"],
    ["calling", { status: "calling" }, "done"],
    ["running", { phase: "done", status: "calling" }, "done"],
    ["writing", { status: "writing" }, "done"],
    ["error", { phase: "error" }, "error"],
  ] as const)("the %s row wears the %s fill, never ongoing or warning", (state, over, fill) => {
    const container = renderIsland(over);
    expect(
      container.querySelector("[data-vex-island-state]")?.getAttribute("data-vex-island-state"),
    ).toBe(state);
    const swatches = container.querySelectorAll("[data-vex-island-state] .vex-swatch");
    expect(swatches).toHaveLength(1);
    expect(swatches[0]?.getAttribute("data-s")).toBe(fill);
    expect(container.querySelector('.vex-swatch[data-s="ongoing"]')).toBeNull();
    expect(container.querySelector('.vex-swatch[data-s="warning"]')).toBeNull();
  });

  it("sets the scope inline in the row, 13 muted, hidden from assistive tech", () => {
    const working = renderIsland({ status: "working", streamId: "s2" });
    const label = working.querySelector("[data-vex-island-label]");
    const detail = working.querySelector("[data-vex-island-detail]");
    expect(detail?.textContent).toBe("Waiting for the model");
    // Same row as the word, not a mono caps caption below it.
    expect(detail?.parentElement).toBe(label?.parentElement);
    expect(detail?.getAttribute("aria-hidden")).toBe("true");
    expect(detail?.className).toContain("vex-step__word");
    expect(detail?.className).not.toMatch(/font-mono|uppercase|tracking-/);

    // A reasoned Writing row keeps the stamp as its scope; a bare one has none.
    const writing = renderIsland({
      status: "writing",
      reasoningText: "x",
      reasoningTokens: 1234,
    });
    expect(writing.querySelector("[data-vex-island-label]")?.textContent).toBe("Writing");
    expect(writing.querySelector("[data-vex-island-detail]")?.textContent).toBe(
      "Reasoned · 1.2K tokens",
    );
    expect(
      renderIsland({ status: "writing" }).querySelector("[data-vex-island-detail]"),
    ).toBeNull();
  });

  it("announces the word and its scope once, in the sr-only status", () => {
    const container = renderIsland({ status: "working", streamId: "s2" });
    const status = container.querySelector('[role="status"]');
    expect(status?.className).toContain("sr-only");
    expect(status?.textContent).toContain("Working Waiting for the model");
  });

  it("sets the elapsed clock in the mono 12 tabular, coloured by the row, never the italic serif", () => {
    const container = renderIsland({ status: "thinking", reasoningText: "x" });
    const clock = container.querySelector("[data-vex-island-clock] span");
    expect(clock?.className).toContain("vex-step__num");
    expect(clock?.className).toContain("shrink-0");
    expect(clock?.className).toContain("font-mono");
    expect(clock?.className).toContain("tabular-nums");
    expect(clock?.className).not.toMatch(/font-serif|italic/);
    // The colour is the row's blue, not the second ink and not a fixed size.
    expect(clock?.className).not.toMatch(/text-ink-secondary|text-\[11px\]/);
    // The head of the row is the step grammar: no mono caps, no italic.
    const row = container.querySelector("[data-vex-island-label]")?.parentElement;
    expect(row?.className).toContain("vex-step");
    expect(row?.className).not.toMatch(/font-mono|uppercase|italic/);
    expect(
      container.querySelector("[data-vex-island-label]")?.className,
    ).toContain("vex-step__title");
  });

  it("carries the clock on every live state and on none of the settled ones", () => {
    for (const status of ["working", "thinking", "calling", "writing"] as const) {
      expect(
        renderIsland({ status }).querySelector("[data-vex-island-clock]"),
      ).not.toBeNull();
    }
    expect(renderIsland({ phase: "error" }).querySelector("[data-vex-island-clock]")).toBeNull();
  });
});
