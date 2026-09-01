/**
 * The Uniswap execution snapshot: what a quote binds, and what an execute may
 * not change about it.
 *
 * The unit under test is the codec plus the drift comparison - the two pure
 * pieces the handler leans on. Their contract is the owner constraint of
 * 2026-08-28: full binding, "not hardcoded-tight - safe, and it has to keep
 * working". So every case here is either a byte-identical round trip, or a
 * NAMED, RECOVERABLE refusal. There is no price comparison in this file at all
 * except the floor one, and that floor already carries the approved slippage.
 */

import { describe, it, expect } from "vitest";

import {
  UNISWAP_QUOTE_BINDING_CARD_VERSION,
  UNISWAP_SNAPSHOT_VERSION,
  compareUniswapExecutionInputs,
  digestUniswapSnapshot,
  floorUnreachableRefusal,
  isUniswapRouteRef,
  restoreUniswapSnapshot,
  sealUniswapSnapshot,
  type UniswapExecutionInputs,
  type UniswapSnapshotFields,
} from "@vex-agent/tools/protocols/quote-authority/uniswap.js";
import {
  QUOTE_BINDING_CARD_VERSION,
  readQuoteBindingPreview,
  renderQuoteBinding,
} from "@vex-agent/tools/protocols/quote-authority/restore.js";
import {
  ROUTE_SNAPSHOT_VERSION,
  sealRouteSnapshot,
} from "@vex-agent/tools/protocols/quote-authority/snapshot.js";
import {
  buildBoundDebitPlan,
  type BoundDebitPlan,
} from "@vex-agent/tools/protocols/quote-authority/debit-plan.js";

const TOKEN_IN = "0x8Ff92566f2e81BDd68EDfAa8cde73942A723796b";
const TOKEN_OUT = "0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31";

function fields(overrides: Partial<UniswapSnapshotFields> = {}): UniswapSnapshotFields {
  return {
    v: UNISWAP_SNAPSHOT_VERSION,
    provider: "uniswap",
    chainId: 4663,
    tokenIn: { address: TOKEN_IN, isNative: false, symbol: "TKN", decimals: 18 },
    tokenOut: { address: TOKEN_OUT, isNative: false, symbol: "OUT", decimals: 18 },
    totalInRaw: "1000000000000000000",
    swapAmountRaw: "997500000000000000",
    fee: {
      disposition: "charged",
      amountRaw: "2500000000000000",
      disclosureText: "Vex charges 25 bps on the input token of every Uniswap swap.",
    },
    approvedAmountOutRaw: "313879700000000000000000",
    approvedMinOutRaw: "298185715000000000000000",
    approvedAmountOutHuman: "313879.7",
    approvedMinOutHuman: "298185.715",
    slippageBps: 500,
    expiresAt: "2026-08-28T10:15:00.000Z",
    debitPlan: PLAN,
    ...overrides,
  };
}

/**
 * The transaction set a quote for this pair binds: an allowance the router does
 * not have yet, the swap, and the Vex fee transfer, all under one ceiling.
 */
const PLAN: BoundDebitPlan = buildBoundDebitPlan({
  legs: [
    { role: "allowance", unpriced: false },
    // The first-time ERC-20 case, ratified: the swap cannot be simulated before
    // its allowance lands, so its UNITS are unknown and the leg says so.
    { role: "swap", unpriced: true },
    { role: "swap_fee", unpriced: false },
  ],
  feeCap: { mode: "eip1559", maxFeePerGasWei: 11_210_000n, maxPriorityFeePerGasWei: 1_210_000n },
});

function inputsFrom(f: UniswapSnapshotFields): UniswapExecutionInputs {
  return {
    chainId: f.chainId,
    tokenIn: f.tokenIn,
    tokenOut: f.tokenOut,
    totalInRaw: f.totalInRaw,
    swapAmountRaw: f.swapAmountRaw,
    fee: f.fee,
  };
}

