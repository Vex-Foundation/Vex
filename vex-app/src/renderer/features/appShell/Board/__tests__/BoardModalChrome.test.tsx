/**
 * THE HEADER CHROME - the single live owner, and the honesty of its dot.
 *
 * THE SWITCH DRIVES THE STORE, NOT A LOCAL BOOLEAN. `liveRequested` is the
 * reader's decision and the store derives the lease from it plus an open
 * modal, which is what makes a lease unable to outlive the surface that asked
 * for it. A chrome that kept its own on/off would be a second source of truth
 * for the one thing this arc exists to keep single.
 *
 * THE DOT FOLLOWS THE FETCH, NOT THE SWITCH. A reader who flips Live on and
 * immediately sees a green LIVE beside figures that have not arrived has been
 * told something untrue, so the dot is gated on `live-connected` while the
 * switch reports only the request.
 *
 * FIGURES ARE PUBLISHED, NOT HELD PRIVATELY. The grid and the transcript card
 * are siblings of this component, not descendants; publishing to the overlay
 * store is what lets them paint live figures without opening a second lease.
 * The publication is keyed by board and CLEARED on unmount, so a closed
 * board's last tick can never appear under the next board that opens.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  BOARD_LIVE_HELPER_OFF,
  BOARD_LIVE_HELPER_ON,
  BoardModalChrome,
} from "../BoardModalChrome.js";
import {
  BOARD_FILTER_NONE,
  useBoardSurfaceStore,
} from "../board-surface-store.js";
import { useBoardLiveOverlayStore } from "../board-live-overlay.js";
import { boardKeyOf, boardRefOf, type BoardRef } from "../board-surface-contracts.js";
import { boardSpec } from "./boardFixture.js";

const capability = vi.fn();
const subscribe = vi.fn();
const unsubscribe = vi.fn();
const onLeaseEvent = vi.fn();

function board(messageId = 21): BoardRef {
  return boardRefOf("session-1", messageId, boardSpec({ title: "Token Radar" }));
}

function resetStores(): void {
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
}

beforeEach(() => {
  resetStores();
  capability.mockReset();
  subscribe.mockReset();
  unsubscribe.mockReset();
  onLeaseEvent.mockReset();
  capability.mockResolvedValue({ ok: true, data: { supported: true } });
  // A subscribe that never settles: this file's subject is the CONTROL and
  // what it publishes, and a lease that stays in flight is the state in which
  // the dot must still be dark.
  subscribe.mockReturnValue(new Promise(() => undefined));
  onLeaseEvent.mockReturnValue(() => undefined);
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: {
      boardLive: { capability, subscribe, unsubscribe, onLeaseEvent },
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

function mount(ref: BoardRef): ReactNode {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return (
    <QueryClientProvider client={client}>
      <BoardModalChrome board={ref} />
    </QueryClientProvider>
  );
}

function area(name: string): HTMLElement | null {
  return document.querySelector(`[data-vex-area="${name}"]`);
}

/**
 * The switch, once capability has answered.
 *
 * Capability is asked BEFORE the control becomes operable, deliberately: a
 * build with no market channel gets a DISABLED switch that says why, rather
 * than one that looks live and fails on its first press. Every test that
 * presses it therefore waits for that answer first, which is the real
 * sequence a reader meets.
 */
async function enabledSwitch(): Promise<HTMLElement> {
  const control = screen.getByRole("switch", { name: "Live data" });
  await waitFor(() => {
    expect(control.hasAttribute("disabled")).toBe(false);
  });
  return control;
}

