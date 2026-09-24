/**
 * Approvals keep working while the machine reports it is offline.
 *
 * On 2026-09-24 a desk order was approved just before the Wi-Fi went off. It
 * failed within four seconds, but TanStack's default "online" network mode
 * paused the pending-approvals query, so the card stayed on screen for eight
 * minutes until the Wi-Fi came back. An Approve clicked while offline would
 * likewise wait and fire later on its own. Approvals only talk to the local
 * main process, so they must not wait for the internet.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { onlineManager, QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

import { useApprove, usePendingApprovals } from "../approvals.js";

const listPending = vi.fn();
const approve = vi.fn();

function wrapper(client: QueryClient) {
  return function Wrapper({ children }: { readonly children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

beforeEach(() => {
  listPending.mockReset().mockResolvedValue({ ok: true, data: [] });
  approve.mockReset().mockResolvedValue({ ok: true, data: { id: "ap-1", executionStatus: "failed" } });
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: { approvals: { listPending, approve } },
  });
  onlineManager.setOnline(false);
});

afterEach(() => {
  onlineManager.setOnline(true);
  Reflect.deleteProperty(window, "vex");
});

describe("approvals while offline", () => {
  it("pauses an ordinary query offline, which is the state this guards against", async () => {
    const queryFn = vi.fn(async () => "value");
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useQuery({ queryKey: ["ordinary"], queryFn }), { wrapper: wrapper(client) });

    await waitFor(() => expect(result.current.fetchStatus).toBe("paused"));
    expect(queryFn).not.toHaveBeenCalled();
  });

  it("still reads the pending list, so a resolved card leaves the desk", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => usePendingApprovals("session-1"), { wrapper: wrapper(client) });

    await waitFor(() => expect(result.current.data).toEqual({ ok: true, data: [] }));
    expect(listPending).toHaveBeenCalledWith({ sessionId: "session-1" });
  });

  it("sends an Approve now instead of holding it for the connection to return", async () => {
    const client = new QueryClient();
    const { result } = renderHook(() => useApprove(), { wrapper: wrapper(client) });

    await result.current.mutateAsync({ id: "ap-1" });

    expect(approve).toHaveBeenCalledWith({ id: "ap-1" });
  });
});