describe("the snapshot codec", () => {
  it("round-trips a sealed snapshot through durable storage unchanged", () => {
    const sealed = sealUniswapSnapshot(fields());

    // Through JSON, because that is what JSONB does to it on the way back.
    const restored = restoreUniswapSnapshot(JSON.parse(JSON.stringify(sealed)));

    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.snapshot).toEqual(sealed);
  });

  it("digests the BOUND fields, not the object's key order", () => {
    const sealed = sealUniswapSnapshot(fields());
    const reordered = Object.fromEntries(Object.entries(sealed).reverse());

    const restored = restoreUniswapSnapshot(reordered);

    expect(restored.ok).toBe(true);
  });

  it.each([
    ["the router input", { swapAmountRaw: "999999999999999999" }],
    ["the total debited", { totalInRaw: "2000000000000000000" }],
    ["the approved floor", { approvedMinOutRaw: "1" }],
    ["the tolerance", { slippageBps: 1000 }],
    ["the fee amount", { fee: { disposition: "charged" as const, amountRaw: "1", disclosureText: "x" } }],
    // WP2-B: the transaction set and the per-gas ceiling are money facts, so a
    // row edited to add a leg or lift a ceiling fails exactly like a tampered
    // amount does.
    ["the bound leg set", {
      debitPlan: buildBoundDebitPlan({
        legs: [
          { role: "allowance_reset" as const, unpriced: false },
          { role: "allowance" as const, unpriced: false },
          { role: "swap" as const, unpriced: true },
          { role: "swap_fee" as const, unpriced: false },
        ],
        feeCap: { mode: "eip1559" as const, maxFeePerGasWei: 11_210_000n, maxPriorityFeePerGasWei: 1_210_000n },
      }),
    }],
    ["the bound gas-price ceiling", {
      debitPlan: buildBoundDebitPlan({
        legs: [
          { role: "allowance" as const, unpriced: false },
          { role: "swap" as const, unpriced: true },
          { role: "swap_fee" as const, unpriced: false },
        ],
        feeCap: { mode: "eip1559" as const, maxFeePerGasWei: 999_000_000n, maxPriorityFeePerGasWei: 1_210_000n },
      }),
    }],
    ["a leg's unpriced marker", {
      debitPlan: buildBoundDebitPlan({
        legs: [
          { role: "allowance" as const, unpriced: false },
          { role: "swap" as const, unpriced: false },
          { role: "swap_fee" as const, unpriced: false },
        ],
        feeCap: { mode: "eip1559" as const, maxFeePerGasWei: 11_210_000n, maxPriorityFeePerGasWei: 1_210_000n },
      }),
    }],
  ])("refuses a durable row whose %s was edited underneath it", (_what, patch) => {
    const sealed = sealUniswapSnapshot(fields());
    const tampered = { ...sealed, ...patch };

    const restored = restoreUniswapSnapshot(tampered);

    expect(restored.ok).toBe(false);
    if (restored.ok) return;
    expect(restored.refusal.kind).toBe("digest_mismatch");
    // Recoverable, and it names THIS venue's quote tool - a refusal that sent
    // the agent to the other venue would produce a prequote no execute matches.
    expect(restored.refusal.message).toContain("uniswap__swap_quote");
    expect(restored.refusal.message).toContain("Nothing was signed");
  });

  it("refuses a missing row and a shape this build cannot read, by kind", () => {
    expect(restoreUniswapSnapshot(null)).toMatchObject({ ok: false, refusal: { kind: "missing_snapshot" } });
    expect(restoreUniswapSnapshot({ provider: "uniswap" })).toMatchObject({
      ok: false, refusal: { kind: "snapshot_unreadable" },
    });
  });

  it("refuses a row from the format that bound no transaction set, BY NAME", () => {
    // A v1 row: everything this build reads except the plan. It is not merely
    // unreadable - it is a quote that authorized a price and left the
    // transaction set free, and the agent is told exactly that.
    const sealed = sealUniswapSnapshot(fields());
    const { debitPlan: _dropped, ...v1 } = sealed;

    const restored = restoreUniswapSnapshot({ ...v1, v: 1 });

    expect(restored.ok).toBe(false);
    if (restored.ok) return;
    expect(restored.refusal.kind).toBe("snapshot_version_unsupported");
    expect(restored.refusal.message).toContain("did not bind the transactions");
    expect(restored.refusal.message).toContain("uniswap__swap_quote");
  });

  it("refuses a plan whose shape this build cannot read, rather than ignoring it", () => {
    const sealed = sealUniswapSnapshot(fields());

    expect(restoreUniswapSnapshot({ ...sealed, debitPlan: { legs: [], reserve: sealed.debitPlan.reserve } }))
      .toMatchObject({ ok: false, refusal: { kind: "snapshot_unreadable" } });
    expect(restoreUniswapSnapshot({ ...sealed, debitPlan: undefined }))
      .toMatchObject({ ok: false, refusal: { kind: "snapshot_unreadable" } });
  });

  it("recognises its own rows and no one else's", () => {
    expect(isUniswapRouteRef(sealUniswapSnapshot(fields()))).toBe(true);
    expect(isUniswapRouteRef({ provider: "kyberswap" })).toBe(false);
    expect(isUniswapRouteRef(null)).toBe(false);
  });
});

