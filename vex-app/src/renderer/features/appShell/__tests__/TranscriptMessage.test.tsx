/**
 * TranscriptMessage marker render tests (stage 8-4).
 *
 * Covers the two inline markers added in 8-4: the static `CompactionMarker`
 * and the static `MemoryMarker`. Asserts accurate memory-vs-knowledge copy,
 * that assistant prose on a recall row is preserved, and that an empty recall
 * row renders the indicator only. Markers are static — no in-flight animation.
 */

import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { TranscriptMessage } from "../TranscriptMessage.js";
import type {
  TranscriptRowModel,
  TranscriptRowVariant,
} from "../transcriptRowModel.js";

const ISO = "2026-05-26T10:00:00.000Z";

function row(p: {
  readonly variant: TranscriptRowVariant;
  readonly label?: string | null;
  readonly content?: string;
}): TranscriptRowModel {
  return {
    id: 1,
    variant: p.variant,
    label: p.label ?? null,
    content: p.content ?? "",
    createdAt: ISO,
  };
}

describe("TranscriptMessage markers (8-4)", () => {
  it("renders the compaction marker text", () => {
    const { container } = render(
      createElement(TranscriptMessage, {
        row: row({
          variant: "compaction",
          content: "Conversation compacted into memory · checkpoint 2",
        }),
      }),
    );
    expect(
      screen.getByText(/Conversation compacted into memory · checkpoint 2/),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-vex-marker="compaction"]'),
    ).not.toBeNull();
  });

  it("labels session_memory_search as session memory and preserves assistant prose", () => {
    render(
      createElement(TranscriptMessage, {
        row: row({
          variant: "recall",
          label: "session_memory_search",
          content: "Let me check what I remember.",
        }),
      }),
    );
    expect(screen.getByText("Recalled session memory")).not.toBeNull();
    expect(screen.getByText("Let me check what I remember.")).not.toBeNull();
  });

  it("labels the long_memory_* reads as long-term memory", () => {
    render(
      createElement(TranscriptMessage, {
        row: row({ variant: "recall", label: "long_memory_search", content: "" }),
      }),
    );
    expect(screen.getByText("Recalled long-term memory")).not.toBeNull();
  });

  it("falls back to neutral recall copy for an unknown/null tool name", () => {
    render(
      createElement(TranscriptMessage, {
        row: row({ variant: "recall", label: null, content: "" }),
      }),
    );
    expect(screen.getByText("Recalled context")).not.toBeNull();
  });

  it("renders only the indicator when a recall row has no prose", () => {
    const { container } = render(
      createElement(TranscriptMessage, {
        row: row({ variant: "recall", label: "session_memory_search", content: "" }),
      }),
    );
    expect(container.querySelector('[data-vex-marker="recall"]')).not.toBeNull();
    // No prose node when content is empty.
    expect(
      container.querySelector("[data-vex-marker-content]"),
    ).toBeNull();
  });
});

