/**
 * The host-conditioned header decision (`requestHeaders`) and the streaming
 * byte bound (`readBoundedBody`, exercised through `siteHttpGet`).
 *
 * Both are proven on a CAPTURED REQUEST, never on prose: `requestHeaders` is
 * asserted directly, and `siteHttpGet` is driven against a fake `BridgeSession`
 * whose `fetch` records exactly what it was called with.
 */

import { describe, expect, it, vi } from "vitest";
import type { HttpGetOptions } from "@tools/dexscreener/transport.js";
import { DexScreenerSiteErrorCodes } from "@tools/dexscreener/site-errors.js";
import { checkHttpUrl, DEXSCREENER_CDN_HOST, sendsSiteOrigin } from "../allowlist.js";
import { CHROME_USER_AGENT, requestHeaders, siteHttpGet } from "../http.js";
import type { BridgeSession } from "../ws-bridge.js";

// ── requestHeaders: the pure host-conditioned decision ────────────────────

describe("requestHeaders", () => {
  it("gives io.dexscreener.com the site Origin and Referer plus the client hints", () => {
    const headers = requestHeaders("application/json", "io.dexscreener.com");
    expect(headers["Origin"]).toBe("https://dexscreener.com");
    expect(headers["Referer"]).toBe("https://dexscreener.com/");
    expect(headers["User-Agent"]).toBe(CHROME_USER_AGENT);
    expect(headers["sec-ch-ua"]).toContain("Chromium");
    expect(headers["sec-ch-ua-mobile"]).toBe("?0");
    expect(headers["sec-ch-ua-platform"]).toBe('"Windows"');
  });

  it("gives the CDN the same client identity but NO Origin and NO Referer key at all", () => {
    const headers = requestHeaders("image/png,image/webp", "cdn.dexscreener.com");
    expect(headers["User-Agent"]).toBe(CHROME_USER_AGENT);
    expect(headers["sec-ch-ua"]).toContain("Chromium");
    expect(headers["sec-ch-ua-mobile"]).toBe("?0");
    expect(headers["sec-ch-ua-platform"]).toBe('"Windows"');
    // Absence of the KEY, not merely a falsy value: a header that is present
    // but empty would still leak that an origin decision was made for this host.
    expect("Origin" in headers).toBe(false);
    expect("Referer" in headers).toBe(false);
  });

  it("sendsSiteOrigin is false only for the CDN host", () => {
    expect(sendsSiteOrigin("io.dexscreener.com")).toBe(true);
    expect(sendsSiteOrigin("dd.dexscreener.com")).toBe(true);
    expect(sendsSiteOrigin(DEXSCREENER_CDN_HOST)).toBe(false);
  });
});

// ── allowlist: the CDN path prefix ─────────────────────────────────────────

describe("checkHttpUrl - the CDN path prefix", () => {
  it("allows the icon path prefix", () => {
    expect(checkHttpUrl("https://cdn.dexscreener.com/cms/images/abc").allowed).toBe(true);
  });

  it("refuses a different path on the same host", () => {
    const decision = checkHttpUrl("https://cdn.dexscreener.com/other/abc");
    expect(decision.allowed).toBe(false);
  });

  it("refuses an unrelated host entirely", () => {
    expect(checkHttpUrl("https://evil.example/cms/images/abc").allowed).toBe(false);
  });
});

// ── siteHttpGet: the captured-request proof ────────────────────────────────

/** Minimal Headers-like object satisfying the `forEach(value, key)` the code reads. */
function fakeHeaders(entries: ReadonlyArray<readonly [string, string]>): {
  forEach: (cb: (value: string, key: string) => void) => void;
} {
  return {
    forEach(cb: (value: string, key: string) => void): void {
      for (const [key, value] of entries) cb(value, key);
    },
  };
}

function fakeSession(
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>,
): BridgeSession {
  return {
    setUserAgent: () => undefined,
    webRequest: {
      onBeforeSendHeaders: (() => undefined) as BridgeSession["webRequest"]["onBeforeSendHeaders"],
      onHeadersReceived: (() => undefined) as BridgeSession["webRequest"]["onHeadersReceived"],
    },
    setPermissionCheckHandler: () => undefined,
    setPermissionRequestHandler: () => undefined,
    setDevicePermissionHandler: () => undefined,
    protocol: { handle: () => undefined, unhandle: () => undefined },
    fetch: fetchImpl as BridgeSession["fetch"],
  };
}

