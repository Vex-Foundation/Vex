/**
 * ToolActRow EXPANDED WELL (owner QA 2026-08-26, BoardCompose screenshots).
 *
 * Three contracts, each a defect the screenshots showed:
 *  1. a section label is STATIC, rendered above its scroll surface - a sticky
 *     label inside the scroller let scrolled args show through the well's
 *     padding around "ARGS" and read as args overlapping the output;
 *  2. the Output section's ARRIVAL is a reveal: it rides its own ExpandRegion
 *     that opens when the result lands and stays mounted afterwards (the
 *     primitive's contract), instead of popping in;
 *  3. a failure line that repeats the tool's own name ("BoardCompose:
 *     BoardCompose: notes ...") drops the prefix in the collapsed SUMMARY
 *     only - the Output body keeps the whole text, prefix included.
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

function openRow(): void {
  fireEvent.click(screen.getByRole("button", { name: /Wallet balances/ }));
}

/** The output region's id is derived from the well's id (aria-controls). */
function outputRegion(container: HTMLElement): HTMLElement | null {
  const trigger = container.querySelector("button[aria-controls]");
  const wellId = trigger?.getAttribute("aria-controls") ?? null;
  return wellId === null ? null : document.getElementById(`${wellId}-output`);
}

describe("ToolActRow expanded well sections", () => {
  it("renders every section label OUTSIDE its scroll surface, never sticky inside it", () => {
    const { container } = render(
      createElement(ToolActRow, {
        act: act({ toolArgs: '{"chain":"base"}', output: '{"ok":true}' }),
      }),
    );
    openRow();
    const labels = container.querySelectorAll("[data-vex-tool-section-label]");
    const scrolls = container.querySelectorAll("[data-vex-tool-section-scroll]");
    expect(labels).toHaveLength(2);
    expect(scrolls).toHaveLength(2);
    for (const label of labels) {
      // No scroll container contains its own (or any) label.
      expect(label.closest("[data-vex-tool-section-scroll]")).toBeNull();
      expect(label.className).not.toContain("sticky");
    }
    for (const scroll of scrolls) {
      // The scroll surface is the only element that scrolls, and it holds
      // the payload - the label precedes it as a sibling in its section.
      expect(scroll.className).toContain("overflow-y-auto");
      const section = scroll.closest("[data-vex-tool-section]");
      const label = section?.querySelector("[data-vex-tool-section-label]");
      expect(label).not.toBeNull();
      expect(
        label !== null && label !== undefined
          ? label.compareDocumentPosition(scroll) & Node.DOCUMENT_POSITION_FOLLOWING
          : 0,
      ).not.toBe(0);
    }
    expect(container.querySelector("[data-vex-tool-section='args']")?.textContent).toContain("Args");
    expect(container.querySelector("[data-vex-tool-section='output']")?.textContent).toContain("Output");
  });

  it("wraps the Output section in an expand region that opens when the result arrives and stays mounted", () => {
    const { container, rerender } = render(
      createElement(ToolActRow, { act: act({ output: null }) }),
    );
    openRow();
    const region = outputRegion(container);
    expect(region).not.toBeNull();
    // Closed and lazily unmounted while no result merged: no "Output" text.
    expect(region?.getAttribute("data-open")).toBe("false");
    expect(container.querySelector("[data-vex-tool-section='output']")).toBeNull();
    expect(screen.queryByText("Output")).toBeNull();

    rerender(createElement(ToolActRow, { act: act({ output: "done" }) }));
    expect(outputRegion(container)).toBe(region);
    expect(region?.getAttribute("data-open")).toBe("true");
    expect(region?.className).toContain("vex-expand");
    const body = container.querySelector("[data-vex-tool-section='output']");
    expect(body?.textContent).toContain("done");
    // The hairline divider unfolds with the section: it lives inside the region.
    expect(region?.querySelector("[aria-hidden]")).not.toBeNull();

    // The well itself keeps its own region; closing it never unmounts the body.
    openRow();
    expect(container.querySelector("[data-vex-tool-section='output']")).toBe(body);
    expect(region?.getAttribute("data-open")).toBe("true");
  });
});

describe("ToolActRow failed summary tool-name prefix", () => {
  it("strips a duplicated display-title prefix from the summary while the body keeps it", () => {
    const output = "Wallet balances: chain: Invalid input\nDetail line";
    const { container } = render(
      createElement(ToolActRow, { act: act({ output, success: false }) }),
    );
    const summary = container.querySelector("[data-vex-tool-error-summary]");
    expect(summary?.textContent).toBe("chain: Invalid input");
    openRow();
    const body = container.querySelector("[data-vex-tool-section='output']");
    expect(body?.textContent).toContain(output);
  });

  it("strips a duplicated raw tool-id prefix, case-sensitively, and leaves other text alone", () => {
    const { container: raw } = render(
      createElement(ToolActRow, {
        act: act({ output: "wallet_balances: rpc unreachable", success: false }),
      }),
    );
    expect(
      raw.querySelector("[data-vex-tool-error-summary]")?.textContent,
    ).toBe("rpc unreachable");

    const { container: other } = render(
      createElement(ToolActRow, {
        act: act({ output: "WALLET_BALANCES: rpc unreachable", success: false }),
      }),
    );
    expect(
      other.querySelector("[data-vex-tool-error-summary]")?.textContent,
    ).toBe("WALLET_BALANCES: rpc unreachable");
  });

  it("shows no summary when the line is nothing but the prefix", () => {
    const { container } = render(
      createElement(ToolActRow, {
        act: act({ output: "wallet_balances:", success: false }),
      }),
    );
    expect(container.querySelector("[data-vex-tool-error-summary]")).toBeNull();
  });
});
