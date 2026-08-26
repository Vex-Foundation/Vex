/**
 * TokenCard - the logo slot's two states, and the third one it used to miss.
 *
 * Main validates icon bytes WITHOUT decoding them: it reads magic bytes and
 * header dimensions, because no image codec ships with Vex. A truthful PNG
 * header followed by a corrupt or truncated body therefore passes every check
 * main can make and still fails in the renderer. The card had no `onError`, so
 * that landed as a broken-image glyph inside a slot that already carries a
 * designed state for "no picture".
 *
 * The composition is real: the actual hook, over a real QueryClient, reading a
 * stubbed `window.vex.boardIcons.read` exactly as the board does. jsdom never
 * decodes an image, so the `error` event is dispatched on the real element
 * rather than waited for - the subject is the card's handling of that event,
 * not a browser decoder.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

import { TokenCard } from "../TokenCard.js";
import type { BoardCardModel } from "../boardModel.js";
import { hydratedRow } from "./boardFixture.js";

const ICON_ID = "abcd1234";

/**
 * A `data:` URL of the shape the IPC contract admits, whose base64 body is NOT
 * a decodable PNG. Precisely the case main cannot catch and the renderer must.
 */
const UNDECODABLE_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

const readBoardIcon = vi.fn();

beforeEach(() => {
  readBoardIcon.mockReset();
  readBoardIcon.mockResolvedValue({
    ok: true,
    data: {
      iconId: ICON_ID,
      icon: { kind: "image", dataUrl: UNDECODABLE_DATA_URL },
    },
  });
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: { boardIcons: { read: readBoardIcon } },
  });
});

afterEach(() => {
  cleanup();
  // @ts-expect-error - test cleanup
  delete window.vex;
});

function withQuery(ui: ReactNode): ReactNode {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return createElement(QueryClientProvider, { client }, ui);
}

function card(): BoardCardModel {
  return {
    key: "base:0xpool",
    chain: "base",
    pairAddress: "0xpool",
    caption: null,
    row: hydratedRow({ iconId: ICON_ID }),
    trendH1: "down",
    trendH24: "up",
  };
}

/** The logo slot, or a named failure rather than a null dereference. */
function logoSlot(container: HTMLElement): HTMLElement {
  const el = container.querySelector('[data-vex-area="board-token-logo"]');
  if (!(el instanceof HTMLElement)) throw new Error("logo slot not found");
  return el;
}

function renderCard(): HTMLElement {
  const { container } = render(
    withQuery(createElement(TokenCard, { card: card(), stale: false })),
  );
  return container;
}

describe("TokenCard logo slot", () => {
  it("draws the image main returned", async () => {
    const container = renderCard();
    await waitFor(() => {
      expect(logoSlot(container).getAttribute("data-state")).toBe("image");
    });
  });

  it("falls back to the designed monogram when the bytes will not decode", async () => {
    const container = renderCard();
    await waitFor(() => {
      expect(logoSlot(container).getAttribute("data-state")).toBe("image");
    });

    fireEvent.error(logoSlot(container));

    const fallback = logoSlot(container);
    expect(fallback.getAttribute("data-state")).toBe("monogram");
    // The card's OWN placeholder, not a second one invented for this path:
    // the symbol's monogram, which is what most cards on a board wear.
    expect(fallback.textContent).toBe("PE");
  });
});
