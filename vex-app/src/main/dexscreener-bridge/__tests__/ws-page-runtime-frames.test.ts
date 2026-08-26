/**
 * Frame accounting inside the page runtime, driven over captured `feed/ws`
 * sequences.
 *
 * WHY THIS TEST EXISTS (measured, EP11): the site sends real BINARY frames of
 * `byteLength === 0` as keepalives, about every 17-47 s. The runtime pushed
 * every binary message into `frames`, so the bridge's own accounting showed
 * bars `[13873, 0, 0]`, trades `[27484, 0, 0]` and pair insight `[6, 0, 0]`:
 * the answer arrived in 0.4 s, three "frames" existed inside the 25 s deadline,
 * the caller wanted 4, and every one of those calls threw TRANSPORT_TIMEOUT
 * with the answer already in hand. Blast radius was every candle interval,
 * every trade page including cursor continuations, and pair_get insight.
 *
 * The rest of the bridge suite stubs the page runtime out with a fake window,
 * so this is the only place the real message handler runs. It evaluates the
 * exported PAGE_RUNTIME source itself against a scripted socket; if the
 * zero-length skip is reverted, the first two cases go red.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: class {},
  session: { fromPartition: () => ({}) },
  net: { fetch: () => Promise.reject(new Error("not used")) },
}));

const { PAGE_RUNTIME } = await import("../ws-bridge.js");

interface PageResult {
  readonly outcome: string;
  readonly detail: string;
  readonly frames: string[];
}

interface Sandbox {
  open(
    id: string,
    url: string,
    sendFrames: readonly string[],
    binaryFrames: number,
    maxTotalBytes: number
  ): Promise<PageResult>;
}

/** A socket the test drives frame by frame, standing in for Chromium's. */
class ScriptedSocket {
  static last: ScriptedSocket | null = null;
  binaryType = "";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  readonly sent: unknown[] = [];
  closed = false;

  constructor(readonly url: string) {
    ScriptedSocket.last = this;
  }

  send(value: unknown): void {
    this.sent.push(value);
  }

  close(): void {
    this.closed = true;
  }

  /** Deliver a BINARY frame of exactly `byteLength` bytes. */
  binary(byteLength: number): void {
    this.onmessage?.({ data: new Uint8Array(byteLength).fill(7).buffer });
  }

  text(value: string): void {
    this.onmessage?.({ data: value });
  }
}

/**
 * Evaluate the real page-runtime source in a function scope carrying the
 * browser globals it uses, and hand back the installed bridge.
 */
function installRuntime(): Sandbox {
  const window: { __vexDsBridge?: Sandbox } = {};
  const btoa = (binary: string): string =>
    Buffer.from(binary, "binary").toString("base64");
  const atob = (b64: string): string =>
    Buffer.from(b64, "base64").toString("binary");
  // eslint-disable-next-line no-new-func -- running the shipped runtime source is the point of this test
  new Function("window", "WebSocket", "btoa", "atob", PAGE_RUNTIME)(
    window,
    ScriptedSocket,
    btoa,
    atob
  );
  const bridge = window.__vexDsBridge;
  if (bridge === undefined) throw new Error("page runtime did not install");
  return bridge;
}

