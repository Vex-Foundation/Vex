/**
 * R14. `coalesceScope` partitions the bridge's single-flight table.
 *
 * WHY THIS IS A LIFECYCLE TEST AND NOT A CACHE TEST. The bridge joins an
 * identical concurrent exchange onto the FIRST caller's promise, which means
 * the first caller's `signal` and `timeoutMs` are the ones that own the socket.
 * That is right for the case it was built for and wrong for the board's live
 * poll: a poll that joined an agent tool's exchange could not abort it on
 * toggle-off, and an agent tool that joined the poll's would be killed by a
 * toggle it knows nothing about. The scope makes ownership explicit.
 *
 * What is asserted here, in both leader orderings:
 *  - different scopes never join, and each side's cancellation and deadline
 *    reach only its own socket;
 *  - the same scope still joins, so the option did not disable single-flight;
 *  - an ABSENT scope is byte-identical to the behaviour that existed before the
 *    option, and an explicitly `undefined` scope is the same thing as omitting
 *    the key (that is the regression that proves nothing was mixed into the
 *    digest for scope-less callers).
 *
 * The fake window stands in for Chromium exactly as `ws-bridge.test.ts` does.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
type BridgeSession = import("../ws-bridge.js").BridgeSession;

const FEED_URL = "wss://io.dexscreener.com/feed/ws";
const EXPECT_ONE = { binaryFrames: 1, maxTotalBytes: 1_000_000 } as const;
/** The identical command both callers send, so only the scope can separate them. */
const COMMAND = JSON.stringify({ type: "getPairs", ids: ["solana:abc"] });

interface OpenCall {
  script: string;
  resolve: (value: unknown) => void;
}

class FakeWindow implements BridgeWindow {
  destroyed = false;
  /** Every abort script the bridge ran, so a cancellation can be attributed. */
  readonly aborts: string[] = [];

  constructor(private readonly state: { openCalls: OpenCall[] }) {}

  load(): Promise<void> {
    return Promise.resolve();
  }

  run<T>(script: string): Promise<T> {
    if (script.includes("__vexDsBridge = ") || script.includes("window.__vexDsBridge)")) {
      return Promise.resolve(true as T);
    }
    if (script.includes(".abort(")) {
      this.aborts.push(script);
      return Promise.resolve(true as T);
    }
    return new Promise<T>((resolve) => {
      this.state.openCalls.push({ script, resolve: resolve as (value: unknown) => void });
    });
  }

  destroy(): void {
    this.destroyed = true;
  }

  isUsable(): boolean {
    return !this.destroyed;
  }
}

interface Fakes {
  readonly runtime: BridgeRuntime;
  readonly openCalls: OpenCall[];
  readonly windows: FakeWindow[];
}

function makeFakes(): Fakes {
  const openCalls: OpenCall[] = [];
  const windows: FakeWindow[] = [];
  const runtime: BridgeRuntime = {
    fromPartition: (): BridgeSession => ({
      setUserAgent: () => undefined,
      webRequest: {
        onBeforeSendHeaders: () => undefined,
        onHeadersReceived: () => undefined,
      },
      setPermissionCheckHandler: () => undefined,
      setPermissionRequestHandler: () => undefined,
      setDevicePermissionHandler: () => undefined,
      protocol: { handle: () => undefined, unhandle: () => undefined },
      fetch: () => Promise.reject(new Error("these tests never fetch over HTTP")),
    }),
    createWindow: () => {
      const window = new FakeWindow({ openCalls });
      windows.push(window);
      return window;
    },
  };
  return { runtime, openCalls, windows };
}

/** Wait until `predicate` holds, yielding to the microtask queue between checks. */
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("condition never became true");
}

function codeOf(error: unknown): string {
  return (error as { code?: string }).code ?? "no-code";
}

type Settled =
  | { readonly ok: true; readonly value: Uint8Array[] }
  | { readonly ok: false; readonly error: unknown };

/**
 * Attach both handlers at creation time.
 *
 * Necessary rather than stylistic: these exchanges are started before the
 * assertion that rejects one of them, and an unhandled rejection on the other
 * would fail the run for a reason that has nothing to do with the contract.
 */
function settle(exchange: Promise<Uint8Array[]>): Promise<Settled> {
  return exchange.then(
    (value): Settled => ({ ok: true, value }),
    (error: unknown): Settled => ({ ok: false, error }),
  );
}

let disposeCurrent: (() => void) | null = null;

afterEach(() => {
  disposeCurrent?.();
  disposeCurrent = null;
});