function baseOptions(overrides: Partial<HttpGetOptions> = {}): HttpGetOptions {
  return { timeoutMs: 5000, ...overrides };
}

describe("siteHttpGet - captured headers differ by host exactly as requestHeaders predicts", () => {
  it("sends Origin/Referer to io.dexscreener.com", async () => {
    let captured: RequestInit | undefined;
    const session = fakeSession(async (_url, init) => {
      captured = init;
      return {
        url: "",
        status: 200,
        headers: fakeHeaders([["content-type", "application/json"]]) as unknown as Headers,
        body: null,
        arrayBuffer: async () => new ArrayBuffer(0),
      } as unknown as Response;
    });

    await siteHttpGet(session, "https://io.dexscreener.com/dex/search/v12/pairs?q=CAT", baseOptions());

    const headers = captured?.headers as Record<string, string>;
    expect(headers["Origin"]).toBe("https://dexscreener.com");
    expect(headers["Referer"]).toBe("https://dexscreener.com/");
  });

  it("sends NO Origin/Referer to cdn.dexscreener.com, same User-Agent otherwise", async () => {
    let captured: RequestInit | undefined;
    const session = fakeSession(async (_url, init) => {
      captured = init;
      return {
        url: "",
        status: 200,
        headers: fakeHeaders([["content-type", "image/png"]]) as unknown as Headers,
        body: null,
        arrayBuffer: async () => new ArrayBuffer(0),
      } as unknown as Response;
    });

    await siteHttpGet(session, "https://cdn.dexscreener.com/cms/images/abc", baseOptions());

    const headers = captured?.headers as Record<string, string>;
    expect(headers["User-Agent"]).toBe(CHROME_USER_AGENT);
    expect("Origin" in headers).toBe(false);
    expect("Referer" in headers).toBe(false);
  });
});

// ── The streaming byte bound: applied DURING the read, not after ──────────

/** A ReadableStream<Uint8Array> that records whether it was fully drained. */
function trackedStream(chunks: readonly Uint8Array[]): {
  stream: ReadableStream<Uint8Array>;
  emittedCount: () => number;
  cancelled: () => boolean;
} {
  let emitted = 0;
  let wasCancelled = false;
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      const chunk = chunks[index];
      if (chunk === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(chunk);
      index += 1;
      emitted += 1;
    },
    cancel() {
      wasCancelled = true;
    },
  });
  return { stream, emittedCount: () => emitted, cancelled: () => wasCancelled };
}

describe("siteHttpGet - the response body is bounded DURING the read", () => {
  it("throws RESPONSE_OVER_CAP and cancels the stream before every chunk was drained", async () => {
    const chunks = [new Uint8Array(40), new Uint8Array(40), new Uint8Array(40), new Uint8Array(40)];
    const { stream, emittedCount, cancelled } = trackedStream(chunks);

    const session = fakeSession(async () => {
      return {
        url: "",
        status: 200,
        headers: fakeHeaders([]) as unknown as Headers,
        body: stream,
        arrayBuffer: async () => {
          throw new Error("must not buffer the whole body when maxBytes is set");
        },
      } as unknown as Response;
    });

    await expect(
      siteHttpGet(session, "https://cdn.dexscreener.com/cms/images/abc", baseOptions({ maxBytes: 50 })),
    ).rejects.toMatchObject({ code: DexScreenerSiteErrorCodes.RESPONSE_OVER_CAP });

    // The cap (50 bytes) is passed after the SECOND 40-byte chunk (80 total).
    // A buffer-then-check implementation would have pulled every chunk before
    // ever refusing; this one stops with chunks still unread.
    expect(emittedCount()).toBeLessThan(chunks.length);
    expect(cancelled()).toBe(true);
  });

  it("returns the complete bytes for a normal under-cap body", async () => {
    const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])];
    const { stream } = trackedStream(chunks);

    const session = fakeSession(async () => {
      return {
        url: "",
        status: 200,
        headers: fakeHeaders([]) as unknown as Headers,
        body: stream,
        arrayBuffer: async () => new ArrayBuffer(0),
      } as unknown as Response;
    });

    const result = await siteHttpGet(
      session,
      "https://cdn.dexscreener.com/cms/images/abc",
      baseOptions({ maxBytes: 1000 }),
    );
    expect([...result.body]).toEqual([1, 2, 3, 4, 5]);
  });
});
