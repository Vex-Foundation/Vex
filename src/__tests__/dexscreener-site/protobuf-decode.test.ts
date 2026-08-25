/**
 * Conformance for the protobuf codec, against real captured bytes.
 *
 * What these prove: the checked-in descriptor set loads, the allowlist is
 * enforced at the only entry point, the byte cap rejects rather than trims, and
 * a real 21 KB search response decodes to exactly the JSON the live capture
 * recorded (which was produced independently, by the reference `protobuf`
 * runtime in Python).
 *
 * What they do not prove: that the site still speaks this schema today. That is
 * the env-gated drift test's job.
 */

import { describe, expect, it } from "vitest";
import {
  DEXSCREENER_MESSAGES,
  decodeDexScreenerMessage,
  decodeDexScreenerMessageToJson,
  getDexScreenerMessageDescriptor,
  getDexScreenerProtoRegistry,
  type DexScreenerMessageName,
} from "../../tools/dexscreener/codec/protobuf.js";
import { DexScreenerSiteErrorCodes } from "../../tools/dexscreener/site-errors.js";
import { VexError } from "../../errors.js";
import { loadFixture, loadFixtureDecodedJson } from "./_fixtures.js";

describe("DexScreener protobuf registry", () => {
  it("resolves every allowlisted message from the checked-in descriptor set", () => {
    for (const name of DEXSCREENER_MESSAGES) {
      expect(getDexScreenerMessageDescriptor(name).typeName).toBe(name);
    }
  });

  it("builds the registry once and reuses it", () => {
    expect(getDexScreenerProtoRegistry()).toBe(getDexScreenerProtoRegistry());
  });
});

describe("decodeDexScreenerMessage", () => {
  it("decodes the captured search response to the JSON the capture recorded", () => {
    const fixture = loadFixture("search-cat-plain");
    expect(fixture.provenance.protobufMessage).toBe(
      "dex_search.SearchPairsResponse"
    );
    const json = decodeDexScreenerMessageToJson(
      "dex_search.SearchPairsResponse",
      fixture.bytes,
      { maxBytes: fixture.bytes.byteLength }
    );
    expect(json).toStrictEqual(loadFixtureDecodedJson("search-cat-plain"));
  });

  it("decodes a Connect-RPC GetTransactions response and keeps 64-bit fields off Number", () => {
    const fixture = loadFixture("connect-gettransactions-uniswap");
    const message = decodeDexScreenerMessage(
      "dex_feed.GetTransactionsResponse",
      fixture.bytes,
      { maxBytes: fixture.bytes.byteLength }
    ) as { transactions?: { blockNumber?: unknown }[] };
    const transactions = message.transactions ?? [];
    expect(transactions.length).toBeGreaterThan(0);
    // Every 64-bit field is a bigint, never a lossy double.
    for (const transaction of transactions) {
      expect(typeof transaction.blockNumber).toBe("bigint");
    }
  });

  /*
   * S8 / A3. `dex_trending.*` is on the allowlist and no production module
   * calls it; the decision is KEEP (see the reason on DEXSCREENER_MESSAGES in
   * `codec/protobuf.ts`). A kept capability has to be a proven one, and this
   * half had a descriptor and an allowlist entry but no decode test at all,
   * while its Avro twin TRENDING_V6 had both. This closes that asymmetry.
   */
  it("decodes a Connect-RPC GetTrendingPairs response, the retained trending oracle", () => {
    const fixture = loadFixture("connect-trending-solana-h24");
    expect(fixture.provenance.protobufMessage).toBe(
      "dex_trending.GetTrendingPairsResponse"
    );
    const message = decodeDexScreenerMessage(
      "dex_trending.GetTrendingPairsResponse",
      fixture.bytes,
      { maxBytes: fixture.bytes.byteLength }
    ) as {
      pairs?: { pairId?: unknown; tokenIconId?: unknown }[];
    };
    const pairs = message.pairs ?? [];
    // The endpoint is hard-capped at 30 rows with no pagination surface.
    expect(pairs).toHaveLength(30);
    // The two fields the omission decision rests on: the board's identity key
    // and the icon the screener row was measured to carry identically.
    expect(typeof pairs[0]?.pairId).toBe("string");
    expect(String(pairs[0]?.pairId).length).toBeGreaterThan(0);
    expect(typeof pairs[0]?.tokenIconId).toBe("string");
  });

  it("rejects bytes over the caller's cap by name, decoding nothing", () => {
    const fixture = loadFixture("search-cat-plain");
    const cap = fixture.bytes.byteLength - 1;
    let thrown: unknown;
    try {
      decodeDexScreenerMessage("dex_search.SearchPairsResponse", fixture.bytes, {
        maxBytes: cap,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(VexError);
    const error = thrown as VexError;
    expect(error.code).toBe(DexScreenerSiteErrorCodes.RESPONSE_OVER_CAP);
    expect(error.message).toContain(String(cap));
    expect(error.message).toContain(String(fixture.bytes.byteLength));
  });

  it("refuses a message name that is not on the allowlist", () => {
    const notAllowed = "dex_screener.Pair" as DexScreenerMessageName;
    let thrown: unknown;
    try {
      decodeDexScreenerMessage(notAllowed, new Uint8Array(0), { maxBytes: 1 });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(VexError);
    const error = thrown as VexError;
    expect(error.code).toBe(
      DexScreenerSiteErrorCodes.DECODE_MESSAGE_NOT_ALLOWED
    );
    expect(error.message).toContain("dex_screener.Pair");
    // The refusal names every allowed alternative, whole.
    for (const allowed of DEXSCREENER_MESSAGES) {
      expect(error.hint).toContain(allowed);
    }
  });

  it("reports a truncated body as a typed decode failure", () => {
    const fixture = loadFixture("search-cat-plain");
    const truncated = fixture.bytes.subarray(0, 64);
    let thrown: unknown;
    try {
      decodeDexScreenerMessage("dex_search.SearchPairsResponse", truncated, {
        maxBytes: truncated.byteLength,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(VexError);
    expect((thrown as VexError).code).toBe(
      DexScreenerSiteErrorCodes.DECODE_FAILED
    );
  });
});
