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
} from "../../../components/icons/index.js";
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
    toolName: "wallet_balances",
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
    const btn = screen.getByRole("button", { name: /Wallet balances/ });
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
    fireEvent.click(screen.getByRole("button", { name: /Wallet balances/ }));
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getAllByText(injected)).toHaveLength(2);
  });

  it("shows the Output section only when a result merged; hints cover empties", () => {
    // No merge → quiet: Args only.
    const first = render(createElement(ToolActRow, { act: act({ toolArgs: null }) }));
    fireEvent.click(screen.getByRole("button", { name: /Wallet balances/ }));
    expect(screen.getByText("(no parameters)")).not.toBeNull();
    expect(screen.queryByText("Output")).toBeNull();
    first.unmount();
    // Merged-but-empty output → Output section with the empty hint.
    render(createElement(ToolActRow, { act: act({ output: "" }) }));
    fireEvent.click(screen.getByRole("button", { name: /Wallet balances/ }));
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
          // BOTH proofs are required: the engine's persisted success AND the
          // tool's strict output contract.
          success: true,
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
    const confirmedOutput = JSON.stringify({
      txHash: "hash",
      status: "confirmed",
    });
    const cases = [
      act({ toolName: "wallet_send_confirm", success: true, output: "not json" }),
      act({
        toolName: "wallet_send_confirm",
        success: true,
        output: JSON.stringify({ txHash: "hash", status: "failed" }),
      }),
      act({
        toolName: "wallet_send_confirm",
        success: true,
        output: JSON.stringify({ status: "confirmed" }),
      }),
      act({
        toolName: "wallet_balances",
        success: true,
        output: confirmedOutput,
      }),
      // A "Confirmed" stamp claims funds moved. The persisted outcome must
      // prove it: output text alone — however well-formed — never can.
      act({
        toolName: "wallet_send_confirm",
        success: false,
        output: confirmedOutput,
      }),
      act({
        toolName: "wallet_send_confirm",
        success: null,
        output: confirmedOutput,
      }),
      act({ toolName: "wallet_send_confirm", output: confirmedOutput }),
      // Oversized output is never handed to JSON.parse at all (20k bound).
      act({
        toolName: "wallet_send_confirm",
        success: true,
        output: `{"status":"confirmed","txHash":"hash","pad":"${"x".repeat(21_000)}"}`,
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
    expect(screen.queryByText("File read")).toBeNull();
    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("File read")).not.toBeNull();
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

// ── FRIENDLY TOOL CARDS (session-UI redesign) ──────────────────────────────

describe("ToolActRow — friendly card presentation", () => {
  it("prints a human title and keeps the raw symbol reachable as the tooltip", () => {
    render(
      createElement(ToolActRow, {
        act: act({ toolName: "swap_execute_uniswap" }),
      }),
    );
    const btn = screen.getByRole("button", { name: /Swap · Uniswap/ });
    expect(btn.getAttribute("title")).toBe("swap_execute_uniswap");
  });

  it("wears the venue mark when contract C5 proves one", () => {
    const { container } = render(
      createElement(ToolActRow, { act: act({ toolName: "bridge_execute_relay" }) }),
    );
    expect(
      container.querySelector('[data-vex-protocol-mark="Relay"]'),
    ).not.toBeNull();
  });

  it("falls back to the category glyph — never a borrowed brand — with no venue", () => {
    const { container } = render(
      createElement(ToolActRow, { act: act({ toolName: "wallet_balances" }) }),
    );
    expect(container.querySelector("[data-vex-protocol-mark]")).toBeNull();
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("shows the duration chip only for a MEASURED duration", () => {
    const measured = render(
      createElement(ToolActRow, { act: act({ durationMs: 2340 }) }),
    );
    expect(
      measured.container.querySelector("[data-vex-tool-duration]")?.textContent,
    ).toBe("2.3 s");
    measured.unmount();

    // A call that never ran carries null — and must show nothing at all.
    const notRun = render(createElement(ToolActRow, { act: act() }));
    expect(notRun.container.querySelector("[data-vex-tool-duration]")).toBeNull();
  });

  it("renders executed swap legs from the sanitized payload instead of raw JSON", () => {
    const { container } = render(
      createElement(ToolActRow, {
        act: act({
          toolName: "swap_execute_uniswap",
          toolArgs: '{"tokenIn":"SOL","tokenOut":"USDC","amountIn":"1.5"}',
          output: '{"amountOut":"240.31"}',
          success: true,
        }),
      }),
    );
    const legs = container.querySelector('[data-vex-tool-legs="executed"]');
    expect(legs).not.toBeNull();
    expect(legs?.textContent).toContain("1.5");
    expect(legs?.textContent).toContain("SOL");
    expect(legs?.textContent).toContain("240.31");
    expect(legs?.textContent).toContain("USDC");
    // An executed summary carries no outcome caveat.
    expect(legs?.querySelector("[data-vex-tool-leg-outcome]")).toBeNull();
  });

  // QUOTE vs EXECUTION (rules/90). `success` proves the CALL succeeded, never
  // that funds moved — a successful preview must never render as a trade.
  it.each(["swap_quote", "bridge_quote"])(
    "labels a SUCCESSFUL %s as a Quote, never a bare executed summary",
    (toolName) => {
      const { container } = render(
        createElement(ToolActRow, {
          act: act({
            toolName,
            toolArgs: '{"tokenIn":"SOL","tokenOut":"USDC","amountIn":"1.5"}',
            output: '{"amountOut":"240.31"}',
            success: true,
          }),
        }),
      );
      const legs = container.querySelector('[data-vex-tool-legs="quote"]');
      expect(legs).not.toBeNull();
      expect(
        legs?.querySelector('[data-vex-tool-leg-outcome="quote"]')?.textContent,
      ).toBe("Quote");
      // The quote's own numbers are honest — the LABEL is what makes them a
      // preview rather than a completed trade.
      expect(legs?.textContent).toContain("240.31");
      expect(container.querySelector('[data-vex-tool-legs="executed"]')).toBeNull();
    },
  );

  // `bridge` — the primary MUTATING bridge — carries no `bridge_` prefix, so a
  // prefix-only rule silently gave it no legs at all.
  it("renders legs for the exact-name `bridge` act, gated on the persisted outcome", () => {
    const bridgeAct = (success: boolean | null) =>
      act({
        toolName: "bridge",
        toolArgs: '{"fromToken":"USDC","toToken":"USDC","amount":"1.5"}',
        output: '{"amountOut":"1.49"}',
        success,
      });

    const executed = render(createElement(ToolActRow, { act: bridgeAct(true) }));
    const legs = executed.container.querySelector('[data-vex-tool-legs="executed"]');
    expect(legs).not.toBeNull();
    expect(legs?.querySelector("[data-vex-tool-leg-outcome]")).toBeNull();
    executed.unmount();

    const pending = render(createElement(ToolActRow, { act: bridgeAct(null) }));
    expect(
      pending.container.querySelector(
        '[data-vex-tool-legs="requested"] [data-vex-tool-leg-outcome="requested"]',
      ),
    ).not.toBeNull();
  });

  // The curated `execute_tool` wrapper nests the real call under `params`;
  // that parser path was unreachable from the card until now.
  it("reaches the leg parser through a curated execute_tool, always labelled", () => {
    const wrapper = (toolId: string) =>
      act({
        toolName: "execute_tool",
        toolArgs: JSON.stringify({
          toolId,
          params: { tokenIn: "SOL", tokenOut: "USDC", amountIn: "1.5" },
        }),
        success: true,
      });

    // A proven quote toolId downgrades the claim to a preview.
    const quoted = render(
      createElement(ToolActRow, { act: wrapper("kyberswap.swap.quote") }),
    );
    expect(
      quoted.container.querySelector('[data-vex-tool-leg-outcome="quote"]')
        ?.textContent,
    ).toBe("Quote");
    expect(quoted.container.querySelector("[data-vex-tool-legs]")?.textContent).toContain(
      "SOL",
    );
    quoted.unmount();

    // Anything else: mutating identity is NEVER derived from untrusted args,
    // so the card says the call completed and nothing more.
    const opaque = render(
      createElement(ToolActRow, { act: wrapper("kyberswap.swap.execute") }),
    );
    expect(
      opaque.container.querySelector('[data-vex-tool-leg-outcome="completed"]')
        ?.textContent,
    ).toBe("Completed");
    expect(
      opaque.container.querySelector('[data-vex-tool-legs="executed"]'),
    ).toBeNull();
  });

  it("labels an UNKNOWN-outcome act as requested and ignores its untrusted output", () => {
    const { container } = render(
      createElement(ToolActRow, {
        act: act({
          toolName: "swap_execute_uniswap",
          toolArgs: '{"tokenIn":"SOL","tokenOut":"USDC","amountIn":"1.5"}',
          output: '{"amountOut":"240.31"}',
        }),
      }),
    );
    const legs = container.querySelector('[data-vex-tool-legs="requested"]');
    expect(legs).not.toBeNull();
    expect(
      legs?.querySelector('[data-vex-tool-leg-outcome="requested"]')?.textContent,
    ).toBe("Requested");
    expect(legs?.textContent).toContain("1.5");
    expect(legs?.textContent).not.toContain("240.31");
  });

  it("labels a FAILED act and prints no amount as fact", () => {
    const { container } = render(
      createElement(ToolActRow, {
        act: act({
          toolName: "swap_execute_uniswap",
          toolArgs: '{"tokenIn":"SOL","tokenOut":"USDC","amountIn":"1.5"}',
          output: '{"amountOut":"240.31"}',
          success: false,
        }),
      }),
    );
    const legs = container.querySelector('[data-vex-tool-legs="failed"]');
    expect(
      legs?.querySelector('[data-vex-tool-leg-outcome="failed"]')?.textContent,
    ).toBe("Failed");
    expect(legs?.textContent).not.toContain("1.5");
    expect(legs?.textContent).not.toContain("240.31");
    // The tokens still name themselves — that is not a claim of movement.
    expect(legs?.textContent).toContain("SOL");
  });

  it("never dresses an unknown execute_tool namespace as a venue", () => {
    const { container } = render(
      createElement(ToolActRow, {
        act: act({
          toolName: "execute_tool",
          toolArgs: '{"toolId":"kyberswapp.swap.quote"}',
        }),
      }),
    );
    expect(container.querySelector("[data-vex-protocol-mark]")).toBeNull();
    expect(screen.getByRole("button", { name: /Execute tool/ })).not.toBeNull();
  });

  it("shows NO legs when the payload cannot be parsed — never a guessed trade", () => {
    const { container } = render(
      createElement(ToolActRow, {
        act: act({
          toolName: "swap_execute_uniswap",
          // Truncated at the DTO's 2000-char cap.
          toolArgs: '{"tokenIn":"SOL","tokenOut":"USD',
        }),
      }),
    );
    expect(container.querySelector("[data-vex-tool-legs]")).toBeNull();
  });

  it("never draws legs for a non-swap act, however token-shaped its args are", () => {
    const { container } = render(
      createElement(ToolActRow, {
        act: act({
          toolName: "wallet_balances",
          toolArgs: '{"tokenIn":"SOL","tokenOut":"USDC","amountIn":"1.5"}',
        }),
      }),
    );
    expect(container.querySelector("[data-vex-tool-legs]")).toBeNull();
  });

  it("keeps Args/Output as inert <pre> text inside the expanded body", () => {
    const { container } = render(
      createElement(ToolActRow, {
        act: act({ toolName: "swap_execute_uniswap", output: "{}" }),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Swap · Uniswap/ }));
    const pres = container.querySelectorAll("pre");
    expect(pres.length).toBe(2);
  });
});
