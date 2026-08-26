/**
 * THE TRANSCRIPT MOUNT - what a board row does to the surfaces, and what it
 * must not do.
 *
 * A historical row renders from ITS OWN persisted document (A1). The store
 * owns selection and ephemeral state, never board documents, so a card five
 * thousand messages back must paint from the spec beside it rather than from
 * whatever board happens to be latest.
 *
 * THE UNSEEN DOT FAILS CLOSED. Only a real live append may light it, and the
 * transcript's own settled bookkeeping is what decides that. Until the
 * tracker is threaded this deep, a row is recorded as HISTORY - which lights
 * nothing. That is the conservative behaviour, and it is asserted here so a
 * later change that starts lighting dots for scrollback has to break a test
 * to do it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { BoardRowCard } from "../BoardRowCard.js";
import {
  BOARD_FILTER_NONE,
  useBoardSurfaceStore,
} from "../board-surface-store.js";
import { useBoardLiveOverlayStore } from "../board-live-overlay.js";
import { useUiStore } from "../../../../stores/uiStore.js";
import { boardSpec } from "./boardFixture.js";

beforeEach(() => {
  useBoardSurfaceStore.setState({
    latestBoard: null,
    pinnedBoard: null,
    modalBoard: null,
    unseenBoardKey: null,
    surfaceKey: null,
    view: "grid",
    selectedPoolIndex: 0,
    filter: BOARD_FILTER_NONE,
    scrollTop: 0,
    askPanelOpen: false,
    liveRequested: false,
    modalGeneration: 0,
    spotlightGeneration: 0,
  });
  useBoardLiveOverlayStore.setState({ published: null });
  useUiStore.setState({ activeSessionId: "session-1" });
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: {
      boardIcons: {
        read: vi.fn().mockResolvedValue({
          ok: true,
          data: { iconId: "abcd1234", icon: { kind: "not_found" } },
        }),
      },
    },
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

function mount(node: ReactNode): ReactNode {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

describe("BoardRowCard", () => {
  it("renders the row's OWN document", () => {
    render(
      mount(<BoardRowCard messageId={41} spec={boardSpec({ title: "Row board" })} />),
    );
    expect(
      document.querySelector('[data-vex-area="board-preview-title"]')?.textContent,
    ).toBe("Row board");
  });

  it("records the board as the session's latest, keyed by its own message", () => {
    render(mount(<BoardRowCard messageId={41} spec={boardSpec()} />));
    const latest = useBoardSurfaceStore.getState().latestBoard;
    expect(latest?.sessionId).toBe("session-1");
    expect(latest?.messageId).toBe(41);
  });

  it("NEVER opens the modal by mounting", () => {
    render(mount(<BoardRowCard messageId={41} spec={boardSpec()} />));
    expect(useBoardSurfaceStore.getState().modalBoard).toBeNull();
  });

  it("opens it when the reader presses View board", () => {
    render(mount(<BoardRowCard messageId={41} spec={boardSpec()} />));
    screen.getByRole("button", { name: /view board/i }).click();
    expect(useBoardSurfaceStore.getState().modalBoard?.messageId).toBe(41);
  });

  it("lights NO unseen dot for a row that arrived as history", () => {
    render(mount(<BoardRowCard messageId={41} spec={boardSpec()} />));
    expect(useBoardSurfaceStore.getState().unseenBoardKey).toBeNull();
  });

  it("lights the dot only for a real live append", () => {
    render(
      mount(
        <BoardRowCard messageId={41} spec={boardSpec()} arrival="live-append" />,
      ),
    );
    expect(useBoardSurfaceStore.getState().unseenBoardKey).toBe("session-1:41");
  });

  it("renders nothing when there is no session to key the board by", () => {
    // No session means no board identity, and a board with no identity has no
    // modal to open. A card that could not act would be worse than none.
    useUiStore.setState({ activeSessionId: null });
    render(mount(<BoardRowCard messageId={41} spec={boardSpec()} />));
    expect(document.querySelector('[data-vex-area="board-preview-card"]')).toBeNull();
  });
});
