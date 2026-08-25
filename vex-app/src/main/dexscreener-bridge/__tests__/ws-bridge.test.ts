/**
 * Lifecycle contract of the WebSocket bridge, with a fake window in place of
 * Chromium.
 *
 * What a fake CAN prove: admission, allowlisting, single-flight, the
 * concurrency ceiling, deadline and cancellation handling, window reuse, and
 * that dispose releases everything exactly once. What it CANNOT prove is
 * covered by the real app: that Chromium's WebSocket opens against Cloudflare
 * with the injected Origin, and that `executeJavaScript` runs the page runtime
 * under the document's CSP. Those are named in the S1 report.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: class {},
  session: { fromPartition: () => ({}) },
  net: { fetch: () => Promise.reject(new Error("not used")) },
}));

const { DexScreenerWsBridge } = await import("../ws-bridge.js");
const { DexScreenerSiteErrorCodes } = await import(
  "@tools/dexscreener/site-errors.js"
);
type BridgeRuntime = import("../ws-bridge.js").BridgeRuntime;
type BridgeWindow = import("../ws-bridge.js").BridgeWindow;

const SCREENER_URL =
  "wss://io.dexscreener.com/dex/screener/v7/pairs/h24/1?rankBy[key]=volume";
const PAIR_URL = "wss://io.dexscreener.com/dex/screener/v7/pair/solana/abc";
/** One URL that serves several DIFFERENT commands, which is the S10-61 shape. */
const FEED_URL = "wss://io.dexscreener.com/feed/ws";

interface FakeState {
  readonly runtime: BridgeRuntime;
  /** Deliver a handshake response to the bridge's own onHeadersReceived hook. */
  headersReceived(url: string, statusCode: number): void;
  readonly created: FakeWindow[];
  /** Resolve the pending `open(...)` call for a script, by index of the call. */
  readonly openCalls: {
    script: string;
    resolve: (value: unknown) => void;
  }[];
}

class FakeWindow implements BridgeWindow {
  destroyed = false;
  loaded: string[] = [];
  runtimeInstalled = false;

  constructor(private readonly state: { openCalls: FakeState["openCalls"] }) {}

  load(url: string): Promise<void> {
    this.loaded.push(url);
    return Promise.resolve();
  }

  run<T>(script: string): Promise<T> {
    if (script.includes("__vexDsBridge = ") || script.includes("window.__vexDsBridge)")) {
      this.runtimeInstalled = true;
      return Promise.resolve(true as T);
    }
    if (script.includes(".abort(")) return Promise.resolve(true as T);
    return new Promise<T>((resolve) => {
      this.state.openCalls.push({
        script,
        resolve: resolve as (value: unknown) => void,
      });
    });
  }

  destroy(): void {
    this.destroyed = true;
  }

  isUsable(): boolean {
    return !this.destroyed;
  }
}

function makeFakes(): FakeState {
  const created: FakeWindow[] = [];
  const openCalls: FakeState["openCalls"] = [];
  let headersListener:
    | ((details: { url: string; statusCode: number }, cb: (r: unknown) => void) => void)
    | null = null;
  const runtime: BridgeRuntime = {
    fromPartition: () =>
      ({
        setUserAgent: () => undefined,
        webRequest: {
          onBeforeSendHeaders: () => undefined,
          onHeadersReceived: (
            _filter: unknown,
            listener?: (details: { url: string; statusCode: number }, cb: (r: unknown) => void) => void,
          ) => {
            headersListener = listener ?? null;
          },
        },
        setPermissionCheckHandler: () => undefined,
        setPermissionRequestHandler: () => undefined,
        setDevicePermissionHandler: () => undefined,
        protocol: { handle: () => undefined },
      }) as unknown as Electron.Session,
    createWindow: () => {
      const window = new FakeWindow({ openCalls });
      created.push(window);
      return window;
    },
  };
  return {
    runtime,
    created,
    openCalls,
    headersReceived: (url, statusCode) => {
      if (headersListener === null) throw new Error("no onHeadersReceived hook installed");
      headersListener({ url, statusCode }, () => undefined);
    },
  };
}

/** Wait until `predicate` holds, yielding to the microtask queue between checks. */
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("condition never became true");
}

