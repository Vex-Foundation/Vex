/**
 * The snapshot codec and its execute-side reader.
 *
 * The property under test is the one the whole lane rests on: what the execute
 * POSTs to `/route/build` is byte-provably what the quote showed. So the tests
 * store, digest, restore and re-parse, and check that a single changed byte
 * anywhere in the stored string is caught - because KyberSwap itself validates
 * nothing (measured 2026-08-27: a tampered summary builds with code 0).
 *
 * The floor arithmetic table lives here too: it is the other half of the same
 * authority, and it is exact bigint math with a MEASURED one-raw-unit
 * allowance for the provider's own rederivation.
 */

import { describe, it, expect } from "vitest";

import {
  ROUTE_SNAPSHOT_VERSION,
  SNAPSHOT_MAX_BYTES,
  SNAPSHOT_MAX_DEPTH,
  digestRouteSnapshot,
  digestSnapshotRaw,
  encodeRouteSnapshotRaw,
  sealRouteSnapshot,
  type RouteSnapshot,
} from "@vex-agent/tools/protocols/quote-authority/snapshot.js";
import {
  buildBoundDebitPlan,
  type BoundDebitPlan,
} from "@vex-agent/tools/protocols/quote-authority/debit-plan.js";
import {
  QUOTE_BINDING_CARD_VERSION,
  readQuoteBindingPreview,
  renderQuoteBinding,
  restoreRouteSnapshot,
} from "@vex-agent/tools/protocols/quote-authority/restore.js";
import {
  computeApprovedMinOut,
  KYBER_BUILD_REDERIVATION_ALLOWANCE_RAW,
} from "@tools/kyberswap/swap-price-floor.js";

const ROUTE_SUMMARY = {
  tokenIn: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  amountIn: "12000000000000000",
  amountInUsd: "30.27887792044092",
  tokenOut: "0x17f31d221a86c091a32d398653f5306fc4d93c0d",
  amountOut: "21335790672285165158400",
  amountOutUsd: "0",
  routeID: "r1",
  checksum: "c1",
  route: [[{ pool: "0xpool", exchange: "orvex-cl", swapAmount: "12000000000000000" }]],
} as const;

/**
 * The transaction set this venue binds for an ERC-20 input whose allowance is
 * still short: reset, approve, swap. Every leg is priced at quote time here -
 * the approve legs estimate live and the swap carries the provider's own build
 * figure - so none is marked unpriced.
 */
const PLAN: BoundDebitPlan = buildBoundDebitPlan({
  legs: [
    { role: "allowance_reset", unpriced: false },
    { role: "allowance", unpriced: false },
    { role: "swap", unpriced: false },
  ],
  feeCap: { mode: "eip1559", maxFeePerGasWei: 11_210_000n, maxPriorityFeePerGasWei: 1_210_000n },
});

/**
 * A snapshot as the quote handler seals it - through the REAL codec, so a test
 * double cannot carry a digest production would reject.
 *
 * Overrides are applied BEFORE sealing, so an override produces an internally
 * consistent row; a suite that wants a TAMPERED row patches the sealed value.
 */
function snapshotFor(overrides: Partial<RouteSnapshot> = {}): RouteSnapshot {
  const encoded = encodeRouteSnapshotRaw(ROUTE_SUMMARY);
  if (!encoded.ok) throw new Error("fixture route must encode");
  const approvedMinOutRaw = computeApprovedMinOut(ROUTE_SUMMARY.amountOut, 50).toString();
  return sealRouteSnapshot({
    v: ROUTE_SNAPSHOT_VERSION,
    provider: "kyberswap",
    raw: encoded.raw,
    approvedAmountOutRaw: ROUTE_SUMMARY.amountOut,
    approvedMinOutRaw,
    approvedAmountOutHuman: "21335.79",
    approvedMinOutHuman: "20269.0",
    tokenOutSymbol: "CCF",
    effectiveSlippageBps: 50,
    expiresAt: "2026-08-28T10:00:00.000Z",
    eligibility: { kind: "executable", priceImpactFraction: 0.001, adverse: false },
    debitPlan: PLAN,
    ...overrides,
  });
}

