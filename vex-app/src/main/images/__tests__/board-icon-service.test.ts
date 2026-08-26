/**
 * board-icon-service.ts - the board token icon trust boundary.
 *
 * Driven directly against `createBoardIconService(fakeFetcher)` (exported for
 * exactly this). No Electron, no network: the fetcher is a hand-rolled fake so
 * every response, delay, and rejection is scripted deterministically. Real
 * image headers are built byte-by-byte, the same technique
 * `image-validation.test.ts` uses, because a checked-in binary fixture would
 * hide the exact bytes these assertions are about.
 *
 * What this file proves, matching the service's own contract:
 *  - the renderer-invisible URL composition and the fixed request budget;
 *  - the three-way outcome split (image / absent / unavailable) and which
 *    side of it gets cached;
 *  - declared-MIME-vs-magic-bytes agreement, and the dimension ceiling;
 *  - single-flight, the concurrency ceiling, and bounded queueing;
 *  - dispose() as a real teardown: idempotent, draining, and abort-propagating.
 */

import { describe, expect, it, vi } from "vitest";
import { DexScreenerSiteErrorCodes, siteError } from "@tools/dexscreener/site-errors.js";
import type { TransportResponse } from "@tools/dexscreener/transport.js";
import {
  BOARD_ICON_MAX_BYTES,
  BOARD_ICON_MAX_DIMENSION,
  createBoardIconService,
  mountBoardIconService,
  resolveBoardIcon,
  type BoardIconFetcher,
} from "../board-icon-service.js";

// ── Fixture builders (byte-by-byte, per repo convention) ──────────────────

/** Minimal PNG: signature + a well-formed IHDR carrying the dimensions. */
function pngFixture(width: number, height: number, pad = 64): Uint8Array {
  const out = new Uint8Array(33 + pad);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(out.buffer);
  view.setUint32(8, 13); // IHDR length
  out.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  view.setUint32(16, width);
  view.setUint32(20, height);
  return out;
}

/** Minimal JPEG: SOI + SOF0 carrying height-before-width. */
function jpegFixture(width: number, height: number, pad = 64): Uint8Array {
  const head = [
    0xff, 0xd8, // SOI
    0xff, 0xc0, 0x00, 0x11, 0x08, // SOF0, length 17, 8-bit precision
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
  ];
  const out = new Uint8Array(head.length + pad);
  out.set(head, 0);
  return out;
}

function riffContainer(fourCc: string, payload: number[]): Uint8Array {
  const body = [...new TextEncoder().encode("WEBP"), ...new TextEncoder().encode(fourCc), ...payload];
  const out = new Uint8Array(8 + body.length);
  out.set(new TextEncoder().encode("RIFF"), 0);
  new DataView(out.buffer).setUint32(4, body.length, true);
  out.set(body, 8);
  return out;
}

/** Lossy WebP (`VP8 `): 14-bit width/height little-endian at chunk offset 6/8. */
function webpLossyFixture(width: number, height: number): Uint8Array {
  const payload = new Array<number>(14).fill(0);
  payload[7] = 0x9d;
  payload[8] = 0x01;
  payload[9] = 0x2a;
  payload[10] = width & 0xff;
  payload[11] = (width >> 8) & 0x3f;
  payload[12] = height & 0xff;
  payload[13] = (height >> 8) & 0x3f;
  return riffContainer("VP8 ", payload);
}

function svgishBody(): Uint8Array {
  return new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
}

function response(
  status: number,
  contentType: string | undefined,
  body: Uint8Array,
): TransportResponse {
  const headers = new Map<string, string>();
  if (contentType !== undefined) headers.set("content-type", contentType);
  return { url: "https://cdn.dexscreener.com/cms/images/x", status, headers, body };
}

// ── Fetcher fakes ───────────────────────────────────────────────────────

interface RecordedCall {
  readonly url: string;
  readonly options: Parameters<BoardIconFetcher>[1];
}

