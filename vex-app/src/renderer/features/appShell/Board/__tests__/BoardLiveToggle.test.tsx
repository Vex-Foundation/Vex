/**
 * The board's LIVE toggle, driven through the real component, the real hook and
 * the real view model, with only the `window.vex.boardLive` bridge scripted.
 *
 * THAT SEAM IS THE POINT. Faking the hook would leave the generation guard, the
 * effect cleanup, the mode union and the badge wiring untested while every
 * assertion still went green. Faking the process boundary keeps all of it real
 * and stubs exactly what a renderer is not allowed to do anyway.
 *
 * Race-table rows covered here: R2 (late subscribe response), R7 (unmount with
 * no explicit unsubscribe), R11 (no capability), R12 (session switch remount),
 * R13 (two boards, the second supersedes the first). The main-process rows live
 * in `main/market/__tests__/board-live-service.test.ts`; R14 lives in
 * `main/dexscreener-bridge/__tests__/ws-bridge-coalesce-scope.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import type { BoardLiveEvent } from "@shared/schemas/board-live.js";
import { BoardBlock } from "../BoardBlock.js";
import { boardSpec, hydratedRow, FIXTURE_FETCHED_AT } from "./boardFixture.js";

const LEASE_A = "11111111-1111-4111-8111-111111111111";
const LEASE_B = "22222222-2222-4222-8222-222222222222";

/**
 * One scripted main process.
 *
 * It mints leases, keeps the per-window listeners it was given, and enforces the
 * one rule the renderer must not be allowed to assume away: a second subscribe
 * supersedes the first, and the superseded one gets its terminal event.
 */
interface FakeMain {
  readonly listeners: Set<(event: BoardLiveEvent) => void>;
  /** Releases addressed by main's lease id. */
  readonly unsubscribed: string[];
  /**
   * Releases addressed by the RENDERER's own request id, which is the only
   * name that exists while a subscribe is still in flight.
   */
  readonly cancelled: string[];
  /** Every request id the renderer minted, in call order. */
  readonly requestIds: string[];
  readonly subscribeCalls: number;
  emit(event: BoardLiveEvent): void;
  /** Resolve a subscribe that was deliberately left in flight. */
  releaseSubscribe(leaseId: string): void;
}

let supported = true;
let holdSubscribe = false;
/**
 * Whether the scripted main GRANTS a lease that was cancelled before it
 * answered. Real main aborts instead, but the two orders are a genuine race at
 * the process boundary and the renderer has to be correct under both.
 */
let grantDespiteCancel = false;

