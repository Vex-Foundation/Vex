/**
 * `usePortfolioHistory` and its key.
 *
 * The hook is the renderer's whole contact with `vex.portfolio.readHistory`,
 * so three things are pinned against a real QueryClient:
 *
 *  1. it asks main for exactly the input it was given and hands back main's
 *     `Result` as is, a refusal included (never thrown, never patched);
 *  2. its key keeps every scope and range apart and sits under
 *     `portfolioKeys.all`, the prefix every portfolio invalidation targets;
 *  3. because of that prefix, the activity pushes (resolved and progress) and
 *     the refresh button re-read the history together with the total, which is
 *     what keeps the chart's newest point equal to the figure above it.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  PortfolioHistoryDto,
  PortfolioHistoryInput,
} from "@shared/schemas/portfolio-history.js";
import { portfolioKeys } from "../queryKeys.js";
import {
  useActivityProgressInvalidation,
  useActivityResolvedInvalidation,
  usePortfolioHistory,
  usePortfolioRefresh,
} from "../portfolio.js";

const SESSION = "00000000-0000-4000-8000-000000000003";
const PROJECT = "00000000-0000-4000-8000-000000000004";

const ANSWER: PortfolioHistoryDto = {
  scope: "global",
  range: "7d",
  walletCount: 2,
  groupCount: 1,
  sampled: false,
  points: [
    {
      at: "2026-11-01T10:00:00.000Z",
      totalUsd: 150,
      settledUsd: 150,
      inTransitUsd: 0,
      partial: false,
    },
  ],
};

const readHistory = vi.fn();
const refresh = vi.fn();
let resolvedListeners: Array<() => void> = [];
let progressListeners: Array<() => void> = [];

let queryClient: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  readHistory.mockReset();
  readHistory.mockResolvedValue({ ok: true, data: ANSWER });
  refresh.mockReset();
  refresh.mockResolvedValue({ ok: true, data: { status: "refreshed", walletCount: 2 } });
  resolvedListeners = [];
  progressListeners = [];
  Object.defineProperty(window, "vex", {
    configurable: true,
    value: {
      portfolio: {
        readHistory,
        refresh,
        onActivityResolved: (listener: () => void) => {
          resolvedListeners.push(listener);
          return () => undefined;
        },
        onActivityProgress: (listener: () => void) => {
          progressListeners.push(listener);
          return () => undefined;
        },
      },
    },
  });
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  queryClient.clear();
});

describe("portfolioKeys.history", () => {
  const key = (input: PortfolioHistoryInput) => JSON.stringify(portfolioKeys.history(input));

  it("keys every scope and range distinctly", () => {
    const inputs: readonly PortfolioHistoryInput[] = [
      { range: "24h", wallets: { scope: "global" } },
      { range: "7d", wallets: { scope: "global" } },
      { range: "30d", wallets: { scope: "global" } },
      { range: "all", wallets: { scope: "global" } },
      { range: "7d", wallets: { scope: "global", walletAddress: "0xabc" } },
      { range: "7d", wallets: { scope: "global", walletAddress: "0xdef" } },
      { range: "7d", wallets: { scope: "session", sessionId: SESSION } },
      { range: "7d", wallets: { scope: "project", projectId: PROJECT } },
    ];
    expect(new Set(inputs.map(key)).size).toBe(inputs.length);
  });

  it("never collides with the read it sits beside", () => {
    const history = portfolioKeys.history({ range: "7d", wallets: { scope: "global" } });
    expect(history.slice(0, 2)).toEqual(["portfolio", "history"]);
    expect(JSON.stringify(history)).not.toBe(JSON.stringify(portfolioKeys.read({ scope: "global" })));
  });

  it("starts with the prefix every portfolio invalidation targets", () => {
    const history = portfolioKeys.history({ range: "all", wallets: { scope: "global" } });
    expect(history[0]).toBe(portfolioKeys.all[0]);
  });
});

describe("usePortfolioHistory", () => {
  it("asks main for exactly its input and returns main's answer", async () => {
    const input: PortfolioHistoryInput = {
      range: "30d",
      wallets: { scope: "session", sessionId: SESSION },
    };

    const { result } = renderHook(() => usePortfolioHistory(input), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(readHistory).toHaveBeenCalledWith(input);
    expect(result.current.data).toEqual({ ok: true, data: ANSWER });
  });

  it("hands back main's refusal as a Result, never throwing", async () => {
    const refusal = {
      ok: false,
      error: {
        code: "wallets.invalid_selection",
        domain: "portfolio",
        message: "Selected wallet is not in the configured inventory.",
        retryable: false,
        userActionable: true,
        redacted: true,
        correlationId: "c",
      },
    };
    readHistory.mockResolvedValue(refusal);

    const { result } = renderHook(
      () => usePortfolioHistory({ range: "7d", wallets: { scope: "global", walletAddress: "0xNOTMINE" } }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.isError).toBe(false);
    expect(result.current.data).toEqual(refusal);
  });

  it("re-reads when a pending transaction resolves", async () => {
    renderHook(
      () => {
        useActivityResolvedInvalidation();
        return usePortfolioHistory({ range: "7d", wallets: { scope: "global" } });
      },
      { wrapper },
    );
    await waitFor(() => expect(readHistory).toHaveBeenCalledTimes(1));
    expect(resolvedListeners).toHaveLength(1);

    act(() => {
      for (const listener of resolvedListeners) listener();
    });

    await waitFor(() => expect(readHistory).toHaveBeenCalledTimes(2));
  });

  it("re-reads on a pending transaction's progress", async () => {
    renderHook(
      () => {
        useActivityProgressInvalidation();
        return usePortfolioHistory({ range: "24h", wallets: { scope: "global" } });
      },
      { wrapper },
    );
    await waitFor(() => expect(readHistory).toHaveBeenCalledTimes(1));

    act(() => {
      for (const listener of progressListeners) listener();
    });

    await waitFor(() => expect(readHistory).toHaveBeenCalledTimes(2));
  });

  it("re-reads after the user's refresh", async () => {
    const { result } = renderHook(
      () => ({
        history: usePortfolioHistory({ range: "7d", wallets: { scope: "global" } }),
        refresh: usePortfolioRefresh(),
      }),
      { wrapper },
    );
    await waitFor(() => expect(readHistory).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.refresh.refresh();
    });

    await waitFor(() => expect(readHistory).toHaveBeenCalledTimes(2));
  });
});