describe("encodeRouteSnapshotRaw", () => {
  it("serializes once and digests the STORED STRING, so the digest proves the bytes", () => {
    const encoded = encodeRouteSnapshotRaw(ROUTE_SUMMARY);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    expect(encoded.rawDigest).toBe(digestSnapshotRaw(encoded.raw));
    expect(JSON.parse(encoded.raw)).toEqual(ROUTE_SUMMARY);
  });

  it("refuses a summary over the byte bound instead of storing a cut one", () => {
    const huge = { blob: "x".repeat(SNAPSHOT_MAX_BYTES + 1) };
    const encoded = encodeRouteSnapshotRaw(huge);
    expect(encoded.ok).toBe(false);
    if (encoded.ok) return;
    expect(encoded.measuredBytes).toBeGreaterThan(SNAPSHOT_MAX_BYTES);
    expect(encoded.limitBytes).toBe(SNAPSHOT_MAX_BYTES);
  });

  it("refuses a summary past the depth bound", () => {
    let nested: unknown = "leaf";
    for (let i = 0; i < SNAPSHOT_MAX_DEPTH + 5; i++) nested = { nested };
    expect(encodeRouteSnapshotRaw(nested).ok).toBe(false);
  });

  it("reports an unserializable summary as oversize rather than throwing the quote", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const encoded = encodeRouteSnapshotRaw(cyclic);
    expect(encoded.ok).toBe(false);
    if (encoded.ok) return;
    expect(encoded.measuredBytes).toBe(-1);
  });
});

describe("restoreRouteSnapshot", () => {
  it("returns the parsed route summary from the digest-verified string", () => {
    const restored = restoreRouteSnapshot(snapshotFor());
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.routeSummary).toEqual(ROUTE_SUMMARY);
  });

  it("refuses a snapshot whose stored string was altered by a single character", () => {
    const good = snapshotFor();
    // The exact tamper KyberSwap itself accepts: amountOut multiplied by ten.
    const tampered = good.raw.replace('"21335790672285165158400"', '"213357906722851651584000"');
    expect(tampered).not.toBe(good.raw);

    const restored = restoreRouteSnapshot({ ...good, raw: tampered });
    expect(restored.ok).toBe(false);
    if (restored.ok) return;
    expect(restored.refusal.kind).toBe("digest_mismatch");
    expect(restored.refusal.message).toContain("Nothing was signed");
    expect(restored.refusal.message).toContain("fresh kyberswap__swap_quote");
  });

  const unreadable: readonly [string, unknown][] = [
    ["null", null],
    ["undefined", undefined],
    ["a non-object", "not a snapshot"],
    // A version tag that is not a number at all: not "an older format", just a
    // shape this build cannot read.
    ["a non-numeric version", { ...snapshotFor(), v: "two" }],
    ["a wrong provider", { ...snapshotFor(), provider: "uniswap" }],
    ["a non-hex digest", { ...snapshotFor(), digest: "zz" }],
    ["a non-integer approved output", { ...snapshotFor(), approvedAmountOutRaw: "12.5" }],
    ["an out-of-range slippage", { ...snapshotFor(), effectiveSlippageBps: 20_001 }],
  ];
  for (const [name, value] of unreadable) {
    it(`refuses ${name}`, () => {
      const restored = restoreRouteSnapshot(value);
      expect(restored.ok).toBe(false);
      if (restored.ok) return;
      expect(["missing_snapshot", "snapshot_unreadable"]).toContain(restored.refusal.kind);
    });
  }

  it("refuses a durable row whose bound TRANSACTION SET was edited underneath it", () => {
    const good = snapshotFor();
    // The exact widening the binding exists to catch: two extra transactions
    // the card never mentioned, on a row that keeps its own digest.
    const widened = buildBoundDebitPlan({
      legs: [
        { role: "allowance_reset", unpriced: false },
        { role: "allowance", unpriced: false },
        { role: "swap", unpriced: false },
        { role: "swap_fee", unpriced: false },
      ],
      feeCap: { mode: "eip1559", maxFeePerGasWei: 11_210_000n, maxPriorityFeePerGasWei: 1_210_000n },
    });

    const restored = restoreRouteSnapshot({ ...good, debitPlan: widened });

    expect(restored.ok).toBe(false);
    if (restored.ok) return;
    expect(restored.refusal.kind).toBe("digest_mismatch");
  });

  it("refuses a durable row whose bound GAS-PRICE CEILING was lifted", () => {
    const good = snapshotFor();
    const lifted = buildBoundDebitPlan({
      legs: PLAN.legs.map((leg) => ({ role: leg.role, unpriced: leg.unpriced })),
      feeCap: { mode: "eip1559", maxFeePerGasWei: 10n ** 18n, maxPriorityFeePerGasWei: 1_210_000n },
    });

    expect(restoreRouteSnapshot({ ...good, debitPlan: lifted })).toMatchObject({
      ok: false, refusal: { kind: "digest_mismatch" },
    });
  });

  it("still refuses a tampered route summary now that the digest covers more", () => {
    const good = snapshotFor();
    const tampered = good.raw.replace('"21335790672285165158400"', '"1"');

    expect(restoreRouteSnapshot({ ...good, raw: tampered })).toMatchObject({
      ok: false, refusal: { kind: "digest_mismatch" },
    });
  });

  it("refuses a row from the format that bound no transaction set, BY NAME", () => {
    // A v1 row: the pre-WP2-B shape, whose digest was the raw string's own hash
    // and which said nothing about the transactions the swap would send.
    const good = snapshotFor();
    const { debitPlan: _dropped, ...v1 } = good;
    const legacyRow = { ...v1, v: 1, digest: digestSnapshotRaw(good.raw) };

    const restored = restoreRouteSnapshot(legacyRow);

    expect(restored.ok).toBe(false);
    if (restored.ok) return;
    expect(restored.refusal.kind).toBe("snapshot_version_unsupported");
    expect(restored.refusal.message).toContain("did not bind the transactions");
    // Recoverable, always: the 15-minute prequote TTL clears this window.
    expect(restored.refusal.message).toContain("Request a fresh kyberswap__swap_quote");
  });

  it("refuses a plan whose shape this build cannot read, rather than ignoring it", () => {
    const good = snapshotFor();

    expect(restoreRouteSnapshot({ ...good, debitPlan: undefined })).toMatchObject({
      ok: false, refusal: { kind: "snapshot_unreadable" },
    });
    expect(restoreRouteSnapshot({
      ...good,
      debitPlan: { legs: [{ role: "swap", feeCap: { mode: "legacy", gasPriceWei: "-1" }, unpriced: false }], reserve: PLAN.reserve },
    })).toMatchObject({ ok: false, refusal: { kind: "snapshot_unreadable" } });
  });

  it("returns the bound plan to the execute, which is what it is held to", () => {
    const restored = restoreRouteSnapshot(snapshotFor());

    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.snapshot.debitPlan).toEqual(PLAN);
  });

  it("refuses an INELIGIBLE snapshot by name - it never authorized a swap", () => {
    const restored = restoreRouteSnapshot(
      snapshotFor({ eligibility: { kind: "unpriceable_output", amountInUsd: 30 } }),
    );
    expect(restored.ok).toBe(false);
    if (restored.ok) return;
    expect(restored.refusal.kind).toBe("not_executable");
  });

  it("every refusal names a way forward - safe is never a dead end", () => {
    for (const [, value] of [
      ...unreadable,
      ["tampered", { ...snapshotFor(), raw: "{}" }] as const,
      // The floor feeds the pre-sign price guard, so a row whose stored
      // minimum was lowered after sealing must fail restore, not gate the
      // signature with the tampered figure.
      ["a lowered floor", { ...snapshotFor(), approvedMinOutRaw: "1" }] as const,
      ["a widened slippage", { ...snapshotFor(), effectiveSlippageBps: 9_999 }] as const,
      ["an older format", { ...snapshotFor(), v: 1 }] as const,
    ]) {
      const restored = restoreRouteSnapshot(value);
      if (restored.ok) continue;
      expect(restored.refusal.message).toContain("Request a fresh kyberswap__swap_quote");
    }
  });
});