function installFakeMain(): FakeMain {
  const listeners = new Set<(event: BoardLiveEvent) => void>();
  const unsubscribed: string[] = [];
  const cancelled: string[] = [];
  const pending: Array<(leaseId: string) => void> = [];
  const requestIds: string[] = [];
  let issued = 0;
  let currentLease: string | null = null;

  const state = {
    listeners,
    unsubscribed,
    cancelled,
    requestIds,
    get subscribeCalls(): number {
      return issued;
    },
    emit: (event: BoardLiveEvent): void => {
      for (const listener of [...listeners]) listener(event);
    },
    releaseSubscribe: (leaseId: string): void => {
      const resolve = pending.shift();
      resolve?.(leaseId);
    },
  };

  const grant = (leaseId: string): { ok: true; data: unknown } => {
    if (currentLease !== null && currentLease !== leaseId) {
      const superseded = currentLease;
      queueMicrotask(() =>
        state.emit({
          kind: "closed",
          leaseId: superseded,
          generation: 9,
          reason: "superseded",
        }),
      );
    }
    currentLease = leaseId;
    return {
      ok: true,
      data: {
        kind: "subscribed",
        leaseId,
        generation: 1,
        snapshot: {
          fetchedAtMs: FIXTURE_FETCHED_AT + 60_000,
          rows: [
            {
              // The fixture board's own pool, lowercased: rows are paired to
              // cards BY IDENTITY, so a key that does not name a card on the
              // board correctly draws nothing.
              key: "base:0xaaa111",
              row: hydratedRow({ priceUsd: "9.99", baseTokenSymbol: "AAA" }),
            },
          ],
        },
      },
    };
  };

  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: {
      boardIcons: {
        read: () =>
          Promise.resolve({
            ok: true,
            data: { iconId: "x", icon: { kind: "absent", reason: "not_found" } },
          }),
      },
      boardLive: {
        capability: () =>
          Promise.resolve({
            ok: true,
            data: {
              supported,
              detail: supported
                ? null
                : "Live figures need the DexScreener site channel, which this build does not mount.",
            },
          }),
        subscribe: (input: { pools: unknown; requestId: string }) => {
          issued += 1;
          const leaseId = issued === 1 ? LEASE_A : LEASE_B;
          const requestId = input.requestId;
          requestIds.push(requestId);
          if (holdSubscribe) {
            return new Promise((resolve) => {
              pending.push((released: string) => {
                // Main aborted this attempt on the pre-response cancel, so it
                // answers with the refusal rather than a lease.
                if (cancelled.includes(requestId) && !grantDespiteCancel) {
                  resolve({
                    ok: false,
                    error: {
                      code: "provider.unavailable",
                      domain: "market",
                      message: "the attempt was cancelled",
                      retryable: false,
                      userActionable: false,
                      redacted: true,
                      correlationId: "test",
                    },
                  });
                  return;
                }
                resolve(grant(released));
              });
            });
          }
          return Promise.resolve(grant(leaseId));
        },
        unsubscribe: (input: { leaseId?: string; requestId?: string }) => {
          if (input.requestId !== undefined) {
            cancelled.push(input.requestId);
            return Promise.resolve({ ok: true, data: { outcome: "closed" } });
          }
          const leaseId = input.leaseId ?? "";
          unsubscribed.push(leaseId);
          if (currentLease === leaseId) currentLease = null;
          return Promise.resolve({ ok: true, data: { outcome: "closed" } });
        },
        onLeaseEvent: (cb: (event: BoardLiveEvent) => void) => {
          listeners.add(cb);
          return () => listeners.delete(cb);
        },
      },
    },
  });

  return state;
}

function withQuery(ui: ReactNode): ReactNode {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return createElement(QueryClientProvider, { client }, ui);
}

function toggleOf(container: HTMLElement): HTMLButtonElement {
  const el = container.querySelector('[data-vex-area="board-live-toggle"]');
  if (el === null) throw new Error("live toggle not found");
  return el as HTMLButtonElement;
}

function badgeOf(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[data-vex-area="board-live-badge"]');
}

/** Let any pending promise and its resulting render settle. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/**
 * Wait for the capability answer to land.
 *
 * The toggle is DISABLED until then by design (R11), so clicking before this
 * resolves does nothing at all and every assertion after it would be about a
 * click that never happened.
 */
async function readyToggle(container: HTMLElement): Promise<HTMLButtonElement> {
  await waitFor(() => {
    expect(toggleOf(container).disabled).toBe(false);
  });
  return toggleOf(container);
}

/** Click the live toggle and let the resulting work settle. */
async function clickToggle(container: HTMLElement): Promise<void> {
  const toggle = await readyToggle(container);
  await act(async () => {
    fireEvent.click(toggle);
    await Promise.resolve();
  });
  await settle();
}

let main: FakeMain;

