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
 *     progress;
 *   - the feed's SECOND ARM: a Lighter fill renders its own row grammar and
 *     its own drawer, states every unknown as an unknown rather than a zero,
 *     names a fill the user did not place, and shares no identity with an
 *     `agent_activity` row that happens to carry the same numeric id.
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
  GLOBAL_SCOPE,
  entry,
  installJsdomGeometry,
  lighterFill,
  restoreJsdomGeometry,
  ROW_PX,
} from "./_agent-scan-fixtures.js";

const mockUseAgentScanInfinite = vi.hoisted(() => vi.fn());
vi.mock("../../../../lib/api/portfolio.js", () => ({
  useAgentScanInfinite: mockUseAgentScanInfinite,
}));

/**
 * The project NAME read is mocked, not provided through a QueryClient: it is a
 * LABEL for the scope chip and nothing about it belongs to this suite's
 * subject. `useProject` is disabled for every non-project scope in the screen,
 * so a global or session mount never consults it.
 */
const mockUseProject = vi.hoisted(() => vi.fn());
vi.mock("../../../../lib/api/projects.js", () => ({
  useProject: mockUseProject,
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
    <AgentScanScreen origin={null} scope={GLOBAL_SCOPE} onClose={() => undefined} />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // The disabled-query shape `useProject` returns for a non-project scope.
  mockUseProject.mockReturnValue({ data: undefined });
  installJsdomGeometry();
});

afterEach(() => {
  restoreJsdomGeometry();
  cleanup();
});

describe("AgentScanScreen - virtualization", () => {
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

describe("AgentScanScreen - rows and audit detail", () => {
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

  /**
   * OWNER RULE V1 (2026-09-04). A fee transfer that is still in flight carries no
   * amount, and the detail line used to render nothing at all for it - so money
   * that may still leave the wallet was invisible on the only surface that shows
   * this row. The line now names the attempt's state instead of inventing a
   * number, which would be the opposite error.
   */
  it("names a PENDING Vex fee attempt on the detail line instead of falling silent", () => {
    mockQuery([
      availablePage([
        entry({
          id: "1",
          activityKind: "swap",
          eventRole: "swap",
          status: "pending",
          vexFee: {
            tokenSymbol: null,
            amountHuman: null,
            status: "pending",
            txHash: `0x${"ab".repeat(32)}`,
            chainId: 8453,
            chainFamily: "eip155",
          },
          usdFeeEst: null,
        }),
      ]),
    ]);
    mountScreen();
    fireEvent.click(screen.getByRole("button", { name: /Show details/ }));

    expect(screen.getByText("Vex fee")).not.toBeNull();
    expect(screen.getByText("attempt pending")).not.toBeNull();
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
          vexFee: {
            tokenSymbol: "USDC",
            amountHuman: "0.05",
            status: "confirmed",
            txHash: "0xfee",
            chainId: 8453,
            chainFamily: "eip155",
          },
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

    expect(screen.getByText(/bridge_failed - destination fill reverted/)).not.toBeNull();
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

  it("a stalled row does not ALSO claim tracking delayed - one chip, the more specific one", () => {
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

/**
 * THE SECOND ARM. These rows come from the venue's own `lighter_fills` ledger,
 * not from `agent_activity`: settled the moment the venue matched them, with
 * no lifecycle, no settlement transaction and no explorer link. What they add
 * to the audit surface is the account's own half of the record - the position
 * before, the leverage that was in force, the fee with its provenance, and the
 * newest observation of the market - so these tests pin the ABSENCES as hard
 * as the figures: an unknown must never print as a zero.
 */
describe("AgentScanScreen - Lighter fill rows", () => {
  function expand(): void {
    fireEvent.click(screen.getByRole("button", { name: /Show details for this fill/ }));
  }

  it("renders the fill line: badge, executed trade, SETTLED usd, leverage, clock", () => {
    mockQuery([availablePage([lighterFill({ id: "9" })])]);
    mountScreen();

    expect(screen.getByText("PERP·OPEN")).not.toBeNull();
    expect(screen.getByText("Buy 0.0050 ETH @ 2,598.09")).not.toBeNull();
    // The venue's OWN settled figure: plain, never the `~ ... est.` marker the
    // activity arm's quote-time USD wears.
    const usd = screen.getByText("$12.99");
    expect(usd).not.toBeNull();
    expect(usd.textContent).not.toContain("est.");
    // The whole value is still reachable - the two-decimal cell hides nothing.
    expect(usd.getAttribute("title")).toBe("12.990450");
    expect(screen.getByText("10.00x")).not.toBeNull();
  });

  it("renders NO link for a fill - there is no settlement transaction to link to", () => {
    mockQuery([availablePage([lighterFill({ id: "9" })])]);
    mountScreen();
    expect(screen.queryByRole("link")).toBeNull();
    expand();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("expands to the whole account half: position, leverage, fees, ids and the observation", () => {
    mockQuery([
      availablePage([
        lighterFill({
          id: "9",
          positionEffect: "reduce",
          positionSizeBefore: "0.0120",
          entryQuoteBefore: "-31.177080",
          accountPnl: "-0.4412",
        }),
      ]),
    ]);
    mountScreen();

    expect(screen.queryByText("Position before")).toBeNull();
    expand();

    expect(screen.getByText("Position before")).not.toBeNull();
    // SIGNED, in the base asset: an unsigned size reads as the wrong direction.
    expect(screen.getByText("+0.0120 ETH")).not.toBeNull();
    expect(screen.getByText("Entry quote before")).not.toBeNull();
    expect(screen.getByText("-31.177080 USDG")).not.toBeNull();
    expect(screen.getByText("Realized PnL")).not.toBeNull();
    expect(screen.getByText("-0.4412 USDG")).not.toBeNull();
    // The leverage BEFORE the fill, as a historical fact.
    expect(screen.getByText("Leverage")).not.toBeNull();
    // The fee is only ESTIMATED, so it carries the marker, the basis and the tick.
    expect(
      screen.getByText(
        "~ 0.012990 USDG est., on quote notional, observed tick · ~$0.012990 est.",
      ),
    ).not.toBeNull();
    expect(screen.getByText("~$0.004546 est.")).not.toBeNull();
    expect(screen.getByText("Trade")).not.toBeNull();
    expect(screen.getByText("Lighter Core")).not.toBeNull();
    expect(screen.getByText("18412771")).not.toBeNull();
    expect(screen.getByText("771203")).not.toBeNull();
    expect(screen.getByText("884412")).not.toBeNull();
    expect(
      screen.getByText("lighter-exec-00000000-0000-4000-8000-0000000000f1"),
    ).not.toBeNull();
    // The observation carries its own time, because it is a fact about THEN.
    // The exact stamp is the display helper's own test; here it must be present
    // and attached to the size.
    expect(screen.getByText(/^\+0\.0050 ETH \(last observed .+\)$/)).not.toBeNull();
    expect(screen.getByText("liquidation 2,365.93")).not.toBeNull();
  });

  it("a PUBLIC row says the position facts are unknown and shows no PnL - never a 0", () => {
    mockQuery([
      availablePage([
        lighterFill({
          id: "9",
          positionEffect: null,
          positionSizeBefore: null,
          entryQuoteBefore: null,
          accountPnl: null,
        }),
      ]),
    ]);
    mountScreen();

    expect(screen.getByText("PERP·UNKNOWN")).not.toBeNull();
    expand();
    expect(screen.getByText("position facts unknown")).not.toBeNull();
    expect(screen.queryByText("Realized PnL")).toBeNull();
    expect(screen.queryByText("Entry quote before")).toBeNull();
  });

  it("the drawer repeats the settled economics WHOLE, on lines that wrap", () => {
    // The feed line clips to the row's width and truncates the cents; the
    // drawer must carry side, size, price, quote notional and the full USD so
    // nothing the venue recorded is lost at a narrow width (final review).
    mockQuery([
      availablePage([
        lighterFill({ id: "9", baseSize: "0.0050", price: "2598.09", quoteNotional: "12.990450", usdAmount: "12.990450" }),
      ]),
    ]);
    mountScreen();
    expand();

    expect(screen.getByText("Side")).not.toBeNull();
    expect(screen.getByText("Buy")).not.toBeNull();
    expect(screen.getByText("Size")).not.toBeNull();
    expect(screen.getByText("0.0050 ETH")).not.toBeNull();
    expect(screen.getByText("Price")).not.toBeNull();
    expect(screen.getByText("2,598.09 USDG")).not.toBeNull();
    expect(screen.getByText("Quote notional")).not.toBeNull();
    expect(screen.getByText("12.990450 USDG")).not.toBeNull();
    expect(screen.getByText("USD")).not.toBeNull();
    expect(screen.getByText("$12.990450")).not.toBeNull();
    // The clipped line carries the whole sentence as its title.
    expect(screen.getByTitle("Buy 0.0050 ETH @ 2,598.09")).not.toBeNull();
  });

  it("a NULL leverage renders no chip at all and reads `unknown` in the drawer", () => {
    mockQuery([availablePage([lighterFill({ id: "9", leverage: null })])]);
    mountScreen();

    // Not "1x", not "-": an absent historical leverage is not a leverage of one.
    expect(screen.queryByText("10.00x")).toBeNull();
    expect(screen.queryByText("1x")).toBeNull();
    expand();
    expect(screen.getByText("unknown")).not.toBeNull();
  });

  it("names a LIQUIDATION as one - it is the venue acting, not a trade the user placed", () => {
    mockQuery([availablePage([lighterFill({ id: "9", tradeType: "liquidation" })])]);
    mountScreen();

    const chip = screen.getByText("liquidation");
    expect(chip).not.toBeNull();
    // The word carries it: the chip is text, never colour alone.
    expect(chip.getAttribute("title")).toContain("not a trade the user placed");
    expand();
    expect(screen.getByText("Liquidation")).not.toBeNull();
  });

  it("renders an UNKNOWN position effect neutrally rather than blanking the row (tolerant reader)", () => {
    mockQuery([
      availablePage([lighterFill({ id: "9", positionEffect: "settle_down" })]),
    ]);
    mountScreen();
    expect(screen.getByText("PERP·SETTLE_DOWN")).not.toBeNull();
    expect(screen.getByText("Buy 0.0050 ETH @ 2,598.09")).not.toBeNull();
  });

  it("a SPOT fill wears no leverage chip and shows no position lines anywhere", () => {
    mockQuery([
      availablePage([
        lighterFill({ id: "9", spot: true, marketSymbol: "ETH", positionEffect: null }),
      ]),
    ]);
    mountScreen();

    expect(screen.getByText("SPOT·UNKNOWN")).not.toBeNull();
    expect(screen.queryByText("10.00x")).toBeNull();
    expand();
    expect(screen.queryByText("Position before")).toBeNull();
    expect(screen.queryByText("Leverage")).toBeNull();
    expect(screen.queryByText("Position now")).toBeNull();
  });

  it("states a market observed CLOSED as closed, with when it was observed", () => {
    mockQuery([
      availablePage([
        lighterFill({
          id: "9",
          positionNow: {
            observedAt: "2020-01-02T16:49:00+00:00",
            open: false,
            position: null,
          },
        }),
      ]),
    ]);
    mountScreen();
    expand();
    expect(screen.getByText(/^closed \(last observed /)).not.toBeNull();
  });

  it("states an OPEN position whose details could not be read, rather than hiding the observation", () => {
    mockQuery([
      availablePage([
        lighterFill({
          id: "9",
          positionNow: {
            observedAt: "2020-01-02T16:49:00+00:00",
            open: true,
            position: null,
          },
        }),
      ]),
    ]);
    mountScreen();
    expand();
    expect(screen.getByText(/^open, details unavailable \(last observed /)).not.toBeNull();
  });

  it("renders NO position-now block when the market was never observed - absence is not `closed`", () => {
    mockQuery([availablePage([lighterFill({ id: "9", positionNow: null })])]);
    mountScreen();
    expand();
    expect(screen.queryByText("Position now")).toBeNull();
    expect(screen.queryByText(/closed/)).toBeNull();
  });

  /**
   * THE KEY COLLISION. The two ledgers are separate BIGSERIAL sequences, so id
   * `42` exists in both and can land on one page. Keying rows on the id alone
   * makes React reconcile one row onto the other's measured wrapper; the
   * compiler cannot catch it, because both ids are strings.
   */
  it("renders BOTH rows when an activity row and a fill share a numeric id", () => {
    mockQuery([
      availablePage([
        entry({ id: "42", createdAt: "2026-07-20T10:22:00+00:00" }),
        lighterFill({ id: "42", createdAt: "2026-07-20T10:21:00+00:00" }),
      ]),
    ]);
    mountScreen();

    expect(screen.getByText("SWAP")).not.toBeNull();
    expect(screen.getByText("PERP·OPEN")).not.toBeNull();
    const list = screen.getByRole("list", { name: "Activity" });
    // One day divider plus the two entry rows.
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
  });
});
