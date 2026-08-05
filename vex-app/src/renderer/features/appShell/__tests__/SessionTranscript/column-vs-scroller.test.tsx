/**
 * WHO SCROLLS, AND WHO IS THE READING COLUMN — the two must not be the same
 * element.
 *
 * The transcript's scroller used to BE the 860px reading column, so the browser
 * drew its scrollbar at the column's right edge: a bar floating in the middle
 * of the window beside the text, which is not how any browser behaves and is
 * not what a reader reaches for (owner, 2026-08-05). The fix is structural, not
 * a custom widget: the SCROLLER spans the whole chat panel — so the native
 * overlay bar hugs the panel's right edge, next to the BOOK rail — and the
 * reading column is re-applied as a wrapper INSIDE it.
 *
 * This suite is what keeps those two roles apart. Everything the arrangement
 * must not break — the top anchor, the run-out spacer, the "↓ latest" pill —
 * is pinned next door in `scroll-model.test.tsx`, which is the real regression
 * guard for the swap.
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
  const el = getScroller(container).querySelector(".max-w-\\[860px\\]");
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

  it("keeps the anchor run-out spacer inside the scroller's flow", async () => {
    // The spacer guarantees the scroll range under an anchored user message;
    // if the swap had left it outside the scroller it would guarantee nothing.
    const { container } = await renderTranscript();
    const scroller = getScroller(container);
    const spacer = scroller.querySelector("div[aria-hidden]:last-child");
    expect(spacer).not.toBeNull();
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
