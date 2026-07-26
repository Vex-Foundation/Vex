/**
 * THE ACT LEDGER component tests (S5).
 *
 * Pins: glyph resolution rules; ToolActRow disclosure semantics (collapsed
 * default, aria-expanded/aria-controls, sanitized strings rendered as TEXT,
 * Output section only when a result merged); the Awaiting-signature
 * stamp-link jump (scroll + focus to `[data-approval-id]`); ToolGroupRow
 * header grammar ("{N} tool calls", distinct-glyph overflow "+{k}") and the
 * group-level stamp when any member matches a pending approval.
 */

import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import {
  AiWebBrowsingIcon,
  BitcoinWalletIcon,
  Brain01Icon,
  File01Icon,
  Search01Icon,
  TerminalIcon,
  Wrench01Icon,
} from "@hugeicons/core-free-icons";
import { ToolActRow } from "../ToolLedger/ToolActRow.js";
import { ToolGroupRow } from "../ToolLedger/ToolGroupRow.js";
import { toolGlyph } from "../ToolLedger/toolGlyph.js";
import type {
  ToolCallActView,
  ToolGroupRowModel,
} from "../transcriptRowModel.js";

const ISO = "2026-05-26T10:00:00.000Z";

function act(over: Partial<ToolCallActView> = {}): ToolCallActView {
  return {
    toolCallId: "c1",
    toolName: "wallet:read",
    toolArgs: '{"chain":"base"}',
    output: null,
    ...over,
  };
}

function groupModel(
  calls: readonly ToolCallActView[],
  distinctToolNames?: readonly string[],
): ToolGroupRowModel {
  return {
    variant: "tool_group",
    id: 1,
    createdAt: ISO,
    calls,
    distinctToolNames:
      distinctToolNames ?? [...new Set(calls.map((c) => c.toolName))],
  };
}

describe("toolGlyph", () => {
  it("maps act categories by keyword, search outranking web", () => {
    expect(toolGlyph("web_search")).toBe(Search01Icon);
    expect(toolGlyph("browser:navigate")).toBe(AiWebBrowsingIcon);
    expect(toolGlyph("shell:exec")).toBe(TerminalIcon);
    expect(toolGlyph("file_write")).toBe(File01Icon);
    expect(toolGlyph("long_memory_suggest")).toBe(Brain01Icon);
    expect(toolGlyph("wallet:send")).toBe(BitcoinWalletIcon);
  });

  it("falls back to the wrench for unknown tools", () => {
    expect(toolGlyph("polymarket:order")).toBe(Wrench01Icon);
  });
});

