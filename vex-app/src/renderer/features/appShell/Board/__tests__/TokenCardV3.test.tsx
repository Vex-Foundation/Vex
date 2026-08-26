/**
 * TOKEN CARD (v3) - every element the owner's mockup fixes, and the rules
 * that decide what fills them.
 *
 * THE PRESENCE TESTS ARE NOT CEREMONY. This card is the surface the owner
 * compares against a mockup pixel by pixel, and the failure mode of a
 * redesign is not a thrown error - it is an element that quietly stops being
 * rendered. So every anatomical part of the mockup has a row here: the 64px
 * photo, the name over the ticker over the chain mark, the hero price, the
 * signed delta and its literal "24h" window, the sparkline, the four stat
 * columns with their labels, the status chip, and both actions.
 *
 * THE CHIP PRECEDENCE TABLE is the real subject. A card can be both a new
 * pair and a pair with a settled safety verdict; the age chip wins the SLOT
 * (A11) while the verdict is still computed, still counted, and still named
 * in the accessible name - which is what stops a reader on assistive tech
 * from losing the fact that lost a layout contest.
 *
 * The composition is real: the actual icon hook over a real QueryClient
 * reading a stubbed `window.vex.boardIcons.read`, exactly as the board does.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { TokenCardV3 } from "../TokenCardV3.js";
import type { BoardCardModel } from "../boardModel.js";
import {
  boardSafetyVerdict,
  type BoardSafetyState,
} from "../board-surface-contracts.js";
import { hydratedRow } from "./boardFixture.js";

const readBoardIcon = vi.fn();

beforeEach(() => {
  readBoardIcon.mockReset();
  readBoardIcon.mockResolvedValue({
    ok: true,
    data: { iconId: "abcd1234", icon: { kind: "not_found" } },
  });
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: { boardIcons: { read: readBoardIcon } },
  });
});

afterEach(() => {
  cleanup();
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: undefined,
  });
});

function card(overrides: Partial<BoardCardModel> = {}): BoardCardModel {
  return {
    key: "solana:0xpool/0",
    chain: "solana",
    pairAddress: "0xpool",
    caption: null,
    row: hydratedRow({
      baseTokenSymbol: "UBERCAT",
      baseTokenName: "UBERCAT",
      priceUsd: "0.0001324",
      priceChange: { h1: "12", h24: "532.42" },
      liquidityUsd: "95200",
      volumeH24Usd: "521600",
      txns: { buys: 900, sells: 500 },
      pairAgeSeconds: 14_400,
    }),
    trendH1: "up",
    trendH24: "up",
    ...overrides,
  };
}

function mount(
  props: Partial<Parameters<typeof TokenCardV3>[0]> = {},
): ReactNode {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return (
    <QueryClientProvider client={client}>
      <TokenCardV3
        card={card()}
        verdict={boardSafetyVerdict("clear")}
        sparkline={{ status: "pending" }}
        selected={false}
        onSpotlight={() => undefined}
        onAsk={() => undefined}
        {...props}
      />
    </QueryClientProvider>
  );
}

function area(name: string): HTMLElement {
  const node = document.querySelector(`[data-vex-area="${name}"]`);
  if (node === null) throw new Error(`missing mockup element: ${name}`);
  return node as HTMLElement;
}

describe("TokenCardV3 - the mockup's anatomy", () => {
  it.each([
    ["board-token-photo"],
    ["board-token-name"],
    ["board-token-ticker"],
    ["board-token-chain"],
    ["board-token-price"],
    ["board-token-delta"],
    ["board-token-delta-window"],
    ["board-sparkline"],
    ["board-token-stats"],
    ["board-status-chip"],
    ["board-card-spotlight"],
    ["board-card-ask"],
  ])("renders %s", (name) => {
    render(mount());
    expect(area(name)).toBeTruthy();
  });

  it("prints the figures the mockup prints", () => {
    render(mount());
    expect(area("board-token-name").textContent).toBe("UBERCAT");
    expect(area("board-token-price").textContent).toBe("$0.0001324");
    expect(area("board-token-delta").textContent).toBe("+532.42%");
    // The window is printed BESIDE the figure, not left to a legend: without
    // it, "+532.42%" can be read as a lifetime move.
    expect(area("board-token-delta-window").textContent).toBe("24h");
  });

  it("labels all four stat columns, label ABOVE value", () => {
    render(mount());
    const stats = area("board-token-stats");
    const labels = [...stats.querySelectorAll("dt")].map((dt) => dt.textContent);
    expect(labels).toEqual(["Liquidity", "24h Volume", "Trades", "Pair age"]);
    const values = [...stats.querySelectorAll("dd")].map((dd) => dd.textContent);
    // Trades is the SUM of both sides: the split belongs to the spotlight, at
    // a size that can carry it.
    expect(values).toEqual(["$95.2K", "$521.6K", "1.4K", "4h"]);
  });

  it("gives the chain a real mark plus a screen-reader name, never a text badge", () => {
    render(mount());
    const chain = area("board-token-chain");
    expect(chain.querySelector("svg, img, span[aria-hidden]")).not.toBeNull();
    expect(within(chain).getByText("solana")).toBeTruthy();
  });

  it("draws the monogram when the token has no artwork", () => {
    render(mount());
    expect(area("board-token-photo").getAttribute("data-state")).toBe("monogram");
    expect(area("board-token-photo").textContent).toBe("UB");
  });
});

describe("TokenCardV3 - chip precedence", () => {
  /**
   * Rows: the pair's age, the classifier's state, and what the ONE chip slot
   * must show. A pair under 24 hours old takes the slot in every row,
   * whatever the verdict says.
   */
  const ROWS: readonly (readonly [number | null, BoardSafetyState, string, string])[] = [
    [14_400, "clear", "new-pair", "caution"],
    [14_400, "flagged", "new-pair", "caution"],
    [14_400, "pending", "new-pair", "caution"],
    [86_400, "clear", "safety", "positive"],
    [259_200, "clear", "safety", "positive"],
    [259_200, "flagged", "safety", "danger"],
    [259_200, "conflict", "safety", "caution"],
    [259_200, "identity-mismatch", "safety", "caution"],
    [259_200, "unverified", "safety", "caution"],
    [259_200, "incomplete", "safety", "caution"],
    [259_200, "not-indexed", "safety", "neutral"],
    [259_200, "unavailable", "safety", "neutral"],
    [259_200, "stale", "safety", "neutral"],
    [259_200, "pending", "safety", "pending"],
    // A pair with no reported age cannot be shown as new: absence is not youth.
    [null, "clear", "safety", "positive"],
  ];

  it.each(ROWS)(
    "age %s + %s shows the %s chip in tone %s",
    (age, state, chip, tone) => {
      render(
        mount({
          card: card({ row: hydratedRow({ pairAgeSeconds: age }) }),
          verdict: boardSafetyVerdict(state),
        }),
      );
      const node = area("board-status-chip");
      expect(node.getAttribute("data-chip")).toBe(chip);
      expect(node.getAttribute("data-tone")).toBe(tone);
      // THE VERDICT IS NEVER LOST. Even when the age chip takes the slot, the
      // state travels on the element and into the accessible name below.
      expect(node.getAttribute("data-safety-state")).toBe(state);
    },
  );

  it("names BOTH facts in the card's accessible name when age wins the slot", () => {
    render(
      mount({
        card: card({ row: hydratedRow({ pairAgeSeconds: 3_600 }) }),
        verdict: boardSafetyVerdict("flagged"),
      }),
    );
    const label = area("board-token-card-v3").getAttribute("aria-label") ?? "";
    expect(label).toContain("New pair");
    expect(label).toContain("High risk");
  });

  it("shows exactly ONE chip", () => {
    render(mount());
    expect(
      document.querySelectorAll('[data-vex-area="board-status-chip"]'),
    ).toHaveLength(1);
  });
});

