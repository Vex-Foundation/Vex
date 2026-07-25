/**
 * `resolveManagedExecution` — the Jupiter Prediction submit-lane routing gate
 * and the validation boundary for three provider-controlled fields
 * (`execution.endpoint`, `execution.context`, `requiredSigners`).
 *
 * Every fixture here is the REAL wire shape captured from the live API on
 * 2026-07-25 (`agents_dm/verify/probe-predict-execution-lanes.ts`), same wallet,
 * minutes apart. The first case is the one that matters most: it is the exact
 * response that the previous `executionModel === "atomic_swap"` gate routed to
 * the raw RPC lane, which is why no prediction mutation had ever executed.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@utils/logger.js", () => {
  const stub = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  return { default: stub, logger: stub };
});

const { resolveManagedExecution } = await import(
  "@tools/solana-ecosystem/jupiter/jupiter-prediction/prediction-api/managed-execution.js"
);

const OUR_WALLET = "AeyBYFtgm85BrsZMKrAWdc2qGQqYvwfkt88dZdfYEndS";
const JUP_FEE_PAYER = "DzrYVeiKz55ASsP2GiUxBpZrGsRxhjKpv6jVdpRwYWE1";
const TX_META = { blockhash: "FLKPrEqhgW8cNrjdSFuSnKSp4h9ScB6KjYxWPKMPTqCv", lastValidBlockHeight: 413108534 };

/** POLY-1654958, keeper-filled: `execution` present, `executionModel` ABSENT. */
const KEEPER_FILLED_BUILD = {
  txMeta: TX_META,
  requiredSigners: [OUR_WALLET],
  execution: { endpoint: "/api/v1/execute", context: { type: "create_order" } },
};

/** BISON-…-DOWN, Forecast: `execution` present AND `executionModel: "atomic_swap"`. */
const FORECAST_BUILD = {
  txMeta: { blockhash: "98FeiJ6EekDDXkK91AVSH3U6XzomRavsCvHbvScrXTHh", lastValidBlockHeight: 413108481 },
  executionModel: "atomic_swap",
  requiredSigners: [JUP_FEE_PAYER, OUR_WALLET],
  execution: {
    endpoint: "/api/v1/execute",
    context: { type: "bisonfi_swap", jupiterSwapRequestId: "019f974d-a0db-76d6-a438-59316c3f4277", ownerPubkey: OUR_WALLET },
  },
};

describe("resolveManagedExecution — routing signal", () => {
  it("routes a KEEPER-FILLED build (no executionModel at all) — the live-gate regression", () => {
    const resolved = resolveManagedExecution(KEEPER_FILLED_BUILD, "Create order");
    expect(resolved).not.toBeNull();
    expect(resolved!.context).toEqual({ type: "create_order" });
    expect(resolved!.requiredSigners).toEqual([OUR_WALLET]);
    expect(resolved!.blockhash).toEqual(TX_META);
  });

  it("passes the context object through byte-identically, never reshaped or re-keyed", () => {
    const resolved = resolveManagedExecution(FORECAST_BUILD, "Create order");
    expect(resolved!.context).toBe(FORECAST_BUILD.execution.context);
  });

  it("routes a Forecast build the same way — executionModel is descriptive, not a gate", () => {
    const resolved = resolveManagedExecution(FORECAST_BUILD, "Create order");
    expect(resolved).not.toBeNull();
    expect(resolved!.requiredSigners).toEqual([JUP_FEE_PAYER, OUR_WALLET]);
  });

  it("returns null when there is no execution object — the caller keeps today's RPC lane", () => {
    expect(resolveManagedExecution({ txMeta: TX_META }, "Create order")).toBeNull();
    expect(resolveManagedExecution({ execution: null, txMeta: TX_META }, "Create order")).toBeNull();
  });

  it("accepts the flat blockhash/lastValidBlockHeight shape the claim-payout docs show", () => {
    const resolved = resolveManagedExecution(
      { blockhash: "abc", lastValidBlockHeight: 7, requiredSigners: [OUR_WALLET], execution: KEEPER_FILLED_BUILD.execution },
      "Claim position",
    );
    expect(resolved!.blockhash).toEqual({ blockhash: "abc", lastValidBlockHeight: 7 });
  });
});

describe("resolveManagedExecution — fails closed on unusable provider input", () => {
  it("refuses a build with no requiredSigners", () => {
    expect(() => resolveManagedExecution({ txMeta: TX_META, execution: KEEPER_FILLED_BUILD.execution }, "Create order"))
      .toThrow(/did not say which signatures it requires/);
  });

  it("refuses a build with an empty requiredSigners array", () => {
    expect(() => resolveManagedExecution({ ...KEEPER_FILLED_BUILD, requiredSigners: [] }, "Create order"))
      .toThrow(/did not say which signatures it requires/);
  });

  it("refuses a build with no blockhash evidence — the blockhash cannot be refreshed", () => {
    expect(() => resolveManagedExecution({ requiredSigners: [OUR_WALLET], execution: KEEPER_FILLED_BUILD.execution }, "Create order"))
      .toThrow(/without blockhash evidence/);
  });

  it("names the feature in the error so the failure is attributable", () => {
    expect(() => resolveManagedExecution({ txMeta: TX_META, execution: KEEPER_FILLED_BUILD.execution }, "Close all positions"))
      .toThrow(/Close all positions/);
  });
});

describe("resolveManagedExecution — endpoint is a PATH, never a destination", () => {
  const accepted = ["/api/v1/execute", "/prediction/v1/execute", "/execute"];
  for (const endpoint of accepted) {
    it(`accepts the known path ${endpoint}`, () => {
      expect(resolveManagedExecution({ ...KEEPER_FILLED_BUILD, execution: { endpoint, context: { type: "create_order" } } }, "Create order"))
        .not.toBeNull();
    });
  }

  const rejected: ReadonlyArray<readonly [string, string]> = [
    ["an absolute https URL", "https://evil.example.com/execute"],
    ["an absolute http URL", "http://127.0.0.1:8899/execute"],
    ["a protocol-relative authority", "//evil.example.com/execute"],
    ["userinfo smuggling", "/api/v1/execute@evil.example.com"],
    ["path traversal", "/api/v1/../../evil/execute"],
    ["a file scheme", "file:///etc/passwd"],
    ["an unknown bare path", "/api/v2/execute-somewhere-else"],
    ["a relative path", "api/v1/execute"],
    ["an empty string", ""],
  ];
  for (const [label, endpoint] of rejected) {
    it(`refuses ${label} and never falls back to a default lane`, () => {
      expect(() =>
        resolveManagedExecution({ ...KEEPER_FILLED_BUILD, execution: { endpoint, context: { type: "create_order" } } }, "Create order"),
      ).toThrow(/execution endpoint/);
    });
  }
});
