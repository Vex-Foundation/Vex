/**
 * THE ACT LEDGER — friendly-card presentation (session-UI redesign).
 *
 * Split from `../ToolLedger.test.tsx` by responsibility (rules/04 550-line
 * decree): that file keeps the S5 disclosure/grouping/stamp pins; THIS file
 * pins the friendly card face — human titles, venue marks (contract C5),
 * duration chips (null is never 0 s), and the swap/bridge leg line's
 * outcome-honesty law (rules/90): the bare executed summary requires a proven
 * mutating operation with persisted `success: true`; quotes stay labeled
 * Quotes however successful; untrusted args/output may downgrade a claim,
 * never upgrade one; unparseable payloads draw nothing.
 */

import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { ToolActRow } from "../../ToolLedger/ToolActRow.js";
import type { ToolCallActView } from "../../transcriptRowModel.js";

function act(over: Partial<ToolCallActView> = {}): ToolCallActView {
  return {
    toolCallId: "c1",
    toolName: "wallet_balances",
    toolArgs: '{"chain":"base"}',
    output: null,
    ...over,
  };
}

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

    // An id OUTSIDE the curated exact-id map proves nothing: mutating identity
    // is never derived from the shape of untrusted args, so the card says the
    // call completed and nothing more.
    const opaque = render(
      createElement(ToolActRow, { act: wrapper("kyberswap.swap.futurething") }),
    );
    expect(
      opaque.container.querySelector('[data-vex-tool-leg-outcome="completed"]')
        ?.textContent,
    ).toBe("Completed");
    expect(
      opaque.container.querySelector('[data-vex-tool-legs="executed"]'),
    ).toBeNull();
  });

  /**
   * The CANONICALIZED lane: main normalizes `kyberswap__swap__quote` to its
   * dotted toolId, so the card meets the id as the tool NAME. The case pinned
   * hardest is `dryRun` — `relay.bridge` multiplexes preview and execution and
   * its dry runs return `success: true`, so a preview must never take the
   * unlabelled executed presentation.
   */
  it("renders a dotted protocol act with its venue, and never a dry run as executed", () => {
    const dotted = (toolName: string, args: Record<string, unknown>) =>
      act({ toolName, toolArgs: JSON.stringify(args), success: true });
    const legs = { tokenIn: "SOL", tokenOut: "USDC", amountIn: "1.5" };

    const executed = render(
      createElement(ToolActRow, { act: dotted("kyberswap.swap.execute", legs) }),
    );
    expect(executed.container.textContent).toContain("KyberSwap · Swap");
    expect(
      executed.container.querySelector('[data-vex-tool-legs="executed"]'),
    ).not.toBeNull();
    executed.unmount();

    const quoted = render(
      createElement(ToolActRow, { act: dotted("kyberswap.swap.quote", legs) }),
    );
    expect(
      quoted.container.querySelector('[data-vex-tool-leg-outcome="quote"]')?.textContent,
    ).toBe("Quote");
    quoted.unmount();

    const dryRun = render(
      createElement(ToolActRow, {
        act: dotted("relay.bridge", { ...legs, dryRun: true }),
      }),
    );
    expect(
      dryRun.container.querySelector('[data-vex-tool-leg-outcome="quote"]')?.textContent,
    ).toBe("Quote");
    expect(dryRun.container.querySelector('[data-vex-tool-legs="executed"]')).toBeNull();
    dryRun.unmount();

    const unreadableDryRun = render(
      createElement(ToolActRow, {
        act: dotted("relay.bridge", { ...legs, dryRun: "true" }),
      }),
    );
    expect(
      unreadableDryRun.container.querySelector('[data-vex-tool-leg-outcome="completed"]')
        ?.textContent,
    ).toBe("Completed");
    expect(
      unreadableDryRun.container.querySelector('[data-vex-tool-legs="executed"]'),
    ).toBeNull();
  });

  it("wears the pools.fun mark on a read act and draws no money legs", () => {
    const { container } = render(
      createElement(ToolActRow, {
        act: act({
          toolName: "pools.tokens",
          toolArgs: '{"platform":"poolsfun","limit":20}',
          success: true,
        }),
      }),
    );
    expect(container.textContent).toContain("pools.fun · Token list");
    expect(
      container.querySelector('[data-vex-protocol-mark="pools.fun"]'),
    ).not.toBeNull();
    expect(container.querySelector("[data-vex-tool-legs]")).toBeNull();
  });

  it("labels a PENDING protocol act rather than showing it as done", () => {
    const { container } = render(
      createElement(ToolActRow, {
        act: act({
          toolName: "kyberswap.swap.execute",
          toolArgs: '{"tokenIn":"SOL","tokenOut":"USDC","amountIn":"1.5"}',
          success: false,
          displayStatus: "pending",
        }),
      }),
    );
    expect(container.querySelector('[data-vex-tool-legs="executed"]')).toBeNull();
    expect(container.textContent).toContain("Pending");
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

  it("labels an AMBIGUOUS broadcast PENDING, not Failed", () => {
    const { container } = render(
      createElement(ToolActRow, {
        act: act({
          toolName: "swap_execute_uniswap",
          toolArgs: '{"tokenIn":"SOL","tokenOut":"USDC","amountIn":"1.5"}',
          output: '{"txHash":"0xabc","status":"pending"}',
          success: false,
          displayStatus: "pending",
        }),
      }),
    );
    expect(container.querySelector('[data-vex-tool-legs="failed"]')).toBeNull();
    const legs = container.querySelector('[data-vex-tool-legs="pending"]');
    expect(legs).not.toBeNull();
    expect(
      legs?.querySelector('[data-vex-tool-leg-outcome="pending"]')?.textContent,
    ).toBe("Pending");
    // The REQUESTED figure is honest; the untrusted output supplies nothing.
    expect(legs?.textContent).toContain("1.5");
    expect(legs?.textContent).toContain("SOL");
  });

  it("keeps a plain failure FAILED when no pending status was persisted", () => {
    const { container } = render(
      createElement(ToolActRow, {
        act: act({
          toolName: "swap_execute_uniswap",
          toolArgs: '{"tokenIn":"SOL","tokenOut":"USDC","amountIn":"1.5"}',
          output: null,
          success: false,
        }),
      }),
    );
    expect(container.querySelector('[data-vex-tool-legs="pending"]')).toBeNull();
    expect(container.querySelector('[data-vex-tool-legs="failed"]')).not.toBeNull();
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
