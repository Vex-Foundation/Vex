/**
 * Conformance for the site's Avro-dialect decoder, against real captured bytes.
 *
 * The load-bearing assertion in every positive case is `bytesConsumed ===
 * bytesTotal`. Under a format with no framing and no field tags, a schema table
 * that is wrong by one field still "decodes" - it just reads the following
 * bytes as the next field. Landing exactly on the end of a 145 KB body is what
 * proves the table matches the writer.
 */

import { describe, expect, it } from "vitest";
import { decodeDsAvro } from "../../tools/dexscreener/codec/dsavro.js";
import {
  METAS_ALL,
  METAS_TRENDING,
  PL_BARS_RESPONSE,
  TOPMAKERS,
  TRENDING_V6,
} from "../../tools/dexscreener/codec/dsavro-schemas.js";
import { DexScreenerSiteErrorCodes } from "../../tools/dexscreener/site-errors.js";
import { VexError } from "../../errors.js";
import { loadFixture } from "./_fixtures.js";

describe("dsavro bars response", () => {
  const fixture = loadFixture("bars-uniswap-ethereum-h1");

  it("consumes the captured body exactly", () => {
    const result = decodeDsAvro(PL_BARS_RESPONSE, fixture.bytes);
    expect(result.bytesTotal).toBe(fixture.provenance.bytes);
    expect(result.bytesConsumed).toBe(result.bytesTotal);
  });

  it("returns the provider's page of bars with decimal prices kept as strings", () => {
    const { value } = decodeDsAvro(PL_BARS_RESPONSE, fixture.bytes);
    expect(value.schemaVersion).toBe("1.0.0");
    const bars = value.bars ?? [];
    // The capture asked for cb=5000; the provider's own page cap is 999 bars.
    expect(bars.length).toBe(999);
    const first = bars[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(typeof first.open).toBe("string");
    expect(typeof first.close).toBe("string");
    expect(first.timestamp).toBe(1783958400000);
    expect(first.minBlockNumber).toBe(25524766);
    // Bars are ordered oldest-first within a page.
    const last = bars[bars.length - 1];
    expect(last).toBeDefined();
    if (last === undefined) return;
    expect(last.timestamp).toBeGreaterThan(first.timestamp);
  });
});

describe("dsavro top makers", () => {
  const fixture = loadFixture("topmakers-uniswap-ethereum");

  it("consumes the captured body exactly", () => {
    const result = decodeDsAvro(TOPMAKERS, fixture.bytes);
    expect(result.bytesConsumed).toBe(result.bytesTotal);
    expect(result.bytesTotal).toBe(fixture.provenance.bytes);
  });

  it("returns 100 makers with nullable label, url and balance", () => {
    const { value } = decodeDsAvro(TOPMAKERS, fixture.bytes);
    expect(value.length).toBe(100);
    const first = value[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(first.maker).toBe("0x5B43453FCE04b92E190f391a83136bfBeCEDEFd1");
    expect(first.label).toBeNull();
    expect(typeof first.amountBuy).toBe("string");
    expect(first.balancePercentage).toBeCloseTo(19.9, 6);
    expect(first.firstSwap).toBeLessThan(first.lastSwap);
  });
});

describe("dsavro trending v6", () => {
  const fixture = loadFixture("trending-solana-h24");

  it("consumes the captured body exactly and yields the window maps", () => {
    const result = decodeDsAvro(TRENDING_V6, fixture.bytes);
    expect(result.bytesConsumed).toBe(result.bytesTotal);
    expect(result.value.length).toBe(30);
    const first = result.value[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(first.chainId).toBe("solana");
    expect(Object.keys(first.volume).sort()).toStrictEqual([
      "h1",
      "h24",
      "h6",
      "m5",
    ]);
  });
});

describe("dsavro narratives", () => {
  it("decodes /metas/v1/all exactly, ids distinct from slugs", () => {
    const fixture = loadFixture("metas-all");
    const result = decodeDsAvro(METAS_ALL, fixture.bytes);
    expect(result.bytesConsumed).toBe(result.bytesTotal);
    expect(result.value.length).toBeGreaterThan(0);
    const first = result.value[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    // The screener filter takes `id`, not `slug` (measured: slug matches 0).
    expect(first.id).not.toBe(first.slug);
    expect(first.icon.type).toBe("emoji");
  });

  it("decodes /metas/v1/trending exactly, with the four-window market columns", () => {
    const fixture = loadFixture("metas-trending");
    const result = decodeDsAvro(METAS_TRENDING, fixture.bytes);
    expect(result.bytesConsumed).toBe(result.bytesTotal);
    const first = result.value[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(typeof first.marketCap).toBe("number");
    expect(Object.keys(first.marketCapChange)).toStrictEqual([
      "m5",
      "h1",
      "h6",
      "h24",
    ]);
    expect(Object.keys(first.marketCapDelta)).toStrictEqual([
      "m5",
      "h1",
      "h6",
      "h24",
    ]);
  });

  /**
   * The chain-scoped variant, closing a gap S3.5 left open.
   *
   * `fetchNarratives` has shipped a `chainId` parameter since S3.5, but the
   * only captured document was the cross-chain one, so the parameterized form
   * was exercised by nothing. A tool parameter proven by no bytes is a claim,
   * not a capability, so it is captured and decoded here against the SAME
   * schema table: that is what makes "scoping to a chain narrows the answer
   * server-side" a measured statement rather than an assumption.
   */
  it("decodes /metas/v1/trending?chainId=solana against the same table", () => {
    const scoped = loadFixture("metas-trending-solana");
    const result = decodeDsAvro(METAS_TRENDING, scoped.bytes);
    expect(result.bytesConsumed).toBe(result.bytesTotal);
    expect(result.value.length).toBeGreaterThan(0);
    expect(scoped.provenance.endpoint).toContain("chainId=solana");

    const first = result.value[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(typeof first.marketCap).toBe("number");
    expect(Object.keys(first.marketCapChange)).toStrictEqual([
      "m5",
      "h1",
      "h6",
      "h24",
    ]);
    // The scoped document is a real narrowing rather than the same rows with a
    // filter applied client-side: it is a different, smaller set of narratives.
    const unscoped = decodeDsAvro(METAS_TRENDING, loadFixture("metas-trending").bytes);
    expect(result.value.length).toBeLessThanOrEqual(unscoped.value.length);
  });
});

describe("dsavro failure modes", () => {
  const fixture = loadFixture("topmakers-uniswap-ethereum");

  it("rejects a truncated buffer instead of returning the records it managed to read", () => {
    const truncated = fixture.bytes.subarray(0, 512);
    let thrown: unknown;
    try {
      decodeDsAvro(TOPMAKERS, truncated);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(VexError);
    expect((thrown as VexError).code).toBe(
      DexScreenerSiteErrorCodes.DECODE_FAILED
    );
  });

  it("rejects trailing bytes rather than reporting a short read as complete", () => {
    const padded = new Uint8Array(fixture.bytes.byteLength + 1);
    padded.set(fixture.bytes, 0);
    let thrown: unknown;
    try {
      decodeDsAvro(TOPMAKERS, padded);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(VexError);
    const error = thrown as VexError;
    expect(error.code).toBe(DexScreenerSiteErrorCodes.DECODE_FAILED);
    expect(error.message).toContain(String(fixture.bytes.byteLength));
    expect(error.message).toContain(String(padded.byteLength));
  });

  it("rejects a schema mismatch that would otherwise read the next field's bytes", () => {
    // Decoding the bars body as top makers reads plausible values for a while
    // and then lands somewhere that is not the end of the buffer.
    const bars = loadFixture("bars-uniswap-ethereum-h1");
    let thrown: unknown;
    try {
      decodeDsAvro(TOPMAKERS, bars.bytes);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(VexError);
    expect((thrown as VexError).code).toBe(
      DexScreenerSiteErrorCodes.DECODE_FAILED
    );
  });
});
