/**
 * THE IN-FLIGHT TURN: `StreamingBubble` (the thin mount) + the `TurnIsland`
 * live row it renders (docs/design/R3-MINIMAL.md section 6).
 *
 * Pins the row's state machine end to end: Working, Thinking (FULL live
 * reasoning as markdown, no masked peek, no "Ephemeral" label now that
 * reasoning is persisted), Calling {tool}, Writing (answer below, the
 * "Reasoned" stamp as the row's inline scope). Plus the invariants inherited
 * from the working strip it replaces: the elapsed m:ss counter, the
 * awaiting-approval FREEZE ("Waiting for approval"), the sr-only
 * `role="status"` announcements, and an error branch that shows a safe
 * generic line and NEVER the raw text or the trace.
 *
 * `data-vex-island-state` is the seam; the visual shell may be retuned
 * without rewriting these assertions.
 */

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { createElement } from "react";

import { StreamingBubble } from "../StreamingBubble.js";
import type { StreamPreview } from "../../../stores/streamStore.js";
import { PENDING_TURN_STREAM_ID } from "../SessionTranscript/turnPreview.js";

function preview(overrides: Partial<StreamPreview> = {}): StreamPreview {
  return {
    streamId: "s1",
    text: "",
    phase: "streaming",
    toolName: null,
    reasoningSegments: [],
    reasoningText: "",
    reasoningTokens: null,
    startedAtMs: Date.now(),
    status: "working",
    errorType: null,
    errorDetail: null,
    ...overrides,
  };
}

/** The island's declared state for the rendered preview. */
function islandState(container: HTMLElement): string | null {
  return (
    container
      .querySelector("[data-vex-island-state]")
      ?.getAttribute("data-vex-island-state") ?? null
  );
}

describe("StreamingBubble - answer stream", () => {
  it("renders streamed markdown text with the semantic stream-preview contract (photo-free)", () => {
    const { container } = render(
      createElement(StreamingBubble, {
        preview: preview({ text: "Hello **world**", status: "writing" }),
      }),
    );
    const root = container.querySelector('[data-vex-area="stream-preview"]');
    expect(root).not.toBeNull();
    expect(root?.getAttribute("data-vex-stream-phase")).toBe("streaming");
    expect(root?.getAttribute("data-vex-message-role")).toBe("assistant");
    expect(root?.getAttribute("aria-busy")).toBe("true");
    // The shell is photo-free — no avatar image survives the rebrand.
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("Hello");
    expect(container.textContent).toContain("world");
    expect(screen.getByText("Vex is responding")).not.toBeNull();
  });

  it("keeps markdown links accessible (not under an aria-hidden ancestor)", () => {
    const { container } = render(
      createElement(StreamingBubble, {
        preview: preview({ text: "see [docs](https://example.com)", status: "writing" }),
      }),
    );
    const link = container.querySelector("a");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toContain("example.com");
    expect(link?.closest('[aria-hidden="true"]')).toBeNull();
  });
});