describe("BoardModalChrome", () => {
  it("renders both mode labels, the switch, the helper line and pin", () => {
    render(mount(board()));
    expect(area("board-mode-snapshot")?.textContent).toBe("Snapshot");
    expect(area("board-mode-live")?.textContent).toBe("Live data");
    expect(area("board-live-switch")).not.toBeNull();
    expect(area("board-live-helper")?.textContent).toBe(BOARD_LIVE_HELPER_OFF);
    expect(area("board-pin")).not.toBeNull();
  });

  it("is a real switch named by its visible label", () => {
    render(mount(board()));
    const control = screen.getByRole("switch", { name: "Live data" });
    expect(control.getAttribute("aria-checked")).toBe("false");
  });

  it("is DISABLED until capability has answered, then operable", async () => {
    render(mount(board()));
    expect(
      screen.getByRole("switch", { name: "Live data" }).hasAttribute("disabled"),
    ).toBe(true);
    await enabledSwitch();
  });

  it("drives the STORE's live intent, in both directions", async () => {
    render(mount(board()));
    const control = await enabledSwitch();
    act(() => {
      control.click();
    });
    expect(useBoardSurfaceStore.getState().liveRequested).toBe(true);
    act(() => {
      screen.getByRole("switch", { name: "Live data" }).click();
    });
    expect(useBoardSurfaceStore.getState().liveRequested).toBe(false);
  });

  it("reflects an intent the store already holds, without being clicked", () => {
    // The intent survives a spotlight round trip and a re-mount of this
    // component; the control reports the decision, it does not own it.
    act(() => {
      useBoardSurfaceStore.getState().setBoardLive(true);
    });
    render(mount(board()));
    expect(
      screen.getByRole("switch", { name: "Live data" }).getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("keeps the LIVE dot dark until a tick has actually landed", async () => {
    render(mount(board()));
    const control = await enabledSwitch();
    act(() => {
      control.click();
    });
    // Requested, subscribe in flight, nothing delivered: the switch is on and
    // the dot is not.
    expect(useBoardSurfaceStore.getState().liveRequested).toBe(true);
    expect(area("board-live-dot")).toBeNull();
  });

  it("switches the helper copy once the lease is held", async () => {
    render(mount(board()));
    expect(area("board-live-helper")?.textContent).toBe(BOARD_LIVE_HELPER_OFF);
    const control = await enabledSwitch();
    act(() => {
      control.click();
    });
    // `live-connecting` is already HELD: the lease exists from the request,
    // and the copy describes the lease. The DOT is what waits for a tick.
    await waitFor(() => {
      expect(area("board-live-helper")?.textContent).toBe(BOARD_LIVE_HELPER_ON);
    });
  });

  it("PUBLISHES its figures under this board's key, and clears them on unmount", () => {
    const ref = board();
    const view = render(mount(ref));
    expect(useBoardLiveOverlayStore.getState().published?.boardKey).toBe(
      boardKeyOf(ref),
    );
    view.unmount();
    // A closed board's last tick must never be painted under the next board.
    expect(useBoardLiveOverlayStore.getState().published).toBeNull();
  });

  it("pins and unpins THIS board, and reports the state", () => {
    const ref = board();
    render(mount(ref));
    const pin = screen.getByRole("button", {
      name: "Pin this board to the sidebar",
    });
    expect(pin.getAttribute("aria-pressed")).toBe("false");
    act(() => {
      pin.click();
    });
    expect(useBoardSurfaceStore.getState().pinnedBoard).toEqual(ref);
    act(() => {
      screen.getByRole("button", { name: "Unpin this board" }).click();
    });
    expect(useBoardSurfaceStore.getState().pinnedBoard).toBeNull();
  });

  it("does NOT retry a lease that failed, and says why", async () => {
    // The defect this pins: reconciling intent against lease state on every
    // render turns a failing provider into an unbounded retry loop. Intent is
    // applied once per decision; a lease that ends returns the decision to off
    // with the provider's own sentence on screen.
    subscribe.mockResolvedValue({
      ok: false,
      error: { code: "market.unavailable", message: "Market channel is busy." },
    });
    render(mount(board()));
    const control = await enabledSwitch();
    act(() => {
      control.click();
    });
    await waitFor(() => {
      expect(useBoardSurfaceStore.getState().liveRequested).toBe(false);
    });
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(area("board-live-helper")?.textContent).toBe("Market channel is busy.");
    expect(area("board-live-dot")).toBeNull();
  });

  it("refuses to arm at all when the build cannot reach the channel", async () => {
    capability.mockResolvedValue({
      ok: true,
      data: { supported: false, detail: "No market channel in this build." },
    });
    render(mount(board()));
    const control = screen.getByRole("switch", { name: "Live data" });
    await waitFor(() => {
      // DISABLED, not hidden, and TITLED: a reader must be able to learn the
      // capability exists and why it is unavailable here, rather than meet a
      // control that looks live and fails on its first press.
      expect(control.getAttribute("title")).toContain("does not mount");
    });
    expect(control.hasAttribute("disabled")).toBe(true);
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("does not open a lease merely by being mounted", () => {
    render(mount(board()));
    expect(subscribe).not.toHaveBeenCalled();
  });
});
