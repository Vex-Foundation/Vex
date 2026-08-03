/**
 * AgentScanScreen ROWS + VIRTUALIZATION — split out of
 * `AgentScanScreen.test.tsx` (which keeps filters, the states matrix, and
 * pagination) by the same seams as the screen itself. Shared DTO factories and
 * the jsdom geometry stubs live in `_agent-scan-fixtures.ts`.
 *
 * Pins:
 *   - VIRTUALIZATION: a large multi-page fixture keeps the rendered row count
 *     BOUNDED, before and after scrolling — an unbounded feed must never
 *     retain a DOM node per fetched row — while the spacer still reserves
 *     height for the FULL feed;
 *   - a row renders its badge, legs, quote-time USD marker and main-resolved
 *     explorer link, marks an ESTIMATED basis with `~`/`est.`, expands to its
 *     audit detail (per-leg explorer links, Vex fee, failure code/reason), and
 *     flags a STALE pending row as tracking delayed rather than implying
 *     progress.
 *
 * `useAgentScanInfinite` is mocked — this suite owns the screen, not the query
 * wiring (the hook's pagination contract is pinned in the api layer).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { AgentScanDto } from "@shared/schemas/agent-scan-feed.js";
import type { Result } from "@shared/ipc/result.js";
import {
  availablePage,
  entry,
  installJsdomGeometry,
  restoreJsdomGeometry,
  ROW_PX,
} from "./_agent-scan-fixtures.js";

vi.mock("../../../../components/icons/VexIcon.js", () => ({
  VexIcon: () => null,
}));
vi.mock("../../../../components/icons/icon-glyphs.js", () => ({
  Cancel01Icon: "Cancel01Icon",
  ArrowUpRight01Icon: "ArrowUpRight01Icon",
}));

const mockUseAgentScanInfinite = vi.hoisted(() => vi.fn());
vi.mock("../../../../lib/api/portfolio.js", () => ({
  useAgentScanInfinite: mockUseAgentScanInfinite,
}));

const { AgentScanScreen } = await import("../AgentScanScreen.js");

function mockQuery(
  pages: readonly Result<AgentScanDto>[],
  options?: { readonly hasNextPage?: boolean },
): void {
  mockUseAgentScanInfinite.mockReturnValue({
    isLoading: false,
    isError: false,
    data: pages.length > 0 ? { pages: [...pages] } : undefined,
    hasNextPage: options?.hasNextPage ?? false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
  });
}

function mountScreen(): void {
  render(
    <AgentScanScreen origin={null} sessionId={null} onClose={() => undefined} />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  installJsdomGeometry();
});

afterEach(() => {
  restoreJsdomGeometry();
  cleanup();
});

describe("AgentScanScreen — virtualization", () => {
  /** 3 pages × 100 rows, all on distinct days so dividers are in the mix too. */
  function largeFeed(): readonly Result<AgentScanDto>[] {
    const page = (offset: number): Result<AgentScanDto> =>
      availablePage(
        Array.from({ length: 100 }, (_, index) => {
          const n = offset + index;
          const day = String((n % 27) + 1).padStart(2, "0");
          return entry({
            id: `e-${n}`,
            createdAt: `2026-07-${day}T10:21:00+00:00`,
          });
        }),
        { hasMore: true },
      );
    return [page(0), page(100), page(200)];
  }

  it("keeps the rendered row count BOUNDED for a large multi-page feed, and after scrolling", () => {
    mockQuery(largeFeed(), { hasNextPage: false });
    mountScreen();

    const list = screen.getByRole("list", { name: "Activity" });
    const renderedBefore = within(list).getAllByRole("listitem").length;

    // 300 entries plus their day dividers are in the data…
    expect(renderedBefore).toBeGreaterThan(0);
    // …but only a window of them is ever in the DOM. A viewport of
    // VIEWPORT_PX / ROW_PX rows plus overscan on both sides is the bound; the
    // fixture is an order of magnitude larger.
    expect(renderedBefore).toBeLessThan(40);
    // The bound is real, not an artifact of a short fixture.
    expect(renderedBefore).toBeLessThan(300 / 4);

    const scroller = list.parentElement;
    expect(scroller).not.toBeNull();
    if (scroller !== null) {
      scroller.scrollTop = 4000;
      fireEvent.scroll(scroller);
    }

    const renderedAfter = within(list).getAllByRole("listitem").length;
    expect(renderedAfter).toBeGreaterThan(0);
    expect(renderedAfter).toBeLessThan(40);
  });

  it("sizes the list to the FULL feed even though only a window is mounted", () => {
    mockQuery(largeFeed());
    mountScreen();
    const list = screen.getByRole("list", { name: "Activity" });
    // The spacer reserves height for every row, so the scrollbar tells the
    // truth about how much history there is.
    const height = Number.parseInt(list.style.height, 10);
    expect(height).toBeGreaterThan(300 * ROW_PX * 0.5);
  });
});

