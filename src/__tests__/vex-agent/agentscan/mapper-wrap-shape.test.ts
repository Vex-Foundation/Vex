/**
 * The AgentScan payload a settled wrap and a settled unwrap PRODUCE.
 *
 * SCOPE, and the line this suite does not cross: it asserts the SHAPE of the
 * mapped event only. It deliberately does NOT assert that a wrap row is
 * currently eligible for the outbox, and it does not touch `ELIGIBILITY_SQL` in
 * `db/repos/agentscan-reporting.ts`. The `wrap` kind is not in that predicate
 * yet, on purpose: turning it on is gated on a live confirmation that the
 * server accepts the pair, and it ships as its own named follow-up rather than
 * riding in on a test change. The last describe block below pins the gate as
 * CLOSED, so the flip cannot happen silently on either side.
 *
 * What the shape has to be right about before that flip is worth making:
 *
 *  1. BOTH LEGS SURVIVE. A wrap is the one kind whose two legs are the same
 *     quantity in two assets, so an event that dropped either side would
 *     describe a transfer rather than a conversion.
 *  2. EVERY AMOUNT IS A RAW DIGIT STRING. The server rejects a whole event over
 *     one optional that fails `^\d+$`, and a wei value cannot survive a JSON
 *     number, so the payload is checked for float syntax and for any numeric
 *     type at all.
 *  3. THE NATIVE LEG CARRIES THE SENTINEL. The mapper normalizes both native
 *     spellings on the way out; a wrap is the row where that matters most,
 *     because exactly one of its two legs is native.
 *
 * The privacy allowlist, the key set and the server schema mirror are the
 * property of `./mapper.test.ts` and are not restated here.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";
import { getPackageRoot } from "@utils/package-assets.js";

import { mapActivityToEvent } from "@vex-agent/agentscan/mapper.js";

const WALLET = "0xaaaabbbbccccddddeeeeffff0000111122223333";
const WETH = "0x4200000000000000000000000000000000000006";
const NATIVE_SENTINEL = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

/** 2.5 ETH in wei - past IEEE-754 integer precision, as every wei value is. */
const AMOUNT_RAW = "2500000000000000000";

/**
 * A settled wrap row as `agent_activity` holds it after the terminal
 * settlement: confirmed, hash present, both executed legs written from the one
 * quantity the receipt proved.
 */
function settledWrapRow(direction: "wrap" | "unwrap"): Record<string, unknown> {
  const wrapping = direction === "wrap";
  const nativeLeg = {
    address: NATIVE_SENTINEL,
    symbol: "ETH",
    decimals: 18,
  };
  const wrappedLeg = { address: WETH, symbol: "WETH", decimals: 18 };
  const tokenIn = wrapping ? nativeLeg : wrappedLeg;
  const tokenOut = wrapping ? wrappedLeg : nativeLeg;

  return {
    id: "77301",
    protocol_execution_id: "5512",
    event_index: 0,
    event_role: direction,
    record_version: 1,
    kind: "wrap",
    protocol: "wallet_wrap",
    chain_id: "8453",
    chain_slug: "base",
    chain_family: "eip155",
    status: "confirmed",
    failure_code: null,
    failure_reason: null,
    token_in_address: tokenIn.address,
    token_in_symbol: tokenIn.symbol,
    token_in_decimals: tokenIn.decimals,
    amount_in_human: "2.5",
    amount_in_raw: AMOUNT_RAW,
    token_out_address: tokenOut.address,
    token_out_symbol: tokenOut.symbol,
    token_out_decimals: tokenOut.decimals,
    amount_out_human: "2.5",
    amount_out_raw: AMOUNT_RAW,
    executed_amount_in_human: "2.5",
    executed_amount_in_raw: AMOUNT_RAW,
    executed_amount_out_human: "2.5",
    executed_amount_out_raw: AMOUNT_RAW,
    usd_in_est: null,
    usd_out_est: null,
    // No fee is taken on a wrap and no fee column is written by this path.
    usd_fee_est: null,
    usd_source: null,
    tx_hash: "0x" + "cd".repeat(32),
    from_address: WALLET,
    nonce: "12",
    wallet_address: WALLET,
    session_id: "session-wrap-1",
    route_provenance: null,
    from_chain_id: null,
    to_chain_id: null,
    observed_at: null,
    broadcast_at: new Date("2026-08-27T09:14:02.000Z"),
    confirmed_at: new Date("2026-08-27T09:14:31.500Z"),
    settled_block_time: new Date("2026-08-27T09:14:25.000Z"),
    settlement_source: "tool_response",
    created_at: new Date("2026-08-27T09:13:58.000Z"),
    updated_at: new Date("2026-08-27T09:14:31.500Z"),
  };
}

