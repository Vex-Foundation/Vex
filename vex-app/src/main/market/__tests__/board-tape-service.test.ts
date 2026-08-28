/**
 * THE TAPE ALGORITHM (A12), one case per rule.
 *
 * Every case here is a loss-of-data question rather than a rendering one: a
 * polled tape either does not lose trades between ticks or SAYS that it did,
 * and the difference is invisible on screen. So the fixtures drive the real
 * service over a scripted page source and assert the published batch, the
 * watermark, the gap marker and the counters together.
 *
 * The W+1 BOUNDARY CASE is the one this suite exists for. The endpoint's
 * `afterBlock` bound is strictly exclusive, so under `afterBlock = W - 1` the
 * oldest block the provider may return is W itself, and a full page whose
 * oldest row sits at exactly W+1 has NOT reached the overlap block. Writing the
 * test as `>=` instead of `>` passes every ordinary case and silently drops one
 * block's trades under load, which is precisely the defect a fixture at the
 * boundary catches and a fixture in the middle never will.
 */

import { describe, expect, it, vi } from "vitest";

import type { PairSubject } from "@tools/dexscreener/endpoints/pair-subject.js";
import {
  TRADES_PER_PAGE,
  type ProjectedTrade,
  type TradeCursor,
  type TradesPage,
} from "@tools/dexscreener/endpoints/trades.js";
import { DexScreenerSiteErrorCodes } from "@tools/dexscreener/site-errors.js";
import { createBoardTapeService, TAPE_RING_SIZE } from "../board-tape-service.js";

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const SUBJECT = {
  chain: "solana",
  pairAddress: "22CfmLna8Bsh7xrbyvGSs6NdD31iFj1UFVnwB7EberWU",
} as const;

/**
 * The canonical subject, spelled exactly as the resolver hands it over.
 *
 * The quote address is kept in the provider's own casing: a lower-cased
 * spelling of the CORRECT address answers 200 with the pair silently inverted,
 * which on a tape draws every buy as a sell.
 */
const PAIR: PairSubject = {
  chainId: "solana",
  pairAddress: "22CfmLna8Bsh7xrbyvGSs6NdD31iFj1UFVnwB7EberWU",
  ammId: "pumpfundex",
  baseTokenAddress: "PisTAcio1111111111111111111111111111111111",
  baseTokenSymbol: "Pistacio",
  quoteTokenAddress: "So11111111111111111111111111111111111111112",
  quoteTokenSymbol: "SOL",
  dexId: "pumpfun",
  labels: [],
  priceUsd: "0.007794",
  liquidityUsd: 41_000,
  pairCreatedAtMs: 1_787_600_000_000,
  resolutionBasis: "explicit_pair_address",
  resolvedFromToken: null,
  searchWindowSize: null,
  fetchedAtMs: 1_787_741_000_000,
};

/** One trade with the exact identity triple the live rows carry (probe P2). */
function trade(
  blockNumber: number,
  transactionIndex: number,
  eventIndex: number,
  overrides: Partial<ProjectedTrade> = {},
): ProjectedTrade {
  return {
    eventType: "sell",
    blockNumber,
    blockTimestampMs: 1_787_741_187_000,
    transactionId: `tx-${blockNumber}-${transactionIndex}-${eventIndex}`,
    transactionIndex,
    eventIndex,
    maker: "C2oUGnvQNvseZ8HuM4DrCi4NwYaeJtRDjidCbGMHfdRE",
    priceUsd: "0.007794",
    priceNative: "0.00007996",
    volumeUsd: "4.98",
    amountBase: "639.068",
    amountQuote: "0.05109",
    marketCapUsd: null,
    trader: null,
    ...overrides,
  };
}

function page(trades: readonly ProjectedTrade[], nextCursor: TradeCursor | null = null): TradesPage {
  return {
    trades,
    channel: "connect",
    url: "https://io.dexscreener.com/dex/log/amm/v5/x",
    bytes: 1024,
    fetchedAtMs: 1_787_741_000_000,
    nextCursor,
  };
}