const EXPECT_ONE = { binaryFrames: 1, maxTotalBytes: 1_000_000 } as const;

function codeOf(error: unknown): string {
  return (error as { code?: string }).code ?? "no-code";
}

let disposeCurrent: (() => void) | null = null;

afterEach(() => {
  disposeCurrent?.();
  disposeCurrent = null;
});

describe("DexScreenerWsBridge", () => {
  it("refuses a URL outside the channel allowlist before creating any window", async () => {
    const fakes = makeFakes();
    const bridge = new DexScreenerWsBridge(fakes.runtime);
    disposeCurrent = () => bridge.dispose();

    await expect(
      bridge.exchange("wss://evil.example/feed/ws", {
        expect: EXPECT_ONE,
        timeoutMs: 1000,
      })
    ).rejects.toMatchObject({
      code: DexScreenerSiteErrorCodes.TRANSPORT_HOST_NOT_ALLOWED,
    });
    expect(fakes.created).toHaveLength(0);
  });

  it("loads only the app://vex bridge document, once, and reuses the window", async () => {
    const fakes = makeFakes();
    const bridge = new DexScreenerWsBridge(fakes.runtime);
    disposeCurrent = () => bridge.dispose();

    const first = bridge.exchange(SCREENER_URL, {
      expect: EXPECT_ONE,
      timeoutMs: 5000,
    });
    await until(() => fakes.openCalls.length === 1);
    fakes.openCalls[0]?.resolve({ outcome: "complete", detail: "", frames: ["AQI="] });
    expect([...(await first)[0] ?? []]).toStrictEqual([1, 2]);

    const second = bridge.exchange(PAIR_URL, {
      expect: EXPECT_ONE,
      timeoutMs: 5000,
    });
    await until(() => fakes.openCalls.length === 2);
    fakes.openCalls[1]?.resolve({ outcome: "complete", detail: "", frames: [] });
    await second.catch(() => undefined);

    expect(fakes.created).toHaveLength(1);
    expect(fakes.created[0]?.loaded).toStrictEqual(["app://vex/dexscreener-bridge"]);
    expect(fakes.created[0]?.runtimeInstalled).toBe(true);
  });

  it("single-flights identical URLs into one socket", async () => {
    const fakes = makeFakes();
    const bridge = new DexScreenerWsBridge(fakes.runtime);
    disposeCurrent = () => bridge.dispose();

    const a = bridge.exchange(SCREENER_URL, { expect: EXPECT_ONE, timeoutMs: 5000 });
    const b = bridge.exchange(SCREENER_URL, { expect: EXPECT_ONE, timeoutMs: 5000 });
    await until(() => fakes.openCalls.length === 1);
    fakes.openCalls[0]?.resolve({ outcome: "complete", detail: "", frames: ["AQ=="] });

    expect(await a).toStrictEqual(await b);
    expect(fakes.openCalls).toHaveLength(1);
  });

  it("does NOT merge two different commands that share one feed URL", async () => {
    /*
     * S10-61, the worst failure shape this bridge has. The feed channel carries
     * its query as a COMMAND FRAME, so getHistoricalTransactions and
     * getHistoricalBars are the same URL with different bytes. Coalescing on the
     * URL alone handed the second caller the FIRST one's frames: an answer to a
     * question it never asked, decoded against its own schema, indistinguishable
     * from a correct result.
     */
    const fakes = makeFakes();
    const bridge = new DexScreenerWsBridge(fakes.runtime);
    disposeCurrent = () => bridge.dispose();

    const trades = bridge.exchange(FEED_URL, {
      send: [Uint8Array.from([1, 1, 1])],
      expect: EXPECT_ONE,
      timeoutMs: 5000,
    });
    const bars = bridge.exchange(FEED_URL, {
      send: [Uint8Array.from([2, 2, 2])],
      expect: EXPECT_ONE,
      timeoutMs: 5000,
    });

    // TWO sockets, because two different questions were asked.
    await until(() => fakes.openCalls.length === 2);
    fakes.openCalls[0]?.resolve({ outcome: "complete", detail: "", frames: ["AQ=="] });
    fakes.openCalls[1]?.resolve({ outcome: "complete", detail: "", frames: ["Ag=="] });

    // And each caller gets ITS OWN answer, not the other's.
    expect(await trades).toStrictEqual([Uint8Array.from([1])]);
    expect(await bars).toStrictEqual([Uint8Array.from([2])]);
  });

  it("still single-flights two identical commands on one feed URL", async () => {
    // The coalescing this bridge exists to do is unchanged: same URL, same
    // bytes, same expectations is still one socket.
    const fakes = makeFakes();
    const bridge = new DexScreenerWsBridge(fakes.runtime);
    disposeCurrent = () => bridge.dispose();

    const a = bridge.exchange(FEED_URL, {
      send: [Uint8Array.from([7, 7])],
      expect: EXPECT_ONE,
      timeoutMs: 5000,
    });
    const b = bridge.exchange(FEED_URL, {
      send: [Uint8Array.from([7, 7])],
      expect: EXPECT_ONE,
      timeoutMs: 5000,
    });
    await until(() => fakes.openCalls.length === 1);
    fakes.openCalls[0]?.resolve({ outcome: "complete", detail: "", frames: ["AQ=="] });

    expect(await a).toStrictEqual(await b);
    expect(fakes.openCalls).toHaveLength(1);
  });

  it("destroys a window that finished loading after dispose instead of adopting it", async () => {
    // S10-62: dispose() clears `window` and `loading`, but a creation already
    // in flight resumes afterwards. Assigning then left a live BrowserWindow
    // and session on a disposed bridge that nothing would destroy again.
    const fakes = makeFakes();
    let releaseLoad: (() => void) | null = null;
    const slowRuntime: BridgeRuntime = {
      ...fakes.runtime,
      createWindow: (session) => {
        const window = fakes.runtime.createWindow(session);
        const original = window.load.bind(window);
        window.load = (url: string) =>
          new Promise<void>((resolve) => {
            releaseLoad = () => {
              void original(url);
              resolve();
            };
          });
        return window;
      },
    };
    const bridge = new DexScreenerWsBridge(slowRuntime);

    const pending = bridge
      .exchange(SCREENER_URL, { expect: EXPECT_ONE, timeoutMs: 5000 })
      .catch((error: unknown) => codeOf(error));
    await until(() => releaseLoad !== null);

    bridge.dispose();
    releaseLoad?.();

    await expect(pending).resolves.toBe(
      DexScreenerSiteErrorCodes.SITE_TRANSPORT_UNAVAILABLE
    );
    // The window this race created was destroyed, not adopted.
    await until(() => fakes.created.every((window) => window.destroyed));
  });

  it("releases the app:// protocol handler on dispose, idempotently", async () => {
    // S10-63: the handler is registered ON THE SESSION and outlives the bridge,
    // so a disposed bridge left `app://` claimed on a partition a later bridge
    // reuses, and the second protocol.handle for that scheme is the one that
    // throws.
    const unhandled: string[] = [];
    const fakes = makeFakes();
    const runtime: BridgeRuntime = {
      ...fakes.runtime,
      fromPartition: (partition: string) => {
        const session = fakes.runtime.fromPartition(partition);
        (session as unknown as { protocol: Record<string, unknown> }).protocol = {
          handle: () => undefined,
          unhandle: (scheme: string) => unhandled.push(scheme),
        };
        return session;
      },
    };
    const bridge = new DexScreenerWsBridge(runtime);
    bridge.sessionForRequests();

    bridge.dispose();
    bridge.dispose();

    expect(unhandled).toStrictEqual(["app"]);
  });

  it("refuses a fifth concurrent exchange by name instead of queueing it", async () => {
    const fakes = makeFakes();
    const bridge = new DexScreenerWsBridge(fakes.runtime);
    disposeCurrent = () => bridge.dispose();

    const running = ["1", "2", "3", "4"].map((page) =>
      bridge
        .exchange(`wss://io.dexscreener.com/dex/screener/v7/pairs/h24/${page}`, {
          expect: EXPECT_ONE,
          timeoutMs: 5000,
        })
        .catch(() => undefined)
    );
    await until(() => fakes.openCalls.length === 4);

    await expect(
      bridge.exchange("wss://io.dexscreener.com/dex/screener/v7/pairs/h24/5", {
        expect: EXPECT_ONE,
        timeoutMs: 5000,
      })
    ).rejects.toMatchObject({ code: DexScreenerSiteErrorCodes.TRANSPORT_FAILED });

    for (const call of fakes.openCalls) {
      call.resolve({ outcome: "closed", detail: "1006", frames: [] });
    }
    await Promise.all(running);
  });

  it("reports an over-cap channel as over-cap, naming the cap", async () => {
    const fakes = makeFakes();
    const bridge = new DexScreenerWsBridge(fakes.runtime);
    disposeCurrent = () => bridge.dispose();

    const pending = bridge.exchange(SCREENER_URL, {
      expect: { binaryFrames: 2, maxTotalBytes: 1024 },
      timeoutMs: 5000,
    });
    await until(() => fakes.openCalls.length === 1);
    fakes.openCalls[0]?.resolve({ outcome: "over_cap", detail: "2048", frames: [] });

    await expect(pending).rejects.toMatchObject({
      code: DexScreenerSiteErrorCodes.RESPONSE_OVER_CAP,
    });
    await pending.catch((error: unknown) => {
      expect((error as Error).message).toContain("2048");
      expect((error as Error).message).toContain("1024");
    });
  });

  it("reports an early close as a failure naming how many frames arrived", async () => {
    const fakes = makeFakes();
    const bridge = new DexScreenerWsBridge(fakes.runtime);
    disposeCurrent = () => bridge.dispose();

    const pending = bridge.exchange(SCREENER_URL, {
      expect: { binaryFrames: 3, maxTotalBytes: 1_000_000 },
      timeoutMs: 5000,
    });
    await until(() => fakes.openCalls.length === 1);
    fakes.openCalls[0]?.resolve({
      outcome: "closed",
      detail: "1006",
      frames: ["AQ==", "Ag=="],
    });

    const error = await pending.catch((caught: unknown) => caught);
    expect(codeOf(error)).toBe(DexScreenerSiteErrorCodes.TRANSPORT_FAILED);
    expect((error as Error).message).toContain("2 of 3");
    expect((error as Error).message).toContain("1006");
  });

  it("names a 422 handshake as a permanent grammar refusal, not a transport failure", async () => {
    // MEASURED (S8, io.dexscreener.com): with upgrade headers a refused
    // grammar returns HTTP 422 with a ZERO-BYTE body while a good one reaches
    // the backend; without upgrade headers both return 404. The page's
    // WebSocket sees only `onerror` either way, so the session hook is the one
    // place this fact exists. Collapsing it into TRANSPORT_FAILED told the
    // agent to retry a request that can never succeed as spelled.
    const fakes = makeFakes();
    const bridge = new DexScreenerWsBridge(fakes.runtime);
    disposeCurrent = () => bridge.dispose();

    const pending = bridge.exchange(SCREENER_URL, {
      expect: EXPECT_ONE,
      timeoutMs: 5000,
    });
    await until(() => fakes.openCalls.length === 1);
    fakes.headersReceived(SCREENER_URL, 422);
    fakes.openCalls[0]?.resolve({
      outcome: "failed",
      detail: "socket-error",
      frames: [],
    });

    const error = await pending.catch((caught: unknown) => caught);
    expect(codeOf(error)).toBe(DexScreenerSiteErrorCodes.WS_UPGRADE_REFUSED);
    expect((error as Error).message).toContain("422");
  });

  it("leaves an unmeasured handshake status to the ordinary transport classification", async () => {
    // Only 422 is a named refusal. A 503, say, is not turned into a grammar
    // complaint just because a status happened to be seen.
    const fakes = makeFakes();
    const bridge = new DexScreenerWsBridge(fakes.runtime);
    disposeCurrent = () => bridge.dispose();

    const pending = bridge.exchange(SCREENER_URL, {
      expect: EXPECT_ONE,
      timeoutMs: 5000,
    });
    await until(() => fakes.openCalls.length === 1);
    fakes.headersReceived(SCREENER_URL, 503);
    fakes.openCalls[0]?.resolve({
      outcome: "failed",
      detail: "socket-error",
      frames: [],
    });

    const error = await pending.catch((caught: unknown) => caught);
    expect(codeOf(error)).toBe(DexScreenerSiteErrorCodes.TRANSPORT_FAILED);
  });

  it("does not carry a refusal from one exchange into the next on the same URL", async () => {
    const fakes = makeFakes();
    const bridge = new DexScreenerWsBridge(fakes.runtime);
    disposeCurrent = () => bridge.dispose();

    const first = bridge.exchange(SCREENER_URL, {
      expect: EXPECT_ONE,
      timeoutMs: 5000,
    });
    await until(() => fakes.openCalls.length === 1);
    fakes.headersReceived(SCREENER_URL, 422);
    fakes.openCalls[0]?.resolve({ outcome: "failed", detail: "socket-error", frames: [] });
    expect(codeOf(await first.catch((caught: unknown) => caught))).toBe(
      DexScreenerSiteErrorCodes.WS_UPGRADE_REFUSED
    );

    const second = bridge.exchange(SCREENER_URL, {
      expect: EXPECT_ONE,
      timeoutMs: 5000,
    });
    await until(() => fakes.openCalls.length === 2);
    fakes.openCalls[1]?.resolve({ outcome: "closed", detail: "1006", frames: [] });
    expect(codeOf(await second.catch((caught: unknown) => caught))).toBe(
      DexScreenerSiteErrorCodes.TRANSPORT_FAILED
    );
  });

  it("turns a caller cancellation into a cancelled outcome and aborts the socket", async () => {
    const fakes = makeFakes();
    const bridge = new DexScreenerWsBridge(fakes.runtime);
    disposeCurrent = () => bridge.dispose();
    const controller = new AbortController();

    const pending = bridge.exchange(SCREENER_URL, {
      expect: EXPECT_ONE,
      timeoutMs: 5000,
      signal: controller.signal,
    });
    await until(() => fakes.openCalls.length === 1);
    controller.abort();
    fakes.openCalls[0]?.resolve({ outcome: "closed", detail: "1000", frames: [] });

    const error = await pending.catch((caught: unknown) => caught);
    expect(codeOf(error)).toBe(DexScreenerSiteErrorCodes.TRANSPORT_CANCELLED);
  });

  it("turns its own deadline into a timeout naming the budget", async () => {
    vi.useFakeTimers();
    try {
      const fakes = makeFakes();
      const bridge = new DexScreenerWsBridge(fakes.runtime);
      disposeCurrent = () => bridge.dispose();

      const pending = bridge.exchange(SCREENER_URL, {
        expect: EXPECT_ONE,
        timeoutMs: 250,
      });
      await until(() => fakes.openCalls.length === 1);
      vi.advanceTimersByTime(251);
      fakes.openCalls[0]?.resolve({ outcome: "closed", detail: "1000", frames: [] });

      const error = await pending.catch((caught: unknown) => caught);
      expect(codeOf(error)).toBe(DexScreenerSiteErrorCodes.TRANSPORT_TIMEOUT);
      expect((error as Error).message).toContain("250 ms");
    } finally {
      vi.useRealTimers();
    }
  });

  it("disposes idempotently, destroys the window once, and admits nothing after", async () => {
    const fakes = makeFakes();
    const bridge = new DexScreenerWsBridge(fakes.runtime);

    const pending = bridge.exchange(SCREENER_URL, {
      expect: EXPECT_ONE,
      timeoutMs: 5000,
    });
    await until(() => fakes.openCalls.length === 1);

    bridge.dispose();
    bridge.dispose();
    expect(fakes.created).toHaveLength(1);
    expect(fakes.created[0]?.destroyed).toBe(true);

    await expect(
      bridge.exchange(SCREENER_URL, { expect: EXPECT_ONE, timeoutMs: 5000 })
    ).rejects.toMatchObject({
      code: DexScreenerSiteErrorCodes.SITE_TRANSPORT_UNAVAILABLE,
    });

    // The exchange that was already running still settles; it is not left hanging.
    fakes.openCalls[0]?.resolve({ outcome: "closed", detail: "1006", frames: [] });
    await pending.catch(() => undefined);
  });
});
