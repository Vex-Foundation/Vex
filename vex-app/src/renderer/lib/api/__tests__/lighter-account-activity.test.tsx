import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LighterTradingAccountActivityEvent } from "@shared/schemas/lighter-trading.js";
import { useLighterAccountActivityRefresh } from "../lighter-trading.js";

let listeners: Array<(event: LighterTradingAccountActivityEvent) => void> = [];
const unsubscribe = vi.fn();

function emit(environment: "core" | "rhc", kind: LighterTradingAccountActivityEvent["kind"]): void {
  for (const listener of listeners) listener({ environment, accountIndex: 42, kind, at: Date.now() });
}

describe("useLighterAccountActivityRefresh", () => {
  let queryClient: QueryClient;
  let invalidate: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    listeners = [];
    unsubscribe.mockClear();
    Object.defineProperty(window, "vex", {
      configurable: true,
      value: {
        lighterTrading: {
          onAccountActivity: (callback: (event: LighterTradingAccountActivityEvent) => void) => {
            listeners.push(callback);
            return unsubscribe;
          },
        },
      },
    });
    queryClient = new QueryClient();
    invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  it("coalesces a burst of evidence into one account + fills refresh for its own environment", () => {
    const { unmount } = renderHook(() => useLighterAccountActivityRefresh("rhc", true), { wrapper });
    expect(listeners).toHaveLength(1);

    emit("core", "trades");
    vi.advanceTimersByTime(1_000);
    expect(invalidate).not.toHaveBeenCalled();

    emit("rhc", "orders");
    emit("rhc", "trades");
    emit("rhc", "positions");
    vi.advanceTimersByTime(399);
    expect(invalidate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(invalidate.mock.calls.map(([input]: readonly unknown[]) => input)).toEqual([
      { queryKey: ["lighterTrading", "account", "rhc"] },
      { queryKey: ["lighterTrading", "fills", "rhc"] },
    ]);

    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("drops a pending refresh when it unmounts and never subscribes while disabled", () => {
    const disabled = renderHook(() => useLighterAccountActivityRefresh("rhc", false), { wrapper });
    expect(listeners).toHaveLength(0);
    disabled.unmount();

    const { unmount } = renderHook(() => useLighterAccountActivityRefresh("rhc", true), { wrapper });
    emit("rhc", "positions");
    unmount();
    vi.advanceTimersByTime(1_000);
    expect(invalidate).not.toHaveBeenCalled();
  });
});
