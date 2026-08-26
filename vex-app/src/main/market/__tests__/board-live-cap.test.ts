/**
 * A7's board-wide cap, proven across BOTH kinds of board read.
 *
 * The live card lease and the admitted Spotlight reads must share ONE
 * scheduler, or a card tick becomes a third board exchange beside two
 * Spotlight reads and the agent is left a single bridge slot. This drives the
 * real scheduler and the real admission wrapper with a fetch double that
 * counts what is actually in flight: the count never exceeds the ceiling,
 * and the third read starts only when one of the first two settles.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  createBoardLiveScheduler,
  type BoardLiveScheduler,
} from "../board-live-scheduler.js";
import { admittedFetchBatch } from "../board-live-service.js";
import type { BatchIdentity } from "@tools/dexscreener/endpoints/pairs-batch.js";

const IDENTITIES: readonly BatchIdentity[] = [
  { chainId: "solana", id: "PairAAA", kind: "pair", raw: "solana:PairAAA" },
];

function scheduler(maxInFlight: number): BoardLiveScheduler {
  return createBoardLiveScheduler({
    now: () => Date.now(),
    maxInFlight,
    admissionQueueMax: 16,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle),
  });
}

/** A read that stays in flight until the test releases it. */
function heldRead(): { start: () => Promise<void>; release: () => void; started: boolean } {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const read = { started: false, release, start: async () => {} };
  read.start = async (): Promise<void> => {
    read.started = true;
    await gate;
  };
  return read;
}

describe("A7 cap across the card lease and Spotlight reads", () => {
  const schedulers: BoardLiveScheduler[] = [];
  afterEach(async () => {
    for (const s of schedulers.splice(0)) await s.stop();
  });

  it("a live card tick plus two Spotlight reads never exceed two in flight", async () => {
    const s = scheduler(2);
    schedulers.push(s);
    let inFlight = 0;
    let peak = 0;
    const enter = (): void => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
    };
    const leave = (): void => {
      inFlight -= 1;
    };

    const spotlightA = heldRead();
    const spotlightB = heldRead();
    const cards = heldRead();

    const admitSpotlight = (read: ReturnType<typeof heldRead>) =>
      s.admit({ id: "spotlight-traders", owner: "spotlight", key: read === spotlightA ? "a" : "b" }, async () => {
        enter();
        try {
          await read.start();
        } finally {
          leave();
        }
        return "ok";
      });

    const fetchBatch = admittedFetchBatch(async (args) => {
      enter();
      try {
        await cards.start();
      } finally {
        leave();
      }
      return {
        rows: [],
        resolvedKeys: new Set<string>(),
        unrequested: [],
        collapsed: [],
        fetchedAtMs: Date.now(),
      };
    }, () => s);

    const a = admitSpotlight(spotlightA);
    const b = admitSpotlight(spotlightB);
    await Promise.resolve();
    await Promise.resolve();
    expect(spotlightA.started && spotlightB.started).toBe(true);

    const controller = new AbortController();
    const tick = fetchBatch({
      identities: IDENTITIES,
      signal: controller.signal,
      timeoutMs: 1_000,
      coalesceScope: "board-live:test",
    });
    await Promise.resolve();
    await Promise.resolve();
    // The third board read WAITS: the ceiling is board-wide, not per kind.
    expect(cards.started).toBe(false);
    expect(peak).toBe(2);

    spotlightA.release();
    await a;
    await Promise.resolve();
    await Promise.resolve();
    expect(cards.started).toBe(true);
    expect(peak).toBe(2);

    spotlightB.release();
    cards.release();
    await b;
    const answer = await tick;
    expect(answer.rows).toEqual([]);
    expect(inFlight).toBe(0);
  });

  it("surfaces a missing scheduler as the transport's own permanent fault", async () => {
    const fetchBatch = admittedFetchBatch(async () => {
      throw new Error("must not reach the provider without a scheduler");
    }, () => null);
    await expect(
      fetchBatch({
        identities: IDENTITIES,
        signal: new AbortController().signal,
        timeoutMs: 1_000,
        coalesceScope: "board-live:test",
      }),
    ).rejects.toMatchObject({ code: "DEXSCREENER_SITE_TRANSPORT_UNAVAILABLE" });
  });
});