describe("TurnIsland - state transitions", () => {
  it("starts in the working state, worded 'Working' behind the solid fill - the 'vexing…' word is retired", () => {
    const { container } = render(
      createElement(StreamingBubble, { preview: preview({ status: "working" }) }),
    );
    expect(islandState(container)).toBe("working");
    const label = container.querySelector("[data-vex-island-label]");
    expect(label?.textContent).toBe("Working");
    expect(label?.textContent).not.toContain("vexing");
    // Live work wears the solid fill (the same swatch the Working sidebar
    // state uses), never the old stepping dot screen.
    expect(
      label?.parentElement?.querySelector(".vex-swatch")?.getAttribute("data-s"),
    ).toBe("done");
  });

  it("keeps the working row in flow - it is the ONLY pending surface", () => {
    // Regression guard for the retired centred scene: nothing may suppress
    // this row, or a pending turn would show nothing at all.
    const { container } = render(
      createElement(StreamingBubble, { preview: preview({ status: "working" }) }),
    );
    expect(
      container.querySelector("[data-vex-island-label]")?.textContent,
    ).toBe("Working");
    expect(screen.getByText("Vex is responding")).not.toBeNull();
    // The sr-only status is the one announcement of the word and its scope.
    expect(screen.getByText("Working Waiting for the model")).not.toBeNull();
  });

  it("expands into Thinking and renders the FULL reasoning as live markdown", () => {
    const { container } = render(
      createElement(StreamingBubble, {
        preview: preview({
          status: "thinking",
          reasoningText: "weigh the **ledger** options",
        }),
      }),
    );
    expect(islandState(container)).toBe("thinking");
    expect(container.textContent).toContain("Thinking");
    // Markdown, not a pre-wrapped raw tail: the emphasis becomes an element.
    const reasoning = container.querySelector("[data-vex-island-reasoning]");
    expect(reasoning).not.toBeNull();
    expect(reasoning?.textContent).toContain("weigh the");
    expect(reasoning?.querySelector("strong")?.textContent).toBe("ledger");
  });

  it("retires the ephemerality label - reasoning is persisted now", () => {
    const { container } = render(
      createElement(StreamingBubble, {
        preview: preview({ status: "thinking", reasoningText: "trace" }),
      }),
    );
    expect(container.textContent).not.toContain("Ephemeral");
  });

  // The label carries the tool's HUMAN identity — the same title the persisted
  // card shows — rather than the raw symbol the model called.
  it("shows Calling with the tool's human title while a tool is preparing", () => {
    const { container } = render(
      createElement(StreamingBubble, {
        preview: preview({ status: "calling", toolName: "swap_execute_uniswap" }),
      }),
    );
    expect(islandState(container)).toBe("calling");
    const label = container.querySelector("[data-vex-island-label]");
    expect(label?.textContent).toContain("Calling");
    expect(label?.textContent).toContain("Swap · Uniswap");
    // Contract C5: a protocol-backed tool wears its venue mark.
    expect(
      container.querySelector('[data-vex-protocol-mark="Uniswap"]'),
    ).not.toBeNull();
  });

  it("writes with the Reasoned stamp as its inline scope and the answer streaming below", () => {
    const { container } = render(
      createElement(StreamingBubble, {
        preview: preview({
          status: "writing",
          text: "The answer",
          reasoningText: "the trace",
          reasoningTokens: 1234,
        }),
      }),
    );
    expect(islandState(container)).toBe("writing");
    // The word is always "Writing"; the stamp the thinking left behind rides
    // inline beside it, in the same grammar the persisted ReasonedBlock uses.
    const label = container.querySelector("[data-vex-island-label]");
    expect(label?.textContent).toBe("Writing");
    const detail = container.querySelector("[data-vex-island-detail]");
    expect(detail?.textContent).toBe("Reasoned · 1.2K tokens");
    expect(detail?.parentElement).toBe(label?.parentElement);
    expect(container.textContent).toContain("Reasoned · 1.2K tokens");
    // The answer is below the island, and the trace is no longer on screen.
    expect(container.textContent).toContain("The answer");
    expect(container.textContent).not.toContain("the trace");
  });

  it("renders the elapsed counter ticking from startedAtMs (m:ss)", () => {
    render(
      createElement(StreamingBubble, { preview: preview({ startedAtMs: Date.now() }) }),
    );
    // Robust to test-runner latency: any m:ss reading proves the counter runs.
    expect(screen.getByText(/^\d+:\d{2}$/)).not.toBeNull();
  });
});

describe("TurnIsland - freeze, error, and settle", () => {
  it("FREEZES into the awaiting-approval register while an approval is pending", () => {
    const { container } = render(
      createElement(StreamingBubble, {
        preview: preview({ status: "thinking", reasoningText: "mid-thought" }),
        awaitingApproval: true,
      }),
    );
    expect(islandState(container)).toBe("awaiting");
    expect(container.querySelector("[data-vex-stream-awaiting]")).not.toBeNull();
    // The status word yields to the awaiting register…
    expect(screen.queryByText("Thinking")).toBeNull();
    // …and it is announced to screen readers as well as shown.
    expect(screen.getAllByText("Waiting for approval").length).toBeGreaterThan(1);
    expect(screen.queryByText("Awaiting signature")).toBeNull();
  });

  it("shows the classified error copy and never the raw text on error phase", () => {
    const { container } = render(
      createElement(StreamingBubble, {
        preview: preview({ phase: "error", text: "raw-provider-leak" }),
      }),
    );
    expect(
      container.querySelector('[data-vex-stream-phase="error"]'),
    ).not.toBeNull();
    expect(islandState(container)).toBe("error");
    // No errorType on the preview → the classifier's honest `unknown` copy
    // (shared table with the error banner), never a bare "Stream error".
    expect(screen.getByText("The provider call failed")).not.toBeNull();
    expect(
      screen.getByText(/cause was not reported/i),
    ).not.toBeNull();
    expect(container.textContent).not.toContain("raw-provider-leak");
  });

  it("marks an interrupted reasoning trace quietly on error, without the trace text", () => {
    const { container } = render(
      createElement(StreamingBubble, {
        preview: preview({ phase: "error", reasoningText: "private-trace" }),
      }),
    );
    expect(screen.getByText("Reasoning interrupted")).not.toBeNull();
    expect(container.textContent).not.toContain("private-trace");
  });

  it("drops the busy indicator once the stream is done", () => {
    const { container } = render(
      createElement(StreamingBubble, {
        preview: preview({ text: "final", phase: "done", status: "writing" }),
      }),
    );
    expect(container.querySelector('[data-vex-stream-phase="done"]')).not.toBeNull();
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    expect(islandState(container)).toBe("settled");
    expect(screen.getByText("Vex responded")).not.toBeNull();
  });
});

