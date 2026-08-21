/**
 * ToolActRow COLLAPSED ANATOMY (UIUX round 2, owner QA item 4).
 *
 * Three contracts, each a defect the owner's screenshot showed:
 *  1. the collapsed header is ONE line - every fixed member is `flex-none`
 *     and only the summary fills and truncates, so nothing folds;
 *  2. a failed act whose summary would otherwise be a bare title now carries
 *     the failure's first line in the error tone - but a PROVEN leg line
 *     outranks it, because that line already reports the failure honestly
 *     ("Failed", every amount suppressed) and is a money-path affordance
 *     (rules/90), not the stale args summary deepseek's rule is about;
 *  3. explorer refs are a SIBLING line under the header, capped with a "+N
 *     more" toggle - as a wrapping neighbour inside the header they crushed
 *     the title and detached into a strip of chips with no owner.
 *
 * Orphan tool-result rows render the same `ExplorerRefLinks`, so contract 3
 * is pinned for both shapes.
 */

import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { ToolActRow } from "../../ToolLedger/ToolActRow.js";
import { ExplorerRefLinks } from "../../ToolLedger/ExplorerRefLinks.js";
import type { ToolCallActView } from "../../transcriptRowModel.js";
import type { ExplorerRef } from "@shared/schemas/messages.js";

function act(over: Partial<ToolCallActView> = {}): ToolCallActView {
  return {
    toolCallId: "c1",
    toolName: "wallet_balances",
    toolArgs: '{"chain":"base"}',
    output: null,
    ...over,
  };
}

/** `n` refs on a chain the shared builder actually resolves. */
function refs(n: number): ExplorerRef[] {
  return Array.from({ length: n }, (_, i) => ({
    chain: "base" as const,
    txRef: `0x${String(i + 1).padStart(64, "0")}`,
  }));
}

describe("ToolActRow one-line collapsed header", () => {
  it("keeps the header a single non-wrapping row with a fill-truncating summary", () => {
    const { container } = render(
      createElement(ToolActRow, {
        act: act({
          toolName: "swap_execute",
          toolArgs: JSON.stringify({
            fromToken: "SOL",
            fromAmount: "1.5",
            toToken: "USDC",
            toAmount: "240.31",
          }),
          output: '{"ok":true}',
          success: true,
          durationMs: 27,
        }),
      }),
    );
    const header = container.querySelector("[data-vex-message-role='tool'] > div");
    expect(header?.className).toContain("items-center");
    // No wrap anywhere on the header's own axis: the QA screenshot's broken
    // row was a flex-wrap fold.
    expect(header?.className).not.toContain("flex-wrap");
    // The measurement never shrinks - a duration clipped to "2" is a wrong
    // number, whereas a clipped summary is still honest prose.
    const duration = container.querySelector("[data-vex-tool-duration]");
    expect(duration?.textContent).toBe("27 ms");
    expect(duration?.className).toContain("flex-none");
    // The summary slot is the only thing that fills.
    const summary = container.querySelector("[data-vex-tool-legs]");
    expect(summary?.className).toContain("min-w-0");
  });

  it("prints no duration chip and no separator when nothing was measured", () => {
    const { container } = render(
      createElement(ToolActRow, { act: act({ durationMs: null }) }),
    );
    expect(container.querySelector("[data-vex-tool-duration]")).toBeNull();
  });
});

