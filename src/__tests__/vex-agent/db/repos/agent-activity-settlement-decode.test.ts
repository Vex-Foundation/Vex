/**
 * `route_provenance.settlementDecode` — the R1→R2 boundary contract.
 *
 * The property under test is that ILLEGAL COMBINATIONS ARE UNREPRESENTABLE. One
 * optional bag would let a `kyberswap` hint exist with no router, which is the
 * shape that sends a decoder at the wrong contract; keyed on `decoder`, such a
 * hint simply does not parse and the reader takes its no-hint path.
 */

import { describe, it, expect } from "vitest";

import {
  SETTLEMENT_DECODE_VERSION,
  readSettlementDecodeHint,
  settlementDecodeProvenance,
} from "@vex-agent/db/repos/agent-activity/settlement-decode.js";

const ROUTER = "0x89e5db8b5aa49aa85ac63f691524311aeb649eba";

describe("settlementDecodeProvenance — what a handler writes", () => {
  it("stamps the version so no call site can invent one", () => {
    const written = settlementDecodeProvenance({
      decoder: "uniswap", chainId: 4663, routerAddress: ROUTER,
    });
    expect(written.settlementDecode.v).toBe(SETTLEMENT_DECODE_VERSION);
    expect(written.settlementDecode.decoder).toBe("uniswap");
  });

  it("round-trips through a `route_provenance` blob beside the venue's own keys", () => {
    const provenance: Record<string, unknown> = {
      routeID: "abc", checksum: "def",
      ...settlementDecodeProvenance({
        decoder: "kyberswap", chainId: 4663, routerAddress: ROUTER,
        declaredValueRaw: "1500000000000000",
      }),
    };
    expect(readSettlementDecodeHint(provenance)).toEqual({
      v: SETTLEMENT_DECODE_VERSION, decoder: "kyberswap", chainId: 4663,
      routerAddress: ROUTER, declaredValueRaw: "1500000000000000",
    });
  });

  it("carries a launch hint with no router and no value — the token does not exist yet", () => {
    const provenance = { ...settlementDecodeProvenance({ decoder: "trench_launch", chainId: 4663 }) };
    expect(readSettlementDecodeHint(provenance)).toEqual({
      v: SETTLEMENT_DECODE_VERSION, decoder: "trench_launch", chainId: 4663,
    });
  });
});

describe("readSettlementDecodeHint — a missing hint is never a guessed decode", () => {
  it("reads null on a row written before this step (the owner's own swap)", () => {
    expect(readSettlementDecodeHint(null)).toBeNull();
    expect(readSettlementDecodeHint({ routeID: "abc" })).toBeNull();
  });

  it("REFUSES a routed hint with no router rather than decoding against nothing", () => {
    expect(readSettlementDecodeHint({
      settlementDecode: { v: 1, decoder: "kyberswap", chainId: 4663 },
    })).toBeNull();
  });

  it("refuses a hint from a version this build does not know", () => {
    expect(readSettlementDecodeHint({
      settlementDecode: { v: 999, decoder: "uniswap", chainId: 4663, routerAddress: ROUTER },
    })).toBeNull();
  });

  it("refuses an unknown decoder instead of guessing the closest one", () => {
    expect(readSettlementDecodeHint({
      settlementDecode: { v: 1, decoder: "sushiswap", chainId: 4663, routerAddress: ROUTER },
    })).toBeNull();
  });

  it("refuses a non-atomic declared value — money is never read from a float", () => {
    expect(readSettlementDecodeHint({
      settlementDecode: {
        v: 1, decoder: "uniswap", chainId: 4663, routerAddress: ROUTER,
        declaredValueRaw: "0.0015",
      },
    })).toBeNull();
  });

  it("refuses a malformed router address", () => {
    expect(readSettlementDecodeHint({
      settlementDecode: { v: 1, decoder: "pendle", chainId: 4663, routerAddress: "not-an-address" },
    })).toBeNull();
  });
});