describe("R14: coalesceScope isolates exchange ownership", () => {
  it("opens two sockets for identical requests carrying different scopes", async () => {
    const fakes = makeFakes();
    const bridge = new DexScreenerWsBridge(fakes.runtime);
    disposeCurrent = () => bridge.dispose();

    const board = bridge.exchange(FEED_URL, {
      send: [COMMAND],
      expect: EXPECT_ONE,
      timeoutMs: 5_000,
      coalesceScope: "board-live:lease-1",
    });
    const agent = bridge.exchange(FEED_URL, {
      send: [COMMAND],
      expect: EXPECT_ONE,
      timeoutMs: 5_000,
      coalesceScope: "agent-tool",
    });

    await until(() => fakes.openCalls.length === 2);
    expect(fakes.openCalls).toHaveLength(2);

    fakes.openCalls[0]?.resolve({ outcome: "complete", detail: "", frames: ["AQ=="] });
    fakes.openCalls[1]?.resolve({ outcome: "complete", detail: "", frames: ["Ag=="] });

    expect([...((await board)[0] ?? [])]).toStrictEqual([1]);
    expect([...((await agent)[0] ?? [])]).toStrictEqual([2]);
  });

  it("still joins two identical requests that carry the SAME scope", async () => {
    const fakes = makeFakes();
    const bridge = new DexScreenerWsBridge(fakes.runtime);
    disposeCurrent = () => bridge.dispose();

    const first = bridge.exchange(FEED_URL, {
      send: [COMMAND],
      expect: EXPECT_ONE,
      timeoutMs: 5_000,
      coalesceScope: "board-live:lease-1",
    });
    const second = bridge.exchange(FEED_URL, {
      send: [COMMAND],
      expect: EXPECT_ONE,
      timeoutMs: 5_000,
      coalesceScope: "board-live:lease-1",
    });

    await until(() => fakes.openCalls.length === 1);
    fakes.openCalls[0]?.resolve({ outcome: "complete", detail: "", frames: ["AQ=="] });

    expect(await first).toStrictEqual(await second);
    expect(fakes.openCalls).toHaveLength(1);
  });

  it("treats an absent scope and an explicitly undefined scope as the same caller", async () => {
    // The regression that proves the digest of every pre-existing call is
    // unchanged: nothing at all is mixed in when the scope is not set, so a
    // call that omits the key and a call that sets it to `undefined` still
    // single-flight into one socket exactly as two omitting calls always did.
    const fakes = makeFakes();
    const bridge = new DexScreenerWsBridge(fakes.runtime);
    disposeCurrent = () => bridge.dispose();

    const omitted = bridge.exchange(FEED_URL, {
      send: [COMMAND],
      expect: EXPECT_ONE,
      timeoutMs: 5_000,
    });
    const explicitUndefined = bridge.exchange(FEED_URL, {
      send: [COMMAND],
      expect: EXPECT_ONE,
      timeoutMs: 5_000,
      coalesceScope: undefined,
    });

    await until(() => fakes.openCalls.length === 1);
    fakes.openCalls[0]?.resolve({ outcome: "complete", detail: "", frames: ["AQ=="] });

    expect(await omitted).toStrictEqual(await explicitUndefined);
    expect(fakes.openCalls).toHaveLength(1);
  });

  it("never joins a scoped caller to an unscoped one, in either leader order", async () => {
    for (const scopedLeads of [true, false]) {
      const fakes = makeFakes();
      const bridge = new DexScreenerWsBridge(fakes.runtime);

      const scopedOptions = {
        send: [COMMAND],
        expect: EXPECT_ONE,
        timeoutMs: 5_000,
        coalesceScope: "board-live:lease-1",
      } as const;
      const unscopedOptions = {
        send: [COMMAND],
        expect: EXPECT_ONE,
        timeoutMs: 5_000,
      } as const;

      const first = bridge.exchange(
        FEED_URL,
        scopedLeads ? scopedOptions : unscopedOptions,
      );
      const second = bridge.exchange(
        FEED_URL,
        scopedLeads ? unscopedOptions : scopedOptions,
      );

      await until(() => fakes.openCalls.length === 2);
      expect(fakes.openCalls).toHaveLength(2);

      fakes.openCalls[0]?.resolve({ outcome: "complete", detail: "", frames: ["AQ=="] });
      fakes.openCalls[1]?.resolve({ outcome: "complete", detail: "", frames: ["Ag=="] });
      await Promise.all([first, second]);
      bridge.dispose();
    }
  });

  it("aborts only the cancelled scope's socket, in either leader order", async () => {
    for (const boardLeads of [true, false]) {
      const fakes = makeFakes();
      const bridge = new DexScreenerWsBridge(fakes.runtime);

      const boardAbort = new AbortController();
      const startBoard = (): Promise<Uint8Array[]> =>
        bridge.exchange(FEED_URL, {
          send: [COMMAND],
          expect: EXPECT_ONE,
          timeoutMs: 30_000,
          coalesceScope: "board-live:lease-1",
          signal: boardAbort.signal,
        });
      const startAgent = (): Promise<Uint8Array[]> =>
        bridge.exchange(FEED_URL, {
          send: [COMMAND],
          expect: EXPECT_ONE,
          timeoutMs: 30_000,
          coalesceScope: "agent-tool",
        });

      // The leader is whichever exchange registers first. Both orderings must
      // behave the same, which is the whole point of the row.
      const board = boardLeads ? startBoard() : undefined;
      const agent = startAgent();
      const boardExchange = board ?? startBoard();
      const boardIndex = boardLeads ? 0 : 1;
      const agentIndex = boardLeads ? 1 : 0;

      const boardSettled = settle(boardExchange);
      const agentSettled = settle(agent);

      // Two sockets, because the scopes differ. A single open call here would
      // mean the two owners had been joined.
      await until(() => fakes.openCalls.length === 2);

      // The board's toggle-off. Only the board's exchange may die: the page
      // reports its socket closed, exactly as the real runtime does after the
      // bridge runs its abort script.
      boardAbort.abort();
      fakes.openCalls[boardIndex]?.resolve({
        outcome: "closed",
        detail: "1000",
        frames: [],
      });
      const boardOutcome = await boardSettled;
      expect(boardOutcome.ok).toBe(false);
      if (!boardOutcome.ok) {
        expect(codeOf(boardOutcome.error)).toBe(
          DexScreenerSiteErrorCodes.TRANSPORT_CANCELLED,
        );
      }

      // The agent's socket is untouched and still delivers its own answer.
      fakes.openCalls[agentIndex]?.resolve({
        outcome: "complete",
        detail: "",
        frames: ["Ag=="],
      });
      const agentOutcome = await agentSettled;
      expect(agentOutcome.ok).toBe(true);
      if (agentOutcome.ok) {
        expect([...(agentOutcome.value[0] ?? [])]).toStrictEqual([2]);
      }

      bridge.dispose();
    }
  });

  it("lets each scope's deadline expire independently", async () => {
    vi.useFakeTimers();
    try {
      const fakes = makeFakes();
      const bridge = new DexScreenerWsBridge(fakes.runtime);
      disposeCurrent = () => bridge.dispose();

      const shortLived = bridge.exchange(FEED_URL, {
        send: [COMMAND],
        expect: EXPECT_ONE,
        timeoutMs: 250,
        coalesceScope: "board-live:lease-1",
      });
      const longLived = bridge.exchange(FEED_URL, {
        send: [COMMAND],
        expect: EXPECT_ONE,
        timeoutMs: 3_600_000,
        coalesceScope: "agent-tool",
      });
      const shortSettled = settle(shortLived);
      const longSettled = settle(longLived);

      await until(() => fakes.openCalls.length === 2);

      // Only the short budget belongs to the board's scope, so only the board's
      // exchange times out. A joined pair could not do this: the leader's one
      // deadline would own both sockets.
      vi.advanceTimersByTime(251);
      fakes.openCalls[0]?.resolve({ outcome: "closed", detail: "1000", frames: [] });
      const shortOutcome = await shortSettled;
      expect(shortOutcome.ok).toBe(false);
      if (!shortOutcome.ok) {
        expect(codeOf(shortOutcome.error)).toBe(
          DexScreenerSiteErrorCodes.TRANSPORT_TIMEOUT,
        );
        expect((shortOutcome.error as Error).message).toContain("250 ms");
      }

      fakes.openCalls[1]?.resolve({
        outcome: "complete",
        detail: "",
        frames: ["Ag=="],
      });
      const longOutcome = await longSettled;
      expect(longOutcome.ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * The scope delimiter is a DIGEST INPUT, so its exact bytes are a contract.
 *
 * `exchangeDigest` separates the scope from the expectation string with one NUL
 * followed by "scope:". Those seven bytes decide which callers single-flight
 * together, and they used to be spelled with a LITERAL NUL in the source, which
 * a reviewer cannot see and a diff cannot show. The delimiter is now written as
 * the escape "\u0000scope:"; the emitted bytes are unchanged. This pins both
 * halves, so a future silent change to either is caught: the byte sequence
 * itself, and the fact that the source spells it visibly.
 */
describe("R14: the scope delimiter bytes are pinned", () => {
  const SOURCE = readFileSync(
    fileURLToPath(new URL("../ws-bridge.ts", import.meta.url)),
    "utf8",
  );

  it("mixes in exactly NUL followed by \"scope:\"", () => {
    expect([...Buffer.from("\u0000scope:", "utf8")]).toStrictEqual([
      0x00, 0x73, 0x63, 0x6f, 0x70, 0x65, 0x3a,
    ]);
  });

  it("spells that delimiter as a reviewable escape in the source", () => {
    expect(SOURCE).toContain('hash.update("\\u0000scope:");');
  });

  it("carries no raw control byte a reader cannot see", () => {
    // Tab, newline and carriage return are the only control characters a source
    // file legitimately contains; anything else is an invisible literal.
    const invisible = [...SOURCE].filter((character) => {
      if (character === "\t" || character === "\n" || character === "\r") return false;
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f;
    });
    expect(invisible.map((character) => character.codePointAt(0))).toStrictEqual([]);
  });
});