describe("ToolActRow", () => {
  it("is collapsed by default; expanding reveals Args via aria-controls", () => {
    const { container } = render(createElement(ToolActRow, { act: act() }));
    expect(
      container.querySelector('[data-vex-message-role="tool"]'),
    ).not.toBeNull();
    const btn = screen.getByRole("button", { name: /wallet:read/ });
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText('{"chain":"base"}')).toBeNull();
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    const controls = btn.getAttribute("aria-controls");
    expect(controls).not.toBeNull();
    expect(document.getElementById(controls!)).not.toBeNull();
    expect(screen.getByText('{"chain":"base"}')).not.toBeNull();
  });

  it("renders args/output as TEXT, never HTML (sanitization stays upstream)", () => {
    const injected = '<img src=x onerror="alert(1)">';
    const { container } = render(
      createElement(ToolActRow, {
        act: act({ toolArgs: injected, output: injected }),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /wallet:read/ }));
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getAllByText(injected)).toHaveLength(2);
  });

  it("shows the Output section only when a result merged; hints cover empties", () => {
    // No merge → quiet: Args only.
    const first = render(createElement(ToolActRow, { act: act({ toolArgs: null }) }));
    fireEvent.click(screen.getByRole("button", { name: /wallet:read/ }));
    expect(screen.getByText("(no parameters)")).not.toBeNull();
    expect(screen.queryByText("Output")).toBeNull();
    first.unmount();
    // Merged-but-empty output → Output section with the empty hint.
    render(createElement(ToolActRow, { act: act({ output: "" }) }));
    fireEvent.click(screen.getByRole("button", { name: /wallet:read/ }));
    expect(screen.getByText("Output")).not.toBeNull();
    expect(screen.getByText("(no output)")).not.toBeNull();
  });

  it("renders no stamp at rest (the persisted ledger row is quiet)", () => {
    render(createElement(ToolActRow, { act: act() }));
    expect(screen.queryByText(/awaiting signature/i)).toBeNull();
    expect(screen.queryByRole("status", { name: /transaction confirmed/i })).toBeNull();
  });

  it("marks a confirmed wallet transfer with a visible check state", () => {
    const { container } = render(
      createElement(ToolActRow, {
        act: act({
          toolName: "wallet_send_confirm",
          output: JSON.stringify({
            txHash: "solana-signature",
            chain: "solana",
            status: "confirmed",
          }),
        }),
      }),
    );

    expect(
      screen.getByRole("status", { name: "Transaction confirmed" }),
    ).not.toBeNull();
    expect(screen.getByText("Confirmed")).not.toBeNull();
    expect(
      container.querySelector('[data-vex-transaction-status="confirmed"]'),
    ).not.toBeNull();
  });

  it("does not infer confirmation from malformed, failed, or unrelated output", () => {
    const cases = [
      act({ toolName: "wallet_send_confirm", output: "not json" }),
      act({
        toolName: "wallet_send_confirm",
        output: JSON.stringify({ txHash: "hash", status: "failed" }),
      }),
      act({
        toolName: "wallet_send_confirm",
        output: JSON.stringify({ status: "confirmed" }),
      }),
      act({
        toolName: "wallet_balances",
        output: JSON.stringify({ txHash: "hash", status: "confirmed" }),
      }),
    ];

    for (const candidate of cases) {
      const view = render(createElement(ToolActRow, { act: candidate }));
      expect(
        screen.queryByRole("status", { name: /transaction confirmed/i }),
      ).toBeNull();
      view.unmount();
    }
  });

  it("Awaiting-signature stamp links to the approval card and focuses it", () => {
    render(
      createElement(
        "div",
        null,
        // Stand-in ApprovalCard target — same focus contract (tabIndex=-1).
        createElement("section", { "data-approval-id": "appr-1", tabIndex: -1 }),
        createElement(ToolActRow, { act: act(), pendingApprovalId: "appr-1" }),
      ),
    );
    const link = screen.getByRole("button", { name: /awaiting signature/i });
    fireEvent.click(link);
    expect(document.activeElement).toBe(
      document.querySelector('[data-approval-id="appr-1"]'),
    );
  });

  // ── Stage 2: explorer links ──
  it("renders NO explorer link when the act has no refs", () => {
    render(createElement(ToolActRow, { act: act() }));
    expect(
      screen.queryByRole("link", { name: /open transaction \d+ on .+ explorer/i }),
    ).toBeNull();
  });

  it("renders a single `tx ↗` link resolving through explorerTxUrl", () => {
    render(
      createElement(ToolActRow, {
        act: act({ explorerRefs: [{ chain: "base", txRef: "0xabc" }] }),
      }),
    );
    const link = screen.getByRole("link", {
      name: /open transaction \d+ on .+ explorer/i,
    });
    expect(link.getAttribute("href")).toBe(
      "https://basescan.org/tx/0xabc",
    );
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.textContent).toContain("tx");
  });

  it("numbers multiple resolvable refs (tx 1, tx 2)", () => {
    render(
      createElement(ToolActRow, {
        act: act({
          explorerRefs: [
            { chain: "base", txRef: "0xabc" },
            { chain: "solana", txRef: "5sig" },
          ],
        }),
      }),
    );
    const links = screen.getAllByRole("link", {
      name: /open transaction \d+ on .+ explorer/i,
    });
    expect(links).toHaveLength(2);
    expect(links[0]!.textContent).toContain("tx 1");
    expect(links[1]!.textContent).toContain("tx 2");
    expect(links[1]!.getAttribute("href")).toBe(
      "https://explorer.solana.com/tx/5sig",
    );
    // A11y: each link carries a DISTINCT accessible name (index + chain), not
    // one repeated generic label.
    expect(links[0]!.getAttribute("aria-label")).toBe(
      "Open transaction 1 on base explorer",
    );
    expect(links[1]!.getAttribute("aria-label")).toBe(
      "Open transaction 2 on solana explorer",
    );
  });

  it("renders nothing for an unknown chain (inert)", () => {
    render(
      createElement(ToolActRow, {
        act: act({ explorerRefs: [{ chain: "dogechain", txRef: "0xabc" }] }),
      }),
    );
    expect(
      screen.queryByRole("link", { name: /open transaction \d+ on .+ explorer/i }),
    ).toBeNull();
  });

  it("drops only the unresolvable ref, keeping resolvable ones", () => {
    render(
      createElement(ToolActRow, {
        act: act({
          explorerRefs: [
            { chain: "dogechain", txRef: "0xbad" },
            { chain: "base", txRef: "0xgood" },
          ],
        }),
      }),
    );
    const links = screen.getAllByRole("link", {
      name: /open transaction \d+ on .+ explorer/i,
    });
    expect(links).toHaveLength(1);
    // Single resolvable ref → unnumbered `tx` label.
    expect(links[0]!.textContent).toContain("tx");
    expect(links[0]!.getAttribute("href")).toBe(
      "https://basescan.org/tx/0xgood",
    );
  });
});