describe("the approval card", () => {
  it("states the quoted output and the floor, tagged with THIS venue's card version", () => {
    const sealed = sealUniswapSnapshot(fields());

    const binding = readQuoteBindingPreview("prequote-9", sealed, "2026-08-28T10:20:00.000Z");

    expect(binding).toBeDefined();
    if (!binding) return;
    expect(binding.cardVersion).toBe(UNISWAP_QUOTE_BINDING_CARD_VERSION);
    const line = renderQuoteBinding(binding);
    expect(line).toContain("quoted 313879.7 OUT");
    expect(line).toContain("will not fill below 298185.715 OUT");
    expect(line).toContain("500 bps");
    // The ROW's expiry, which is what the claim enforces - not the snapshot's
    // display copy.
    expect(line).toContain("2026-08-28T10:20:00.000Z");
    expect(line).toContain(sealed.digest);
  });

  it("still reads a KyberSwap row through the KyberSwap codec", () => {
    const raw = JSON.stringify({
      amountOut: "100", amountIn: "1", tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT,
      routeID: "r1", checksum: "c1",
    });
    const kyberRef = sealRouteSnapshot({
      v: ROUTE_SNAPSHOT_VERSION, provider: "kyberswap", raw,
      approvedAmountOutRaw: "100", approvedMinOutRaw: "95",
      approvedAmountOutHuman: "100", approvedMinOutHuman: "95",
      tokenOutSymbol: "OUT", effectiveSlippageBps: 500,
      expiresAt: "2026-08-28T10:15:00.000Z",
      eligibility: { kind: "executable", priceImpactFraction: 0.001, adverse: false },
      debitPlan: PLAN,
    });

    const binding = readQuoteBindingPreview("prequote-1", kyberRef, "2026-08-28T10:20:00.000Z");

    expect(binding?.cardVersion).toBe(QUOTE_BINDING_CARD_VERSION);
  });

  it("states nothing at all when the row cannot be proven", () => {
    const sealed = sealUniswapSnapshot(fields());
    expect(readQuoteBindingPreview("p", { ...sealed, swapAmountRaw: "1" }, "x")).toBeUndefined();
  });
});

