import { describe, expect, it, vi } from "vitest";
import { configureEvmRpcFetch, getEvmRpcFetch } from "@tools/evm-chains/rpc-fetch.js";

describe("RPC HTTP adapter lifecycle", () => {
  it("keeps captured clients stable and does not let an older cleanup remove the newer adapter", () => {
    const first = vi.fn<typeof fetch>();
    const second = vi.fn<typeof fetch>();
    const removeFirst = configureEvmRpcFetch(first);
    const captured = getEvmRpcFetch();
    const removeSecond = configureEvmRpcFetch(second);
    try {
      removeFirst();
      expect(getEvmRpcFetch()).toBe(second);
      expect(captured).toBe(first);
    } finally {
      removeSecond();
    }
    expect(getEvmRpcFetch()).toBe(fetch);
  });
});