const RAW_AMOUNT_FIELDS = [
  "amountInRaw",
  "amountOutRaw",
  "executedInRaw",
  "executedOutRaw",
] as const;

describe("a settled wrap and unwrap map to an eligible-SHAPED payload", () => {
  for (const direction of ["wrap", "unwrap"] as const) {
    it(`${direction}: both legs are present and carry their decimals`, () => {
      const event = mapActivityToEvent(settledWrapRow(direction), { status: "confirmed" });

      expect(event.kind).toBe("wrap");
      expect(event.eventRole).toBe(direction);
      expect(event.status).toBe("confirmed");

      // A conversion has two sides. Either one missing would describe a
      // transfer, which is not what happened.
      expect(event.tokenIn).not.toBeNull();
      expect(event.tokenOut).not.toBeNull();
      expect(event.tokenIn).toEqual({
        address: direction === "wrap" ? NATIVE_SENTINEL : WETH,
        symbol: direction === "wrap" ? "ETH" : "WETH",
        decimals: 18,
      });
      expect(event.tokenOut).toEqual({
        address: direction === "wrap" ? WETH : NATIVE_SENTINEL,
        symbol: direction === "wrap" ? "WETH" : "ETH",
        decimals: 18,
      });

      // The quoted legs are always declared, both directions.
      expect(event.amountInRaw).toBe(AMOUNT_RAW);
      expect(event.amountOutRaw).toBe(AMOUNT_RAW);

      // THE EXECUTED LEGS FOLLOW THE MAPPER'S NATIVE REPORTING RULE, and a wrap
      // is the row that shows both of its arms at once. The server's verifier
      // cross-checks a native INPUT against the transaction's own value and
      // SKIPS a native output outright, and skipping is not verifying - so only
      // the slot it genuinely checks may carry a native amount. A wrap's native
      // leg is the input and is reported; an unwrap's native leg is the output
      // and is suppressed, while its wrapped input is declared normally.
      //
      // This is a REPORTING rule, not a decoding one: both executed legs are
      // written in full locally by the settlement, and it is only the outbound
      // event that holds one back. It is also the concrete reason the
      // eligibility flip below needs a live server confirmation before it can
      // be made: an unwrap event reaches the server with one executed leg.
      if (direction === "wrap") {
        expect(event.executedInRaw).toBe(AMOUNT_RAW);
        expect(event.executedOutRaw).toBe(AMOUNT_RAW);
      } else {
        expect(event.executedInRaw).toBe(AMOUNT_RAW);
        expect(event.executedOutRaw).toBeNull();
      }
    });

    it(`${direction}: every amount it does declare is a raw digit string, never a float`, () => {
      const event = mapActivityToEvent(settledWrapRow(direction), { status: "confirmed" });

      for (const field of RAW_AMOUNT_FIELDS) {
        const value = event[field];
        // A suppressed native output leaves the field null, which the server
        // accepts. What must never happen is a non-string, or digits that are
        // not digits.
        if (value === null) continue;
        expect(typeof value, `${field} must be a string`).toBe("string");
        // The server's own per-item regex. A value that fails it sinks the
        // whole event, and a wei value that had passed through a JSON number
        // would arrive here in exponent form.
        expect(String(value)).toMatch(/^\d+$/);
      }

      const json = JSON.stringify(event);
      expect(json).not.toMatch(/"(amount|executed)[A-Za-z0-9]*Raw":\s*-?\d/);
      expect(json).not.toContain("e+");
      expect(json).not.toContain("2.5e");
    });

    it(`${direction}: the native leg leaves as the sentinel, never the zero address`, () => {
      const zeroAddressRow = {
        ...settledWrapRow(direction),
        [direction === "wrap" ? "token_in_address" : "token_out_address"]:
          "0x0000000000000000000000000000000000000000",
      };
      const event = mapActivityToEvent(zeroAddressRow, { status: "confirmed" });
      const nativeLeg = direction === "wrap" ? event.tokenIn : event.tokenOut;
      expect(nativeLeg).not.toBeNull();
      expect((nativeLeg as { address: string }).address).toBe(NATIVE_SENTINEL);
    });

    it(`${direction}: a pending snapshot omits the executed legs and the confirmation time`, () => {
      // The outbox status is a snapshot, not the live row: an event sent while
      // the row was still pending must not claim amounts it had not proved.
      const event = mapActivityToEvent(settledWrapRow(direction), { status: "pending" });
      expect(event.executedInRaw).toBeNull();
      expect(event.executedOutRaw).toBeNull();
      expect(event.confirmedAt).toBeNull();
    });
  }

  it("the reported confirmation time is the block time, never the local observation", () => {
    const event = mapActivityToEvent(settledWrapRow("wrap"), { status: "confirmed" });
    expect(event.confirmedAt).toBe("2026-08-27T09:14:25.000Z");
    expect(JSON.stringify(event)).not.toContain("09:14:31.500Z");
  });

  it("carries no fee estimate, because a wrap takes no fee", () => {
    const event = mapActivityToEvent(settledWrapRow("wrap"), { status: "confirmed" });
    expect(event.usdFeeEst).toBeNull();
  });
});

