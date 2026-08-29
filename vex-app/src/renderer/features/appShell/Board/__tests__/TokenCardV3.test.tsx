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
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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
    data: { iconId: "abcd1234", icon: { kind: "absent", reason: "not_found" } },
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

  it("draws a ONE-letter monogram once the icon read settled absent", async () => {
    render(mount({ card: card({ row: hydratedRow({ iconId: "abcd1234", baseTokenSymbol: "UBERCAT" }) }) }));
    // `not_found` is the scripted answer, so the read settles absent: the
    // slot moves from its skeleton to the monogram.
    await waitFor(() => {
      expect(area("board-token-photo").getAttribute("data-state")).toBe("monogram");
    });
    // ONE letter, the market provider's own treatment, never two.
    expect(area("board-token-photo").textContent).toBe("U");
  });

  it("shows a skeleton, not letters, while the icon read is in flight", () => {
    readBoardIcon.mockReturnValue(new Promise(() => undefined));
    render(mount({ card: card({ row: hydratedRow({ iconId: "abcd1234", baseTokenSymbol: "UBERCAT" }) }) }));
    const photo = area("board-token-photo");
    expect(photo.getAttribute("data-state")).toBe("loading");
    expect(photo.textContent).toBe("");
  });

  it("draws the monogram at once, with no read, when the pool has no artwork handle", () => {
    render(mount({ card: card({ row: hydratedRow({ iconId: null }) }) }));
    expect(area("board-token-photo").getAttribute("data-state")).toBe("monogram");
    expect(readBoardIcon).not.toHaveBeenCalled();
  });

  /**
   * THE PHOTO SLOT'S FIVE STATES. Two rows carry the whole point. A read that
   * failed for a transport-class reason, or a query that threw, must not settle
   * to letters, because the monogram's note ("no image published") is a claim
   * about the token that only the provider can make. And a read the app REFUSED
   * (`refused_by_policy`) must settle to neither: the provider did publish
   * artwork, so "no image published" is false, and the verdict is deterministic
   * for those bytes, so "could not be loaded" invites a retry that will fetch
   * the same refusal. Rows: what the icon bridge answers, the `data-state` the
   * slot must carry, the text it may show, and which of the three notes
   * (absence / refusal / unavailable) is announced.
   */
  describe.each<{
    readonly label: string;
    readonly answer: () => unknown;
    readonly state: string;
    readonly letters: string;
    readonly absenceNote: boolean;
    readonly refusedNote: boolean;
    readonly unavailableNote: boolean;
  }>([
    {
      label: "in flight",
      answer: () => new Promise(() => undefined),
      state: "loading",
      letters: "",
      absenceNote: false,
      refusedNote: false,
      unavailableNote: false,
    },
    {
      label: "image",
      answer: () =>
        Promise.resolve({
          ok: true,
          data: { iconId: "abcd1234", icon: { kind: "image", dataUrl: "data:image/png;base64,AAAA" } },
        }),
      state: "image",
      letters: "",
      absenceNote: false,
      refusedNote: false,
      unavailableNote: false,
    },
    {
      label: "absent (provider 404)",
      answer: () =>
        Promise.resolve({
          ok: true,
          data: { iconId: "abcd1234", icon: { kind: "absent", reason: "not_found" } },
        }),
      state: "monogram",
      letters: "U",
      absenceNote: true,
      refusedNote: false,
      unavailableNote: false,
    },
    {
      label: "unavailable (transport)",
      answer: () =>
        Promise.resolve({
          ok: true,
          data: { iconId: "abcd1234", icon: { kind: "unavailable", reason: "transport" } },
        }),
      state: "unavailable",
      letters: "",
      absenceNote: false,
      refusedNote: false,
      unavailableNote: true,
    },
    {
      label: "refused by policy (bytes are not an image this app can identify)",
      answer: () =>
        Promise.resolve({
          ok: true,
          data: {
            iconId: "abcd1234",
            icon: { kind: "refused_by_policy", reason: "unsupported_image" },
          },
        }),
      state: "refused",
      letters: "",
      absenceNote: false,
      refusedNote: true,
      unavailableNote: false,
    },
    {
      label: "refused by policy (body past the byte ceiling)",
      answer: () =>
        Promise.resolve({
          ok: true,
          data: { iconId: "abcd1234", icon: { kind: "refused_by_policy", reason: "over_cap" } },
        }),
      state: "refused",
      letters: "",
      absenceNote: false,
      refusedNote: true,
      unavailableNote: false,
    },
    {
      label: "Result error (input or sender rejected)",
      answer: () =>
        Promise.resolve({
          ok: false,
          error: {
            code: "validation.invalid_input",
            domain: "data",
            message: "Not a board token icon id.",
            retryable: false,
            userActionable: false,
            redacted: true,
            correlationId: "00000000-0000-4000-8000-0000000000ff",
          },
        }),
      state: "unavailable",
      letters: "",
      absenceNote: false,
      refusedNote: false,
      unavailableNote: true,
    },
    {
      label: "query threw",
      answer: () => Promise.reject(new Error("bridge missing")),
      state: "unavailable",
      letters: "",
      absenceNote: false,
      refusedNote: false,
      unavailableNote: true,
    },
  ])(
    "photo slot - $label",
    ({ answer, state, letters, absenceNote, refusedNote, unavailableNote }) => {
    it(`settles to data-state=${state}`, async () => {
      readBoardIcon.mockImplementation(answer);
      render(
        mount({ card: card({ row: hydratedRow({ iconId: "abcd1234", baseTokenSymbol: "UBERCAT" }) }) }),
      );
      await waitFor(() => {
        expect(area("board-token-photo").getAttribute("data-state")).toBe(state);
      });
      const photo = area("board-token-photo");
      expect(photo.textContent).toBe(letters);
      expect(photo.className).not.toMatch(/\bborder\b|ring-/);
      // The absence note is the provider's claim; the unavailable note is
      // ours. Exactly the announced one is present, never both.
      expect(document.querySelector('[data-vex-area="board-token-photo-absence"]') !== null).toBe(
        absenceNote,
      );
      expect(
        document.querySelector('[data-vex-area="board-token-photo-unavailable"]') !== null,
      ).toBe(unavailableNote);
      // The THIRD note, and the reason the class exists: published artwork the
      // app declined is neither an absence nor an unknown.
      expect(
        document.querySelector('[data-vex-area="board-token-photo-refused"]') !== null,
      ).toBe(refusedNote);
      if (unavailableNote) {
        expect(photo.getAttribute("title")).toBe("Image could not be loaded");
        expect(document.body.textContent).not.toContain("No image published");
      }
      if (absenceNote) {
        expect(photo.getAttribute("title")).toBe("No image published for this token yet");
      }
      if (refusedNote) {
        expect(photo.getAttribute("title")).toBe(
          "Published image was not accepted by Vex's image checks",
        );
        // NEITHER of the two wrong claims is anywhere on the surface.
        expect(document.body.textContent).not.toContain("No image published");
        expect(document.body.textContent).not.toContain("could not be loaded");
      }
      },
    );
  },
  );

  it("puts no ring on any photo state", async () => {
    render(mount());
    await waitFor(() => {
      expect(area("board-token-photo").getAttribute("data-state")).toBe("monogram");
    });
    expect(area("board-token-photo").className).not.toMatch(/\bborder\b|ring-/);
  });

  it("renders the chain mark with no circle and no ring", () => {
    render(mount());
    const chain = area("board-token-chain");
    expect(chain.querySelector("circle")).toBeNull();
    expect(chain.querySelector(".rounded-full")).toBeNull();
    expect(chain.innerHTML).not.toContain("border");
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

  it("carries its tone as data and its whole label as a title", () => {
    // The chip's CONTRACT is the tone it reports, not the utility classes the
    // design composes (the file's own rule); the title keeps the whole label
    // reachable on a card narrow enough to clamp it.
    render(mount({ verdict: boardSafetyVerdict("flagged"), card: card({ row: hydratedRow({ pairAgeSeconds: 259_200 }) }) }));
    const chip = area("board-status-chip");
    expect(chip.getAttribute("data-tone")).toBe("danger");
    expect(chip.getAttribute("title")).toBe("High risk");
    expect(chip.querySelector("svg")).not.toBeNull();
  });
});

