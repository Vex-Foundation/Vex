/**
 * The transport seam's contract: single-owner registry, honest capabilities,
 * and typed outcomes for the four things that can go wrong (wrong host, over
 * cap, cancelled, timed out).
 *
 * `fetch` is the only thing stubbed. It is the external boundary; everything
 * else here is the real module.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEXSCREENER_PUBLIC_API_ORIGIN,
  DEXSCREENER_CATALOG_ORIGIN,
  defaultPublicApiTransport,
  getDexScreenerTransport,
  registerDexScreenerTransport,
  type DexScreenerTransport,
} from "../../tools/dexscreener/transport.js";
import { DexScreenerSiteErrorCodes } from "../../tools/dexscreener/site-errors.js";
import { VexError } from "../../errors.js";

const releases: (() => void)[] = [];

afterEach(() => {
  while (releases.length > 0) releases.pop()?.();
  vi.unstubAllGlobals();
});

function claim(transport: DexScreenerTransport): () => void {
  const release = registerDexScreenerTransport(transport);
  releases.push(release);
  return release;
}

const fakeSiteTransport: DexScreenerTransport = {
  name: "site_bridge",
  capabilities: { site: true, publicApi: true },
  httpGet: () => Promise.reject(new Error("not used")),
  wsExchange: () => Promise.reject(new Error("not used")),
};

function caught(run: () => unknown): VexError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(VexError);
    return error as VexError;
  }
  throw new Error("expected the call to throw");
}

async function caughtAsync(run: () => Promise<unknown>): Promise<VexError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(VexError);
    return error as VexError;
  }
  throw new Error("expected the call to reject");
}

describe("transport registry", () => {
  it("serves the degraded public-API transport when no bridge is mounted", () => {
    const transport = getDexScreenerTransport();
    expect(transport).toBe(defaultPublicApiTransport);
    expect(transport.capabilities).toStrictEqual({ site: false, publicApi: true });
    expect(transport.name).toBe("public_api");
  });

  it("serves the registered transport once one claims the slot", () => {
    claim(fakeSiteTransport);
    expect(getDexScreenerTransport()).toBe(fakeSiteTransport);
    expect(getDexScreenerTransport().capabilities.site).toBe(true);
  });

  it("refuses a second registration by name instead of replacing the owner", () => {
    claim(fakeSiteTransport);
    const error = caught(() => registerDexScreenerTransport(fakeSiteTransport));
    expect(error.code).toBe(
      DexScreenerSiteErrorCodes.TRANSPORT_ALREADY_REGISTERED
    );
    expect(getDexScreenerTransport()).toBe(fakeSiteTransport);
  });

  it("releases the slot idempotently, and a stale release cannot evict a newer owner", () => {
    const release = claim(fakeSiteTransport);
    release();
    release();
    expect(getDexScreenerTransport()).toBe(defaultPublicApiTransport);

    const second: DexScreenerTransport = { ...fakeSiteTransport };
    claim(second);
    release();
    expect(getDexScreenerTransport()).toBe(second);
  });
});

describe("default public-API transport", () => {
  it("refuses a site host with the unavailable-transport code, not a provider error", async () => {
    const error = await caughtAsync(() =>
      defaultPublicApiTransport.httpGet(
        "https://io.dexscreener.com/dex/search/v12/pairs?q=CAT",
        { timeoutMs: 1000 }
      )
    );
    expect(error.code).toBe(
      DexScreenerSiteErrorCodes.SITE_TRANSPORT_UNAVAILABLE
    );
    expect(error.message).toContain("https://io.dexscreener.com");
    expect(error.message).toContain(DEXSCREENER_PUBLIC_API_ORIGIN);
    expect(error.hint).toContain("desktop app");
  });

  /**
   * S9-8. `dd.dexscreener.com` is a site host by ownership and NOT by gating:
   * measured 2026-08-25 with Node's own `fetch` and no browser impersonation,
   * the chain catalog answered HTTP 200 with 63,237 bytes. Refusing it
   * headlessly made `chains_list` unavailable outside the desktop app, and
   * with it the remedy every "unknown chain" refusal points at. The pair of
   * tests below is the boundary: the catalog host passes, the gated site host
   * does not.
   */
  it("reaches the chain catalog host, because that host has no fingerprint gate", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      expect(url).toBe(`${DEXSCREENER_CATALOG_ORIGIN}/ds-data/v2/chains/by-trending`);
      return new Response(new Uint8Array([7]), { status: 200 });
    });
    const response = await defaultPublicApiTransport.httpGet(
      `${DEXSCREENER_CATALOG_ORIGIN}/ds-data/v2/chains/by-trending`,
      { timeoutMs: 1000 }
    );
    expect(response.status).toBe(200);
  });

  it("names both reachable origins when it refuses a third one", async () => {
    const error = await caughtAsync(() =>
      defaultPublicApiTransport.httpGet("https://example.com/x", {
        timeoutMs: 1000,
      })
    );
    expect(error.code).toBe(
      DexScreenerSiteErrorCodes.SITE_TRANSPORT_UNAVAILABLE
    );
    expect(error.message).toContain(DEXSCREENER_PUBLIC_API_ORIGIN);
    expect(error.message).toContain(DEXSCREENER_CATALOG_ORIGIN);
  });

  it("refuses every WebSocket with the same typed outcome", async () => {
    const error = await caughtAsync(() =>
      defaultPublicApiTransport.wsExchange(
        "wss://io.dexscreener.com/dex/screener/v7/pairs/h24/1",
        { expect: { binaryFrames: 2, maxTotalBytes: 1 }, timeoutMs: 1000 }
      )
    );
    expect(error.code).toBe(
      DexScreenerSiteErrorCodes.SITE_TRANSPORT_UNAVAILABLE
    );
    expect(error.message).toContain("io.dexscreener.com");
  });

  it("returns status, lowercased headers and the whole body", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      expect(url).toBe(`${DEXSCREENER_PUBLIC_API_ORIGIN}/latest/dex/tokens/x`);
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "Content-Type": "application/json", "CF-Ray": "abc" },
      });
    });
    const response = await defaultPublicApiTransport.httpGet(
      `${DEXSCREENER_PUBLIC_API_ORIGIN}/latest/dex/tokens/x`,
      { timeoutMs: 1000 }
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("cf-ray")).toBe("abc");
    expect([...response.body]).toStrictEqual([1, 2, 3]);
  });

  it("rejects an over-cap body by naming the cap, with no truncated result", async () => {
    vi.stubGlobal("fetch", async () => new Response(new Uint8Array(10)));
    const error = await caughtAsync(() =>
      defaultPublicApiTransport.httpGet(
        `${DEXSCREENER_PUBLIC_API_ORIGIN}/latest/dex/tokens/x`,
        { timeoutMs: 1000, maxBytes: 4 }
      )
    );
    expect(error.code).toBe(DexScreenerSiteErrorCodes.RESPONSE_OVER_CAP);
    expect(error.message).toContain("10 bytes");
    expect(error.message).toContain("4 bytes");
  });

  it("reports a caller cancellation as cancelled, not as a provider failure", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const abortError = new Error("aborted");
          abortError.name = "AbortError";
          reject(abortError);
        });
      });
    });
    const pending = defaultPublicApiTransport.httpGet(
      `${DEXSCREENER_PUBLIC_API_ORIGIN}/latest/dex/tokens/x`,
      { timeoutMs: 10_000, signal: controller.signal }
    );
    controller.abort();
    const error = await caughtAsync(() => pending);
    expect(error.code).toBe(DexScreenerSiteErrorCodes.TRANSPORT_CANCELLED);
  });

  it("reports its own deadline as a timeout naming the budget", async () => {
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const abortError = new Error("aborted");
          abortError.name = "AbortError";
          reject(abortError);
        });
      });
    });
    const error = await caughtAsync(() =>
      defaultPublicApiTransport.httpGet(
        `${DEXSCREENER_PUBLIC_API_ORIGIN}/latest/dex/tokens/x`,
        { timeoutMs: 5 }
      )
    );
    expect(error.code).toBe(DexScreenerSiteErrorCodes.TRANSPORT_TIMEOUT);
    expect(error.message).toContain("5 ms");
  });

  it("reports an unreachable host as a transport failure with no claim about the endpoint", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    const error = await caughtAsync(() =>
      defaultPublicApiTransport.httpGet(
        `${DEXSCREENER_PUBLIC_API_ORIGIN}/latest/dex/tokens/x`,
        { timeoutMs: 1000 }
      )
    );
    expect(error.code).toBe(DexScreenerSiteErrorCodes.TRANSPORT_FAILED);
    expect(error.hint).toContain("not a provider refusal");
  });
});