describe("the outbox eligibility gate is still CLOSED for wrap", () => {
  /**
   * Read from source rather than executed: the flip is a deliberate, live-
   * confirmed follow-up, and this assertion is the tripwire that makes it a
   * conscious edit on both sides. When `wrap` is added to the predicate, this
   * block changes with it; until then, a silent widening fails here.
   */
  const REPORTING_SQL = readFileSync(
    join(getPackageRoot(), "src", "vex-agent", "db", "repos", "agentscan-reporting.ts"),
    "utf-8",
  );

  /**
   * Migration 102 split the predicate by VOCABULARY VERSION: the always-reported
   * half (`ELIGIBLE_VOCABULARY_V1_SQL`) and the launchpad family gated behind the
   * one-time backfill (`ELIGIBLE_VOCABULARY_V2_SQL`). `wrap` may not appear in
   * EITHER, so both are read and concatenated - checking only the composed
   * `ELIGIBILITY_SQL` would now look at a block that names no roles at all and
   * pass for the wrong reason.
   */
  function vocabularyBlocks(): string {
    const names = ["ELIGIBLE_VOCABULARY_V1_SQL", "ELIGIBLE_VOCABULARY_V2_SQL"];
    return names
      .map((name) => {
        const start = REPORTING_SQL.indexOf(`const ${name} = \``);
        if (start === -1) throw new Error(`${name} not found in agentscan-reporting.ts`);
        const end = REPORTING_SQL.indexOf("`;", start);
        if (end === -1) throw new Error(`${name} is unterminated`);
        return REPORTING_SQL.slice(start, end);
      })
      .join("\n");
  }

  it("neither the wrap kind nor its two roles are in the predicate yet", () => {
    const block = vocabularyBlocks();
    expect(block).not.toContain("'wrap'");
    expect(block).not.toContain("'unwrap'");
    // The kinds that ARE eligible, so this is not passing because the block
    // was renamed out from under the search.
    expect(block).toContain("'swap'");
    expect(block).toContain("'bridge'");
  });

  it("the composed predicate gates the launchpad family on the COVERED vocabulary, not on a timestamp", () => {
    // The gate is what keeps a widened vocabulary from letting the incremental
    // scan claim months of history as live activity. If it is ever removed, the
    // wrap flip above would be the second-least of the problems.
    //
    // CONTRACT CHANGE 2026-09-04: it reads `backfill_vocabulary_version`, not
    // `backfill_enqueued_at IS NOT NULL`. A timestamp says only that SOME
    // backfill ran; a build at vocabulary 1 running against a database migration
    // 102 already stamped at 2 performs a V1-only scan and would leave a mark the
    // next V2 build reads as full coverage. The version stamp can only claim
    // what the scan that wrote it actually covered.
    const start = REPORTING_SQL.indexOf("const ELIGIBILITY_SQL = `");
    const end = REPORTING_SQL.indexOf("`;", start);
    const composed = REPORTING_SQL.slice(start, end);
    expect(composed).toContain("s.vocabulary_version >=");
    expect(composed).toContain("s.backfill_vocabulary_version >=");
    expect(composed).not.toContain("backfill_enqueued_at");
  });
});
