import { QueryClient, QueryClientProvider, keepPreviousData } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useLighterTradingAccount, useLighterTradingFills } from "../lighter-trading.js";

const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_B = "22222222-2222-4222-8222-222222222222";

describe("desk account query ownership", () => {
  let queryClient: QueryClient;
  afterEach(() => queryClient.clear());
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  it("drops the previous session's account and fills while the new wallet is loading", async () => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, placeholderData: keepPreviousData } } });
    const accountA = { ok: true, data: { accountIndex: 42 } };
    const fillsA = { ok: true, data: { accountIndex: 42, fills: [{ tradeId: "wallet-a-fill" }] } };
    queryClient.setQueryData(["lighterTrading", "account", "rhc", SESSION_A], accountA);
    queryClient.setQueryData(["lighterTrading", "fills", "rhc", SESSION_A], fillsA);
    const accountB = Promise.withResolvers<unknown>();
    const fillsB = Promise.withResolvers<unknown>();
    const getAccount = vi.fn(() => ({ promise: accountB.promise, cancel: vi.fn() }));
    const listFills = vi.fn(() => ({ promise: fillsB.promise, cancel: vi.fn() }));
    Object.defineProperty(window, "vex", { configurable: true, value: { lighterTrading: { getAccount, listFills } } });
    const { result, rerender } = renderHook(({ sessionId }) => ({
      account: useLighterTradingAccount("rhc", true, sessionId),
      fills: useLighterTradingFills("rhc", true, sessionId),
    }), { wrapper, initialProps: { sessionId: SESSION_A } });
    expect(result.current.account.data).toEqual(accountA);
    expect(result.current.fills.data).toEqual(fillsA);

    rerender({ sessionId: SESSION_B });

    expect(result.current.account.data).toBeUndefined();
    expect(result.current.fills.data).toBeUndefined();
    expect(getAccount).toHaveBeenCalledWith({ environment: "rhc", sessionId: SESSION_B });
    expect(listFills).toHaveBeenCalledWith({ environment: "rhc", sessionId: SESSION_B, limit: 50 });
    await act(async () => {
      accountB.resolve({ ok: true, data: { accountIndex: 43 } });
      fillsB.resolve({ ok: true, data: { accountIndex: 43, fills: [] } });
    });
    await waitFor(() => expect(result.current.account.data).toMatchObject({ data: { accountIndex: 43 } }));
    expect(result.current.fills.data).toMatchObject({ data: { accountIndex: 43, fills: [] } });
  });

  it("never performs an unscoped read when the desk has no session, including manual refresh", async () => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(["lighterTrading", "account", "rhc", "unscoped"], { ok: true, data: { accountIndex: 42 } });
    const getAccount = vi.fn();
    const listFills = vi.fn();
    Object.defineProperty(window, "vex", { configurable: true, value: { lighterTrading: { getAccount, listFills } } });
    const { result } = renderHook(() => ({
      account: useLighterTradingAccount("rhc", true, null),
      fills: useLighterTradingFills("rhc", true, null),
    }), { wrapper });
    expect(result.current.account.data).toBeUndefined();
    expect(result.current.fills.data).toBeUndefined();
    await act(async () => {
      await result.current.account.refetch();
      await result.current.fills.refetch();
    });
    expect(getAccount).not.toHaveBeenCalled();
    expect(listFills).not.toHaveBeenCalled();
  });
});