describe("the digest covers the plan as well as the bytes", () => {
  it("differs whenever the bound plan differs, at identical route bytes", () => {
    const encoded = encodeRouteSnapshotRaw(ROUTE_SUMMARY);
    if (!encoded.ok) throw new Error("fixture route must encode");
    const digests = [
      digestRouteSnapshot({ ...snapshotFor(), raw: encoded.raw, debitPlan: PLAN }),
      digestRouteSnapshot({
        ...snapshotFor(),
        raw: encoded.raw,
        debitPlan: buildBoundDebitPlan({
          legs: [{ role: "swap", unpriced: false }],
          feeCap: { mode: "eip1559", maxFeePerGasWei: 11_210_000n, maxPriorityFeePerGasWei: 1_210_000n },
        }),
      }),
      digestRouteSnapshot({
        ...snapshotFor(),
        raw: encoded.raw,
        debitPlan: buildBoundDebitPlan({
          legs: [{ role: "swap", unpriced: true }],
          feeCap: { mode: "eip1559", maxFeePerGasWei: 11_210_000n, maxPriorityFeePerGasWei: 1_210_000n },
        }),
      }),
      digestRouteSnapshot({
        ...snapshotFor(),
        raw: encoded.raw,
        debitPlan: buildBoundDebitPlan({
          legs: [{ role: "swap", unpriced: false }],
          feeCap: { mode: "legacy", gasPriceWei: 11_210_000n },
        }),
      }),
    ];

    expect(new Set(digests).size).toBe(digests.length);
  });

  it("is NOT the route string's own hash any more, so a v1 digest cannot pass", () => {
    const snapshot = snapshotFor();

    expect(snapshot.digest).not.toBe(digestSnapshotRaw(snapshot.raw));
  });
});

