/**
 * The board's live channel VOCABULARY, as a table.
 *
 * WHY THIS FILE EXISTS. The spotlight shipped a momentum panel and an
 * other-pools panel that were absent from `BOARD_LIVE_CHANNEL_IDS`. A channel
 * missing from that list is a read the ceiling, the priority order and the cut
 * cannot see, and nothing caught it because the three tables are three
 * separate object literals that happened to agree. These tests make them agree
 * BY CONSTRUCTION: a future channel added to one and forgotten in another is a
 * red test rather than a poll nobody can stop.
 *
 * Everything here is a pure table read. There is no clock, no network and no
 * scheduler: the enumeration itself is the contract under test.
 */

import { describe, expect, it } from "vitest";
import {
  BOARD_LIVE_ADMISSION_QUEUE_MAX,
  BOARD_LIVE_CHANNEL_IDS,
  BOARD_LIVE_CHANNEL_OWNER,
  BOARD_LIVE_CHANNEL_PRIORITY,
  BOARD_LIVE_MAX_IN_FLIGHT,
  CADENCE_CARDS_MS,
  CADENCE_DETAILS_MS,
  CADENCE_MOMENTUM_MS,
  CADENCE_OTHER_POOLS_MS,
  CADENCE_TAPE_MS,
  CADENCE_TRADERS_MS,
  chartCadenceMsFor,
} from "../live-channels.js";

describe("every channel appears in every table", () => {
  it.each(BOARD_LIVE_CHANNEL_IDS)("%s has a priority", (id) => {
    expect(BOARD_LIVE_CHANNEL_PRIORITY[id]).toBeTypeOf("number");
  });

  it.each(BOARD_LIVE_CHANNEL_IDS)("%s has an owning surface", (id) => {
    expect(["modal", "spotlight"]).toContain(BOARD_LIVE_CHANNEL_OWNER[id]);
  });

  it("has no priority or owner entry for a channel that is not enumerated", () => {
    // The other direction: a row left behind after a channel was removed is
    // just as much a lie about what the board runs.
    const ids = new Set<string>(BOARD_LIVE_CHANNEL_IDS);
    expect(Object.keys(BOARD_LIVE_CHANNEL_PRIORITY).sort()).toEqual(
      [...ids].sort(),
    );
    expect(Object.keys(BOARD_LIVE_CHANNEL_OWNER).sort()).toEqual([...ids].sort());
  });

  it("enumerates the two panels that shipped without an entry", () => {
    // The literal defect. Reverting the vocabulary addition turns this red.
    expect(BOARD_LIVE_CHANNEL_IDS).toContain("spotlight-momentum");
    expect(BOARD_LIVE_CHANNEL_IDS).toContain("spotlight-other-pools");
    expect(BOARD_LIVE_CHANNEL_OWNER["spotlight-momentum"]).toBe("spotlight");
    expect(BOARD_LIVE_CHANNEL_OWNER["spotlight-other-pools"]).toBe("spotlight");
  });

  it("names every id exactly once", () => {
    expect(new Set(BOARD_LIVE_CHANNEL_IDS).size).toBe(
      BOARD_LIVE_CHANNEL_IDS.length,
    );
  });
});

describe("the cadences the surfaces actually ship", () => {
  it("keeps the measured card and tape cadence at five seconds", () => {
    expect(CADENCE_CARDS_MS).toBe(5_000);
    expect(CADENCE_TAPE_MS).toBe(5_000);
  });

  it("polls the two aggregate panels on the same thirty-second clock", () => {
    // The renderer's momentum panel ships at the traders cadence; these two
    // constants agreeing is what makes that true rather than coincidental.
    expect(CADENCE_MOMENTUM_MS).toBe(CADENCE_TRADERS_MS);
    expect(CADENCE_MOMENTUM_MS).toBe(30_000);
  });

  it("keeps the details cadence at the provider's own max-age", () => {
    expect(CADENCE_DETAILS_MS).toBe(60_000);
  });

  it("declares other-pools a one-shot rather than a poll", () => {
    expect(CADENCE_OTHER_POOLS_MS).toBeNull();
  });

  it("gives a faster pill a faster chart cadence, floored at the card clock", () => {
    expect(chartCadenceMsFor("1m")).toBe(5_000);
    expect(chartCadenceMsFor("15m")).toBe(15_000);
    expect(chartCadenceMsFor("2h")).toBe(30_000);
    expect(chartCadenceMsFor("8h")).toBe(30_000);
  });
});

describe("the board's share of the bridge", () => {
  it("takes two of the bridge's four exchanges and leaves the agent two", () => {
    expect(BOARD_LIVE_MAX_IN_FLIGHT).toBe(2);
  });

  it("bounds the waiting line, so the ceiling is a ceiling and not a delay", () => {
    expect(BOARD_LIVE_ADMISSION_QUEUE_MAX).toBeGreaterThan(
      BOARD_LIVE_MAX_IN_FLIGHT,
    );
    expect(Number.isFinite(BOARD_LIVE_ADMISSION_QUEUE_MAX)).toBe(true);
  });
});