/** A fetcher whose scripted answers are consumed one call at a time. */
function scriptedFetcher(
  answers: ReadonlyArray<TransportResponse | Error>,
): { fetcher: BoardIconFetcher; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let index = 0;
  const fetcher: BoardIconFetcher = async (url, options) => {
    calls.push({ url, options });
    const answer = answers[Math.min(index, answers.length - 1)];
    index += 1;
    if (answer === undefined) {
      // Unreachable while at least one answer is scripted; named so an empty
      // script fails loudly instead of resolving undefined.
      throw new Error("scriptedFetcher: no answers were scripted");
    }
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { fetcher, calls };
}

/** A fetcher whose promise resolution is controlled by the test. */
function deferredFetcher(): {
  fetcher: BoardIconFetcher;
  calls: RecordedCall[];
  resolveNext: (value: TransportResponse) => void;
  rejectNext: (error: unknown) => void;
  pendingCount: () => number;
} {
  const calls: RecordedCall[] = [];
  const pending: Array<{
    resolve: (value: TransportResponse) => void;
    reject: (error: unknown) => void;
  }> = [];
  const fetcher: BoardIconFetcher = (url, options) => {
    calls.push({ url, options });
    return new Promise<TransportResponse>((resolve, reject) => {
      pending.push({ resolve, reject });
      // Mirrors the real transport: an aborted signal fails the request
      // rather than leaving it hanging forever, which is what lets
      // dispose() actually drain in-flight work instead of hanging the test.
      options.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
        once: true,
      });
    });
  };
  return {
    fetcher,
    calls,
    resolveNext: (value) => {
      const next = pending.shift();
      if (next === undefined) throw new Error("no pending fetch to resolve");
      next.resolve(value);
    },
    rejectNext: (error) => {
      const next = pending.shift();
      if (next === undefined) throw new Error("no pending fetch to reject");
      next.reject(error);
    },
    pendingCount: () => pending.length,
  };
}

const ID = "profile_abc123";

describe("createBoardIconService - URL composition and request budget", () => {
  it("composes the CDN URL from the id and fixes maxBytes/timeoutMs", async () => {
    const { fetcher, calls } = scriptedFetcher([response(200, "image/png", pngFixture(64, 64))]);
    const service = createBoardIconService(fetcher);
    await service.resolve(ID);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call === undefined) throw new Error("the service made no fetch call");
    expect(call.url.startsWith(`https://cdn.dexscreener.com/cms/images/${ID}`)).toBe(true);
    expect(call.options.maxBytes).toBe(BOARD_ICON_MAX_BYTES);
    expect(call.options.timeoutMs).toBe(10_000);
    await service.dispose();
  });
});