describe("approval-card binding", () => {
  it("states the quoted output, the floor, the tolerance and the WHOLE digest in human units", () => {
    const snapshot = snapshotFor();
    const binding = readQuoteBindingPreview("prequote-1", snapshot, "2026-08-28T10:15:00.000Z");
    if (binding === undefined) throw new Error("test expected a readable card binding");
    const line = renderQuoteBinding(binding);

    expect(line).toContain("quoted 21335.79 CCF");
    expect(line).toContain("will not fill below 20269.0 CCF");
    expect(line).toContain("(50 bps of the quote)");
    // The ROW's expiry, not the snapshot's display copy: the claim reads that one.
    expect(line).toContain("2026-08-28T10:15:00.000Z");
    expect(line).not.toContain(snapshot.expiresAt);
    // Whole digest - a person cannot check a shortened fingerprint against the row.
    expect(line).toContain(snapshot.digest);
    expect(line).toContain(QUOTE_BINDING_CARD_VERSION);
  });

  it("states nothing at all when the row carries no provable snapshot", () => {
    expect(readQuoteBindingPreview("prequote-1", null, "2026-08-28T10:15:00.000Z")).toBeUndefined();
    expect(
      readQuoteBindingPreview("prequote-1", { ...snapshotFor(), raw: "{}" }, "2026-08-28T10:15:00.000Z"),
    ).toBeUndefined();
  });
});

describe("computeApprovedMinOut - exact bigint floor arithmetic", () => {
  const table: readonly [string, number, string][] = [
    ["0", 50, "0"],
    ["1", 0, "1"],
    ["1", 50, "0"],
    ["10000", 0, "10000"],
    ["10000", 1, "9999"],
    ["10000", 50, "9950"],
    ["10000", 1000, "9000"],
    ["10000", 10_000, "0"],
    // Truncation is toward zero and never rounds a floor UP.
    ["9999", 50, "9949"],
    ["3", 5000, "1"],
    // The incident's own numbers, in raw 18-decimal units.
    ["313879700000000000000000", 500, "298185715000000000000000"],
    // Well past Number.MAX_SAFE_INTEGER - the reason this is bigint math.
    ["115792089237316195423570985008687907853269984665640564039457584007913129639935", 50,
     "115213128791129614446453130083644468314003634742312361219260296087873563991735"],
  ];
  for (const [netOut, bps, expected] of table) {
    it(`floor(${netOut} x (10000-${bps})/10000) = ${expected}`, () => {
      expect(computeApprovedMinOut(netOut, bps).toString()).toBe(expected);
    });
  }

  const bad: readonly [string, number][] = [
    ["-1", 50], ["1.5", 50], ["", 50], ["1e3", 50], ["0x10", 50], [" 10", 50],
  ];
  for (const [netOut, bps] of bad) {
    it(`throws rather than clamping on netOutRaw ${JSON.stringify(netOut)}`, () => {
      expect(() => computeApprovedMinOut(netOut, bps)).toThrow(TypeError);
    });
  }
  for (const bps of [-1, 10_001, 50.5, Number.NaN]) {
    it(`throws rather than clamping on slippageBps ${bps}`, () => {
      expect(() => computeApprovedMinOut("10000", bps)).toThrow(RangeError);
    });
  }

  it("the MEASURED one-raw-unit allowance is exactly what an honest build needs", () => {
    // MEASURED again on 2026-08-28 (robinhood, live): route quoted
    // 21315090697680289005568 and the build echoed ...567 - one raw unit less,
    // every time. So a floor derived from the quote sits exactly one unit above
    // an honest build's own floor at the same slippage.
    expect(KYBER_BUILD_REDERIVATION_ALLOWANCE_RAW).toBe(1n);
    const quoted = 21315090697680289005568n;
    const built = quoted - 1n;
    const approvedFloor = computeApprovedMinOut(quoted.toString(), 500);
    const honestBuildFloor = computeApprovedMinOut(built.toString(), 500);
    expect(honestBuildFloor).toBeLessThan(approvedFloor);
    expect(honestBuildFloor + KYBER_BUILD_REDERIVATION_ALLOWANCE_RAW).toBeGreaterThanOrEqual(approvedFloor);
  });
});