describe("ToolActRow error summary", () => {
  /** A non-money tool: no leg line can be proven, so the slot was a bare title. */
  const failing = act({
    toolName: "wallet_balances",
    toolArgs: '{"chain":"base"}',
    output: "Insufficient balance for the requested route.\nRoute id: 88",
    success: false,
  });

  it("shows the failure's FIRST line in the error tone", () => {
    const { container } = render(createElement(ToolActRow, { act: failing }));
    const summary = container.querySelector("[data-vex-tool-error-summary]");
    expect(summary?.textContent).toBe(
      "Insufficient balance for the requested route.",
    );
    expect(summary?.className).toContain("text-destructive");
    expect(summary?.className).toContain("truncate");
    // The FIRST line only - the rest stays in the expanded Output section.
    expect(container.textContent).not.toContain("Route id: 88");
  });

  it("does NOT claim failure for an ambiguous broadcast", () => {
    const { container } = render(
      createElement(ToolActRow, {
        act: { ...failing, displayStatus: "pending" as const },
      }),
    );
    // Unresolved is not failed, and an unknown commit outcome is reconciled,
    // never reported failed by guesswork (rules/90).
    expect(container.querySelector("[data-vex-tool-error-summary]")).toBeNull();
  });

  it("says nothing on a successful act, or on one whose outcome is unknown", () => {
    for (const success of [true, null] as const) {
      const { container } = render(
        createElement(ToolActRow, { act: { ...failing, success } }),
      );
      expect(container.querySelector("[data-vex-tool-error-summary]")).toBeNull();
    }
  });

  it("keeps a PROVEN leg line over the failure prose - it already reports the failure", () => {
    const { container } = render(
      createElement(ToolActRow, {
        act: {
          ...failing,
          toolName: "swap_execute",
          toolArgs: JSON.stringify({
            fromToken: "SOL",
            fromAmount: "1.5",
            toToken: "USDC",
            toAmount: "240.31",
          }),
        },
      }),
    );
    const legs = container.querySelector("[data-vex-tool-legs]");
    expect(
      legs?.querySelector('[data-vex-tool-leg-outcome="failed"]')?.textContent,
    ).toBe("Failed");
    // No amount survives beside a failed call - it would read as money moved.
    expect(legs?.textContent).not.toContain("1.5");
    expect(legs?.textContent).not.toContain("240.31");
    expect(container.querySelector("[data-vex-tool-error-summary]")).toBeNull();
  });
});

describe("ExplorerRefLinks", () => {
  it("renders on its own line under the act header, never inside it", () => {
    const { container } = render(
      createElement(ToolActRow, { act: act({ explorerRefs: refs(1) }) }),
    );
    const row = container.querySelector("[data-vex-message-role='tool']");
    const links = container.querySelector("[data-vex-explorer-refs]");
    expect(links).not.toBeNull();
    // A direct child of the act row, i.e. a sibling of the header line.
    expect(links?.parentElement).toBe(row);
  });

  it("caps the visible chips at three and reveals the rest in place", () => {
    const { container } = render(
      createElement(ExplorerRefLinks, { refs: refs(7) }),
    );
    expect(container.querySelectorAll("a")).toHaveLength(3);
    const toggle = screen.getByRole("button", { name: "+4 more" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(toggle);
    expect(container.querySelectorAll("a")).toHaveLength(7);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    // Every link keeps a DISTINCT accessible name, revealed or not.
    const labels = [...container.querySelectorAll("a")].map((a) =>
      a.getAttribute("aria-label"),
    );
    expect(new Set(labels).size).toBe(7);

    // Collapsing no longer UNMOUNTS the overflow chips: they ride the shared
    // expand primitive, which needs them mounted to animate closed. They leave
    // the accessibility tree and the tab order instead (aria-hidden + inert).
    fireEvent.click(screen.getByRole("button", { name: "less" }));
    const overflow = container.querySelector(".vex-expand");
    expect(overflow).not.toBeNull();
    expect(overflow?.getAttribute("data-open")).toBe("false");
    expect(overflow?.getAttribute("aria-hidden")).toBe("true");
    expect(overflow?.hasAttribute("inert")).toBe(true);
    expect(overflow?.querySelectorAll("a")).toHaveLength(4);
  });

  it("shows no toggle at or below the cap", () => {
    const { container } = render(
      createElement(ExplorerRefLinks, { refs: refs(3) }),
    );
    expect(container.querySelectorAll("a")).toHaveLength(3);
    expect(container.querySelector("button")).toBeNull();
  });

  it("sits at the repo's 10px mono floor, not the old 9px", () => {
    const { container } = render(
      createElement(ExplorerRefLinks, { refs: refs(1) }),
    );
    const link = container.querySelector("a");
    expect(link?.className).toContain("text-[10px]");
    expect(link?.className).not.toContain("text-[9px]");
  });

  it("stays inert when nothing resolves", () => {
    const { container } = render(
      createElement(ExplorerRefLinks, {
        refs: [{ chain: "not-a-chain", txRef: "0xabc" } as unknown as ExplorerRef],
      }),
    );
    expect(container.innerHTML).toBe("");
  });
});