describe("AgentScanScreen — rows and audit detail", () => {
  it("renders a row with its badge, legs, quote-time USD marker and main-resolved explorer link", () => {
    mockQuery([availablePage([entry({ id: "1" })])]);
    mountScreen();

    expect(screen.getByText("SWAP")).not.toBeNull();
    expect(screen.getByText(/50 USDC/)).not.toBeNull();
    expect(screen.getByText(/0\.02 WETH/)).not.toBeNull();
    // Every USD figure in this feed is a quote-time estimate — it must say so.
    expect(screen.getByText("~$49.80 est.")).not.toBeNull();
    const link = screen.getByRole("link", {
      name: "Open transaction on block explorer",
    });
    expect(link.getAttribute("href")).toBe("https://basescan.org/tx/0xabc");
  });

  it("marks an ESTIMATED bridge amount with ~ and an est. tag", () => {
    mockQuery([
      availablePage([
        entry({
          id: "1",
          activityKind: "bridge",
          eventRole: "bridge_fill_expected",
          amountBasis: "estimated",
          fromChain: { chainId: 8453, slug: "base" },
          toChain: { chainId: 42161, slug: "arbitrum" },
        }),
      ]),
    ]);
    mountScreen();
    expect(screen.getByText("BRIDGE·FILL")).not.toBeNull();
    expect(screen.getByText(/~50 USDC/)).not.toBeNull();
    expect(screen.getByText("est.")).not.toBeNull();
    expect(screen.getByText("base → arbitrum")).not.toBeNull();
  });

  it("expands to the audit detail: legs with their own explorer links, Vex fee, and the failure reason", () => {
    mockQuery([
      availablePage([
        entry({
          id: "1",
          activityKind: "bridge",
          eventRole: "bridge_fill_expected",
          status: "failed",
          failureCode: "bridge_failed",
          failureReason: "destination fill reverted",
          vexFee: { tokenSymbol: "USDC", amountHuman: "0.05" },
          usdFeeEst: "0.05",
          providerOrderId: "ord_9",
          legs: [
            {
              role: "bridge_deposit",
              chainId: 8453,
              chainFamily: "eip155",
              chainSlug: "base",
              txHash: "0xdep",
              status: "confirmed",
              failureCode: null,
              explorerUrl: "https://basescan.org/tx/0xdep",
            },
            {
              role: "bridge_fill_expected",
              chainId: 42161,
              chainFamily: "eip155",
              chainSlug: "arbitrum",
              txHash: null,
              status: "failed",
              failureCode: "bridge_failed",
              // Uncurated chain / no hash → main resolved no URL; the leg must
              // still be listed, just not linked.
              explorerUrl: null,
            },
          ],
        }),
      ]),
    ]);
    mountScreen();

    // Collapsed by default.
    expect(screen.queryByText(/destination fill reverted/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Show details/ }));

    expect(screen.getByText(/bridge_failed — destination fill reverted/)).not.toBeNull();
    expect(screen.getByText(/0\.05 USDC/)).not.toBeNull();
    expect(screen.getByText("ord_9")).not.toBeNull();
    // Both legs listed; only the one main resolved a URL for is a link.
    expect(screen.getByText("bridge_deposit")).not.toBeNull();
    expect(screen.getAllByText("bridge_fill_expected").length).toBeGreaterThan(0);
    const legLinks = screen.getAllByLabelText(/on block explorer/);
    expect(
      legLinks.filter((el) => el.getAttribute("href")?.includes("0xdep")).length,
    ).toBe(1);
  });

  it("flags a STALE pending row as tracking delayed rather than implying progress", () => {
    mockQuery([
      availablePage([
        entry({
          id: "1",
          status: "pending",
          createdAt: "2020-01-01T00:00:00+00:00",
          lastCheckedAt: "2020-01-01T00:00:00+00:00",
        }),
      ]),
    ]);
    mountScreen();
    expect(screen.getByText("PENDING")).not.toBeNull();
    expect(screen.getByText("tracking delayed")).not.toBeNull();
  });

  // Migration 065's DERIVED state (Wave P, Blocker 2). The engine writes
  // `verification_attempts`/`last_verification_reason`, the main mapper derives
  // `stalledVerification`, and this is the surface that finally says it out
  // loud. A row that could not be VERIFIED is not a row that FAILED — the whole
  // point of never auto-failing it is that the outcome is UNKNOWN.
  it("renders a stalled pending row as a distinct NON-FAILURE state, with its reason", () => {
    mockQuery([
      availablePage([
        entry({
          id: "1",
          status: "pending",
          stalledVerification: true,
          stalledReason: "no_safe_rpc",
        }),
      ]),
    ]);
    mountScreen();

    expect(screen.getByText("PENDING")).not.toBeNull();
    expect(screen.getByText("verification stalled")).not.toBeNull();
    // NOT dressed as a failure: no FAILED badge, and the chip does not wear the
    // destructive tone reserved for a proven failure.
    expect(screen.queryByText("FAILED")).toBeNull();
    const chip = screen.getByText("verification stalled");
    expect(chip.className).not.toContain("destructive");
    expect(chip.className).not.toContain("warning");
    expect(chip.getAttribute("title")).toContain("no_safe_rpc");
    expect(chip.getAttribute("title")).toContain("nothing has failed");

    // The expanded detail names the reason verbatim, so the user and the agent
    // read the same bounded code.
    fireEvent.click(screen.getByRole("button", { name: /Show details/ }));
    expect(screen.getByText(/Could not conclude: no_safe_rpc/)).not.toBeNull();
  });

  it("a stalled row does not ALSO claim tracking delayed — one chip, the more specific one", () => {
    mockQuery([
      availablePage([
        entry({
          id: "1",
          status: "pending",
          createdAt: "2020-01-01T00:00:00+00:00",
          lastCheckedAt: "2020-01-01T00:00:00+00:00",
          stalledVerification: true,
          stalledReason: "receipt_unavailable",
        }),
      ]),
    ]);
    mountScreen();

    expect(screen.getByText("verification stalled")).not.toBeNull();
    expect(screen.queryByText("tracking delayed")).toBeNull();
  });
});
