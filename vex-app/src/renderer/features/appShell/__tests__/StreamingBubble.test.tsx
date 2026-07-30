/**
 * THE IN-FLIGHT TURN — `StreamingBubble` (the thin mount) + the `TurnIsland`
 * it renders.
 *
 * Pins the island's state machine end to end: Working → Thinking (FULL live
 * reasoning as markdown, no masked peek, no "Ephemeral — not retained" label
 * now that reasoning is persisted) → Calling {tool} → Writing (answer below,
 * "Reasoned" stamp above). Plus the invariants inherited from the working
 * strip it replaces: the elapsed m:ss counter, the awaiting-signature FREEZE,
 * the sr-only `role="status"` announcements, and an error branch that shows a
 * safe generic line and NEVER the raw text or the trace.
 *
 * `data-vex-island-state` is the seam — the visual shell may be retuned
 * without rewriting these assertions.
 */

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { createElement } from "react";

import { StreamingBubble } from "../StreamingBubble.js";
import type { StreamPreview } from "../../../stores/streamStore.js";

function preview(overrides: Partial<StreamPreview> = {}): StreamPreview {
  return {
    streamId: "s1",
    text: "",
    phase: "streaming",
    toolName: null,
    reasoningText: "",
    reasoningTokens: null,
    startedAtMs: Date.now(),
    status: "working",
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

describe("StreamingBubble — answer stream", () => {
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

describe("TurnIsland — state transitions", () => {
  it("starts in the compact Working state", () => {
    const { container } = render(
      createElement(StreamingBubble, { preview: preview({ status: "working" }) }),
    );
    expect(islandState(container)).toBe("working");
    expect(container.textContent).toContain("Working");
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

  it("retires the ephemerality label — reasoning is persisted now", () => {
    const { container } = render(
      createElement(StreamingBubble, {
        preview: preview({ status: "thinking", reasoningText: "trace" }),
      }),
    );
    expect(container.textContent).not.toContain("Ephemeral");
  });

  it("shows Calling with the tool name while a tool is preparing", () => {
    const { container } = render(
      createElement(StreamingBubble, {
        preview: preview({ status: "calling", toolName: "swap_execute_uniswap" }),
      }),
    );
    expect(islandState(container)).toBe("calling");
    const label = container.querySelector("[data-vex-island-label]");
    expect(label?.textContent).toContain("Calling");
    expect(label?.textContent).toContain("swap_execute_uniswap");
    // Contract C5: a protocol-backed tool wears its venue mark.
    expect(
      container.querySelector('[data-vex-protocol-mark="Uniswap"]'),
    ).not.toBeNull();
  });

  it("settles to the Writing stamp with the answer streaming below it", () => {
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
    // Same stamp grammar the persisted ReasonedBlock uses.
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

describe("TurnIsland — freeze, error, and settle", () => {
  it("FREEZES into the awaiting-signature register while an approval is pending", () => {
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
    expect(screen.getAllByText("Awaiting signature").length).toBeGreaterThan(1);
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
