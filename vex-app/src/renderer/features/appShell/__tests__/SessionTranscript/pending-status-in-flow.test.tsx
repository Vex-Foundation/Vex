/**
 * THE PENDING TURN IS AN IN-FLOW ROW, NOT A VIEWPORT OVERLAY.
 *
 * The retired centred "vexing…" scene was a `height: 0` sticky slot whose child
 * was one VIEWPORT tall. A zero-height box contributes no normal-flow height,
 * but a positively overflowing child still enlarges SCROLLABLE OVERFLOW, so the
 * scrollport's floor moved out past the sticky composer seat: every send lifted
 * the composer, and Chromium's clamp dropped it back when the scene unmounted
 * (owner QA item 7).
 *
 * What replaces it is the surface Vex already had - `TurnIsland`'s `vexing…`
 * pill at the tail of the observed message column, which the deepseek reference
 * mounts the same way (`ChatView` renders `TurnStatus` as an ordinary child of
 * the message column). Its height is real conversation geometry, so a pinned
 * reader follows it and a reader who owns the viewport keeps it.
 *
 * The claims pinned here:
 *  1. the pill is present from the SEND, before any engine delta;
 *  2. nothing inside the scrollport is a viewport-sized child;
 *  3. status arrival and removal follow while pinned;
 *  4. status arrival and removal move nothing while the reader owns the view.
 */

import { afterEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";

import { SessionTranscript } from "../../SessionTranscript.js";
import {
  SESSION,
  freshClient,
  getScroller,
  installScrollMetrics,
  listMock,
  msg,
  page,
  readerScroll,
  resetTranscriptEnv,
  setVex,
  startChatTurn,
} from "./transcript-harness.js";

function makeWrapper(client: QueryClient) {
  return function Wrapper({ children }: { readonly children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

afterEach(resetTranscriptEnv);

async function mountWithRow(client: QueryClient) {
  setVex();
  listMock.mockResolvedValue(
    page([msg({ id: 3, role: "user", kind: "text", content: "newest" })], null),
  );
  const view = render(createElement(SessionTranscript, { sessionId: SESSION }), {
    wrapper: makeWrapper(client),
  });
  await waitFor(() => expect(screen.getByText("newest")).not.toBeNull());
  return view;
}

/** The island's live status label - the whole visible pending surface. */
function statusLabel(container: HTMLElement): HTMLElement | null {
  return container.querySelector("[data-vex-island-label]");
}

describe("SessionTranscript - the pending turn's in-flow status", () => {
  it("shows the 'vexing…' pill from the SEND, before any engine delta", async () => {
    const client = freshClient();
    const { container } = await mountWithRow(client);
    expect(statusLabel(container)).toBeNull();

    let settle: () => void = () => undefined;
    act(() => {
      settle = startChatTurn(client);
    });
    await waitFor(() =>
      expect(statusLabel(container)?.textContent).toBe("vexing…"),
    );

    act(() => {
      settle();
    });
  });

  it("puts the status INSIDE the observed message column, not in a viewport slot", async () => {
    const client = freshClient();
    const { container } = await mountWithRow(client);
    let settle: () => void = () => undefined;
    act(() => {
      settle = startChatTurn(client);
    });
    await waitFor(() => expect(statusLabel(container)).not.toBeNull());

    const scroller = getScroller(container);
    // No zero-height slot with an overflowing viewport-sized child anywhere in
    // the scrolled subtree. These attributes are the retired scene's markers;
    // their return would restore the inflated scrollHeight.
    expect(scroller.querySelector("[data-vex-viewport-slot]")).toBeNull();
    expect(scroller.querySelector("[data-vex-viewport-scene]")).toBeNull();
    expect(scroller.querySelector("[data-vex-vexing-working]")).toBeNull();
    // And the status really is a descendant of the streamed tail row, which is
    // an ordinary child of the message column.
    expect(
      scroller
        .querySelector("[data-vex-area='stream-preview']")
        ?.contains(statusLabel(container)),
    ).toBe(true);

    act(() => {
      settle();
    });
  });

  it("a PINNED reader follows the status arriving and leaving", async () => {
    const client = freshClient();
    const { container } = await mountWithRow(client);
    const scroller = getScroller(container);
    const geometry = installScrollMetrics(scroller, 500, 200);
    fireEvent.scroll(scroller);
    expect(scroller.scrollTop).toBe(300);

    // The status is real conversation geometry: it grows the flow, and a
    // pinned reader is carried with it.
    let settle: () => void = () => undefined;
    geometry.setHeight(560);
    act(() => {
      settle = startChatTurn(client);
    });
    await waitFor(() => expect(scroller.scrollTop).toBe(360));

    // It leaves when the turn settles; the floor comes back and the pinned
    // reader lands on it rather than being stranded above it.
    geometry.setHeight(500);
    act(() => {
      settle();
    });
    await waitFor(() => expect(scroller.scrollTop).toBe(300));
  });

  it("a READER-OWNED viewport is untouched by the status arriving or leaving", async () => {
    const client = freshClient();
    const { container } = await mountWithRow(client);
    const scroller = getScroller(container);
    const geometry = installScrollMetrics(scroller, 900, 200);
    readerScroll(scroller, 100);

    let settle: () => void = () => undefined;
    geometry.setHeight(960);
    act(() => {
      settle = startChatTurn(client);
    });
    await waitFor(() => expect(statusLabel(container)).not.toBeNull());
    expect(scroller.scrollTop).toBe(100);

    geometry.setHeight(900);
    act(() => {
      settle();
    });
    await waitFor(() => expect(statusLabel(container)).toBeNull());
    expect(scroller.scrollTop).toBe(100);
  });
});
