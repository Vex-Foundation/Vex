/**
 * BOARD LIVE - the pool boundary is a POSITIVE PICK.
 *
 * The live channel exists to refresh figures. It has no business carrying the
 * agent's authored text across it, and the guarantee has to survive the pool
 * shape GROWING: this schema was once "the pool minus caption", and under that
 * subtractive rule the `analysis` field - the model's full written assessment -
 * would have become admissible on this channel the moment it was added, with
 * nothing failing to say so.
 *
 * Both authored fields are asserted here BY NAME, because a strict object
 * refuses them rather than dropping them silently, and a silent drop is the
 * outcome that would have hidden the leak.
 */

import { describe, expect, it } from "vitest";

import {
  boardLivePoolSchema,
  boardLiveSubscribeInputSchema,
} from "../board-live.js";

const CHAIN = "solana";
const PAIR = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";
const REQUEST_ID = "0e2ec2a5-8ba0-4a10-9f2f-3c9d1d3b8f10";

describe("boardLivePoolSchema", () => {
  it("accepts exactly the two identity fields", () => {
    const parsed = boardLivePoolSchema.safeParse({
      chain: CHAIN,
      pairAddress: PAIR,
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(Object.keys(parsed.data).sort()).toEqual(["chain", "pairAddress"]);
  });

  it.each([
    ["caption", "deepest pool"],
    ["analysis", "Safety checks are clean.\nVolume is accelerating."],
  ])("refuses the authored field %s by name", (field, value) => {
    const parsed = boardLivePoolSchema.safeParse({
      chain: CHAIN,
      pairAddress: PAIR,
      [field]: value,
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const paths = parsed.error.issues.flatMap((issue) =>
      issue.code === "unrecognized_keys" ? issue.keys : [],
    );
    expect(paths).toContain(field);
  });

  it("does not admit an authored field even when it is null", () => {
    // Null is what a writer emits for a pool with no assessment, so a durable
    // pool object handed to this channel verbatim carries the key. It is still
    // refused: the channel takes identity, not the pool document.
    expect(
      boardLivePoolSchema.safeParse({
        chain: CHAIN,
        pairAddress: PAIR,
        analysis: null,
      }).success,
    ).toBe(false);
  });

  it("refuses a whole persisted pool through the subscribe input", () => {
    const parsed = boardLiveSubscribeInputSchema.safeParse({
      pools: [
        { chain: CHAIN, pairAddress: PAIR, caption: "x", analysis: "y" },
      ],
      requestId: REQUEST_ID,
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts the identity-only subscribe input", () => {
    expect(
      boardLiveSubscribeInputSchema.safeParse({
        pools: [{ chain: CHAIN, pairAddress: PAIR }],
        requestId: REQUEST_ID,
      }).success,
    ).toBe(true);
  });
});
