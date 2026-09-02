/**
 * TokenHistoryScreen HONESTY PINS — the money-truth rules the row layer must
 * never quietly relax. Split from `TokenHistoryScreen-rows.test.tsx` at the
 * 500-line cap, along the seam that matters: the sibling owns what a row LOOKS
 * like, this file owns what a row is allowed to CLAIM.
 *
 * Pins:
 *   - an `agent_activity`-sourced swap entry's pending/failed status renders a
 *     status chip (Agent Scan §4.7); `null`/`"confirmed"` renders none — the
 *     shell's "quiet unless it needs attention" posture;
 *   - amount honesty (C20/C27): a proven-human whole number renders, while an
 *     unknown-provenance value keeps the em dash even when a value string is
 *     present — never a blind base-unit format;
 *   - USD provenance (C35): an `"estimated"` figure renders with an explicit
 *     `~ … est.` marker and a `"recorded"` one renders bare, and neither leg
 *     having a value omits the figure entirely rather than fabricating $0.00.
 *
 * `useTokenHistoryInfinite` is mocked — this suite owns display rules, not
 * query wiring.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { TokenHistoryDto } from "@shared/schemas/token-history.js";
import type { Result } from "@shared/ipc/result.js";
import { useUiStore } from "../../../../stores/uiStore.js";
import {
  availablePage,
  swapEntry,
  tokenHistoryRoute,
  USDC_BASE,
} from "./_token-history-fixtures.js";

// Every brand mark stubs to null, whatever its name: the marks are
// presentation-only here, and a hand-listed mock breaks the whole suite
// file each time a component references a new mark.
vi.mock("@thesvg/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@thesvg/react")>();
  return Object.fromEntries(Object.keys(actual).map((name) => [name, () => null]));
});

// Sibling screens pull heavy registers; only the token-history branch is
// under test.
vi.mock("../MemoryScreen.js", () => ({ MemoryScreen: () => null }));
vi.mock("../SessionsScreen.js", () => ({ SessionsScreen: () => null }));
vi.mock("../HowVexWorksScreen.js", () => ({ HowVexWorksScreen: () => null }));
vi.mock("../SettingsScreen.js", () => ({ SettingsScreen: () => null }));
vi.mock("../AssetsScreen.js", () => ({ AssetsScreen: () => null }));
vi.mock("../AgentScanScreen.js", () => ({ AgentScanScreen: () => null }));

const mockUseTokenHistoryInfinite = vi.hoisted(() => vi.fn());
vi.mock("../../../../lib/api/portfolio.js", () => ({
  useTokenHistoryInfinite: mockUseTokenHistoryInfinite,
}));

const { ShellScreens } = await import("../ShellScreens.js");

function mockQuery(pages: readonly Result<TokenHistoryDto>[]): void {
  mockUseTokenHistoryInfinite.mockReturnValue({
    isLoading: false,
    isError: false,
    data: pages.length > 0 ? { pages: [...pages] } : undefined,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
  });
}

function mountScreen(): void {
  useUiStore.setState({ shellRoute: tokenHistoryRoute({ kind: "shell" }) });
  render(<ShellScreens />);
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  useUiStore.setState({ shellRoute: { kind: "none" } });
});

afterEach(() => {
  cleanup();
});

describe("TokenHistoryScreen - agent_activity swap status chip (Agent Scan §4.7)", () => {
  it("renders a PENDING chip for a pending agent_activity swap entry", () => {
    mockQuery([
      availablePage([swapEntry({ id: "a-1", status: "pending", failureCode: null })]),
    ]);
    mountScreen();
    expect(screen.getByText("PENDING")).not.toBeNull();
  });

  it("renders a FAILED chip with the failureCode as its tooltip", () => {
    mockQuery([
      availablePage([
        swapEntry({ id: "a-1", status: "failed", failureCode: "slippage" }),
      ]),
    ]);
    mountScreen();
    const chip = screen.getByText("FAILED");
    expect(chip.getAttribute("title")).toBe("slippage");
  });

  it("renders NO status chip for a confirmed or null-status swap entry (the quiet default)", () => {
    mockQuery([
      availablePage([swapEntry({ id: "a-1", status: "confirmed", failureCode: null })]),
    ]);
    mountScreen();
    expect(screen.queryByText("PENDING")).toBeNull();
    expect(screen.queryByText("FAILED")).toBeNull();
    expect(screen.queryByText("CONFIRMED")).toBeNull();
  });
});

describe("TokenHistoryScreen - agent_activity amount honesty (Codex final review C20/C27)", () => {
  it("renders a whole-number human amount (no decimal point) for a confirmed agent_activity leg", () => {
    mockQuery([
      availablePage([
        swapEntry({
          id: "a-1",
          status: "confirmed",
          failureCode: null,
          tradeSide: null,
          input: {
            token: "0x1111111111111111111111111111111111111111",
            symbol: "TOKA",
            localSymbol: null,
            amount: { value: "50", unitProvenance: "human" },
            valueUsd: { value: "50.00", usdProvenance: "estimated" },
          },
        }),
      ]),
    ]);
    mountScreen();
    // A main-process-resolved executed amount with no fractional part (e.g.
    // `formatUnits(50_000_000n, 6)` → "50") must still render — the
    // decimal-point heuristic never applies once `unitProvenance` already
    // proves the value human (contract C27).
    expect(screen.getByText(/50 TOKA/)).not.toBeNull();
  });

  it("renders the em dash for an unknown-provenance leg even when a value string is present (a status the mapper could not resolve, e.g. a failed row)", () => {
    mockQuery([
      availablePage([
        swapEntry({
          id: "a-1",
          status: "failed",
          failureCode: "slippage",
          input: {
            token: "0x1111111111111111111111111111111111111111",
            symbol: "TOKA",
            localSymbol: null,
            amount: { value: "50", unitProvenance: "unknown" },
            valueUsd: { value: null, usdProvenance: "estimated" },
          },
        }),
      ]),
    ]);
    mountScreen();
    expect(screen.getByText(/- TOKA/)).not.toBeNull();
    expect(screen.queryByText(/50 TOKA/)).toBeNull();
  });
});

describe("TokenHistoryScreen - USD estimate provenance (Codex final review round 2 C35)", () => {
  it("renders an agent_activity-sourced (estimated) valueUsd with an explicit ~... est. marker, never bare execution USD", () => {
    mockQuery([
      availablePage([
        swapEntry({
          id: "a-1",
          status: "confirmed",
          failureCode: null,
          output: {
            token: USDC_BASE,
            symbol: "TOKB",
            localSymbol: null,
            amount: { value: "25100000", unitProvenance: "unknown" },
            valueUsd: { value: "25.10", usdProvenance: "estimated" },
          },
        }),
      ]),
    ]);
    mountScreen();
    expect(screen.getByText(/~\$25\.10 est\./)).not.toBeNull();
  });

  it("keeps a recorded (legacy proj_activity) valueUsd bare, with no est. marker", () => {
    mockQuery([availablePage([swapEntry({ id: "a-1" })])]);
    mountScreen();
    expect(screen.getByText(/\$25\.10/)).not.toBeNull();
    expect(screen.queryByText(/est\./)).toBeNull();
  });

  it("omits the USD figure entirely when neither leg has a value, regardless of provenance (never a fabricated $0.00)", () => {
    mockQuery([
      availablePage([
        swapEntry({
          id: "a-1",
          unitPriceUsd: null,
          input: {
            token: "0x1111111111111111111111111111111111111111",
            symbol: "TOKA",
            localSymbol: null,
            amount: { value: "1.5", unitProvenance: "human" },
            valueUsd: { value: null, usdProvenance: "estimated" },
          },
          output: {
            token: USDC_BASE,
            symbol: "TOKB",
            localSymbol: null,
            amount: { value: "25100000", unitProvenance: "unknown" },
            valueUsd: { value: null, usdProvenance: "estimated" },
          },
        }),
      ]),
    ]);
    mountScreen();
    expect(screen.queryByText(/\$/)).toBeNull();
  });
});
