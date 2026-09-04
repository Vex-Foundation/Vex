import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  net: { fetch: vi.fn() },
}));

const { BlockscoutErrorCodes } = await import("@tools/blockscout/errors.js");
const { createBlockscoutBridgeTransport } = await import("../index.js");

const PUBLIC_ADDRESS = "0x0000000000000000000000000000000000000001";

describe("createBlockscoutBridgeTransport", () => {
  it("closes admission, cancels active work, and joins one idempotent drain", async () => {
    let requestSignal: AbortSignal | null = null;
    const requestWasAborted = (): boolean => requestSignal?.aborted ?? false;
    const handle = createBlockscoutBridgeTransport(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          requestSignal = init.signal ?? null;
          init.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    );

    const activeRequest = handle.transport.fetchAddressTokenBalances(
      PUBLIC_ADDRESS,
      { timeoutMs: 5_000, maxBytes: 1_000 },
    );
    await Promise.resolve();

    const firstDispose = handle.dispose();
    const secondDispose = handle.dispose();
    expect(firstDispose).toBe(secondDispose);
    expect(requestWasAborted()).toBe(true);
    await expect(activeRequest).rejects.toMatchObject({
      code: BlockscoutErrorCodes.TRANSPORT_UNAVAILABLE,
    });
    await firstDispose;

    await expect(
      handle.transport.fetchAddressTokenBalances(PUBLIC_ADDRESS, {
        timeoutMs: 5_000,
        maxBytes: 1_000,
      }),
    ).rejects.toMatchObject({
      code: BlockscoutErrorCodes.TRANSPORT_UNAVAILABLE,
    });
  });

  it("does not invoke Electron for a caller already cancelled", async () => {
    const fetcher = vi.fn(async () => new Response("[]"));
    const handle = createBlockscoutBridgeTransport(fetcher);
    const caller = new AbortController();
    caller.abort();

    await expect(
      handle.transport.fetchAddressTokenBalances(PUBLIC_ADDRESS, {
        timeoutMs: 5_000,
        maxBytes: 1_000,
        signal: caller.signal,
      }),
    ).rejects.toMatchObject({
      code: BlockscoutErrorCodes.TRANSPORT_CANCELLED,
    });
    expect(fetcher).not.toHaveBeenCalled();
    await handle.dispose();
  });
});
