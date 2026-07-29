import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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
    // No provider error type by default — the bubble's error branch maps a
    // null label through the classifier's total default.
    errorType: null,
    ...overrides,
  };
}

describe("StreamingBubble", () => {
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
    // S4: the shell is photo-free — no avatar image survives the rebrand.
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("Hello");
    expect(container.textContent).toContain("world");
    // sr-only phase status (announced, not the growing text).
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

  it("shows the Calling status word with the tool name while a tool is preparing", () => {
    const { container } = render(
      createElement(StreamingBubble, {
        preview: preview({ status: "calling", toolName: "swap" }),
      }),
    );
    const hint = container.querySelector('[data-vex-tool-state="preparing"]');
    expect(hint).not.toBeNull();
    expect(hint?.textContent).toContain("Calling");
    expect(hint?.textContent).toContain("swap");
  });

  it("renders the elapsed counter ticking from startedAtMs (m:ss)", () => {
    render(
      createElement(StreamingBubble, {
        preview: preview({ startedAtMs: Date.now() }),
      }),
    );
    // Robust to test-runner latency: any m:ss reading proves the counter runs.
    expect(screen.getByText(/^\d+:\d{2}$/)).not.toBeNull();
  });

  it("shows the live reasoning tail with the ephemerality label while thinking", () => {
    const { container } = render(
      createElement(StreamingBubble, {
        preview: preview({ status: "thinking", reasoningText: "weigh the ledger options" }),
      }),
    );
    expect(container.textContent).toContain("Thinking");
    expect(container.textContent).toContain("weigh the ledger options");
    expect(screen.getByText("Ephemeral — not retained")).not.toBeNull();
    const trace = screen.getByRole("button", { name: "Reasoning trace" });
    expect(trace.getAttribute("aria-expanded")).toBe("false");
  });

  it("toggles aria-expanded when the reasoning trace is clicked", () => {
    render(
      createElement(StreamingBubble, {
        preview: preview({ status: "thinking", reasoningText: "trace" }),
      }),
    );
    const trace = screen.getByRole("button", { name: "Reasoning trace" });
    fireEvent.click(trace);
    expect(trace.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(trace);
    expect(trace.getAttribute("aria-expanded")).toBe("false");
  });

  it("collapses the trace to a 'Reasoned' summary once the answer streams, reopenable", () => {
    const { container } = render(
      createElement(StreamingBubble, {
        preview: preview({
          status: "writing",
          text: "The answer",
          reasoningText: "hidden-trace",
          reasoningTokens: 1234,
        }),
      }),
    );
    expect(container.textContent).toContain("Reasoned · 1.2K tokens");
    // Collapsed summary hides the full trace until the user reopens it.
    expect(container.textContent).not.toContain("hidden-trace");
    fireEvent.click(screen.getByRole("button", { name: "Reasoning trace" }));
    expect(container.textContent).toContain("hidden-trace");
  });

  it("shows a safe generic error line and never the raw text on error phase", () => {
    const { container } = render(
      createElement(StreamingBubble, {
        preview: preview({ phase: "error", text: "raw-provider-leak" }),
      }),
    );
    expect(
      container.querySelector('[data-vex-stream-phase="error"]'),
    ).not.toBeNull();
    // The strip no longer says the opaque "Stream error": with no errorType
    // the category classifier lands on `unknown`, whose copy still NAMES what
    // failed. Raw provider text remains excluded at every layer.
    expect(screen.getByText("The provider call failed")).not.toBeNull();
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

  // S5 circuit-break: the default (no prop) keeps every pin above unchanged;
  // a pending approval freezes the machine into the awaiting register.
  it("renders the Awaiting-signature status word while an approval is pending", () => {
    const { container } = render(
      createElement(StreamingBubble, {
        preview: preview({ status: "working" }),
        awaitingApproval: true,
      }),
    );
    const awaiting = container.querySelector("[data-vex-stream-awaiting]");
    expect(awaiting).not.toBeNull();
    expect(awaiting?.textContent).toBe("Awaiting signature");
    // The working status word yields to the awaiting register.
    expect(screen.queryByText("Working")).toBeNull();
    // Announced to screen readers as well (sr-only status).
    expect(screen.getAllByText("Awaiting signature").length).toBeGreaterThan(1);
  });

  it("drops the indicator once the stream is done", () => {
    const { container } = render(
      createElement(StreamingBubble, {
        preview: preview({ text: "final", phase: "done", status: "writing" }),
      }),
    );
    expect(container.querySelector('[data-vex-stream-phase="done"]')).not.toBeNull();
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    expect(screen.getByText("Vex responded")).not.toBeNull();
  });
});