beforeEach(() => {
  supported = true;
  holdSubscribe = false;
  grantDespiteCancel = false;
  main = installFakeMain();
  vi.setSystemTime(FIXTURE_FETCHED_AT + 1_000);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("board LIVE toggle", () => {
  it("is OFF on every mount and shows the composed figures", async () => {
    const { container } = render(withQuery(createElement(BoardBlock, { spec: boardSpec() })));
    await settle();

    expect(toggleOf(container).getAttribute("aria-pressed")).toBe("false");
    expect(badgeOf(container)).toBeNull();
    expect(main.subscribeCalls).toBe(0);
    // The persisted figure, not a live one.
    expect(container.textContent).not.toContain("9.99");
  });

  it("draws live figures over the persisted ones and restores them on toggle-off", async () => {
    const { container } = render(withQuery(createElement(BoardBlock, { spec: boardSpec() })));
    await settle();

    await clickToggle(container);

    expect(toggleOf(container).getAttribute("aria-pressed")).toBe("true");
    expect(badgeOf(container)?.getAttribute("data-live-mode")).toBe("live-connected");
    expect(container.textContent).toContain("9.99");
    // The board section states it in words too, for a reader who cannot see
    // the badge.
    const block = container.querySelector('[data-vex-area="board-block"]');
    expect(block?.getAttribute("aria-label")).toContain("live figures");

    await clickToggle(container);

    expect(main.unsubscribed).toStrictEqual([LEASE_A]);
    expect(toggleOf(container).getAttribute("aria-pressed")).toBe("false");
    expect(badgeOf(container)).toBeNull();
    // Back to the composed figures. The persisted spec was never touched.
    expect(container.textContent).not.toContain("9.99");
  });

  it("shows Reconnecting on a degraded lease while keeping the last good figures", async () => {
    const { container } = render(withQuery(createElement(BoardBlock, { spec: boardSpec() })));
    await settle();
    await clickToggle(container);
    expect(container.textContent).toContain("9.99");

    await act(async () => {
      main.emit({
        kind: "degraded",
        leaseId: LEASE_A,
        generation: 5,
        reason: "incomplete",
        lastGood: null,
      });
    });

    expect(badgeOf(container)?.getAttribute("data-live-mode")).toBe("live-degraded");
    expect(badgeOf(container)?.textContent).toContain("Reconnecting");
    // Figures do NOT blank: the reader keeps looking at the last set that
    // reconciled exactly.
    expect(container.textContent).toContain("9.99");
  });

  it("drops a lease event whose generation is not newer than the one already applied", async () => {
    // K-d. Main's generation is monotonic per lease, so anything at or below
    // what this mount has already acted on describes a transition it has passed.
    // Non-blocking by design: everything newer still lands.
    const { container } = render(withQuery(createElement(BoardBlock, { spec: boardSpec() })));
    await settle();
    await clickToggle(container);
    // The subscribe response carried generation 1 and the figures it granted.
    expect(container.textContent).toContain("9.99");

    await act(async () => {
      main.emit({
        kind: "degraded",
        leaseId: LEASE_A,
        // STALE: generation 1 was already applied by the subscribe response.
        generation: 1,
        reason: "provider",
        lastGood: null,
      });
    });
    expect(badgeOf(container)?.getAttribute("data-live-mode")).toBe("live-connected");

    await act(async () => {
      main.emit({
        kind: "degraded",
        leaseId: LEASE_A,
        generation: 2,
        reason: "provider",
        lastGood: null,
      });
    });
    expect(badgeOf(container)?.getAttribute("data-live-mode")).toBe("live-degraded");
  });

  it("R7-pre: unmounting while connecting cancels the in-flight attempt", async () => {
    holdSubscribe = true;
    const { container, unmount } = render(
      withQuery(createElement(BoardBlock, { spec: boardSpec() })),
    );
    await settle();
    const toggle = await readyToggle(container);
    await act(async () => {
      fireEvent.click(toggle);
      await Promise.resolve();
    });
    expect(main.requestIds).toHaveLength(1);

    // A session switch unmounts the row and the effect cleanup is all that
    // runs. It must still be able to name the exchange it started.
    unmount();
    expect(main.cancelled).toStrictEqual([main.requestIds[0]]);
    expect(main.unsubscribed).toStrictEqual([]);
  });

  it("R4-pre: toggling off while connecting CANCELS the in-flight attempt by request id", async () => {
    // THE WINDOW THIS ROW IS ABOUT. Main withholds the lease id until its first
    // fetch settles, so between the click and that response the renderer holds
    // no handle from main at all. Without an identity of its own it could only
    // stop drawing while main kept the exchange open to its deadline.
    holdSubscribe = true;
    const { container } = render(withQuery(createElement(BoardBlock, { spec: boardSpec() })));
    await settle();

    const toggle = await readyToggle(container);
    await act(async () => {
      fireEvent.click(toggle);
      await Promise.resolve();
    });
    expect(badgeOf(container)?.getAttribute("data-live-mode")).toBe("live-connecting");
    expect(main.requestIds).toHaveLength(1);

    await act(async () => {
      fireEvent.click(toggleOf(container)); // off, still connecting
      await Promise.resolve();
    });

    // The cancel went out IMMEDIATELY, addressed by the only name both sides
    // knew, and it did not wait for the response to arrive first.
    expect(main.cancelled).toStrictEqual([main.requestIds[0]]);
    expect(main.unsubscribed).toStrictEqual([]);

    await act(async () => {
      main.releaseSubscribe(LEASE_A);
      await Promise.resolve();
    });
    await settle();
    expect(container.textContent).not.toContain("9.99");
    expect(badgeOf(container)).toBeNull();
  });

  it("R2: discards a subscribe response that lands after the reader turned it off, and releases its lease", async () => {
    holdSubscribe = true;
    // The race order in which main granted the lease before the cancel reached
    // it. The generation guard still refuses to paint it, and the orphan is
    // released by lease id.
    grantDespiteCancel = true;
    const { container } = render(withQuery(createElement(BoardBlock, { spec: boardSpec() })));
    await settle();

    const toggle = await readyToggle(container);
    await act(async () => {
      fireEvent.click(toggle); // start; the response is held
      await Promise.resolve();
    });
    expect(badgeOf(container)?.getAttribute("data-live-mode")).toBe("live-connecting");

    await act(async () => {
      fireEvent.click(toggleOf(container)); // off, while still connecting
      await Promise.resolve();
    });
    expect(badgeOf(container)).toBeNull();

    // The lease is granted now, for a request nobody is waiting for.
    await act(async () => {
      main.releaseSubscribe(LEASE_A);
      await Promise.resolve();
    });
    await settle();

    // Nothing is painted, AND the orphaned lease is released rather than left
    // polling a provider for a board that stopped listening.
    expect(container.textContent).not.toContain("9.99");
    expect(badgeOf(container)).toBeNull();
    expect(main.unsubscribed).toStrictEqual([LEASE_A]);
  });

  it("R7 and R12: unmount releases the lease and detaches the listener, with no explicit toggle-off", async () => {
    const { container, unmount } = render(
      withQuery(createElement(BoardBlock, { spec: boardSpec() })),
    );
    await settle();
    await clickToggle(container);
    expect(main.listeners.size).toBe(1);

    // A session switch remounts the keyed transcript content; the cleanup is
    // the only thing that runs.
    unmount();

    expect(main.unsubscribed).toStrictEqual([LEASE_A]);
    expect(main.listeners.size).toBe(0);

    // R12: the board that comes back starts OFF, never resuming a lease.
    const remounted = render(withQuery(createElement(BoardBlock, { spec: boardSpec() })));
    await settle();
    expect(toggleOf(remounted.container).getAttribute("aria-pressed")).toBe("false");
    expect(badgeOf(remounted.container)).toBeNull();
  });

  it("R11: disables the toggle with an honest label when the build cannot reach the channel", async () => {
    supported = false;
    const { container } = render(withQuery(createElement(BoardBlock, { spec: boardSpec() })));
    await settle();

    // Disabled BEFORE the first click, not failing on it. And still present:
    // hiding it would mean the reader never learns the capability exists.
    await waitFor(() => {
      expect(toggleOf(container).getAttribute("title")).toContain("site channel");
    });
    const toggle = toggleOf(container);
    expect(toggle.disabled).toBe(true);

    fireEvent.click(toggle);
    await settle();
    expect(main.subscribeCalls).toBe(0);
  });

  it("R13: a second board takes the lease and the first returns to its snapshot, saying why", async () => {
    const first = render(withQuery(createElement(BoardBlock, { spec: boardSpec() })));
    await settle();
    await clickToggle(first.container);
    expect(first.container.textContent).toContain("9.99");

    // A second board in the same transcript claims the single lease.
    const second = render(withQuery(createElement(BoardBlock, { spec: boardSpec() })));
    await settle();
    await clickToggle(second.container);

    expect(toggleOf(second.container).getAttribute("aria-pressed")).toBe("true");
    // The first board is back on its composed figures and SAYS what happened
    // rather than going quietly dark.
    expect(toggleOf(first.container).getAttribute("aria-pressed")).toBe("false");
    expect(badgeOf(first.container)).toBeNull();
    expect(
      first.container.querySelector('[data-vex-area="board-live-notice"]')?.textContent,
    ).toContain("Another board took over");
  });
});
