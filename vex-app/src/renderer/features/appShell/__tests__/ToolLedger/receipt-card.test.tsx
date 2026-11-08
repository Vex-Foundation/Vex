/**
 * THE FILLED RECEIPT (`ToolLedger/ReceiptCard.tsx`, docs/design/H3-DESKTOP.md
 * Appendix A.8): drawn only for a persisted, proven fund-moving act whose
 * transaction the session's activity ledger holds as a confirmed swap, and
 * filled only from that ledger entry.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentScanActivityEntry } from "@shared/schemas/agent-scan-feed.js";
import {
  ActReceipt,
  ReceiptCard,
  receiptEntry,
  receiptTxRef,
  sameTransaction,
} from "../../ToolLedger/ReceiptCard.js";
import { entry, availablePage } from "../../screens/__tests__/_agent-scan-fixtures.js";
import type { ToolCallActView } from "../../transcriptRowModel.js";

const HASH = `0x4833${"0".repeat(56)}f11d`;
const SESSION = "00000000-0000-4000-8000-0000000000ac";

function leg(symbol: string, amount: string | null, usd: string | null) {
  return {
    address: null,
    symbol,
    displaySymbol: symbol,
    decimals: null,
    amountHuman: amount,
    amountRaw: null,
    executedAmountHuman: amount,
    executedAmountRaw: null,
    displayAmount: amount,
    usdEst: usd,
  };
}

function swapEntry(over: Partial<AgentScanActivityEntry> = {}): AgentScanActivityEntry {
  return entry({
    id: "1",
    createdAt: "2026-11-03T14:28:58.000Z",
    txHash: HASH,
    input: leg("USDC", "200", "200.00"),
    output: leg("ETH", "0.05709", "199.82"),
    vexFee: {
      tokenSymbol: "USDC",
      amountHuman: "0.5",
      status: "confirmed",
      txHash: null,
      chainId: 8453,
      chainFamily: "eip155",
    },
    ...over,
  });
}

function act(over: Partial<ToolCallActView> = {}): ToolCallActView {
  return {
    toolCallId: "call_swap",
    toolName: "execute_tool",
    toolArgs: JSON.stringify({
      toolId: "kyberswap.swap.execute",
      params: { chain: "base", tokenIn: "USDC", tokenOut: "ETH", amountIn: "200" },
    }),
    output: "{}",
    success: true,
    explorerRefs: [{ chain: "base", txRef: HASH }],
    ...over,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("receiptTxRef", () => {
  it("names the transaction of a persisted, proven fund-moving success", () => {
    expect(receiptTxRef(act())).toBe(HASH);
  });

  it("names none for a failure, an unknown outcome, a quote, or an act with no transaction", () => {
    expect(receiptTxRef(act({ success: false }))).toBeNull();
    expect(receiptTxRef(act({ success: null }))).toBeNull();
    expect(
      receiptTxRef(
        act({
          toolArgs: JSON.stringify({ toolId: "kyberswap.swap.quote", params: {} }),
        }),
      ),
    ).toBeNull();
    expect(receiptTxRef(act({ explorerRefs: null }))).toBeNull();
  });
});

describe("receiptEntry", () => {
  it("joins on the transaction hash, in any case for an EVM hash", () => {
    expect(sameTransaction(HASH, HASH.toUpperCase().replace("0X", "0x"))).toBe(true);
    expect(receiptEntry([swapEntry()], HASH.toUpperCase().replace("0X", "0x"))?.id).toBe("1");
    expect(receiptEntry([swapEntry({ txHash: "0xother" })], HASH)).toBeNull();
  });

  it("draws a receipt only for a confirmed swap", () => {
    expect(receiptEntry([swapEntry({ status: "pending" })], HASH)).toBeNull();
    expect(receiptEntry([swapEntry({ status: "failed" })], HASH)).toBeNull();
    expect(receiptEntry([swapEntry({ activityKind: "bridge" })], HASH)).toBeNull();
  });
});

describe("ReceiptCard", () => {
  it("says the kind and the chain by name, Mainnet on the quiet hatch, the time, and desktop's outcome word on the filled stamp", () => {
    const { container } = render(createElement(ReceiptCard, { entry: swapEntry() }));
    expect(container.textContent).toContain("Swap · Base");
    // EC-10: a settled mainnet card carries the quiet hatch and the word
    // Mainnet, never the solid REAL FUNDS stamp; the chain stays named in
    // the kind and the title line.
    const net = container.querySelector("[data-vex-receipt-net]");
    expect(net?.textContent).toBe("Mainnet");
    expect(net?.classList.contains("vex-rf")).toBe(true);
    expect(container.querySelector(".vex-stamp")).toBeNull();
    expect(container.textContent).not.toMatch(/real funds/i);
    expect(container.querySelector(".vex-receipt__title")?.textContent).toContain("· Base");
    expect(container.querySelector("[data-vex-receipt-time]")?.textContent).toMatch(/^\d{2}:\d{2}$/);
    const stamp = container.querySelector("[data-vex-receipt-stamp]");
    expect(stamp?.textContent).toBe("Confirmed");
    // PD-03: a fill, a square and a word; the square leads.
    expect(stamp?.firstElementChild?.classList.contains("vex-sq")).toBe(true);
    expect(stamp?.firstElementChild?.getAttribute("data-state")).toBe("done");
    expect(stamp?.className).toContain("bg-stamp-filled");
    expect(stamp?.className).toContain("text-ink-on-stamp-filled");
    expect(container.textContent).toContain("USDC → ETH");
  });

  it("fills its rows from the entry alone, the USD as the feed's estimate", () => {
    const { container } = render(createElement(ReceiptCard, { entry: swapEntry() }));
    const value = (label: string): string | null | undefined =>
      container.querySelector(`[data-vex-receipt-row="${label}"] dd`)?.textContent;
    expect(value("Sell")).toBe("200 USDC");
    expect(value("Value (USD)")).toBe("about $200.00");
    expect(value("Received")).toBe("0.05709 ETH");
    expect(value("Vex fee")).toBe("0.5 USDC");
    // The labels are the field-label register (mono caps).
    expect(
      container.querySelector('[data-vex-receipt-row="Sell"] dt')?.className,
    ).toContain("vex-field-label");
    // Approvals are not joined to activity: no approval row is drawn.
    expect(container.textContent).not.toMatch(/approv/i);
  });

  it("leaves out a row the entry does not hold, never fills it", () => {
    const { container } = render(
      createElement(ReceiptCard, {
        entry: swapEntry({ input: leg("USDC", "200", null), vexFee: null }),
      }),
    );
    expect(container.querySelector('[data-vex-receipt-row="Value (USD)"]')).toBeNull();
    expect(container.querySelector('[data-vex-receipt-row="Vex fee"]')).toBeNull();
    expect(container.querySelector('[data-vex-receipt-row="Sell"]')).not.toBeNull();
  });
});

describe("the receipt's sheet (Cloud's result card, 6f067702)", () => {
  const sheet = readFileSync(join(process.cwd(), "src/renderer/styles/global-css/chat-transcript.css"), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  const body = (selector: string): string => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(sheet)?.[1] ?? "";
  };

  it("sits on the card ground with a 44 head row, the title 18 / 1.3 and the place word 15", () => {
    expect(body(".vex-receipt")).toContain("background: var(--vex-alias-card)");
    expect(body(".vex-receipt__eyebrow")).toContain("min-height: 44px");
    expect(body(".vex-receipt__head")).toContain("padding: 0 16px 16px");
    expect(body(".vex-receipt__title")).toContain("font-size: 18px");
    expect(body(".vex-receipt__title")).toContain("letter-spacing: -0.01em");
    expect(body(".vex-receipt__where")).toContain("font-size: 15px");
  });

  it("draws the tag at Cloud's measures: 24 high, padding 0 7, 6 between, caps 11", () => {
    const tag = body(".vex-receipt__stamp");
    expect(tag).toContain("height: 24px");
    expect(tag).toContain("padding: 0 7px");
    expect(tag).toContain("gap: 6px");
    expect(tag).toContain("font-size: 11px");
    expect(body(".vex-receipt__stamp > .vex-sq")).toContain("color: inherit");
  });

  it("sets the rows' names mono 12 at 0.06em and the values mono 12 at 0.01em", () => {
    expect(body(".vex-receipt__label")).toContain("font-size: 12px");
    expect(body(".vex-receipt__label")).toContain("letter-spacing: 0.06em");
    expect(body(".vex-receipt__value")).toContain("font-size: 12px");
    expect(body(".vex-receipt__value")).toContain("letter-spacing: 0.01em");
  });
});

describe("ActReceipt", () => {
  function renderReceipt(entries: readonly AgentScanActivityEntry[]) {
    const listAgentScan = vi.fn().mockResolvedValue(availablePage([...entries]));
    vi.stubGlobal("vex", { portfolio: { listAgentScan } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(ActReceipt, { txRef: HASH, sessionId: SESSION }),
      ),
    );
    return { view, listAgentScan };
  }

  it("reads the session's activity and draws the matching confirmed swap", async () => {
    const { listAgentScan } = renderReceipt([swapEntry()]);
    await waitFor(() => expect(screen.getByText("Confirmed")).not.toBeNull());
    expect(listAgentScan).toHaveBeenCalledWith({
      cursor: null,
      filters: { sessionId: SESSION },
    });
  });

  it("draws nothing when the ledger holds no confirmed swap for the transaction", async () => {
    const { view, listAgentScan } = renderReceipt([swapEntry({ status: "pending" })]);
    await waitFor(() => expect(listAgentScan).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(view.container.querySelector("[data-vex-receipt]")).toBeNull();
  });
});