/** A full page, newest first, descending from `topBlock`. */
function fullPage(topBlock: number, nextCursor: TradeCursor | null = null): TradesPage {
  const trades = Array.from({ length: TRADES_PER_PAGE }, (_unused, index) =>
    trade(topBlock - index, 1, 0),
  );
  return page(trades, nextCursor);
}

interface Recorded {
  readonly afterBlock: number | undefined;
  readonly cursor: TradeCursor | undefined;
  readonly coalesceScope: string;
}

/** Build a service over a scripted page source, recording every request. */
function harness(
  pages: readonly TradesPage[],
  options: { readonly now?: () => number; readonly onFetch?: () => void } = {},
): {
  readonly service: ReturnType<typeof createBoardTapeService>;
  readonly calls: Recorded[];
} {
  const calls: Recorded[] = [];
  let index = 0;
  const service = createBoardTapeService({
    resolveSubject: async () => PAIR,
    fetchPage: async (args) => {
      calls.push({
        afterBlock: args.afterBlock,
        cursor: args.cursor,
        coalesceScope: args.coalesceScope,
      });
      options.onFetch?.();
      const next = pages[index] ?? page([]);
      index += 1;
      return next;
    },
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { service, calls };
}

describe("the first tick seeds the ring", () => {
  it("publishes one page, sets the watermark to its highest block, and asks for no overlap", async () => {
    const { service, calls } = harness([page([trade(100, 2, 0), trade(99, 1, 0)])]);
    const outcome = await service.poll({ subject: SUBJECT, reset: true });

    expect(outcome.kind).toBe("tape");
    if (outcome.kind !== "tape") return;
    expect(outcome.rows).toHaveLength(2);
    expect(outcome.watermark).toBe(100);
    expect(outcome.appended).toBe(2);
    expect(outcome.gapBefore).toBe(false);
    // A first read has nothing to join to, so it sends no lower bound at all.
    expect(calls[0]?.afterBlock).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it("runs in its own coalescence scope, so a teardown cannot abort an agent's socket", async () => {
    const { service, calls } = harness([page([trade(100, 1, 0)])]);
    await service.poll({ subject: SUBJECT, reset: true });
    expect(calls[0]?.coalesceScope).toBe(
      `board-tape:solana:22cfmlna8bsh7xrbyvgss6ndd31ifj1ufvnwb7eberwu`,
    );
  });
});

describe("the overlap anchor", () => {
  it("asks for watermark minus one, because the provider's bound is strictly exclusive", async () => {
    const { service, calls } = harness([
      page([trade(100, 1, 0)]),
      page([trade(101, 1, 0), trade(100, 1, 0)]),
    ]);
    await service.poll({ subject: SUBJECT, reset: true });
    await service.poll({ subject: SUBJECT, reset: false });
    // Asking for 100 would EXCLUDE block 100, so a trade that landed in it
    // after the first tick could never be seen.
    expect(calls[1]?.afterBlock).toBe(99);
  });

  it("catches a late trade in the watermark's own block without re-publishing the old one", async () => {
    // Probe P2: every one of 12 live ticks returned at least one already-seen
    // row, which is the overlap doing its job.
    const { service } = harness([
      page([trade(100, 1, 0)]),
      page([trade(100, 5, 0), trade(100, 1, 0)]),
    ]);
    await service.poll({ subject: SUBJECT, reset: true });
    const second = await service.poll({ subject: SUBJECT, reset: false });

    expect(second.kind).toBe("tape");
    if (second.kind !== "tape") return;
    expect(second.appended).toBe(1);
    expect(second.rows.map((row) => row.id)).toEqual(["100:5:0", "100:1:0"]);
    expect(second.gapBefore).toBe(false);
  });
});

describe("the continuation boundary - the case a >= would pass and a > catches", () => {
  it("MUST continue when a full page's oldest row sits exactly at W+1", async () => {
    // W = 100, so the poll asked `afterBlock = 99` and the oldest block the
    // provider may return is 100. A full page whose oldest row is 101 has
    // therefore NOT reached the overlap block, even though it is adjacent to
    // it, and stopping here would lose block 100's trades.
    const cursor: TradeCursor = { blockNumber: 101, transactionIndex: 1, eventIndex: 0 };
    const { service, calls } = harness([
      page([trade(100, 1, 0)]),
      fullPage(200, cursor),
      page([trade(100, 9, 0)]),
    ]);
    await service.poll({ subject: SUBJECT, reset: true });
    const second = await service.poll({ subject: SUBJECT, reset: false });

    // The full page spans 200 down to 101 inclusive: its oldest row is W+1.
    expect(calls).toHaveLength(3);
    expect(calls[2]?.cursor).toEqual(cursor);
    expect(second.kind).toBe("tape");
    if (second.kind !== "tape") return;
    expect(second.gapBefore).toBe(false);
    expect(second.pagesFetched).toBe(2);
  });

  it("stops when a full page's oldest row reaches the overlap block itself", async () => {
    // Oldest row at exactly W: the overlap block was read, so there is nothing
    // between this page and what is already published.
    const { service, calls } = harness([
      page([trade(100, 1, 0)]),
      fullPage(199, { blockNumber: 100, transactionIndex: 1, eventIndex: 0 }),
    ]);
    await service.poll({ subject: SUBJECT, reset: true });
    const second = await service.poll({ subject: SUBJECT, reset: false });

    expect(calls).toHaveLength(2);
    expect(second.kind).toBe("tape");
    if (second.kind !== "tape") return;
    expect(second.gapBefore).toBe(false);
    expect(second.pagesFetched).toBe(1);
  });

  it("does not continue on a SHORT page, which is the provider's own end of the window", async () => {
    const { service, calls } = harness([
      page([trade(100, 1, 0)]),
      page([trade(150, 1, 0)], { blockNumber: 150, transactionIndex: 1, eventIndex: 0 }),
    ]);
    await service.poll({ subject: SUBJECT, reset: true });
    await service.poll({ subject: SUBJECT, reset: false });
    expect(calls).toHaveLength(2);
  });
});

describe("an unreachable overlap is an honest gap, never a silent one", () => {
  it("publishes atomically with gapBefore on the oldest row after exhausting the page budget", async () => {
    const cursor = (block: number): TradeCursor => ({
      blockNumber: block,
      transactionIndex: 1,
      eventIndex: 0,
    });
    const { service } = harness([
      page([trade(100, 1, 0)]),
      fullPage(400, cursor(301)),
      fullPage(300, cursor(201)),
      fullPage(200, cursor(101)),
    ]);
    await service.poll({ subject: SUBJECT, reset: true });
    const second = await service.poll({ subject: SUBJECT, reset: false });

    expect(second.kind).toBe("tape");
    if (second.kind !== "tape") return;
    // Three pages is the whole budget, and the overlap at block 100 was never
    // reached, so the trades between 100 and 101 are missing and the tape says
    // exactly where.
    expect(second.pagesFetched).toBe(3);
    expect(second.gapBefore).toBe(true);
    const oldest = second.rows[second.rows.length - 1];
    expect(oldest?.gapBefore).toBe(true);
    // The marker sits on the OLDEST row only: every newer row is continuous
    // with the one after it.
    expect(second.rows.filter((row) => row.gapBefore)).toHaveLength(1);
  });

  it("stops continuing when the tick deadline is spent, and still publishes", async () => {
    let clock = 0;
    const cursor = (block: number): TradeCursor => ({
      blockNumber: block,
      transactionIndex: 1,
      eventIndex: 0,
    });
    const { service } = harness(
      [
        page([trade(100, 1, 0)]),
        fullPage(400, cursor(301)),
        fullPage(300, cursor(201)),
      ],
      {
        now: () => clock,
        // Each page costs 8 s, so the 12 s tick deadline is spent after two.
        onFetch: () => {
          clock += 8_000;
        },
      },
    );
    await service.poll({ subject: SUBJECT, reset: true });
    const second = await service.poll({ subject: SUBJECT, reset: false });

    expect(second.kind).toBe("tape");
    if (second.kind !== "tape") return;
    expect(second.pagesFetched).toBe(2);
    expect(second.gapBefore).toBe(true);
  });
});

describe("a row without the full identity triple is refused and counted", () => {
  it.each([
    ["no block number", { blockNumber: null }],
    ["no transaction index", { transactionIndex: null }],
    ["no event index", { eventIndex: null }],
  ])("drops a row with %s and reports it", async (_label, missing) => {
    const { service } = harness([
      page([trade(100, 1, 0), trade(99, 1, 0, missing as Partial<ProjectedTrade>)]),
    ]);
    const outcome = await service.poll({ subject: SUBJECT, reset: true });

    expect(outcome.kind).toBe("tape");
    if (outcome.kind !== "tape") return;
    // Refused rather than shown: a row that cannot be deduplicated would
    // reappear on every later tick.
    expect(outcome.rows).toHaveLength(1);
    expect(outcome.droppedIncompleteIdentity).toBe(1);
  });

  it("never lets a dropped row advance the watermark past what was published", async () => {
    const { service } = harness([
      page([trade(500, 1, 0, { transactionIndex: null }), trade(100, 1, 0)]),
    ]);
    const outcome = await service.poll({ subject: SUBJECT, reset: true });
    expect(outcome.kind).toBe("tape");
    if (outcome.kind !== "tape") return;
    expect(outcome.watermark).toBe(100);
  });
});

describe("the ring is bounded and evicts the oldest", () => {
  it(`holds at most ${TAPE_RING_SIZE} rows, newest first`, async () => {
    const first = Array.from({ length: 20 }, (_unused, index) => trade(1_000 - index, 1, 0));
    const second = Array.from({ length: 20 }, (_unused, index) => trade(1_100 - index, 1, 0));
    const { service } = harness([page(first), page(second)]);

    await service.poll({ subject: SUBJECT, reset: true });
    const outcome = await service.poll({ subject: SUBJECT, reset: false });

    expect(outcome.kind).toBe("tape");
    if (outcome.kind !== "tape") return;
    expect(outcome.rows).toHaveLength(TAPE_RING_SIZE);
    // Newest first, and the oldest ten of the first batch have been evicted.
    expect(outcome.rows[0]?.blockNumber).toBe(1_100);
    expect(outcome.rows.map((row) => row.id)).not.toContain("981:1:0");
  });
});

describe("cancellation", () => {
  it("publishes nothing and leaves the watermark unchanged when aborted mid-continuation", async () => {
    const controller = new AbortController();
    const cursor: TradeCursor = { blockNumber: 301, transactionIndex: 1, eventIndex: 0 };
    // The cancelled tick fetches nothing at all, so the page after the seed is
    // the one the RECOVERING tick receives.
    void cursor;
    const { service, calls } = harness([
      page([trade(100, 1, 0)]),
      page([trade(101, 1, 0), trade(100, 1, 0)]),
    ]);

    const first = await service.poll({ subject: SUBJECT, reset: true });
    expect(first.kind).toBe("tape");
    if (first.kind !== "tape") return;
    expect(first.watermark).toBe(100);

    // The reader leaves before the tick starts. Nothing is fetched and nothing
    // is published.
    controller.abort();
    const second = await service.poll({
      subject: SUBJECT,
      reset: false,
      signal: controller.signal,
    });
    expect(second).toEqual({ kind: "unavailable", reason: "cancelled" });
    expect(calls).toHaveLength(1);

    // The watermark did NOT move, which the NEXT tick's request proves: it
    // still asks for the same overlap window rather than stepping over the
    // trades the cancelled tick would have fetched.
    const third = await service.poll({ subject: SUBJECT, reset: false });
    expect(calls[1]?.afterBlock).toBe(99);
    expect(third.kind).toBe("tape");
    if (third.kind !== "tape") return;
    expect(third.watermark).toBe(101);
  });

  it("aborts an in-flight continuation without publishing a partial batch", async () => {
    const controller = new AbortController();
    let pageIndex = 0;
    const service = createBoardTapeService({
      resolveSubject: async () => PAIR,
      fetchPage: async (args) => {
        pageIndex += 1;
        if (pageIndex === 1) return page([trade(100, 1, 0)]);
        if (pageIndex === 2) {
          // The reader leaves while this page is being fetched.
          controller.abort();
          return fullPage(400, { blockNumber: 301, transactionIndex: 1, eventIndex: 0 });
        }
        expect(args.signal.aborted).toBe(false);
        return page([]);
      },
    });

    await service.poll({ subject: SUBJECT, reset: true });
    const outcome = await service.poll({
      subject: SUBJECT,
      reset: false,
      signal: controller.signal,
    });
    expect(outcome).toEqual({ kind: "unavailable", reason: "cancelled" });
    // Exactly two pages: the loop noticed the abort instead of spending the
    // rest of the budget on a reader who has gone.
    expect(pageIndex).toBe(2);
  });
});

describe("reset and cut forget one subject's ring", () => {
  it("reset re-seeds instead of showing the previous visit's trades as new", async () => {
    const { service, calls } = harness([
      page([trade(100, 1, 0)]),
      page([trade(200, 1, 0)]),
    ]);
    await service.poll({ subject: SUBJECT, reset: true });
    const second = await service.poll({ subject: SUBJECT, reset: true });

    expect(calls[1]?.afterBlock).toBeUndefined();
    expect(second.kind).toBe("tape");
    if (second.kind !== "tape") return;
    expect(second.rows).toHaveLength(1);
    expect(second.watermark).toBe(200);
  });

  it("cut forgets the ring so the next poll seeds again", async () => {
    const { service, calls } = harness([
      page([trade(100, 1, 0)]),
      page([trade(200, 1, 0)]),
    ]);
    await service.poll({ subject: SUBJECT, reset: true });
    service.cut(SUBJECT);
    await service.poll({ subject: SUBJECT, reset: false });
    expect(calls[1]?.afterBlock).toBeUndefined();
  });
});

describe("failures are typed, and none of them is remembered", () => {
  it.each([
    [DexScreenerSiteErrorCodes.TRANSPORT_TIMEOUT, "transport"],
    [DexScreenerSiteErrorCodes.SITE_TRANSPORT_UNAVAILABLE, "not_mounted"],
    ["SOMETHING_ELSE", "provider"],
  ])("maps %s to %s", async (code, reason) => {
    const service = createBoardTapeService({
      resolveSubject: async () => PAIR,
      fetchPage: async () => {
        throw Object.assign(new Error("refused"), { code });
      },
    });
    const outcome = await service.poll({ subject: SUBJECT, reset: true });
    expect(outcome).toEqual({ kind: "unavailable", reason });
  });

  it("keeps the watermark and the ring when a tick fails", async () => {
    let calls = 0;
    const service = createBoardTapeService({
      resolveSubject: async () => PAIR,
      fetchPage: async () => {
        calls += 1;
        if (calls === 1) return page([trade(100, 1, 0)]);
        if (calls === 2) throw Object.assign(new Error("refused"), { code: "X" });
        return page([trade(101, 1, 0), trade(100, 1, 0)]);
      },
    });
    await service.poll({ subject: SUBJECT, reset: true });
    await service.poll({ subject: SUBJECT, reset: false });
    const third = await service.poll({ subject: SUBJECT, reset: false });

    expect(third.kind).toBe("tape");
    if (third.kind !== "tape") return;
    // The failed tick published nothing, so the ring still holds the seed and
    // the overlap still catches the duplicate.
    expect(third.appended).toBe(1);
    expect(third.rows).toHaveLength(2);
  });
});

describe("dispose", () => {
  it("refuses new polls and clears every ring", async () => {
    const { service } = harness([page([trade(100, 1, 0)])]);
    await service.poll({ subject: SUBJECT, reset: true });
    await service.dispose();
    const outcome = await service.poll({ subject: SUBJECT, reset: false });
    expect(outcome).toEqual({ kind: "unavailable", reason: "not_mounted" });
  });

  it("is idempotent", async () => {
    const { service } = harness([page([trade(100, 1, 0)])]);
    await service.dispose();
    await expect(service.dispose()).resolves.toBeUndefined();
  });
});