describe("TurnIsland - turn phase (U-3)", () => {
  function phaseOf(container: HTMLElement): string | null {
    return (
      container
        .querySelector("[data-vex-turn-phase]")
        ?.getAttribute("data-vex-turn-phase") ?? null
    );
  }

  it("scopes the Working row with the step, inline beside the word", () => {
    const { container, rerender } = render(
      createElement(StreamingBubble, {
        preview: preview({ streamId: PENDING_TURN_STREAM_ID }),
      }),
    );
    expect(phaseOf(container)).toBe("preparing");
    const label = container.querySelector("[data-vex-island-label]");
    expect(label?.textContent).toBe("Working");
    const detail = container.querySelector("[data-vex-island-detail]");
    expect(detail?.textContent).toBe("Preparing the turn");
    // INLINE in the row (not a caption below it), quiet, and hidden from
    // assistive tech because the status region already announces it.
    expect(detail?.parentElement).toBe(label?.parentElement);
    expect(detail?.getAttribute("aria-hidden")).toBe("true");
    expect(detail?.className).toContain("vex-step__word");

    rerender(
      createElement(StreamingBubble, {
        preview: preview({ streamId: PENDING_TURN_STREAM_ID }),
        leaseHeld: true,
      }),
    );
    expect(phaseOf(container)).toBe("waiting_provider");
    expect(container.querySelector("[data-vex-island-detail]")?.textContent).toBe(
      "Waiting for the model",
    );
  });

  it("shows a RUNNING tool row while the tool executes, announced as live work", () => {
    const { container } = render(
      createElement(StreamingBubble, {
        preview: preview({ phase: "done", status: "calling", toolName: "swap_quote" }),
      }),
    );
    expect(islandState(container)).toBe("running");
    expect(phaseOf(container)).toBe("running_tool");
    const label = container.querySelector("[data-vex-island-label]")?.textContent ?? "";
    expect(label.startsWith("Running ")).toBe(true);
    expect(container.querySelector('[data-vex-sweep="running"]')).not.toBeNull();
    expect(screen.getByText("Vex is responding")).not.toBeNull();
    // No scope on the running row (only Working and a reasoned Writing carry one).
    expect(container.querySelector("[data-vex-island-detail]")).toBeNull();
  });
});

describe("StreamingBubble - Vex's token on the live row", () => {
  it("renders no token by default", () => {
    const { container } = render(
      createElement(StreamingBubble, { preview: preview({ status: "writing", text: "Hi" }) }),
    );
    expect(container.querySelector("[data-vex-agent-avatar]")).toBeNull();
    expect(container.querySelector("[data-vex-vx-token]")).toBeNull();
  });

  it("renders the vx token once, ahead of the live row, when turnMark is set", () => {
    const { container } = render(
      createElement(StreamingBubble, {
        preview: preview({ status: "working" }),
        turnMark: true,
      }),
    );
    const marks = container.querySelectorAll("[data-vex-agent-avatar]");
    expect(marks).toHaveLength(1);
    expect(marks[0]?.querySelector("[data-vex-vx-token]")).not.toBeNull();
    const row = container.querySelector("[data-vex-island-state]");
    expect(row).not.toBeNull();
    // The token leads the row in document order (it marks the turn's start).
    expect(
      marks[0]?.compareDocumentPosition(row as Node) ?? 0,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("shows the token beside the error row and still never the raw text", () => {
    const { container } = render(
      createElement(StreamingBubble, {
        preview: preview({ phase: "error", text: "raw-provider-leak" }),
        turnMark: true,
      }),
    );
    expect(container.querySelector("[data-vex-agent-avatar]")).not.toBeNull();
    expect(islandState(container)).toBe("error");
    expect(container.textContent).not.toContain("raw-provider-leak");
  });
});
