import { afterEach, describe, expect, it, vi } from "vitest";
import { BlockscoutErrorCodes } from "@tools/blockscout/errors.js";
import { ROBINHOOD_BLOCKSCOUT_HOST } from "@tools/blockscout/operation.js";
import { fetchBlockscoutAddressTokenBalances } from "../http.js";

const PUBLIC_ADDRESS = "0x0000000000000000000000000000000000000001";

afterEach(() => {
  vi.useRealTimers();
});

function trackedStream(chunks: readonly Uint8Array[]): {
  readonly stream: ReadableStream<Uint8Array>;
  readonly emitted: () => number;
  readonly cancelled: () => boolean;
} {
  let index = 0;
  let emittedCount = 0;
  let wasCancelled = false;
  return {
    stream: new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[index];
        if (chunk === undefined) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
        index += 1;
        emittedCount += 1;
      },
      cancel() {
        wasCancelled = true;
      },
    }),
    emitted: () => emittedCount,
    cancelled: () => wasCancelled,
  };
}

describe("fetchBlockscoutAddressTokenBalances", () => {
  it("can request only the exact HTTPS host and token-balances path", async () => {
    let capturedUrl: string | null = null;
    let capturedInit: RequestInit | null = null;
    const result = await fetchBlockscoutAddressTokenBalances(
      async (url, init) => {
        capturedUrl = url;
        capturedInit = init;
        return new Response("[]", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
      PUBLIC_ADDRESS,
      { timeoutMs: 5_000, maxBytes: 1_000 },
    );

    expect(capturedUrl).toBe(
      `https://${ROBINHOOD_BLOCKSCOUT_HOST}/api/v2/addresses/${PUBLIC_ADDRESS}/token-balances`,
    );
    expect(capturedInit).toEqual(
      expect.objectContaining({
        method: "GET",
        redirect: "error",
        credentials: "omit",
        headers: { accept: "application/json" },
      }),
    );
    expect(result.status).toBe(200);
    expect(new TextDecoder().decode(result.body)).toBe("[]");
  });

  it("rejects an invalid address before the fetch capability is invoked", async () => {
    let invoked = false;
    await expect(
      fetchBlockscoutAddressTokenBalances(
        async () => {
          invoked = true;
          return new Response("[]");
        },
        "https://example.com/",
        { timeoutMs: 5_000, maxBytes: 1_000 },
      ),
    ).rejects.toMatchObject({ code: BlockscoutErrorCodes.ADDRESS_INVALID });
    expect(invoked).toBe(false);
  });

  it("rejects and cancels an over-cap stream before draining every chunk", async () => {
    const body = trackedStream([
      new Uint8Array(40),
      new Uint8Array(40),
      new Uint8Array(40),
      new Uint8Array(40),
    ]);

    await expect(
      fetchBlockscoutAddressTokenBalances(
        async () =>
          new Response(body.stream, {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        PUBLIC_ADDRESS,
        { timeoutMs: 5_000, maxBytes: 50 },
      ),
    ).rejects.toMatchObject({ code: BlockscoutErrorCodes.RESPONSE_OVER_CAP });
    expect(body.emitted()).toBeLessThan(4);
    expect(body.cancelled()).toBe(true);
  });

  it("refuses a response whose final URL escaped the exact operation", async () => {
    await expect(
      fetchBlockscoutAddressTokenBalances(
        async () => Response.redirect("https://example.com/escaped", 302),
        PUBLIC_ADDRESS,
        { timeoutMs: 5_000, maxBytes: 1_000 },
      ),
    ).rejects.toMatchObject({ code: BlockscoutErrorCodes.REDIRECT_REFUSED });
  });

  it("propagates caller cancellation with its own typed outcome", async () => {
    const caller = new AbortController();
    const pending = fetchBlockscoutAddressTokenBalances(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
      PUBLIC_ADDRESS,
      { timeoutMs: 5_000, maxBytes: 1_000, signal: caller.signal },
    );
    caller.abort();

    await expect(pending).rejects.toMatchObject({
      code: BlockscoutErrorCodes.TRANSPORT_CANCELLED,
    });
  });

  it("owns a hard timeout for the complete request", async () => {
    vi.useFakeTimers();
    const pending = fetchBlockscoutAddressTokenBalances(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
      PUBLIC_ADDRESS,
      { timeoutMs: 25, maxBytes: 1_000 },
    );
    const rejected = expect(pending).rejects.toMatchObject({
      code: BlockscoutErrorCodes.TRANSPORT_TIMEOUT,
    });

    await vi.advanceTimersByTimeAsync(25);
    await rejected;
  });
});
