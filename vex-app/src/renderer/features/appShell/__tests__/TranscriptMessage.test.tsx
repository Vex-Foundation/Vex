/**
 * TranscriptMessage marker render tests (stage 8-4).
 *
 * Covers the two inline markers added in 8-4: the static `CompactionMarker`
 * and the static `MemoryMarker`. Asserts accurate memory-vs-knowledge copy,
 * that assistant prose on a recall row is preserved, and that an empty recall
 * row renders the indicator only. Markers are static - no in-flight animation.
 */

import { describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
    const btn = screen.getByRole("button", { name: /Wallet read/ });
    expect(btn.getAttribute("aria-expanded")).toBe("false"); // collapsed by default
    expect(document.querySelector("[data-vex-json-tree]")).toBeNull();
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector("[data-vex-json-tree]")).not.toBeNull(); // params on expand (C9 tree)
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
    fireEvent.click(screen.getByRole("button", { name: /Wallet read/ }));
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
    expect(screen.queryByText("Search web")).toBeNull();
    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Search web")).not.toBeNull();
    expect(screen.getByText("File read")).not.toBeNull();
    expect(screen.getByText("Wallet read")).not.toBeNull();
    // Semantic contract: group container AND every member act row keep the
    // tool role attr (tests and tooling query it).
    expect(
      container.querySelectorAll('[data-vex-message-role="tool"]').length,
    ).toBe(4);
  });

  it("surfaces the Waiting-for-approval link on an act matched to a pending approval", () => {
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
    const link = screen.getByRole("button", { name: /waiting for approval/i });
    expect(link.textContent).toBe("Waiting for approval");
    // The target is the step's own node (VEX Cloud's trace), so the link
    // carries the word alone and the row shows the state once.
    expect(
      document.querySelector('[data-vex-tool-status="waiting"] .vex-step-node')?.getAttribute("data-step-node"),
    ).toBe("waiting");
    expect(link.querySelector(".vex-sq, .vex-step-node")).toBeNull();
  });

  it("folds two or more calls of one row into one quiet row that opens to the steps", () => {
    const { container } = render(
      createElement(TranscriptMessage, {
        row: {
          id: 3,
          variant: "tool",
          toolKind: "call",
          label: "wallet:read",
          content: "",
          createdAt: ISO,
          toolCalls: [],
          toolActs: [
            { toolCallId: "a", toolName: "wallet:read", toolArgs: "{}", output: "ok", success: true, durationMs: 27 },
            { toolCallId: "b", toolName: "search:web", toolArgs: "{}", output: "ok", success: true, durationMs: 2300 },
          ],
        },
      }),
    );
    const fold = screen.getByRole("button", { name: /2 tool calls/ });
    expect(fold.textContent).toContain("2 tool calls · Wallet read, Search web");
    // Time spent in the tools: the measured durations, summed.
    expect(fold.querySelector("[data-vex-tool-duration]")?.textContent).toBe("2.3s");
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("27ms")).toBeNull();
    fireEvent.click(fold);
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    // A done step's time column holds its measured time, not a word.
    expect(screen.getByText("27ms")).not.toBeNull();
    expect(screen.queryByText("Done")).toBeNull();
    expect(container.querySelector("[data-vex-tool-fold]")).not.toBeNull();
  });

  it("never lets a fold hide a failure: the folded row counts it, beside the ink cross", () => {
    const { container } = render(
      createElement(TranscriptMessage, {
        row: {
          id: 4,
          variant: "tool",
          toolKind: "call",
          label: "wallet:read",
          content: "",
          createdAt: ISO,
          toolCalls: [],
          toolActs: [
            { toolCallId: "a", toolName: "wallet:read", toolArgs: "{}", output: "ok", success: true },
            { toolCallId: "b", toolName: "search:web", toolArgs: "{}", output: "boom", success: false },
          ],
        },
      }),
    );
    const failed = container.querySelector("[data-vex-tool-fold-failed]");
    expect(failed?.textContent).toBe("1 failed");
    // docs/design/H3-DESKTOP.md section 2.2: a step that did not execute is
    // the ink cross beside its count in the refusal ink.
    expect(failed?.querySelector('.vex-step-node[data-step-node="failed"]')).not.toBeNull();
    // No member was measured, so the fold prints no time at all.
    expect(container.querySelector("[data-vex-tool-duration]")).toBeNull();
  });

  it("draws each outcome as the trace's node, with its time or its word", () => {
    // docs/design/H3-DESKTOP.md sections 1.7 and 2.2 (VEX Cloud's trace): done
    // the ink 2 square and its time; failed the ink cross and FAILED; a
    // broadcast still in flight the blinking node and PENDING.
    const cases = [
      { success: true, displayStatus: null, node: "done", word: null, time: "812ms" },
      { success: false, displayStatus: null, node: "failed", word: "Failed", time: null },
      { success: false, displayStatus: "pending" as const, node: "running", word: "Pending", time: null },
    ];
    for (const c of cases) {
      const { container } = render(
        createElement(TranscriptMessage, {
          row: {
            id: 6,
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
                toolArgs: "{}",
                output: "x",
                success: c.success,
                displayStatus: c.displayStatus,
                durationMs: 812,
              },
            ],
          },
        }),
      );
      const node = container.querySelector("[data-vex-tool-status] .vex-step-node");
      expect(node?.getAttribute("data-step-node")).toBe(c.node);
      expect(container.querySelector("[data-vex-step-word]")?.textContent ?? null).toBe(c.word);
      // The time column: the measured time, or the word where it outranks it.
      expect(container.querySelector("[data-vex-tool-duration]")?.textContent ?? null).toBe(c.time);
      cleanup();
    }
  });

  it("keeps a single call as its own step row with its outcome word", () => {
    render(
      createElement(TranscriptMessage, {
        row: {
          id: 5,
          variant: "tool",
          toolKind: "call",
          label: "wallet:read",
          content: "",
          createdAt: ISO,
          toolCalls: [],
          toolActs: [
            { toolCallId: "a", toolName: "wallet:read", toolArgs: "{}", output: "ok", success: true },
          ],
        },
      }),
    );
    expect(screen.queryByRole("button", { name: /tool calls/ })).toBeNull();
    expect(screen.getByText("Done")).not.toBeNull();
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

describe("TranscriptMessage agent activity seam", () => {
  it("says which row is the working turn's, with nothing drawn for it: the live row says it", () => {
    const { container } = render(
      createElement(TranscriptMessage, {
        row: row({ variant: "assistant", content: "Preparing the transfer." }),
        agentWorking: true,
      }),
    );
    const reply = container.querySelector('[data-vex-agent-state="working"]');
    expect(reply?.getAttribute("data-vex-message-role")).toBe("assistant");
    // The turn in flight is the live row's fill, word and timer; the row
    // itself carries no swatch and nothing spins.
    expect(reply?.querySelector(".vex-swatch")).toBeNull();
    expect(container.querySelector("[data-vex-agent-spinner]")).toBeNull();
  });

  it("keeps settled rows settled", () => {
    const { container } = render(
      createElement(TranscriptMessage, {
        row: row({ variant: "assistant", content: "Transfer prepared." }),
      }),
    );
    expect(
      container.querySelector('[data-vex-agent-state="settled"]'),
    ).not.toBeNull();
    expect(container.querySelector("[data-vex-agent-spinner]")).toBeNull();
  });

  it("marks only the row that heads the turn, and draws no token on either", () => {
    for (const turnMark of [true, false] as const) {
      const { container } = render(
        createElement(TranscriptMessage, {
          row: row({ variant: "assistant", content: "And the second part." }),
          turnMark,
        }),
      );
      const reply = container.querySelector('[data-vex-message-role="assistant"]');
      expect(reply?.hasAttribute("data-vex-turn-head")).toBe(turnMark);
      // docs/design/H3-DESKTOP.md section 1.7: H3 draws no token beside Vex's
      // rows, so neither the head nor a later row carries one.
      expect(container.querySelector("[data-vex-vx-token]")).toBeNull();
      expect(reply?.className).toContain("vex-reply");
      expect(container.querySelector(".sr-only")?.textContent).toBe("Vex");
      cleanup();
    }
  });
});

describe("TranscriptMessage persisted reasoning", () => {
  it("renders NOTHING when an assistant row carries no reasoning (null = today)", () => {
    const { container } = render(
      createElement(TranscriptMessage, {
        row: row({ variant: "assistant", content: "Done." }),
      }),
    );
    expect(container.querySelector('[data-vex-reasoning="persisted"]')).toBeNull();
  });

  it("mounts the collapsible Thought block above the assistant body", () => {
    const { container } = render(
      createElement(TranscriptMessage, {
        row: {
          ...row({ variant: "assistant", content: "Done." }),
          reasoning: "I checked the balances first.\nThen I priced the route.",
        },
      }),
    );
    const block = container.querySelector('[data-vex-reasoning="persisted"]');
    expect(block).not.toBeNull();
    expect(screen.getByRole("button", { name: /Thought/ })).not.toBeNull();
    // Collapsed: only the trace's FIRST line rides beside the stamp, so the
    // answer stays the first substantial thing read.
    expect(container.textContent).not.toContain("Then I priced the route.");
  });

  it("renders the block on a stopped assistant row too", () => {
    const { container } = render(
      createElement(TranscriptMessage, {
        row: {
          ...row({ variant: "assistant_stopped", content: "Partial." }),
          reasoning: "trace",
        },
      }),
    );
    expect(container.querySelector('[data-vex-reasoning="persisted"]')).not.toBeNull();
  });

  it("renders exactly ONE block on a prose-less tool row carrying reasoning", () => {
    const { container } = render(
      createElement(TranscriptMessage, {
        row: {
          ...row({ variant: "tool", content: "" }),
          toolKind: "call" as const,
          reasoning: "trace",
          toolActs: [
            { toolCallId: "c1", toolName: "wallet_balances", toolArgs: null, output: null },
          ],
        },
      }),
    );
    expect(
      container.querySelectorAll('[data-vex-reasoning="persisted"]'),
    ).toHaveLength(1);
  });

  it("renders the folded trace above a tool_group ledger line", () => {
    const { container } = render(
      createElement(TranscriptMessage, {
        row: {
          variant: "tool_group",
          id: 10,
          createdAt: ISO,
          distinctToolNames: ["search:web"],
          calls: [
            { toolCallId: "a", toolName: "search:web", toolArgs: "{}", output: "r1" },
          ],
          reasonings: ["why I ran the whole chain"],
        },
      }),
    );
    expect(
      container.querySelectorAll('[data-vex-reasoning="persisted"]'),
    ).toHaveLength(1);
    expect(screen.getByRole("button", { name: /Thought/ })).not.toBeNull();
  });

  it("renders EVERY folded trace, in turn order, above the ledger line", () => {
    const { container } = render(
      createElement(TranscriptMessage, {
        row: {
          variant: "tool_group",
          id: 10,
          createdAt: ISO,
          distinctToolNames: ["search:web"],
          calls: [
            { toolCallId: "a", toolName: "search:web", toolArgs: "{}", output: "r1" },
          ],
          reasonings: ["first trace", "second trace"],
        },
      }),
    );
    const blocks = container.querySelectorAll('[data-vex-reasoning="persisted"]');
    expect(blocks).toHaveLength(2);
    // Collapsed by default — expand both to read the traces themselves.
    for (const block of blocks) {
      fireEvent.click(block.querySelector("button")!);
    }
    expect(blocks[0]?.textContent).toContain("first trace");
    expect(blocks[1]?.textContent).toContain("second trace");
  });

  it("renders no block on a tool_group that folded no trace", () => {
    const { container } = render(
      createElement(TranscriptMessage, {
        row: {
          variant: "tool_group",
          id: 10,
          createdAt: ISO,
          distinctToolNames: ["search:web"],
          calls: [
            { toolCallId: "a", toolName: "search:web", toolArgs: "{}", output: null },
          ],
          reasonings: [],
        },
      }),
    );
    expect(container.querySelector('[data-vex-reasoning="persisted"]')).toBeNull();
  });
});

// ── C2 typographic register: human captions are NOT mono ────────────────────

describe("TranscriptMessage caption register (contract C2)", () => {
  it("stamps the user caption with the sans small-caps class, never font-mono", () => {
    const { container } = render(
      createElement(TranscriptMessage, {
        row: row({ variant: "user", content: "hi" }),
      }),
    );
    const caption = container.querySelector(".vex-micro");
    expect(caption).not.toBeNull();
    expect(caption?.className).not.toContain("font-mono");
    expect(caption?.textContent).toContain("You");
  });

  it("draws the person's message as H3's bubble beside the avatar cell", () => {
    // docs/design/H3-DESKTOP.md section 1.7: the bubble, then the round avatar
    // cell at its right. "You" is for assistive technology only (the avatar
    // says it on screen), and the clock is hover-revealed chrome.
    const { container } = render(
      createElement(TranscriptMessage, {
        row: row({ variant: "user", content: "Swap 200 USDC to ETH on Base." }),
      }),
    );
    const message = container.querySelector('[data-vex-message-role="user"]');
    const bubble = message?.querySelector(".vex-you__body");
    expect(bubble?.textContent).toBe("Swap 200 USDC to ETH on Base.");
    const avatar = message?.querySelector("[data-vex-you-avatar]");
    expect(avatar).not.toBeNull();
    expect(avatar?.getAttribute("aria-hidden")).toBe("true");
    // The disc is SVG geometry, never a CSS radius (base.css's shape law).
    expect(avatar?.querySelector("svg circle.vex-you__disc")).not.toBeNull();
    // The avatar is the row's last cell: the bubble sits to its left.
    expect(message?.lastElementChild).toBe(avatar);
    expect(message?.querySelector(".sr-only")?.textContent).toBe("You");
    expect(message?.querySelector(".vex-time-reveal")).not.toBeNull();
  });

  it("puts the assistant clock and actions in a TAIL row, in the same register", () => {
    const { container } = render(
      createElement(TranscriptMessage, {
        row: row({ variant: "assistant", content: "Done." }),
      }),
    );
    const tail = container.querySelector("[data-vex-message-tail]");
    expect(tail).not.toBeNull();
    expect(tail?.className).toContain("vex-micro");
    expect(tail?.className).not.toContain("font-mono");
    // The tail is the LAST thing in the row: the body has to start level with
    // the mark, not below a band of chrome.
    expect(container.querySelector('[data-vex-message-role="assistant"]')?.lastElementChild)
      .toBe(tail);
  });
});

// ── Assistant identity: the mark, never a wordmark (owner QA round 2) ───────

describe("TranscriptMessage assistant identity", () => {
  /**
   * Same precedent as `SidebarHomeSigil.test.tsx`: the brand mark alone.
   * The anime portrait and the visual "VEX" name are both retired; a screen
   * reader still has to be told whose turn this is, so the sr-only speaker
   * label is the text equivalent that replaces them.
   */
  it("signs an assistant turn for assistive technology alone: no token, NO visible wordmark", () => {
    const { container } = render(
      createElement(TranscriptMessage, {
        row: row({ variant: "assistant", content: "Done." }),
      }),
    );
    // docs/design/H3-DESKTOP.md section 1.7: her presence is the Vex key in
    // the header; the transcript draws no mark beside her rows.
    expect(container.querySelector("[data-vex-vx-token]")).toBeNull();
    // No raster portrait anywhere, and no wordmark of any casing.
    expect(container.querySelector("img")).toBeNull();
    expect(screen.queryByText("VEX")).toBeNull();
    expect(screen.queryByText("Vex", { selector: ":not(.sr-only)" })).toBeNull();
    // The shimmer overlay went with the name it swept.
    expect(container.querySelector(".vex-preview-shimmer")).toBeNull();
    // The accessible speaker label survives.
    const label = container.querySelector(".sr-only");
    expect(label?.textContent).toBe("Vex");
  });

  it("says which row belongs to the working turn, for the active turn only", () => {
    for (const working of [true, false] as const) {
      const { container } = render(
        createElement(TranscriptMessage, {
          row: row({ variant: "assistant", content: "Done." }),
          agentWorking: working,
        }),
      );
      const reply = container.querySelector('[data-vex-message-role="assistant"]');
      expect(reply?.getAttribute("data-vex-agent-state")).toBe(
        working ? "working" : "settled",
      );
      cleanup();
    }
  });
});

// ── Friendly tool cards: the duration chip's null-vs-measured law ───────────

describe("TranscriptMessage tool card duration", () => {
  function toolRowWith(durationMs: number | null | undefined) {
    return {
      ...row({ variant: "tool", content: "" }),
      toolKind: "call" as const,
      toolActs: [
        {
          toolCallId: "c1",
          toolName: "wallet_balances",
          toolArgs: null,
          output: "ok",
          durationMs,
        },
      ],
    };
  }

  it("shows a measured duration as a chip", () => {
    const { container } = render(
      createElement(TranscriptMessage, { row: toolRowWith(2340) }),
    );
    expect(
      container.querySelector("[data-vex-tool-duration]")?.textContent,
    ).toBe("2.3s");
  });

  it("shows NO chip for a call that never ran - null must not read as 0 s", () => {
    for (const value of [null, undefined]) {
      const view = render(
        createElement(TranscriptMessage, { row: toolRowWith(value) }),
      );
      expect(
        view.container.querySelector("[data-vex-tool-duration]"),
      ).toBeNull();
      view.unmount();
    }
  });
});

/**
 * M6. The operator-instruction acknowledgement is the engine's durable answer
 * to something the operator just did, and it is the ONLY notice that is. A
 * screen-reader user must learn their instruction landed without going looking
 * for the row - politely, because it reports what already happened and must
 * never cut across the operator's own typing.
 */
describe("TranscriptMessage operator acknowledgement (M6)", () => {
  const ACK =
    "Sent to the agent. It is mid-turn, so it will pick this up at its next step and keep going.";

  it("announces the ack notice politely", () => {
    const { container } = render(
      createElement(TranscriptMessage, {
        row: { ...row({ variant: "notice", content: ACK }), noticeTone: "ack" },
      }),
    );
    const node = container.querySelector('[data-vex-notice-tone="ack"]');
    expect(node).not.toBeNull();
    expect(node?.getAttribute("role")).toBe("status");
    // POLITE, never assertive: an interrupting announcement over a composer the
    // operator is still typing in is the rude failure this tone exists to avoid.
    expect(node?.getAttribute("aria-live")).toBe("polite");
    expect(node?.textContent).toBe(ACK);
  });

  it("leaves every other runtime notice silent", () => {
    const { container } = render(
      createElement(TranscriptMessage, {
        row: {
          ...row({ variant: "notice", content: "Run resumed" }),
          noticeTone: "runtime",
        },
      }),
    );
    const node = container.querySelector('[data-vex-notice-tone="runtime"]');
    expect(node).not.toBeNull();
    expect(node?.getAttribute("role")).toBeNull();
    expect(node?.getAttribute("aria-live")).toBeNull();
  });
});

describe("TranscriptMessage mission stop result (Kairos E-1 follow-up)", () => {
  const STOP_ARGS = JSON.stringify({
    reason: "goal_reached",
    summary: "Reading 1 = $2,664.55; reading 2 = $2,663.69. Price moved down $0.86, or -0.03%.",
  });

  function stopRow(success: boolean | null): TranscriptRowModel {
    return {
      id: 1,
      variant: "tool",
      toolKind: "call",
      label: "MissionStop",
      content: "",
      createdAt: ISO,
      toolCalls: [],
      toolActs: [
        {
          toolCallId: "stop",
          toolName: "MissionStop",
          toolArgs: STOP_ARGS,
          output: "Mission stop requested: goal_reached - ...",
          success,
        },
      ],
    };
  }

  it("shows an accepted stop's reason and summary without expanding the act", () => {
    const { container } = render(createElement(TranscriptMessage, { row: stopRow(true) }));
    const block = container.querySelector('[data-vex-area="mission-stop-result"]');
    expect(block?.textContent).toContain("Mission ended · Goal reached");
    expect(block?.textContent).toContain("Price moved down $0.86, or -0.03%.");
  });

  it("shows nothing for a stop that was refused or has no result yet", () => {
    for (const success of [false, null]) {
      const { container, unmount } = render(createElement(TranscriptMessage, { row: stopRow(success) }));
      expect(container.querySelector('[data-vex-area="mission-stop-result"]')).toBeNull();
      unmount();
    }
  });

  it("keeps the result visible when the stop is folded into a tool group", () => {
    const { container } = render(
      createElement(TranscriptMessage, {
        row: {
          variant: "tool_group",
          id: 11,
          createdAt: ISO,
          distinctToolNames: ["dexscreener__pairs_search", "MissionStop"],
          calls: [
            { toolCallId: "a", toolName: "dexscreener__pairs_search", toolArgs: "{}", output: "{}" },
            { toolCallId: "b", toolName: "MissionStop", toolArgs: STOP_ARGS, output: "ok", success: true },
          ],
        },
      }),
    );
    expect(screen.getByRole("button", { name: /2 tool calls/ }).getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[data-vex-area="mission-stop-result"]')?.textContent).toContain(
      "-0.03%",
    );
  });
});

// ── Her bubble runs: code and tables stand out of the bubble (C3-C-02) ──────

describe("TranscriptMessage: Vex's answer in bubble runs", () => {
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const { join } = require("node:path") as typeof import("node:path");
  const sheet = (name: string): string =>
    readFileSync(join(process.cwd(), "src/renderer/styles/global-css", name), "utf8").replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
  const RUN = ".vex-reply :is(.vex-answer, .vex-answer-resolve) > .vex-chat-prose";
  const BLOCK = ":is(.vex-code-block, .vex-md-table)";

  function answerParts(): HTMLElement[] {
    const { container } = render(
      createElement(TranscriptMessage, {
        row: row({
          variant: "assistant",
          content: [
            "First, the plan.",
            "Then the detail.",
            "```ts\nconst a = 1;\n```",
            "After the code.",
            "| Pair | Price |\n|---|---|\n| ETH | 3200 |",
            "Done.",
          ].join("\n\n"),
        }),
      }),
    );
    const prose = container.querySelector(".vex-reply .vex-answer > .vex-chat-prose");
    expect(prose, "the answer's prose sits directly in its wrapper").not.toBeNull();
    return Array.from(prose?.children ?? []) as HTMLElement[];
  }

  it("renders a code block and a table as the prose's own parts, each with its hook", () => {
    const parts = answerParts();
    expect(parts.map((part) => part.className.split(" ")[0] ?? part.tagName)).toEqual([
      expect.any(String),
      expect.any(String),
      "vex-code-block",
      expect.any(String),
      "vex-md-table",
      expect.any(String),
    ]);
    expect(parts[0]?.tagName).toBe("P");
    expect(parts[4]?.querySelector("table")).not.toBeNull();
  });

  it("lays the prose in a fit-content(82%) column and sets code and tables across the full width, square", () => {
    const css = sheet("chat-transcript.css");
    const body = (selector: string): string => {
      const at = css.indexOf(`${selector} {`);
      expect(at, `${selector} not found`).toBeGreaterThanOrEqual(0);
      return css.slice(css.indexOf("{", at) + 1, css.indexOf("}", at));
    };
    const grid = body(RUN);
    expect(grid).toContain("display: grid;");
    expect(grid).toContain("grid-template-columns: fit-content(82%) minmax(0, 1fr);");
    const part = body(`${RUN} > *`);
    expect(part).toContain("grid-column: 1;");
    expect(part).toContain("background: var(--vex-alias-bubble-vex);");
    const block = body(`${RUN} > ${BLOCK}`);
    expect(block).toContain("grid-column: 1 / -1;");
    expect(block).toContain("background: transparent;");
    // The wrapper itself is no longer the bubble: no 82% cap, no fill.
    expect(css).not.toMatch(/\.vex-reply :is\(\.vex-answer, \.vex-answer-resolve\) \{[^}]*max-width: 82%/);
  });

  it("rounds each run, a new one after every block, and never a block", () => {
    const base = sheet("base.css");
    const selectorOf = (corner: string): string => {
      const match = new RegExp(`([^{}]+)\\{[^}]*${corner}: var\\(--vex-radius-bubble-corner[a-z-]*\\) !important`).exec(base);
      expect(match, corner).not.toBeNull();
      return (match?.[1] ?? "").trim();
    };
    const parts = answerParts();
    const top = selectorOf("border-top-left-radius");
    const bottom = selectorOf("border-bottom-left-radius");
    const tops = parts.map((part) => part.matches(top));
    const bottoms = parts.map((part) => part.matches(bottom));
    // Runs: [plan, detail] code [after] table [done].
    expect(tops).toEqual([true, false, false, true, false, true]);
    expect(bottoms).toEqual([false, true, false, true, false, true]);
  });
});
