/**
 * The `price-read` seam's own contract.
 *
 * The consumer-level behavior is characterized in
 * `s11a-consumer-characterization.test.ts`, including agreement with the old
 * REST client on the same bytes. What is left to prove here belongs to the seam
 * itself and to nobody else:
 *
 *  - it works with NO transport registered, which is the state the agent
 *    process is in outside the desktop app and the state the price-watch poller
 *    runs in;
 *  - a caller's deadline bounds that CALLER and leaves the shared request
 *    running for whoever else is waiting on it;
 *  - a 429 parks the rate class instead of being retried;
 *  - an over-cap body is refused by name rather than parsed in part.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  DEXSCREENER_PUBLIC_API_ORIGIN,
  registerDexScreenerTransport,
  type DexScreenerTransport,
  type TransportResponse,
} from "@tools/dexscreener/transport.js";
import {
  PRICE_READ_MAX_BYTES,
  readTokenPools,
  resetPriceReadCacheForTests,
} from "@tools/dexscreener/price-read.js";

const TOKEN = "0x532f27101965dd16442e59d40670faf5ebb142e4";

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

beforeEach(() => {
  resetPriceReadCacheForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("price-read without a registered transport (headless)", () => {
  it("reaches the public API origin the degraded transport is allowed to serve", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      seen.push(url);
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    // No `registerDexScreenerTransport` call: this is the poller's own process
    // state outside the desktop app, and it must be a working read rather than
    // a "site transport unavailable" refusal.
    await expect(readTokenPools("base", TOKEN)).resolves.toEqual([]);
    expect(seen).toEqual([
      `${DEXSCREENER_PUBLIC_API_ORIGIN}/token-pairs/v1/base/${TOKEN}`,
    ]);
  });
});

describe("price-read with a registered transport", () => {
  let unregister: (() => void) | null = null;

  afterEach(() => {
    unregister?.();
    unregister = null;
  });

  function install(httpGet: DexScreenerTransport["httpGet"]): void {
    unregister = registerDexScreenerTransport({
      name: "site_bridge",
      capabilities: { site: true, publicApi: true },
      httpGet,
      async wsExchange() {
        throw new Error("this suite opens no WebSocket");
      },
    });
  }

  function respond(status: number, body: unknown, headers: Record<string, string> = {}): TransportResponse {
    return {
      url: "https://api.dexscreener.com/",
      status,
      headers: new Map(Object.entries(headers)),
      body: encode(body),
    };
  }

  it("bounds the CALLER'S wait and leaves the shared request for the other caller", async () => {
    let release = (): void => {};
    const arrived = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requests = 0;
    install(async () => {
      requests += 1;
      await arrived;
      return respond(200, []);
    });

    const impatient = readTokenPools("base", TOKEN, { timeoutMs: 5 });
    const patient = readTokenPools("base", TOKEN);

    await expect(impatient).rejects.toThrow(/timed out after 5ms/);
    release();

    // The abandoned wait did not cancel anything: the same in-flight request
    // answers the caller that was still waiting, and it was only ever ONE.
    await expect(patient).resolves.toEqual([]);
    expect(requests).toBe(1);
  });

  it("propagates the caller's own abort reason rather than a provider failure", async () => {
    install(async () => respond(200, []));
    const aborter = new AbortController();
    aborter.abort(new Error("the poller is shutting down"));

    await expect(
      readTokenPools("base", TOKEN, { signal: aborter.signal }),
    ).rejects.toThrow(/shutting down/);
  });

  it("maps a 429 to a typed refusal and does not retry it", async () => {
    let requests = 0;
    install(async () => {
      requests += 1;
      return respond(429, { error: "slow down" }, { "retry-after": "1" });
    });

    await expect(readTokenPools("base", TOKEN)).rejects.toMatchObject({
      code: expect.stringMatching(/^DEXSCREENER_/),
    });
    expect(requests).toBe(1);
  });

  it("passes the byte cap to the transport so a huge body is refused, not cut", async () => {
    const caps: (number | undefined)[] = [];
    install(async (_url, options) => {
      caps.push(options.maxBytes);
      return respond(200, []);
    });

    await readTokenPools("base", TOKEN);
    expect(caps).toEqual([PRICE_READ_MAX_BYTES]);
  });

  it("serves a repeat read of the same URL from cache without a second request", async () => {
    let requests = 0;
    install(async () => {
      requests += 1;
      return respond(200, []);
    });

    await readTokenPools("base", TOKEN);
    await readTokenPools("base", TOKEN);

    // This is what makes a 3 s poll cadence affordable against a 30 s TTL.
    expect(requests).toBe(1);
  });
});