/** Yield to the microtask queue so the runtime's promise callbacks settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

const URL = "wss://io.dexscreener.com/dex/feed/ws";

describe("page runtime frame accounting", () => {
  it("does not count zero-length keepalives, so a captured [answer, 0, 0, 0] sequence still needs more real frames", async () => {
    const bridge = installRuntime();
    const pending = bridge.open("a", URL, [], 2, 1_000_000);
    const socket = ScriptedSocket.last;
    expect(socket).not.toBeNull();
    socket?.onopen?.();

    // The captured bars sequence: one 13,873-byte answer then three keepalives.
    socket?.binary(13_873);
    socket?.binary(0);
    socket?.binary(0);
    socket?.binary(0);
    await settle();

    // Still open: one real frame of the two asked for. Before the fix the
    // keepalives satisfied the budget and the caller resolved on padding.
    expect(socket?.closed).toBe(false);

    socket?.binary(11);
    const result = await pending;
    expect(result.outcome).toBe("complete");
    expect(result.frames).toHaveLength(2);
    expect(
      result.frames.map((frame) => Buffer.from(frame, "base64").byteLength)
    ).toStrictEqual([13_873, 11]);
  });

  it("resolves on the answer when keepalives arrive before it", async () => {
    const bridge = installRuntime();
    const pending = bridge.open("b", URL, [], 1, 1_000_000);
    const socket = ScriptedSocket.last;
    socket?.onopen?.();

    socket?.binary(0);
    socket?.binary(0);
    socket?.binary(6);

    const result = await pending;
    expect(result.outcome).toBe("complete");
    expect(result.frames).toHaveLength(1);
    expect(Buffer.from(result.frames[0] ?? "", "base64").byteLength).toBe(6);
  });

  /**
   * S9-21. The frame-budget half of the B3 fix (`*_FRAMES` 4 -> 1) and the
   * zero-length-skip half are BOTH load-bearing, and the happy path cannot
   * tell them apart: at budget 1 a fast answer resolves before any keepalive
   * exists. EP11 held a real socket at budget 1 against a command the provider
   * accepts and never answers, and witnessed keepalives at 13.608 s, 30.032 s
   * and 43.667 s, with the shipped runtime returning `frames: []`. Without the
   * skip, the budget fix alone would have turned the wave-1 timeout into an
   * ANSWER MADE OF PADDING on every request slower than about 14 s, which is a
   * silently wrong result rather than a loud one.
   */
  it("three keepalives and no answer at budget 1 return no frames instead of an empty one", async () => {
    const bridge = installRuntime();
    const pending = bridge.open("f", URL, [], 1, 1_000_000);
    const socket = ScriptedSocket.last;
    socket?.onopen?.();

    // The measured hold: three real 0-byte BINARY frames, no answer.
    socket?.binary(0);
    await settle();
    // The first keepalive alone satisfied budget 1 before the fix, so this is
    // the assertion that separates the two halves.
    expect(socket?.closed).toBe(false);
    socket?.binary(0);
    socket?.binary(0);
    await settle();
    expect(socket?.closed).toBe(false);

    // The socket eventually goes away with the answer never delivered, and the
    // caller is told so rather than handed padding.
    socket?.onclose?.({ code: 1006 });
    const result = await pending;
    expect(result.outcome).toBe("closed");
    expect(result.frames).toStrictEqual([]);
  });

  it("keeps keepalive bytes out of the byte ceiling", async () => {
    const bridge = installRuntime();
    const pending = bridge.open("c", URL, [], 2, 100);
    const socket = ScriptedSocket.last;
    socket?.onopen?.();

    socket?.binary(0);
    socket?.binary(60);
    socket?.binary(0);
    socket?.binary(40);

    const result = await pending;
    expect(result.outcome).toBe("complete");
    expect(result.detail).toBe("");
  });

  it("still rejects a genuinely over-cap channel, naming the total", async () => {
    const bridge = installRuntime();
    const pending = bridge.open("d", URL, [], 2, 100);
    const socket = ScriptedSocket.last;
    socket?.onopen?.();

    socket?.binary(60);
    socket?.binary(0);
    socket?.binary(61);

    const result = await pending;
    expect(result.outcome).toBe("over_cap");
    expect(result.detail).toBe("121");
  });

  it("answers the text keepalive with pong and never counts it as a frame", async () => {
    const bridge = installRuntime();
    const pending = bridge.open("e", URL, [], 1, 1_000_000);
    const socket = ScriptedSocket.last;
    socket?.onopen?.();

    socket?.text('"ping"');
    socket?.binary(0);
    socket?.binary(5);

    const result = await pending;
    expect(socket?.sent).toStrictEqual(['"pong"']);
    expect(result.frames).toHaveLength(1);
  });
});