describe("TokenCardV3 - equal cards and designed data states", () => {
  it("pins the height of every section so cards cannot disagree", () => {
    render(mount());
    // Fixed heights, not content-driven ones: this is what makes a grid of
    // cards line up regardless of name length, missing artwork or absent bars.
    // The stat block's height is now PER MODE and therefore CSS's
    // (`vex-board-card-stats` in global-css/board-layout.css, 46px wide /
    // 92px compact); what this file still owns is that the card carries the
    // class at all, so the mode has something to act on. The heights
    // themselves are proven where they are observable, in
    // `e2e/board-layout.spec.ts`.
    expect(area("board-token-card-v3").className).toContain("h-full");
    expect(area("board-token-card-v3").className).toContain("w-full");
    expect(area("board-token-stats").className).toContain(
      "vex-board-card-stats",
    );
    expect(area("board-token-footer").className).toContain(
      "vex-board-card-footer",
    );
    // THE NAME KEEPS ITS ELLIPSIS, and this pin stays deliberate: a token
    // name is prose, it is the one string on the card that may be clamped,
    // and the whole of it is still in the `title`, in the card's accessible
    // name and in the full-value disclosure.
    expect(area("board-token-name").className).toContain("truncate");
    expect(area("board-token-name").getAttribute("title")).toBe("UBERCAT");
  });

  it("clamps no figure, stat label or chip label", () => {
    render(mount());
    // The counterpart of the pin above. Everything that is not the name is a
    // figure or a fixed piece of product copy, and the mode floors in
    // `board-layout.css` are sized so each one fits whole; an ellipsis here
    // would be a silent cut with no recovery in the layout.
    const stats = area("board-token-stats");
    for (const cell of [...stats.querySelectorAll("dt, dd")]) {
      expect(cell.className).not.toContain("truncate");
      expect(cell.className).toContain("whitespace-nowrap");
    }
    const chipLabel = area("board-status-chip").querySelector("span");
    expect(chipLabel?.className).not.toContain("truncate");
  });

  it("keeps the sparkline in BOTH anatomies rather than dropping it", () => {
    render(mount());
    // Compact mode moves the line, it never deletes it. Both slots are in the
    // DOM and CSS shows exactly one; a reader on a narrow card still gets the
    // shape of the last 24 hours.
    expect(area("board-token-sparkline-inline")).toBeTruthy();
    expect(area("board-token-sparkline-slot")).toBeTruthy();
    expect(
      document.querySelectorAll('[data-vex-area="board-sparkline"]'),
    ).toHaveLength(2);
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

describe("TokenCardV3 - the live tick", () => {
  function rerenderWith(view: ReturnType<typeof render>, price: string, change: string, live: boolean): void {
    view.rerender(
      mount({
        live,
        card: card({ row: hydratedRow({ priceUsd: price, priceChange: { h1: "1", h24: change } }) }),
      }),
    );
  }

  it("stamps the price row on a live change and not on an unchanged rerender", () => {
    const view = render(mount({ live: true }));
    const row = () => area("board-token-price-row");
    expect(row().hasAttribute("data-tick")).toBe(false);

    rerenderWith(view, "0.0001324", "532.42", true);
    expect(row().hasAttribute("data-tick")).toBe(false);

    rerenderWith(view, "0.0001400", "532.42", true);
    const first = row().getAttribute("data-tick");
    expect(first).not.toBeNull();

    rerenderWith(view, "0.0001400", "532.42", true);
    expect(row().getAttribute("data-tick")).toBe(first);

    rerenderWith(view, "0.0001400", "540.00", true);
    expect(row().getAttribute("data-tick")).not.toBe(first);
  });

  it("never ticks a snapshot board", () => {
    const view = render(mount({ live: false }));
    rerenderWith(view, "0.0009999", "1", false);
    expect(area("board-token-price-row").hasAttribute("data-tick")).toBe(false);
  });
});

describe("TokenCardV3 - actions", () => {
  it("makes Spotlight a BUTTON with a pressed state and the fullscreen glyph, not a switch", () => {
    render(mount({ selected: true }));
    const button = area("board-card-spotlight");
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("role")).toBeNull();
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.querySelector("svg")).not.toBeNull();
    expect(button.textContent).toContain("Spotlight");
    // The pressed state is the accent wash, never a solid accent fill.
    expect(button.className).toContain("bg-accent-wash");
    expect(button.className).not.toContain("bg-accent-primary");
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


/**
 * THE FULL-VALUE DISCLOSURE.
 *
 * The card clamps by necessity - the formatters round every price, the name
 * ellipsizes, and a 512-character symbol is schema-valid - and until this
 * control existed the only way back to the whole string was a `title`, which
 * a keyboard reader and a touch reader never reach.
 *
 * WHAT THIS FILE PROVES AND WHAT IT DOES NOT. jsdom does not synthesize a
 * click from a keypress, so "Enter opens it" cannot be an honest assertion
 * here; the browser does that natively and only for real buttons, so what is
 * asserted below is the semantics that EARN the native behaviour, plus the
 * focus contract, which is real DOM state. The Enter press itself is driven
 * against a real engine in `e2e/board-layout.spec.ts`.
 */
describe("TokenCardV3 - the full-value disclosure", () => {
  const RAW_PRICE = "1234567890123456789012345678901234.5678";

  function openPanel(): HTMLElement {
    const trigger = area("board-token-full-value");
    fireEvent.click(trigger);
    return trigger;
  }

  it("is a real button, which is what makes Enter and Space work natively", () => {
    render(mount());
    const trigger = area("board-token-full-value");
    // `<button type="button">`, not a `div` with `role="button"`: the native
    // element is what activates on BOTH keys with no handler of ours, and
    // what keeps it in the tab order with no `tabindex` of ours.
    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger.getAttribute("type")).toBe("button");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.getAttribute("aria-label")).toContain("UBERCAT");
  });

  it("shows the WHOLE provider string the hero price rounded away", () => {
    render(
      mount({ card: card({ row: hydratedRow({ priceUsd: RAW_PRICE }) }) }),
    );
    openPanel();
    const popover = area("board-token-full-value-popover");
    // The panel's ROLE is asserted where it is the subject, in "is a labelled
    // disclosure and claims no modality it does not have" below. It is a
    // `group`, not a `dialog`: an INTENTIONAL contract change, because
    // `aria-modal` promised an inertness this overlay never had.
    expect(area("board-token-full-value").getAttribute("aria-expanded")).toBe(
      "true",
    );
    // The 40-character decimal, entire. This is the whole point: the hero row
    // shows `$1234567890123456789012345678901234.56` and every digit the
    // formatter dropped is here rather than lost.
    expect(popover.textContent).toContain(RAW_PRICE);
  });

  it("carries the whole name and ticker, which the identity row clamps", () => {
    const symbol = "X".repeat(512);
    render(
      mount({
        card: card({
          row: hydratedRow({ baseTokenSymbol: symbol, baseTokenName: symbol }),
        }),
      }),
    );
    openPanel();
    expect(area("board-token-full-value-popover").textContent).toContain(
      symbol,
    );
  });

  it("gives the panel initial focus, so a keyboard reader lands inside it", async () => {
    render(mount());
    openPanel();
    await waitFor(() => {
      expect(document.activeElement).toBe(area("board-token-full-value-close"));
    });
  });

  it("closes on Escape and restores focus to the trigger", async () => {
    render(mount());
    const trigger = openPanel();
    await waitFor(() => {
      expect(document.activeElement).toBe(area("board-token-full-value-close"));
    });

    fireEvent.keyDown(area("board-token-full-value-popover"), {
      key: "Escape",
    });
    expect(
      document.querySelector('[data-vex-area="board-token-full-value-popover"]'),
    ).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("does not let its own Escape close the board behind it", () => {
    // The board modal is a native `<dialog>` listening for the same key. An
    // Escape that propagated would take the whole board down with it, which
    // is a reader losing their place to a control they opened to read one
    // number.
    const onBoardEscape = vi.fn();
    render(
      <div
        onKeyDown={(event) => {
          if (event.key === "Escape") onBoardEscape();
        }}
      >
        {mount()}
      </div>,
    );
    openPanel();
    fireEvent.keyDown(area("board-token-full-value-popover"), {
      key: "Escape",
    });
    expect(onBoardEscape).not.toHaveBeenCalled();
  });

  it("is a labelled disclosure and claims no modality it does not have", () => {
    // `role="dialog"` WITH `aria-modal="true"` WAS A LIE. Nothing outside this
    // panel was ever inert: a pointer reached every other card while it was
    // open, and two of them could be "modal" at once. A promise the code does
    // not keep is worse than no promise, so the panel is what it is - a group
    // a button expands - and the trigger carries the whole relationship.
    render(mount());
    const trigger = area("board-token-full-value");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    const controls = trigger.getAttribute("aria-controls");
    expect(controls).not.toBeNull();

    openPanel();
    const panel = area("board-token-full-value-popover");
    expect(panel.getAttribute("role")).toBe("group");
    expect(panel.hasAttribute("aria-modal")).toBe(false);
    expect(panel.getAttribute("id")).toBe(controls);
    expect(panel.getAttribute("aria-label")).toContain("UBERCAT");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  it("takes every covered control out of the tab order while open", () => {
    // THE PANEL IS OPAQUE AND COVERS THE WHOLE CARD, so a control underneath
    // it cannot be seen - and a Tab that lands there puts focus somewhere
    // invisible, which rule 08 forbids ("focus is visible and not obscured").
    // Withdrawing them is the CARD's job, because the card owns them.
    //
    // `tabIndex={-1}` and NOT `inert`: `inert` removes the subtree from the
    // accessibility tree along with the trigger's own `aria-expanded`, so the
    // panel would be open with nothing able to report that it was.
    render(mount());
    const covered = [
      "board-token-full-value",
      "board-card-spotlight",
      "board-token-dexscreener-link",
      "board-card-ask",
    ];
    for (const name of covered) {
      expect(area(name).hasAttribute("tabindex")).toBe(false);
    }

    openPanel();
    for (const name of covered) {
      expect(area(name).getAttribute("tabindex")).toBe("-1");
      // STILL IN THE TREE, which is the entire reason this is not `inert`:
      // each one keeps its accessible name, and the trigger keeps its state.
      expect(area(name).getAttribute("aria-label")).not.toBeNull();
    }
    expect(area("board-token-full-value").getAttribute("aria-expanded")).toBe(
      "true",
    );
    // The panel's own control keeps its natural place in the order.
    expect(area("board-token-full-value-close").hasAttribute("tabindex")).toBe(
      false,
    );

    // It reverts with the state flip, in the same commit that removes the
    // panel, and the trigger still takes focus back although it was
    // `tabIndex={-1}` at the moment it was asked to.
    fireEvent.keyDown(area("board-token-full-value-popover"), {
      key: "Escape",
    });
    for (const name of covered) {
      expect(area(name).hasAttribute("tabindex")).toBe(false);
    }
    expect(document.activeElement).toBe(area("board-token-full-value"));
  });

  it("does not trap Tab, because a non-modal surface must not", () => {
    // The counterpart of the assertion above. A trap on a surface that is not
    // modal steals a key the rest of the page is entitled to; the browser's
    // own sequence is the correct behaviour, and the E2E measures where it
    // actually lands.
    render(mount());
    openPanel();
    const panel = area("board-token-full-value-popover");
    for (const shiftKey of [false, true]) {
      expect(
        fireEvent.keyDown(document.activeElement ?? panel, {
          key: "Tab",
          shiftKey,
          cancelable: true,
        }),
      ).toBe(true);
    }
  });

  it("says the values are shortened only when the card shortened one", () => {
    // NAMED, NOT GENERIC. On a card that cut nothing the plain label is the
    // truth; on one that did, "Show the full values" would leave a reader
    // believing the figure in front of them is the figure.
    render(mount());
    expect(
      area("board-token-full-value").getAttribute("aria-label"),
    ).not.toMatch(/shortened/i);
    expect(area("board-token-full-value").hasAttribute("data-shortened")).toBe(
      false,
    );

    cleanup();
    render(
      mount({
        card: card({
          row: hydratedRow({
            priceUsd: RAW_PRICE,
            baseTokenSymbol: "X".repeat(512),
          }),
        }),
      }),
    );
    const trigger = area("board-token-full-value");
    expect(trigger.getAttribute("aria-label")).toMatch(/shortened/i);
    expect(trigger.getAttribute("data-shortened")).toBe("true");
    // The cut is marked where it happened, not only on the affordance.
    expect(area("board-token-price").getAttribute("data-shortened")).toBe(
      "true",
    );
    expect(area("board-token-ticker").getAttribute("data-shortened")).toBe(
      "true",
    );
    // And the panel repeats it visibly, above the whole values.
    fireEvent.click(trigger);
    expect(area("board-token-full-value-notice").textContent).toMatch(
      /shortened/i,
    );
  });

  it("closes on its own close button too, and restores focus", async () => {
    render(mount());
    const trigger = openPanel();
    await waitFor(() => {
      expect(document.activeElement).toBe(area("board-token-full-value-close"));
    });
    fireEvent.click(area("board-token-full-value-close"));
    expect(
      document.querySelector('[data-vex-area="board-token-full-value-popover"]'),
    ).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
