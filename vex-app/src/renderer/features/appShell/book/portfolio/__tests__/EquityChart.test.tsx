/**
 * EquityChart - the Portfolio page's wallet total over time
 * (docs/design/H3-DESKTOP.md section 4.1 item 12, A.8).
 *
 * Pins:
 *   - the history read takes the SAME wallets input the page's figures read
 *     with, per scope (the global read, one wallet's narrowed global read, a
 *     chat's session, a project), and the selected range; it opens on 30 d;
 *   - the range keys are 24 h, 7 d, 30 d and All, and a press reads that range;
 *   - every state is words: loading, a refusal, no wallet in the scope, no
 *     cycle in the range; never a line at zero;
 *   - a drawn history is an image with a summary, partial cycles are hollow
 *     marks with their note, and a thinned answer says what it stands for.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type {
  PortfolioHistoryDto,
  PortfolioHistoryInput,
} from "@shared/schemas/portfolio-history.js";
import type { AvailableWalletDto } from "@shared/schemas/wallets.js";
import { ok, type Result } from "@shared/ipc/result.js";

interface HistoryStub {
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly data: Result<PortfolioHistoryDto> | undefined;
}

const mockUsePortfolioHistory = vi.hoisted(() => vi.fn<(input: PortfolioHistoryInput) => HistoryStub>());
vi.mock("../../../../../lib/api/portfolio.js", () => ({
  usePortfolioHistory: mockUsePortfolioHistory,
}));

const { EquityChart } = await import("../EquityChart.js");

const DAY = 86_400_000;
const END = Date.UTC(2026, 10, 3, 14, 26, 0);
const WALLET: AvailableWalletDto = {
  id: "evm-1",
  family: "evm",
  address: "0x1111111111111111111111111111111111111111",
  label: "Main",
};

function dto(overrides: Partial<PortfolioHistoryDto> = {}): PortfolioHistoryDto {
  return {
    scope: "global",
    range: "30d",
    walletCount: 2,
    groupCount: 3,
    sampled: false,
    points: [
      { at: new Date(END - 2 * DAY).toISOString(), totalUsd: 2800, settledUsd: 2800, inTransitUsd: 0, partial: false },
      { at: new Date(END - DAY).toISOString(), totalUsd: 2850, settledUsd: 2850, inTransitUsd: 0, partial: false },
      { at: new Date(END).toISOString(), totalUsd: 2912.75, settledUsd: 2912.75, inTransitUsd: 0, partial: false },
    ],
    ...overrides,
  };
}

function answer(history: PortfolioHistoryDto): void {
  mockUsePortfolioHistory.mockReturnValue({ isLoading: false, isError: false, data: ok(history) });
}

function inputs(): readonly PortfolioHistoryInput[] {
  return mockUsePortfolioHistory.mock.calls.map(([input]) => input);
}

function chart(): HTMLElement {
  const found = document.querySelector('[data-vex-area="portfolio-equity-chart"]');
  if (!(found instanceof HTMLElement)) throw new Error("missing the chart");
  return found;
}

beforeEach(() => {
  vi.clearAllMocks();
  answer(dto());
});

afterEach(() => {
  cleanup();
});

describe("EquityChart - what it reads", () => {
  it("opens on 30 d over the global read", () => {
    render(<EquityChart scope={{ kind: "global" }} />);
    expect(inputs().at(-1)).toEqual({ range: "30d", wallets: { scope: "global" } });
  });

  it.each([
    [{ kind: "wallet", wallet: WALLET } as const, { scope: "global", walletAddress: WALLET.address }],
    [{ kind: "session", sessionId: "s-1" } as const, { scope: "session", sessionId: "s-1" }],
    [{ kind: "project", projectId: "p-1" } as const, { scope: "project", projectId: "p-1" }],
  ])("reads the same wallets as the figures for %o", (scope, wallets) => {
    render(<EquityChart scope={scope} />);
    expect(inputs().at(-1)?.wallets).toEqual(wallets);
  });

  it("offers 24 h, 7 d, 30 d and All, and reads the range pressed", () => {
    render(<EquityChart scope={{ kind: "global" }} />);
    const group = screen.getByRole("group", { name: "History range" });
    expect(within(group).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "24 h",
      "7 d",
      "30 d",
      "All",
    ]);
    expect(within(group).getByRole("button", { name: "30 d" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(group).getByRole("button", { name: "24 h" }));
    expect(inputs().at(-1)?.range).toBe("24h");
    fireEvent.click(within(group).getByRole("button", { name: "All" }));
    expect(inputs().at(-1)?.range).toBe("all");
  });

  it("is headed Wallet total, never Equity (the page's Equity is Lighter's)", () => {
    render(<EquityChart scope={{ kind: "global" }} />);
    expect(within(chart()).getByRole("heading", { level: 2 }).textContent).toBe("Wallet total");
  });
});

describe("EquityChart - states in words", () => {
  it("loading, a refusal, no wallet and no cycle each say so, with no image", () => {
    mockUsePortfolioHistory.mockReturnValue({ isLoading: true, isError: false, data: undefined });
    const { unmount } = render(<EquityChart scope={{ kind: "global" }} />);
    expect(chart().textContent).toContain("Loading the history");
    unmount();

    mockUsePortfolioHistory.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        ok: false,
        error: {
          code: "internal.unexpected",
          domain: "system",
          message: "boom",
          retryable: false,
          userActionable: false,
          redacted: true,
          correlationId: "c-1",
        },
      },
    });
    render(<EquityChart scope={{ kind: "global" }} />);
    expect(chart().textContent).toContain("Couldn't load the history.");
    expect(chart().textContent).not.toContain("boom");
    cleanup();

    answer(dto({ walletCount: 0, groupCount: 0, points: [] }));
    render(<EquityChart scope={{ kind: "global" }} />);
    expect(chart().textContent).toContain("No wallets in this scope");
    cleanup();

    answer(dto({ points: [], groupCount: 0 }));
    render(<EquityChart scope={{ kind: "global" }} />);
    expect(chart().textContent).toContain("No complete snapshot in the last 30 days yet.");
    expect(screen.queryByRole("img")).toBeNull();
  });
});

describe("EquityChart - the drawing", () => {
  it("is an image named by its summary, with the line and no notes for a whole history", () => {
    render(<EquityChart scope={{ kind: "global" }} />);
    const image = screen.getByRole("img");
    expect(image.getAttribute("aria-label")).toMatch(/^Wallet total, 30 d: \$2,800\.00 on .+ to \$2,912\.75 on .+, 3 snapshots\.$/);
    expect(chart().querySelector(".vex-pf-chart__line")).not.toBeNull();
    expect(chart().querySelector("[data-vex-note]")).toBeNull();
  });

  it("draws a partial cycle as a hollow mark off the line and says why", () => {
    const history = dto();
    answer({
      ...history,
      points: history.points.map((p, index) => (index === 1 ? { ...p, totalUsd: 2600, partial: true } : p)),
    });
    render(<EquityChart scope={{ kind: "global" }} />);
    expect(chart().querySelectorAll('[data-vex-mark="partial"]')).toHaveLength(1);
    expect(chart().querySelector('[data-vex-note="partial"]')?.textContent).toContain(
      "A chain could not be read in one snapshot",
    );
  });

  it("says a thinned answer stands for more snapshots than it draws", () => {
    answer(dto({ sampled: true, groupCount: 8641 }));
    render(<EquityChart scope={{ kind: "global" }} />);
    expect(chart().querySelector('[data-vex-note="sampled"]')?.textContent).toBe(
      "3 of 8,641 snapshots, each the last of its interval.",
    );
  });
});