describe("TokenCardV3 - equal cards and designed data states", () => {
  it("pins the height of every section so cards cannot disagree", () => {
    render(mount());
    // Fixed heights, not content-driven ones: this is what makes a grid of
    // cards line up regardless of name length, missing artwork or absent bars.
    expect(area("board-token-card-v3").className).toContain("h-full");
    expect(area("board-token-stats").className).toContain("h-[46px]");
    expect(area("board-token-name").className).toContain("truncate");
  });

  it("renders every element for an UNHYDRATED pool, with dashes not gaps", () => {
    render(mount({ card: card({ row: null }) }));
    expect(area("board-token-card-v3").getAttribute("data-state")).toBe("unhydrated");
    expect(area("board-token-photo")).toBeTruthy();
    expect(area("board-sparkline")).toBeTruthy();
    const values = [...area("board-token-stats").querySelectorAll("dd")].map(
      (dd) => dd.textContent,
    );
    expect(values).toEqual(["-", "-", "-", "-"]);
  });

  it("renders every element for a row whose price the provider did not report", () => {
    render(mount({ card: card({ row: hydratedRow({ priceUsd: null }) }) }));
    expect(area("board-token-card-v3").getAttribute("data-state")).toBe("partial");
    expect(area("board-token-price").textContent).toBe("-");
  });
});

describe("TokenCardV3 - actions", () => {
  it("makes Spotlight a BUTTON with a pressed state, not a switch", () => {
    render(mount({ selected: true }));
    const button = area("board-card-spotlight");
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("role")).toBeNull();
    expect(button.getAttribute("aria-pressed")).toBe("true");
  });

  it("calls its handlers, and names the token in both labels", () => {
    const onSpotlight = vi.fn();
    const onAsk = vi.fn();
    render(mount({ onSpotlight, onAsk }));
    screen.getByRole("button", { name: "Spotlight UBERCAT" }).click();
    screen.getByRole("button", { name: "Ask VEX about UBERCAT" }).click();
    expect(onSpotlight).toHaveBeenCalledTimes(1);
    expect(onAsk).toHaveBeenCalledTimes(1);
  });

  it("keeps both actions in the tab order with a visible focus ring", () => {
    render(mount());
    for (const name of ["board-card-spotlight", "board-card-ask"]) {
      const node = area(name);
      // No hover-only affordance: a hover-revealed primary action is
      // unreachable by keyboard and by touch.
      expect(node.className).not.toContain("opacity-0");
      expect(node.className).toContain("focus-visible:ring");
    }
  });
});