describe("ToolGroupRow", () => {
  it("prints '{N} tool calls' and reveals members under the rail on expand", () => {
    const { container } = render(
      createElement(ToolGroupRow, {
        group: groupModel([
          act({ toolCallId: "a", toolName: "search:web" }),
          act({ toolCallId: "b", toolName: "file:read" }),
          act({ toolCallId: "c", toolName: "wallet:read", output: "0.5 ETH" }),
        ]),
      }),
    );
    const header = screen.getByRole("button", { name: /3 tool calls/ });
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("file:read")).toBeNull();
    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("file:read")).not.toBeNull();
    // Group container + 3 member act rows all carry the tool role attr.
    expect(
      container.querySelectorAll('[data-vex-message-role="tool"]').length,
    ).toBe(4);
  });

  it("shows at most 4 distinct glyphs and '+{k}' for the overflow", () => {
    // 6 distinct glyph categories → 4 icons + "+2".
    render(
      createElement(ToolGroupRow, {
        group: groupModel(
          [
            act({ toolCallId: "a", toolName: "web_search" }),
            act({ toolCallId: "b", toolName: "browser:open" }),
            act({ toolCallId: "c", toolName: "shell:exec" }),
            act({ toolCallId: "d", toolName: "file:read" }),
            act({ toolCallId: "e", toolName: "wallet:send" }),
            act({ toolCallId: "f", toolName: "polymarket:order" }),
          ],
        ),
      }),
    );
    expect(screen.getByText("+2")).not.toBeNull();
  });

  it("surfaces the Awaiting-signature stamp at group level when any member matches", () => {
    render(
      createElement(ToolGroupRow, {
        group: groupModel([
          act({ toolCallId: "a", toolName: "search:web" }),
          act({ toolCallId: "b", toolName: "wallet:send" }),
          act({ toolCallId: "c", toolName: "file:read" }),
        ]),
        pendingApprovals: new Map([["b", "appr-9"]]),
      }),
    );
    // Collapsed: exactly one stamp (the group-level surface).
    expect(
      screen.getAllByRole("button", { name: /awaiting signature/i }),
    ).toHaveLength(1);
  });

  it("stays quiet when no member matches a pending approval", () => {
    render(
      createElement(ToolGroupRow, {
        group: groupModel([
          act({ toolCallId: "a" }),
          act({ toolCallId: "b" }),
          act({ toolCallId: "c" }),
        ]),
        pendingApprovals: new Map(),
      }),
    );
    expect(screen.queryByText(/awaiting signature/i)).toBeNull();
  });
});
