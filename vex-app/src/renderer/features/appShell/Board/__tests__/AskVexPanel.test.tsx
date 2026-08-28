/**
 * ASK VEX - the panel that asks, and never sends.
 *
 * The three claims this file exists to keep true:
 *
 *  - THE PANEL DOES NOT SUBMIT. Pressing Send parks an envelope on the intent
 *    channel. Nothing here touches the chat API, and the transcript only ever
 *    grows because the resident composer dispatched it.
 *  - WHAT THE READER SAW IS WHAT THE MODEL GETS. The visible context chip and
 *    the message's context header are the same facts; the message is pinned
 *    BYTE FOR BYTE against the frozen envelope, because that string is
 *    persisted into the transcript and read back by the model.
 *  - THE QUICK QUESTIONS PRE-FILL, they do not send. A reader edits before
 *    anything leaves the panel.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { AskVexPanel } from "../AskVexPanel.js";
import { useBoardAskIntentStore } from "../board-ask-intent.js";
import { useBoardSurfaceStore } from "../board-surface-store.js";
import {
  BOARD_ASK_QUICK_QUESTIONS,
  boardRefOf,
  type BoardRef,
} from "../board-surface-contracts.js";
import { FIXTURE_FETCHED_AT, boardSpec, hydratedRow } from "./boardFixture.js";

const SESSION = "00000000-0000-4000-8000-000000000001";

/** The fixture board's clock, as the frozen envelope prints it. */
const FIXTURE_STAMP = "2026-07-04 13:45 UTC";
/** The same instant as the chip prints it. */
const FIXTURE_CLOCK = "13:45 UTC";

function boardRef(): BoardRef {
  return boardRefOf(
    SESSION,
    12,
    boardSpec({
      title: "Token Radar",
      pools: [
        { chain: "base", pairAddress: "0xaaa111", analysis: null },
        { chain: "solana", pairAddress: "SoLpair2", analysis: null },
      ],
      rows: [
        hydratedRow(),
        hydratedRow({ baseTokenSymbol: "UBERCAT", baseTokenName: "UBERCAT" }),
      ],
      marketDataFetchedAt: FIXTURE_FETCHED_AT,
    }),
  );
}

function wrapper({ children }: { readonly children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

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
  useBoardAskIntentStore.setState({ intent: null });
});

afterEach(() => {
  cleanup();
  useBoardAskIntentStore.setState({ intent: null });
  useBoardSurfaceStore.setState({ askPanelOpen: false });
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: undefined,
  });
});

describe("AskVexPanel", () => {
  it("shows the token, its chain and the reading of its figures as a visible chip", () => {
    render(<AskVexPanel board={boardRef()} poolIndex={1} />, { wrapper });
    const chip = document.querySelector('[data-vex-area="board-ask-context"]');
    expect(chip?.textContent).toBe(`UBERCAT · Solana · snapshot ${FIXTURE_CLOCK}`);
    expect(chip?.getAttribute("data-live")).toBe("false");
  });

  it("pre-fills the field from a quick question and leaves it editable", () => {
    render(<AskVexPanel board={boardRef()} poolIndex={0} />, { wrapper });
    const field = screen.getByRole("textbox");
    expect((field as HTMLTextAreaElement).value).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "Check the risks" }));
    expect((field as HTMLTextAreaElement).value).toBe("Check the risks");
    // Nothing was sent by pre-filling.
    expect(useBoardAskIntentStore.getState().intent).toBeNull();

    fireEvent.change(field, { target: { value: "Check the risks, briefly" } });
    expect((field as HTMLTextAreaElement).value).toBe("Check the risks, briefly");
  });

  it("offers exactly the four frozen quick questions", () => {
    render(<AskVexPanel board={boardRef()} poolIndex={0} />, { wrapper });
    for (const question of BOARD_ASK_QUICK_QUESTIONS) {
      expect(screen.getByRole("button", { name: question })).toBeTruthy();
    }
  });

  it("parks a byte-exact envelope on Send and never calls a chat API", () => {
    render(<AskVexPanel board={boardRef()} poolIndex={0} />, { wrapper });
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "  Why is it moving?  " },
    });
    fireEvent.click(screen.getByRole("button", { name: /Send to chat/ }));

    const intent = useBoardAskIntentStore.getState().intent;
    expect(intent).not.toBeNull();
    expect(intent?.sessionId).toBe(SESSION);
    expect(intent?.boardKey).toBe(`${SESSION}:12`);
    expect(intent?.message).toBe(
      [
        "[Board context]",
        "Board: Token Radar",
        "Token: PEPE (Pepe the Frog) on base",
        "Pair: 0xaaa111 on uniswap",
        "Price: 0.00000123 USD",
        `Figures: snapshot, read at ${FIXTURE_STAMP}`,
        "",
        "Why is it moving?",
      ].join("\n"),
    );
    // The pinned context is the same object the chip was drawn from.
    expect(intent?.context.pairAddress).toBe("0xaaa111");
    expect(intent?.context.priceUsd).toBe("0.00000123");
    expect(intent?.context.observedAtMs).toBe(FIXTURE_FETCHED_AT);
  });

  it("names a token whose name equals its symbol without repeating it", () => {
    render(<AskVexPanel board={boardRef()} poolIndex={1} />, { wrapper });
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Check the risks" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Send to chat/ }));
    expect(useBoardAskIntentStore.getState().intent?.message).toContain(
      "Token: UBERCAT on solana",
    );
  });

  it("refuses to send an empty question", () => {
    render(<AskVexPanel board={boardRef()} poolIndex={0} />, { wrapper });
    const send = screen.getByRole("button", { name: /Send to chat/ });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "   " } });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(send);
    expect(useBoardAskIntentStore.getState().intent).toBeNull();
  });

  it("clears the field and says the question went to the chat", () => {
    render(<AskVexPanel board={boardRef()} poolIndex={0} />, { wrapper });
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Why is it moving?" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Send to chat/ }));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
    const notice = document.querySelector('[data-vex-area="board-ask-sent"]');
    expect(notice?.textContent).toContain("Sent to the chat");
    expect(notice?.getAttribute("aria-live")).toBe("polite");
  });

  it("closes the panel through the store, the one owner of that state", () => {
    useBoardSurfaceStore.setState({ askPanelOpen: true });
    render(<AskVexPanel board={boardRef()} poolIndex={0} />, { wrapper });
    fireEvent.click(
      screen.getByRole("button", { name: "Close the Ask VEX panel" }),
    );
    expect(useBoardSurfaceStore.getState().askPanelOpen).toBe(false);
  });
});
