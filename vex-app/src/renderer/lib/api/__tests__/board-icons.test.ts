/**
 * board-icons.ts - the board token icon hook's FRESHNESS policy.
 *
 * The defect this file exists to keep fixed: the hook used one
 * `staleTime: Infinity` for every fulfilled outcome, which froze the three
 * outcomes that carry NO information about the icon (`busy`, `transport`,
 * `not_mounted`) for the lifetime of a mounted transcript, and froze a 404
 * long past the window main itself keeps it for. A board that met one busy
 * instant stayed logo-less until the user navigated away.
 *
 * Two layers, deliberately:
 *  - a table test on `boardIconFreshnessMs`, the pure decision;
 *  - three behavioral tests driving the real `useQuery` through fake timers,
 *    because "the outcome is stale" is not the contract - "the card asks
 *    again and recovers" is, and only the wired refetch cadence proves it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import type { Result } from "@shared/ipc/result.js";
import type { BoardIconReadResult } from "@shared/schemas/board-icons.js";

import {
  BOARD_ICON_NOT_FOUND_STALE_MS,
  BOARD_ICON_TRANSIENT_STALE_MS,
  boardIconFreshnessMs,
  useBoardTokenIcon,
} from "../board-icons.js";

const ID = "profile_abc123";
const DATA_URL = "data:image/png;base64,AAAA";

function ok(icon: BoardIconReadResult["icon"]): Result<BoardIconReadResult> {
  return { ok: true, data: { iconId: ID, icon } };
}

const IMAGE = ok({ kind: "image", dataUrl: DATA_URL });

const readMock = vi.fn<() => Promise<Result<BoardIconReadResult>>>();

beforeEach(() => {
  readMock.mockReset();
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: { boardIcons: { read: () => readMock() } },
  });
});

afterEach(() => {
  vi.useRealTimers();
  // @ts-expect-error - test cleanup
  delete window.vex;
});

function makeWrapper(client: QueryClient) {
  return function Wrapper({ children }: { readonly children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

/** A client that imposes no freshness of its own, so the hook's is the only one. */
function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
}

describe("boardIconFreshnessMs", () => {
  it("settles an image forever - the handle names one immutable asset", () => {
    expect(boardIconFreshnessMs(IMAGE)).toBe(Number.POSITIVE_INFINITY);
  });

  it("settles a definitive absence forever", () => {
    expect(
      boardIconFreshnessMs(ok({ kind: "absent", reason: "unsupported_image" })),
    ).toBe(Number.POSITIVE_INFINITY);
    expect(boardIconFreshnessMs(ok({ kind: "absent", reason: "over_cap" }))).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  it("holds a 404 for exactly main's negative-cache window", () => {
    expect(boardIconFreshnessMs(ok({ kind: "absent", reason: "not_found" }))).toBe(
      BOARD_ICON_NOT_FOUND_STALE_MS,
    );
    // THE DRIFT GUARD, and the reason it is a literal here rather than an
    // import: a renderer module may not import a main-process one. Main's
    // `BOARD_ICON_NOT_FOUND_TTL_MS` is the same ten minutes and is asserted
    // against the same literal in `src/main/images/__tests__/
    // board-icon-service.test.ts`, so moving the window on one side alone
    // turns one of the two red instead of silently desynchronising them.
    expect(BOARD_ICON_NOT_FOUND_STALE_MS).toBe(600_000);
  });

  it("holds every transient non-answer only briefly", () => {
    for (const reason of ["busy", "transport", "not_mounted"] as const) {
      expect(boardIconFreshnessMs(ok({ kind: "unavailable", reason }))).toBe(
        BOARD_ICON_TRANSIENT_STALE_MS,
      );
    }
  });

  it("settles a Result error and an unfetched query forever", () => {
    expect(boardIconFreshnessMs(undefined)).toBe(Number.POSITIVE_INFINITY);
    expect(
      boardIconFreshnessMs({
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
    ).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("useBoardTokenIcon - transient outcomes recover", () => {
  it("re-asks after a transport failure and draws the image that follows", async () => {
    vi.useFakeTimers();
    readMock
      .mockResolvedValueOnce(ok({ kind: "unavailable", reason: "transport" }))
      .mockResolvedValue(IMAGE);

    const { result } = renderHook(() => useBoardTokenIcon(ID), {
      wrapper: makeWrapper(makeClient()),
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.data).toEqual(
      ok({ kind: "unavailable", reason: "transport" }),
    );
    expect(readMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(BOARD_ICON_TRANSIENT_STALE_MS + 50);
    });

    expect(readMock).toHaveBeenCalledTimes(2);
    expect(result.current.data).toEqual(IMAGE);
  });

  it("re-asks after a queue overflow, so a busy instant is not permanent", async () => {
    vi.useFakeTimers();
    readMock
      .mockResolvedValueOnce(ok({ kind: "unavailable", reason: "busy" }))
      .mockResolvedValue(IMAGE);

    const { result } = renderHook(() => useBoardTokenIcon(ID), {
      wrapper: makeWrapper(makeClient()),
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(readMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(BOARD_ICON_TRANSIENT_STALE_MS + 50);
    });

    expect(readMock).toHaveBeenCalledTimes(2);
    expect(result.current.data).toEqual(IMAGE);
  });

  it("holds a 404 for main's whole window, then asks again", async () => {
    vi.useFakeTimers();
    readMock
      .mockResolvedValueOnce(ok({ kind: "absent", reason: "not_found" }))
      .mockResolvedValue(IMAGE);

    const { result } = renderHook(() => useBoardTokenIcon(ID), {
      wrapper: makeWrapper(makeClient()),
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(readMock).toHaveBeenCalledTimes(1);

    // Well past the transient window: a 404 is settled for far longer than a
    // busy queue, and treating the two alike would hammer the CDN.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BOARD_ICON_TRANSIENT_STALE_MS * 4);
    });
    expect(readMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(BOARD_ICON_NOT_FOUND_STALE_MS);
    });
    expect(readMock).toHaveBeenCalledTimes(2);
    expect(result.current.data).toEqual(IMAGE);
  });

  it("never re-asks once an image is in hand", async () => {
    vi.useFakeTimers();
    readMock.mockResolvedValue(IMAGE);

    renderHook(() => useBoardTokenIcon(ID), {
      wrapper: makeWrapper(makeClient()),
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BOARD_ICON_NOT_FOUND_STALE_MS * 3);
    });

    expect(readMock).toHaveBeenCalledTimes(1);
  });
});