// S5 DELIBERATE PIN UPDATE (act ledger): tool_call rows now render ToolActRow
// (glyph + name + Args/Output well) instead of the bare ToolDisclosure. The
// SEMANTICS pinned below are unchanged: collapsed by default, aria-expanded
// button, args revealed as TEXT on expand, prose preserved, role attr kept.
describe("TranscriptMessage tool acts (S5)", () => {
  it("renders a tool_call row's prose plus a collapsed per-call act row", () => {
    const { container } = render(
      createElement(TranscriptMessage, {
        row: {
          id: 1,
          variant: "tool",
          toolKind: "call",
          label: "wallet:read",
          content: "Let me check.",
          createdAt: ISO,
          toolCalls: [
            {
              toolCallId: "a",
              toolName: "wallet:read",
              toolArgs: '{"chain":"base"}',
            },
          ],
        },
      }),
    );
    expect(screen.getByText("Let me check.")).not.toBeNull(); // prose preserved
    expect(
      container.querySelector('[data-vex-message-role="tool"]'),
    ).not.toBeNull();
    const btn = screen.getByRole("button", { name: /wallet:read/ });
    expect(btn.getAttribute("aria-expanded")).toBe("false"); // collapsed by default
    expect(screen.queryByText('{"chain":"base"}')).toBeNull();
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText('{"chain":"base"}')).not.toBeNull(); // params on expand
    expect(screen.getByText("Args")).not.toBeNull(); // S5 section heading
    // No result merged → the quiet row shows no Output section.
    expect(screen.queryByText("Output")).toBeNull();
  });

  it("renders the merged Output section when the act carries a paired result (S5)", () => {
    render(
      createElement(TranscriptMessage, {
        row: {
          id: 1,
          variant: "tool",
          toolKind: "call",
          label: "wallet:read",
          content: "",
          createdAt: ISO,
          toolCalls: [],
          toolActs: [
            {
              toolCallId: "a",
              toolName: "wallet:read",
              toolArgs: '{"chain":"base"}',
              output: "0.5 ETH",
            },
          ],
        },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /wallet:read/ }));
    expect(screen.getByText("Output")).not.toBeNull();
    expect(screen.getByText("0.5 ETH")).not.toBeNull();
  });

  it("renders an orphan tool_result row as a collapsed `<tool>_output` disclosure", () => {
    const { container } = render(
      createElement(TranscriptMessage, {
        row: {
          id: 2,
          variant: "tool",
          toolKind: "result",
          label: "wallet:read_output",
          content: "0.5 ETH",
          createdAt: ISO,
        },
      }),
    );
    expect(
      container.querySelector('[data-vex-message-role="tool"]'),
    ).not.toBeNull();
    const btn = screen.getByRole("button", { name: /wallet:read_output/ });
    expect(screen.queryByText("0.5 ETH")).toBeNull(); // collapsed
    fireEvent.click(btn);
    expect(screen.getByText("0.5 ETH")).not.toBeNull();
  });

  it("renders a tool_group row collapsed; expanding reveals member act rows with the role attr", () => {
    const { container } = render(
      createElement(TranscriptMessage, {
        row: {
          variant: "tool_group",
          id: 10,
          createdAt: ISO,
          distinctToolNames: ["search:web", "file:read", "wallet:read"],
          calls: [
            { toolCallId: "a", toolName: "search:web", toolArgs: "{}", output: "r1" },
            { toolCallId: "b", toolName: "file:read", toolArgs: null, output: null },
            { toolCallId: "c", toolName: "wallet:read", toolArgs: "{}", output: null },
          ],
        },
      }),
    );
    const header = screen.getByRole("button", { name: /3 tool calls/ });
    expect(header.getAttribute("aria-expanded")).toBe("false");
    // Members hidden while collapsed.
    expect(screen.queryByText("search:web")).toBeNull();
    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("search:web")).not.toBeNull();
    expect(screen.getByText("file:read")).not.toBeNull();
    expect(screen.getByText("wallet:read")).not.toBeNull();
    // Semantic contract: group container AND every member act row keep the
    // tool role attr (tests and tooling query it).
    expect(
      container.querySelectorAll('[data-vex-message-role="tool"]').length,
    ).toBe(4);
  });

  it("surfaces the Awaiting-signature stamp on an act matched to a pending approval", () => {
    render(
      createElement(TranscriptMessage, {
        row: {
          id: 1,
          variant: "tool",
          toolKind: "call",
          label: "wallet:send",
          content: "",
          createdAt: ISO,
          toolCalls: [],
          toolActs: [
            { toolCallId: "call-1", toolName: "wallet:send", toolArgs: "{}", output: null },
          ],
        },
        pendingApprovals: new Map([["call-1", "appr-1"]]),
      }),
    );
    expect(
      screen.getByRole("button", { name: /awaiting signature/i }),
    ).not.toBeNull();
  });
});

describe("TranscriptMessage assistant_stopped (9-5b)", () => {
  it("renders the stopped assistant prose + a Stopped badge", () => {
    const { container } = render(
      createElement(TranscriptMessage, {
        row: row({ variant: "assistant_stopped", content: "The balance is" }),
      }),
    );
    expect(screen.getByText("The balance is")).not.toBeNull();
    expect(screen.getByText("Stopped")).not.toBeNull();
    expect(container.querySelector("[data-vex-stopped]")).not.toBeNull();
  });

  it("still shows the Stopped badge when the partial content is empty", () => {
    const { container } = render(
      createElement(TranscriptMessage, {
        row: row({ variant: "assistant_stopped", content: "" }),
      }),
    );
    expect(screen.getByText("Stopped")).not.toBeNull();
    expect(container.querySelector("[data-vex-stopped]")).not.toBeNull();
  });
});

describe("TranscriptMessage agent activity avatar", () => {
  it("draws a theme-accent spinner around the active agent avatar", () => {
    const { container } = render(
      createElement(TranscriptMessage, {
        row: row({ variant: "assistant", content: "Preparing the transfer." }),
        agentWorking: true,
      }),
    );
    const avatar = container.querySelector(
      '[data-vex-agent-avatar-state="working"]',
    );
    const spinner = container.querySelector("[data-vex-agent-spinner]");
    expect(avatar).not.toBeNull();
    expect(spinner?.className).toContain("border-[var(--vex-accent)]");
    expect(spinner?.className).toContain("animate-spin");
    expect(spinner?.className).toContain("[animation-duration:1200ms]");
    expect(spinner?.className).toContain("motion-reduce:animate-none");
  });

  it("keeps settled agent avatars still", () => {
    const { container } = render(
      createElement(TranscriptMessage, {
        row: row({ variant: "assistant", content: "Transfer prepared." }),
      }),
    );
    expect(
      container.querySelector('[data-vex-agent-avatar-state="settled"]'),
    ).not.toBeNull();
    expect(container.querySelector("[data-vex-agent-spinner]")).toBeNull();
  });
});
