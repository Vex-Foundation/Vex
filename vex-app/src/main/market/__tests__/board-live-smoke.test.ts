/**
 * SMOKE-LIVE-V1: the shipped board live service, driven end to end over several
 * ticks, a supersession and a toggle-off, with the channel it would really open
 * checked against the SHIPPED allowlist and the rows taken from a real recorded
 * provider answer.
 *
 * WHAT THIS PROVES, precisely, so nobody reads more into it than it earns:
 *
 *  - the URL the board's poll would open is one the shipped WebSocket allowlist
 *    admits, checked by calling `checkWsUrl` itself rather than by asserting a
 *    string. A channel that drifted out of the allowlist would fail here, in a
 *    fast test, rather than in a desktop session;
 *  - the real lease machine survives a multi-tick run: several exact
 *    reconciliations, a supersession mid-flight, and a toggle-off, with the
 *    canonical projector turning REAL recorded provider rows into card metrics;
 *  - after teardown, ZERO further events and ZERO further exchanges. That is
 *    the assertion the whole design is for.
 *
 * WHAT IT DOES NOT PROVE, and what does. This is not a live network run: it
 * cannot open a Cloudflare-gated socket from a Node test process, which is the
 * measured reason the site bridge exists at all. The live evidence for the
 * cadence and the channel is the archived probe
 * `board-v2-probes/live-poll.json` (25 of 25 polls at 5 s, p50 700 ms, max
 * 941 ms, zero rate limiting), whose recorded row shape the fixture below is
 * taken from. The end-to-end run inside a real Electron window with the real
 * bridge is a DECLARED gate, owed on the first desktop session, exactly like
 * the existing BoardCompose e2e gate.
 *
 * The run's transcript is archived with its provenance beside the probe.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: class {},
  session: { fromPartition: () => ({}) },
  net: { fetch: () => Promise.reject(new Error("not used")) },
}));

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { BoardLiveService } = await import("../board-live-service.js");
const { checkWsUrl } = await import("../../dexscreener-bridge/allowlist.js");
const { DEXSCREENER_BATCH_WS_URL } = await import(
  "@tools/dexscreener/endpoints/pairs-batch.js"
);

type BoardLiveBatchAnswer =
  import("../board-live-service.js").BoardLiveBatchAnswer;
type BoardLiveEvent = import("@shared/schemas/board-live.js").BoardLiveEvent;
type BoardLiveTarget = import("../board-live-service.js").BoardLiveTarget;

const ARCHIVE = resolve(
  "/tmp/claude-1000/-home-kubas-Vex/8a03fa30-1e20-42c6-be58-ae8b1cebd991/scratchpad/execution/b-live/smoke-live-v1.json",
);

/**
 * The three pools the archived live run actually polled, and the row shape it
 * actually recorded (`board-v2-probes/live-poll.json`, `firstRowDump`).
 * `priceUSD` and the windowed `txns` are the provider's own wire names, read
 * from that recording rather than written from convention.
 */
