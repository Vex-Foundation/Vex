/**
 * WHO SCROLLS, AND WHO IS THE READING COLUMN (standalone mount) - the two must not be the same
 * element.
 *
 * The transcript's scroller used to BE the reading column, so the browser
 * drew its scrollbar at the column's right edge: a bar floating in the middle
 * of the window beside the text, which is not how any browser behaves and is
 * not what a reader reaches for (owner, 2026-08-05). The fix is structural, not
 * a custom widget: the SCROLLER spans the whole chat panel — so the native
 * overlay bar hugs the panel's right edge, next to the BOOK rail — and the
 * reading column is re-applied as a wrapper INSIDE it.
 *
 * This suite is what keeps those two roles apart. It exercises the STANDALONE
 * mount, where the transcript owns its own overflow; inside the resident shell
 * `SessionPanel`'s scroll body is the scrollport instead and these classes go
 * inert (`chat-transcript.css`). Everything the arrangement must not break -
 * follow ownership, the force-scroll on the reader's own words, prepend
 * anchoring, the "↓ latest" pill - is pinned next door in
 * `scroll-model.test.tsx`.
 */

import { afterEach, describe, expect, it } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";

import { SessionTranscript } from "../../SessionTranscript.js";
import {
  SESSION,
  freshClient,
  getScroller,
  listMock,
  msg,
  page,
  resetTranscriptEnv,
  setVex,
} from "./transcript-harness.js";

function makeWrapper(client: QueryClient) {
  return function Wrapper({ children }: { readonly children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

afterEach(resetTranscriptEnv);

async function renderTranscript() {
  setVex();
  listMock.mockResolvedValue(
    page([msg({ id: 1, role: "user", kind: "text", content: "hello" })], null),
  );
  const view = render(
    createElement(SessionTranscript, { sessionId: SESSION }),
    { wrapper: makeWrapper(freshClient()) },
  );
  await waitFor(() => expect(view.container.textContent).toContain("hello"));
  return view;
}

/** The wrapper that carries the reading measure, inside the scroller. */
function readingColumn(container: HTMLElement): HTMLElement {
  const el = getScroller(container).querySelector(".max-w-\\[780px\\]");
  if (el === null) throw new Error("reading column not found inside scroller");
  return el as HTMLElement;
}

describe("the scroller spans the panel; the column lives inside it", () => {
  it("does NOT constrain the scrolling element to the reading measure", async () => {
    const { container } = await renderTranscript();
    const scroller = getScroller(container);
    // A max-width here is exactly what put the scrollbar mid-screen.
    expect(scroller.className).not.toContain("max-w-");
    expect(scroller.className).not.toContain("mx-auto");
    // It is still the element that actually scrolls.
    expect(scroller.className).toContain("overflow-y-auto");
  });

  it("puts the reading column INSIDE the scroller, not around it", async () => {
    const { container } = await renderTranscript();
    const scroller = getScroller(container);
    const column = readingColumn(container);
    expect(scroller.contains(column)).toBe(true);
    expect(column).not.toBe(scroller);
    // Centred on the panel's axis — the same axis the column had before, so
    // nothing the reader looks at moves sideways.
    expect(column.className).toContain("mx-auto");
  });

  it("keeps the rows inside the reading column", async () => {
    const { container } = await renderTranscript();
    const column = readingColumn(container);
    const row = container.querySelector("[data-vex-entry-id]");
    expect(row).not.toBeNull();
    expect(column.contains(row)).toBe(true);
  });

  it("keeps the floating slots inside the scroller but OUT of the row column", async () => {
    // The centred scene and the jump pill are zero-height STICKY slots: inside
    // the scroller (sticky resolves against the scrolling ancestor) and
    // outside the row column, whose 16px gap they would otherwise take,
    // opening a hole between rows. The retired anchor-run-out spacer used to
    // hold the scroll range with dead space; the follow model needs none, so
    // nothing in the scroller writes an inline height any more.
    const { container } = await renderTranscript();
    const scroller = getScroller(container);
    const column = readingColumn(container);
    const rowStack = column.querySelector(".gap-4");
    expect(rowStack).not.toBeNull();
    expect(scroller.querySelector('div[style*="height"]')).toBeNull();
  });

  it("wears the overlay scrollbar utility, so the bar is the native one", async () => {
    const { container } = await renderTranscript();
    const scroller = getScroller(container);
    expect(scroller.className).toContain("vex-scroll");
    expect(scroller.className).toContain("vex-scroll-overlay");
    // The reserved gutter keeps content from shifting when the bar appears.
    expect(scroller.className).toContain("[scrollbar-gutter:stable]");
  });
});
