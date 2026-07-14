import { describe, expect, it, vi } from "vitest";

import { HyperliquidInfoClient } from "@tools/hyperliquid/info.js";

describe("HyperliquidInfoClient candleSnapshot", () => {
  it("posts the venue-required req wrapper instead of the former flat payload", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }));
    const client = new HyperliquidInfoClient({ fetchFn });

    await client.candleSnapshot({
      coin: "BTC",
      interval: "1h",
      startTime: 1_700_000_000_000,
      endTime: 1_700_025_200_000,
    });

    expect(fetchFn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: JSON.stringify({
          type: "candleSnapshot",
          req: {
            coin: "BTC",
            interval: "1h",
            startTime: 1_700_000_000_000,
            endTime: 1_700_025_200_000,
          },
        }),
      }),
    );
    expect(fetchFn).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: JSON.stringify({
          type: "candleSnapshot",
          coin: "BTC",
          interval: "1h",
          startTime: 1_700_000_000_000,
          endTime: 1_700_025_200_000,
        }),
      }),
    );
  });
});

describe("HyperliquidInfoClient account-history endpoints", () => {
  it.each([
    ["userTwapSliceFills", (c: HyperliquidInfoClient, user: string) => c.userTwapSliceFills(user)],
    ["historicalOrders", (c: HyperliquidInfoClient, user: string) => c.historicalOrders(user)],
  ] as const)("posts the %s info type with the user payload", async (type, call) => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }));
    const client = new HyperliquidInfoClient({ fetchFn });
    const user = "0x00000000000000000000000000000000000000ab";

    await call(client, user);

    expect(fetchFn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ body: JSON.stringify({ type, user }) }),
    );
  });
});