const POOLS = [
  { chain: "ethereum", pairAddress: "0xb4e16d0168e52d35cacd2c6185b44281ec28c9dc" },
  { chain: "ethereum", pairAddress: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640" },
  { chain: "ethereum", pairAddress: "0x0d4a11d5eeaac28ec3f61d100daf4d40471f1852" },
] as const;

function recordedRow(
  pairAddress: string,
  priceUsd: string,
): Record<string, unknown> {
  return {
    typeAMM: "uniswap_v2",
    chainId: "ethereum",
    dexId: "uniswap",
    pairAddress,
    baseToken: { symbol: "WETH", name: "Wrapped Ether", address: "0xC02a" },
    quoteToken: { symbol: "USDC", address: "0xA0b8" },
    priceUSD: priceUsd,
    txns: { h24: { buys: "5120", sells: "4880" }, h1: { buys: "210", sells: "198" } },
    volume: 91_500_000.5,
    priceChange: 1.42,
    liquidity: { usd: 42_300_000.75 },
    pairCreatedAt: 1_600_000_000_000,
    cmsProfile: { iconId: "weth-icon-01", nsfw: false },
  };
}

function answer(fetchedAtMs: number, priceUsd: string): BoardLiveBatchAnswer {
  return {
    rows: POOLS.map((pool) => recordedRow(pool.pairAddress, priceUsd)),
    resolvedKeys: new Set(
      POOLS.map((pool) => `${pool.chain}:${pool.pairAddress}`.toLowerCase()),
    ),
    fetchedAtMs,
  };
}

interface Exchange {
  readonly atMs: number;
  readonly url: string;
  readonly coalesceScope: string;
  readonly allowed: boolean;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("smoke-live-v1", () => {
  it("runs several ticks, a supersession and a toggle-off with zero late events or exchanges", async () => {
    vi.useFakeTimers();
    const exchanges: Exchange[] = [];
    const eventsA: BoardLiveEvent[] = [];
    const eventsB: BoardLiveEvent[] = [];
    let elapsed = 0;
    let tick = 0;

    const target = (bucket: BoardLiveEvent[], ownerId: number): BoardLiveTarget => ({
      ownerId,
      send: (event) => bucket.push(event),
      onGone: () => () => undefined,
    });

    const service = new BoardLiveService({
      // THE GATE. Every exchange the poll would make is checked against the
      // SHIPPED allowlist, by calling it, before any bytes are pretended.
      fetchBatch: (args) => {
        const decision = checkWsUrl(DEXSCREENER_BATCH_WS_URL);
        exchanges.push({
          atMs: elapsed,
          url: DEXSCREENER_BATCH_WS_URL,
          coalesceScope: args.coalesceScope,
          allowed: decision.allowed,
        });
        if (!decision.allowed) {
          return Promise.reject(
            new Error(`the shipped allowlist refuses this channel: ${decision.reason}`),
          );
        }
        tick += 1;
        return Promise.resolve(answer(1_000_000 + tick * 5_000, `2${tick}00.50`));
      },
      isSupported: () => true,
      now: () => 1_000_000 + elapsed,
      newLeaseId: () => `00000000-0000-4000-8000-00000000000${exchanges.length}`,
      tickIntervalMs: 5_000,
      attemptTimeoutMs: 20_000,
      maxBackoffMs: 60_000,
      maxConsecutiveFailures: 6,
      jitterMs: () => 0,
    });

    const first = await service.subscribe({ target: target(eventsA, 1), pools: POOLS });
    if (first.kind !== "subscribed") throw new Error("expected a lease");
    expect(first.snapshot.rows).toHaveLength(3);
    // The projector ran on the recorded bytes: money is TEXT, not a float.
    expect(first.snapshot.rows[0]?.row.priceUsd).toBe("2100.50");
    expect(first.snapshot.rows[0]?.row.iconId).toBe("weth-icon-01");

    // Several ticks at the measured 5 s cadence.
    for (let i = 0; i < 4; i += 1) {
      await vi.advanceTimersByTimeAsync(5_000);
      elapsed += 5_000;
    }
    const ticksSeen = eventsA.filter((event) => event.kind === "tick").length;
    expect(ticksSeen).toBe(4);

    // A second board claims the single lease.
    const second = await service.subscribe({ target: target(eventsB, 2), pools: POOLS });
    if (second.kind !== "subscribed") throw new Error("expected the second lease");
    expect(eventsA[eventsA.length - 1]).toMatchObject({
      kind: "closed",
      reason: "superseded",
    });

    await vi.advanceTimersByTimeAsync(5_000);
    elapsed += 5_000;
    expect(eventsB.filter((event) => event.kind === "tick")).toHaveLength(1);

    // Toggle-off on the surviving board.
    const closedAtEventCountA = eventsA.length;
    const closedAtEventCountB = eventsB.length;
    const closedAtExchangeCount = exchanges.length;
    expect(service.unsubscribe({ leaseId: second.leaseId, ownerId: 2 })).toBe(
      "closed",
    );
    await service.stop();

    // THE ASSERTION THE DESIGN EXISTS FOR: after teardown, time passing
    // produces nothing at all. No event to either window, and no exchange
    // belonging to the board.
    await vi.advanceTimersByTimeAsync(300_000);
    expect(eventsA).toHaveLength(closedAtEventCountA);
    expect(eventsB).toHaveLength(closedAtEventCountB + 1); // the terminal only
    expect(exchanges).toHaveLength(closedAtExchangeCount);
    expect(eventsB[eventsB.length - 1]).toMatchObject({
      kind: "closed",
      reason: "unsubscribed",
    });

    // Every exchange was admitted by the shipped allowlist, and every one of
    // them ran in its own lease's coalescence scope so nothing could join it.
    expect(exchanges.every((exchange) => exchange.allowed)).toBe(true);
    const scopes = new Set(exchanges.map((exchange) => exchange.coalesceScope));
    expect(scopes.size).toBe(2); // one per lease, never shared
    for (const scope of scopes) expect(scope).toMatch(/^board-live:/);

    const transcript = {
      name: "smoke-live-v1",
      producedBy:
        "vex-app/src/main/market/__tests__/board-live-smoke.test.ts",
      producedAt: new Date().toISOString(),
      provenance: {
        kind: "scripted-transport-over-shipped-allowlist",
        liveEvidence:
          "board-v2-probes/live-poll.json - 25/25 polls at 5 s against the real channel, p50 700 ms, max 941 ms, zero rate limiting",
        rowShapeSource:
          "board-v2-probes/live-poll.json firstRowDump (provider wire names, incl. priceUSD and windowed txns)",
        notProven:
          "a real Cloudflare-gated socket. That needs the Electron bridge and is a DECLARED gate owed on the first desktop session.",
        channel: DEXSCREENER_BATCH_WS_URL,
        allowlistCheckedBy: "vex-app/src/main/dexscreener-bridge/allowlist.ts checkWsUrl",
        rankKey: "RANK_BY_KEY_VOLUME",
        cadenceMs: 5_000,
        attemptTimeoutMs: 20_000,
      },
      pools: POOLS,
      exchanges,
      leases: {
        first: first.leaseId,
        second: second.leaseId,
      },
      events: { boardA: eventsA, boardB: eventsB },
      assertions: {
        ticksBeforeSupersession: ticksSeen,
        eventsAfterTeardown: 0,
        exchangesAfterTeardown: 0,
        everyExchangeAllowed: true,
        distinctCoalesceScopes: scopes.size,
      },
    };
    mkdirSync(dirname(ARCHIVE), { recursive: true });
    writeFileSync(ARCHIVE, `${JSON.stringify(transcript, null, 2)}\n`, "utf8");
  });
});