describe("createBoardIconService - happy path", () => {
  it("resolves a 200 png to an image dataUrl", async () => {
    const { fetcher } = scriptedFetcher([response(200, "image/png", pngFixture(64, 64))]);
    const service = createBoardIconService(fetcher);
    const outcome = await service.resolve(ID);
    expect(outcome.kind).toBe("image");
    if (outcome.kind === "image") {
      expect(outcome.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    }
    await service.dispose();
  });
});

describe("createBoardIconService - settled absence is cached, transient failure is not", () => {
  it("caches a 404 and never calls the fetcher again for the same id", async () => {
    const { fetcher, calls } = scriptedFetcher([response(404, undefined, new Uint8Array(0))]);
    const service = createBoardIconService(fetcher);

    const first = await service.resolve(ID);
    expect(first).toEqual({ kind: "absent", reason: "not_found" });
    const second = await service.resolve(ID);
    expect(second).toEqual({ kind: "absent", reason: "not_found" });
    expect(calls).toHaveLength(1);
    await service.dispose();
  });

  it("does NOT cache a transport rejection - a later resolve calls the fetcher again", async () => {
    const { fetcher, calls } = scriptedFetcher([
      new Error("ECONNRESET"),
      response(200, "image/png", pngFixture(64, 64)),
    ]);
    const service = createBoardIconService(fetcher);

    const first = await service.resolve(ID);
    expect(first).toEqual({ kind: "unavailable", reason: "transport" });
    const second = await service.resolve(ID);
    expect(second.kind).toBe("image");
    expect(calls).toHaveLength(2);
    await service.dispose();
  });

  it("does NOT cache a 503 either", async () => {
    const { fetcher, calls } = scriptedFetcher([
      response(503, undefined, new Uint8Array(0)),
      response(200, "image/png", pngFixture(64, 64)),
    ]);
    const service = createBoardIconService(fetcher);

    expect(await service.resolve(ID)).toEqual({ kind: "unavailable", reason: "transport" });
    expect((await service.resolve(ID)).kind).toBe("image");
    expect(calls).toHaveLength(2);
    await service.dispose();
  });
});

describe("createBoardIconService - MIME and magic bytes must agree", () => {
  it("refuses when content-type claims png but the bytes are webp", async () => {
    const { fetcher } = scriptedFetcher([response(200, "image/png", webpLossyFixture(64, 64))]);
    const service = createBoardIconService(fetcher);
    expect(await service.resolve(ID)).toEqual({ kind: "absent", reason: "unsupported_image" });
    await service.dispose();
  });

  it("refuses when content-type claims png but the bytes are jpeg", async () => {
    const { fetcher } = scriptedFetcher([response(200, "image/png", jpegFixture(64, 64))]);
    const service = createBoardIconService(fetcher);
    expect(await service.resolve(ID)).toEqual({ kind: "absent", reason: "unsupported_image" });
    await service.dispose();
  });

  it("refuses svg - no SVG ever, whatever the declared type", async () => {
    const { fetcher } = scriptedFetcher([response(200, "image/svg+xml", svgishBody())]);
    const service = createBoardIconService(fetcher);
    expect(await service.resolve(ID)).toEqual({ kind: "absent", reason: "unsupported_image" });
    await service.dispose();
  });
});

describe("createBoardIconService - the board dimension ceiling", () => {
  it("refuses a png past the ceiling (1024x1024)", async () => {
    const { fetcher } = scriptedFetcher([response(200, "image/png", pngFixture(1024, 1024))]);
    const service = createBoardIconService(fetcher);
    expect(await service.resolve(ID)).toEqual({ kind: "absent", reason: "unsupported_image" });
    await service.dispose();
  });

  it("accepts a png exactly at the ceiling (512x512), inclusive boundary", async () => {
    const { fetcher } = scriptedFetcher([
      response(200, "image/png", pngFixture(BOARD_ICON_MAX_DIMENSION, BOARD_ICON_MAX_DIMENSION)),
    ]);
    const service = createBoardIconService(fetcher);
    expect((await service.resolve(ID)).kind).toBe("image");
    await service.dispose();
  });
});

describe("createBoardIconService - over-cap", () => {
  it("maps the real RESPONSE_OVER_CAP transport code to absent/over_cap", async () => {
    const overCap = siteError(DexScreenerSiteErrorCodes.RESPONSE_OVER_CAP, "too big");
    const { fetcher } = scriptedFetcher([overCap]);
    const service = createBoardIconService(fetcher);
    expect(await service.resolve(ID)).toEqual({ kind: "absent", reason: "over_cap" });
    await service.dispose();
  });
});

describe("createBoardIconService - single-flight per id", () => {
  it("calls the fetcher exactly once for five concurrent resolves of the same id", async () => {
    const { fetcher, resolveNext, calls } = deferredFetcher();
    const service = createBoardIconService(fetcher);

    const promises = [
      service.resolve(ID),
      service.resolve(ID),
      service.resolve(ID),
      service.resolve(ID),
      service.resolve(ID),
    ];
    // Let the microtask queue settle so all five have reached the fetcher (or
    // joined the in-flight promise) before the single response is delivered.
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toHaveLength(1);

    resolveNext(response(200, "image/png", pngFixture(64, 64)));
    const outcomes = await Promise.all(promises);
    for (const outcome of outcomes) expect(outcome.kind).toBe("image");
    await service.dispose();
  });
});

describe("createBoardIconService - positive cache", () => {
  it("answers a second resolve from cache, without a second fetch", async () => {
    const { fetcher, calls } = scriptedFetcher([response(200, "image/png", pngFixture(64, 64))]);
    const service = createBoardIconService(fetcher);
    await service.resolve(ID);
    const second = await service.resolve(ID);
    expect(second.kind).toBe("image");
    expect(calls).toHaveLength(1);
    await service.dispose();
  });
});

describe("createBoardIconService - the concurrency ceiling", () => {
  it("admits at most 2 distinct ids in flight, and releases the rest once slots free up", async () => {
    const { fetcher, resolveNext, pendingCount } = deferredFetcher();
    const service = createBoardIconService(fetcher);

    const p1 = service.resolve("id-1");
    const p2 = service.resolve("id-2");
    const p3 = service.resolve("id-3");
    const p4 = service.resolve("id-4");
    await Promise.resolve();
    await Promise.resolve();

    // Only 2 fetches were actually admitted; the other two are queued, not
    // in flight against the fetcher.
    expect(pendingCount()).toBe(2);

    resolveNext(response(200, "image/png", pngFixture(64, 64)));
    resolveNext(response(200, "image/png", pngFixture(64, 64)));
    await Promise.resolve();
    await Promise.resolve();

    // Releasing the two active slots pumps the queue: the remaining two ids
    // now hold the fetcher's attention.
    expect(pendingCount()).toBe(2);

    resolveNext(response(200, "image/png", pngFixture(64, 64)));
    resolveNext(response(200, "image/png", pngFixture(64, 64)));
    const outcomes = await Promise.all([p1, p2, p3, p4]);
    for (const outcome of outcomes) expect(outcome.kind).toBe("image");
    await service.dispose();
  });
});

describe("createBoardIconService - queue overflow", () => {
  it("answers 'busy' rather than queueing without bound past the FIFO cap", async () => {
    const { fetcher, pendingCount } = deferredFetcher();
    const service = createBoardIconService(fetcher);

    // 2 admitted immediately (the concurrency ceiling), 16 queued (QUEUE_MAX),
    // for 18 total that the service will hold. The 19th distinct id must be
    // refused as busy rather than queued.
    const held: Array<Promise<unknown>> = [];
    for (let i = 0; i < 18; i += 1) held.push(service.resolve(`queued-${i}`));
    await Promise.resolve();
    expect(pendingCount()).toBe(2);

    const overflow = await service.resolve("queued-overflow");
    expect(overflow).toEqual({ kind: "unavailable", reason: "busy" });

    await service.dispose();
    await Promise.allSettled(held);
  });
});

describe("createBoardIconService - dispose()", () => {
  it("answers not_mounted after dispose", async () => {
    const { fetcher } = scriptedFetcher([response(200, "image/png", pngFixture(64, 64))]);
    const service = createBoardIconService(fetcher);
    await service.dispose();
    expect(await service.resolve(ID)).toEqual({ kind: "unavailable", reason: "not_mounted" });
  });

  it("aborts an in-flight fetch's signal", async () => {
    let capturedSignal: AbortSignal | undefined;
    const fetcher: BoardIconFetcher = (_url, options) => {
      capturedSignal = options.signal;
      return new Promise<TransportResponse>((_resolve, reject) => {
        // Never settles on its own - dispose must abort it, and this listener
        // is what lets the drain actually observe that abort.
        options.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
    };
    const service = createBoardIconService(fetcher);
    const pending = service.resolve(ID);
    await Promise.resolve();

    expect(capturedSignal?.aborted).toBe(false);
    const disposePromise = service.dispose();
    expect(capturedSignal?.aborted).toBe(true);

    await disposePromise;
    await pending;
  });

  it("is idempotent - a second dispose does not throw", async () => {
    const { fetcher } = scriptedFetcher([response(200, "image/png", pngFixture(64, 64))]);
    const service = createBoardIconService(fetcher);
    await service.dispose();
    await expect(service.dispose()).resolves.toBeUndefined();
  });

  it("resolves (drains) rather than hanging, even with in-flight work", async () => {
    const { fetcher } = deferredFetcher();
    const service = createBoardIconService(fetcher);
    const pending = service.resolve(ID);
    await Promise.resolve();

    // dispose() itself must settle - the deferred fetch is never resolved by
    // this test, only aborted by dispose. If dispose hung, this await would
    // hang the test until the suite timeout.
    await service.dispose();
    await pending;
  });
});

describe("mountBoardIconService / resolveBoardIcon", () => {
  it("answers not_mounted before anything is mounted", async () => {
    expect(await resolveBoardIcon(ID)).toEqual({ kind: "unavailable", reason: "not_mounted" });
  });

  it("routes to the mounted service once mounted", async () => {
    const { fetcher } = scriptedFetcher([response(200, "image/png", pngFixture(64, 64))]);
    const teardown = mountBoardIconService(fetcher);
    try {
      const outcome = await resolveBoardIcon(ID);
      expect(outcome.kind).toBe("image");
    } finally {
      teardown();
    }
  });

  it("the returned teardown unmounts - a later call answers not_mounted again", async () => {
    const { fetcher } = scriptedFetcher([response(200, "image/png", pngFixture(64, 64))]);
    const teardown = mountBoardIconService(fetcher);
    teardown();
    expect(await resolveBoardIcon(`${ID}-after-teardown`)).toEqual({
      kind: "unavailable",
      reason: "not_mounted",
    });
  });
});
