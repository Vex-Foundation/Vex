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
 *  - it works IDENTICALLY with the site bridge registered, which is the state
 *    the desktop app is in. This is the production-routing regression: the
 *    bridge's host allowlist does not admit `api.dexscreener.com`, so a seam
 *    that asked the registry which transport is in force would throw before the
 *    network in the shipped app and pass everywhere else;
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
} from "@tools/dexscreener/transport.js";
import {
  PRICE_READ_MAX_BYTES,
  readPair,
  readTokenPools,
  readTokensPairs,
  resetPriceReadCacheForTests,
} from "@tools/dexscreener/price-read.js";

const TOKEN = "0x532f27101965dd16442e59d40670faf5ebb142e4";
const PAIR = "0xd0b53d9277642d899df5c87a3966a349a798f224";

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


/**
 * The production-routing regression demanded by the S11 review.
 *
 * The registered transport here is a faithful stand-in for the shipped site
 * bridge: it applies the SAME host rule as
 * `vex-app/src/main/dexscreener-bridge/allowlist.ts`, which admits
 * `io.dexscreener.com` and `dd.dexscreener.com` and refuses everything else by
 * name before any network call. Every read in this seam targets
 * `api.dexscreener.com`, so if `price-read` ever asks the registry which
 * transport is in force again, every case below fails with
 * `not on the bridge allowlist` - which is exactly what the desktop app did.
 */
describe("price-read with the site bridge registered (the desktop app's state)", () => {
  const BRIDGE_HOSTS: readonly string[] = ["io.dexscreener.com", "dd.dexscreener.com"];

  let unregister: (() => void) | null = null;
  let bridgeCalls: string[] = [];

  beforeEach(() => {
    bridgeCalls = [];
    const bridge: DexScreenerTransport = {
      name: "site_bridge",
      capabilities: { site: true, publicApi: true },
      async httpGet(url) {
        bridgeCalls.push(url);
        const host = new URL(url).host;
        if (!BRIDGE_HOSTS.includes(host)) {
          throw new Error(`host "${host}" is not on the bridge allowlist`);
        }
        return {
          url,
          status: 200,
          headers: new Map<string, string>(),
          body: encode([]),
        };
      },
      async wsExchange() {
        throw new Error("this suite opens no WebSocket");
      },
    };
    unregister = registerDexScreenerTransport(bridge);
  });

  afterEach(() => {
    unregister?.();
    unregister = null;
  });

  it("serves all three reads through the public transport, never through the bridge", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      seen.push(url);
      return new Response(JSON.stringify(url.includes("/latest/dex/pairs/") ? { pairs: [] } : []), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    await expect(readTokenPools("base", TOKEN)).resolves.toEqual([]);
    await expect(readPair("base", PAIR)).resolves.toMatchObject({ pairs: [] });
    await expect(readTokensPairs("base", TOKEN)).resolves.toEqual([]);

    expect(seen).toEqual([
      `${DEXSCREENER_PUBLIC_API_ORIGIN}/token-pairs/v1/base/${TOKEN}`,
      `${DEXSCREENER_PUBLIC_API_ORIGIN}/latest/dex/pairs/base/${PAIR}`,
      `${DEXSCREENER_PUBLIC_API_ORIGIN}/tokens/v1/base/${TOKEN}`,
    ]);
    // The privileged capability was never pointed at a host it cannot serve.
    expect(bridgeCalls).toEqual([]);
  });
});

describe("price-read caller policy and provider outcomes", () => {
  it("bounds the CALLER'S wait and leaves the shared request for the other caller", async () => {
    let release = (): void => {};
    const arrived = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requests = 0;
    vi.stubGlobal("fetch", async () => {
      requests += 1;
      await arrived;
      return new Response(JSON.stringify([]), { status: 200 });
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
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify([]), { status: 200 }));
    const aborter = new AbortController();
    aborter.abort(new Error("the poller is shutting down"));

    await expect(
      readTokenPools("base", TOKEN, { signal: aborter.signal }),
    ).rejects.toThrow(/shutting down/);
  });

  it("maps a 429 to a typed refusal and does not retry it", async () => {
    let requests = 0;
    vi.stubGlobal("fetch", async () => {
      requests += 1;
      return new Response(JSON.stringify({ error: "slow down" }), {
        status: 429,
        headers: { "retry-after": "1" },
      });
    });

    await expect(readTokenPools("base", TOKEN)).rejects.toMatchObject({
      code: expect.stringMatching(/^DEXSCREENER_/),
    });
    expect(requests).toBe(1);
  });

  it("refuses an over-cap body by name instead of parsing part of it", async () => {
    const oversize = "x".repeat(PRICE_READ_MAX_BYTES + 1);
    vi.stubGlobal("fetch", async () => new Response(oversize, { status: 200 }));

    await expect(readTokenPools("base", TOKEN)).rejects.toMatchObject({
      code: "DEXSCREENER_RESPONSE_OVER_CAP",
    });
  });

  it("serves a repeat read of the same URL from cache without a second request", async () => {
    let requests = 0;
    vi.stubGlobal("fetch", async () => {
      requests += 1;
      return new Response(JSON.stringify([]), { status: 200 });
    });

    await readTokenPools("base", TOKEN);
    await readTokenPools("base", TOKEN);

    // This is what makes a 3 s poll cadence affordable against a 30 s TTL.
    expect(requests).toBe(1);
  });
});