describe("execute-time drift", () => {
  it("passes when the execute resolved exactly what the quote bound", () => {
    const snapshot = sealUniswapSnapshot(fields());

    expect(compareUniswapExecutionInputs(snapshot, inputsFrom(fields()))).toBeNull();
  });

  it("refuses when a fee APPEARS that the approved quote was answered without", () => {
    const snapshot = sealUniswapSnapshot(
      fields({ fee: { disposition: "not_charged", amountRaw: null, disclosureText: "No Vex fee." }, swapAmountRaw: "1000000000000000000" }),
    );

    const drift = compareUniswapExecutionInputs(snapshot, inputsFrom(fields()));

    // The router input moved too; the FIRST thing the agent is told is the one
    // that changes what leaves the wallet.
    expect(drift?.kind).toBe("router_input_changed");
    expect(drift?.hint).toContain("Nothing was signed");
  });

  it("names the fee when ONLY the fee resolution changed", () => {
    const snapshot = sealUniswapSnapshot(fields());
    const feeVanished = inputsFrom(
      fields({ fee: { disposition: "not_charged", amountRaw: null, disclosureText: "No Vex fee." } }),
    );

    const drift = compareUniswapExecutionInputs(snapshot, feeVanished);

    expect(drift?.kind).toBe("fee_changed");
    expect(drift?.message).toContain("no longer applies");
    expect(drift?.hint).toContain("uniswap__swap_quote");
    expect(`${drift?.message} ${drift?.hint}`.length).toBeLessThan(320);
  });

  it("names the fee when it appears where the quote disclosed none", () => {
    const snapshot = sealUniswapSnapshot(
      fields({ fee: { disposition: "not_charged", amountRaw: null, disclosureText: "No Vex fee." } }),
    );
    const feeAppeared = inputsFrom(
      fields({ fee: { disposition: "charged", amountRaw: "2500000000000000", disclosureText: "charged" } }),
    );

    const drift = compareUniswapExecutionInputs(snapshot, feeAppeared);

    expect(drift?.kind).toBe("fee_changed");
    expect(drift?.message).toContain("a Vex fee now applies");
  });

  it("refuses a changed DISCLOSURE even at an identical amount", () => {
    const snapshot = sealUniswapSnapshot(
      fields({ fee: { disposition: "not_charged", amountRaw: null, disclosureText: "No fee. Reason: dust." } }),
    );
    const differentReason = inputsFrom(
      fields({ fee: { disposition: "not_charged", amountRaw: null, disclosureText: "No fee. Reason: fee-on-transfer input." } }),
    );

    expect(compareUniswapExecutionInputs(snapshot, differentReason)?.kind).toBe("fee_changed");
  });

  it("refuses a router input that moved, and states both figures", () => {
    const snapshot = sealUniswapSnapshot(fields());
    const moved = inputsFrom(fields({ swapAmountRaw: "997000000000000000" }));

    const drift = compareUniswapExecutionInputs(snapshot, moved);

    expect(drift?.kind).toBe("router_input_changed");
    expect(drift?.message).toContain("997500000000000000");
    expect(drift?.message).toContain("997000000000000000");
  });

  it("refuses a different pair, including a native flag that flipped", () => {
    const snapshot = sealUniswapSnapshot(fields());

    expect(
      compareUniswapExecutionInputs(snapshot, inputsFrom(fields({ chainId: 8453 })))?.kind,
    ).toBe("pair_changed");
    expect(
      compareUniswapExecutionInputs(snapshot, inputsFrom(fields({
        tokenIn: { address: TOKEN_IN, isNative: true, symbol: "ETH", decimals: 18 },
      })))?.kind,
    ).toBe("pair_changed");
  });

  it("ignores address CASE, which is not an identity difference", () => {
    const snapshot = sealUniswapSnapshot(fields());
    const lowercased = inputsFrom(fields({
      tokenIn: { address: TOKEN_IN.toLowerCase(), isNative: false, symbol: "TKN", decimals: 18 },
    }));

    expect(compareUniswapExecutionInputs(snapshot, lowercased)).toBeNull();
  });
});

describe("the floor refusal", () => {
  it("names the floor, the tolerance the human approved, and the way out", () => {
    const snapshot = sealUniswapSnapshot(fields());

    const refusal = floorUnreachableRefusal(snapshot, 1190145000000000000000n);

    expect(refusal.message).toContain("298185.715 OUT");
    expect(refusal.message).toContain("1190.145");
    expect(refusal.hint).toContain("500 bps");
    expect(refusal.hint).toContain("the floor was not lowered");
    expect(refusal.hint).toContain("uniswap__swap_quote");
    // The renderer caps message and hint TOGETHER, so the way out must survive.
    expect(`${refusal.message} ${refusal.hint}`.length).toBeLessThan(320);
  });
});

describe("the digest is a function of the bound fields only", () => {
  it("differs whenever any bound field differs", () => {
    const base = digestUniswapSnapshot(fields());
    const others = [
      digestUniswapSnapshot(fields({ chainId: 1 })),
      digestUniswapSnapshot(fields({ totalInRaw: "2" })),
      digestUniswapSnapshot(fields({ swapAmountRaw: "2" })),
      digestUniswapSnapshot(fields({ approvedAmountOutRaw: "2" })),
      digestUniswapSnapshot(fields({ approvedMinOutRaw: "2" })),
      digestUniswapSnapshot(fields({ slippageBps: 1 })),
      digestUniswapSnapshot(fields({ expiresAt: "2026-01-01T00:00:00.000Z" })),
      digestUniswapSnapshot(fields({
        debitPlan: buildBoundDebitPlan({
          legs: [{ role: "swap", unpriced: false }],
          feeCap: { mode: "legacy", gasPriceWei: 1n },
        }),
      })),
    ];

    expect(new Set([base, ...others]).size).toBe(others.length + 1);
  });
});
