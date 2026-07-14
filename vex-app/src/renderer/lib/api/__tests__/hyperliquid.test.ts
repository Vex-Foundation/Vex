import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

import { useHyperliquidPositions } from "../hyperliquid.js";

const SESSION = "00000000-0000-4000-8000-000000000001";
const OTHER_SESSION = "00000000-0000-4000-8000-000000000002";
const ISO = "2026-07-11T12:00:00.000Z";

type PositionsListener = (update: {
  readonly sessionId: string;
  readonly positions: readonly unknown[];
  readonly updatedAt: string;
}) => void;

let positionsListener: PositionsListener | null = null;
const unsubscribe = vi.fn();

function positions(sessionId: string) {
  return {
    sessionId,
    updatedAt: ISO,
    positions: [{
      coin: "BTC",
      side: "long",
      size: "0.01",
      entryPx: "100000",
      markPx: "100100",
      leverage: "3",
      marginMode: "isolated",
      liquidationPx: "75000",
      unrealizedPnl: "1",
      fundingAccrued: "0",
      slPrice: "98000",
      tpPrice: null,
      protectionState: "PROTECTED",
      confirmedAt: ISO,
      updatedAt: ISO,
    }],
  };
}

function wrapper({ children }: { readonly children: ReactNode }) {
  return createElement(QueryClientProvider, { client: new QueryClient() }, children);
}

beforeEach(() => {
  positionsListener = null;
  unsubscribe.mockReset();
  Object.defineProperty(window, "vex", {
    configurable: true,
    value: {
      hyperliquid: {
        getPositions: vi.fn(async ({ sessionId }: { readonly sessionId: string }) => ({ ok: true, data: positions(sessionId) })),
        onPositionsUpdate: (callback: PositionsListener) => {
          positionsListener = callback;
          return unsubscribe;
        },
      },
    },
  });
});

afterEach(() => {
  // @ts-expect-error Test-only cleanup of the global preload bridge.
  delete window.vex;
});

describe("useHyperliquidPositions", () => {
  it("uses the main push and ignores a different session", async () => {
    const { result, unmount } = renderHook(() => useHyperliquidPositions(SESSION), { wrapper });
    await waitFor(() => expect(result.current.data?.ok).toBe(true));
    expect(positionsListener).not.toBeNull();

    act(() => positionsListener!(positions(OTHER_SESSION)));
    expect(result.current.data?.ok && result.current.data.data.sessionId).toBe(SESSION);

    act(() => positionsListener!(positions(SESSION)));
    expect(result.current.data?.ok && result.current.data.data.positions[0]?.coin).toBe("BTC");
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
