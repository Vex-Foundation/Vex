/**
 * The persisted Vex fee statement: schema, projection, and the two facts that
 * can never come from a payload.
 *
 * The block is what a person consents to and what an executor is held to before
 * signing, so this suite is written the way MetaMask writes its own quote
 * validator suite (`packages/bridge-controller/src/validators/validators.test.ts`):
 * one valid case per arm, then one case per field that must be rejected, driven
 * through the real schema rather than through a hand-shaped narrowing.
 *
 * The invariants worth the reader's attention:
 *   - the parts must add up (`fee + net === total`), because a statement that
 *     describes no real split is a statement nobody can consent to;
 *   - `collection` - WHEN Vex takes the money - comes from the quote-tool table,
 *     never from the payload;
 *   - the block survives the JSONB round-trip it actually makes on the way to
 *     the row and back;
 *   - a shape failure yields `undefined`, never a partial or fabricated block.
 */

import { describe, it, expect } from "vitest";

import {
  FEE_BEARING_QUOTE_TOOLS,
  VEX_FEE_SKIP_REASON_MAX_CHARS,
  isFeeBearingGatedExecute,
  toVexFeePreview,
  vexFeeFromSafetyDetail,
  vexFeeOperationNoun,
  vexFeePreviewSchema,
  withVexFee,
} from "@vex-agent/tools/protocols/prequote/fee-disclosure.js";

const CHARGED = {
  v: "vex-fee-v1",
  charged: true,
  bps: 25,
  chargedOn: "currency_in",
  tokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  tokenSymbol: "USDC",
  tokenDecimals: 6,
  feeAmountRaw: "2500",
  feeAmountDecimal: "0.0025",
  receiver: "0xTREASURY",
  totalDebitedRaw: "1000000",
  netAmountRaw: "997500",
  collection: "separate_transfer_after_success",
} as const;

const SKIPPED = {
  v: "vex-fee-v1",
  charged: false,
  bps: 0,
  reason: "25 bps of the requested amount floors to 0 in smallest units",
  totalDebitedRaw: "399",
  netAmountRaw: "399",
  collection: "separate_transfer_after_success",
} as const;

/** Venue disclosure as `src/tools/bridge-fee/fee-disclosure.ts` emits it. */
const VENUE_BRIDGE = {
  charged: true,
  bps: 25,
  chargedOn: "currency_in",
  tokenAddress: CHARGED.tokenAddress,
  tokenSymbol: "USDC",
  tokenDecimals: 6,
  feeAmountRaw: "2500",
  feeAmountDecimal: "0.0025",
  feeUsdEstimate: "0.0025",
  receiver: "0xTREASURY",
  bridgedAmountRaw: "997500",
  totalDebitedRaw: "1000000",
  note: "Vex charges 25 bps on the input token of every bridge.",
} as const;

/** Venue disclosure as the Uniswap and KyberSwap builders emit it. */
const VENUE_SWAP = {
  charged: true,
  bps: 25,
  chargedOn: "currency_in",
  tokenAddress: CHARGED.tokenAddress,
  tokenSymbol: "USDC",
  tokenDecimals: 6,
  feeAmountRaw: "25000",
  feeAmountDecimal: "0.025",
  receiver: "0xTREASURY",
  swappedAmountRaw: "9975000",
  totalDebitedRaw: "10000000",
  note: "Vex charges 25 bps on the input token of every swap.",
} as const;

describe("vexFeePreviewSchema", () => {
  it("accepts a well-formed charged arm and a well-formed skipped arm", () => {
    expect(vexFeePreviewSchema.safeParse(CHARGED).success).toBe(true);
    expect(vexFeePreviewSchema.safeParse(SKIPPED).success).toBe(true);
  });

  it("survives the JSONB round-trip the row actually makes", () => {
    // The block is written into `safety_detail` and re-read from it, so the
    // schema must accept exactly what JSON gives back - the discriminant
    // included, which is a literal boolean rather than a string tag.
    for (const block of [CHARGED, SKIPPED]) {
      const roundTripped: unknown = JSON.parse(JSON.stringify(block));
      const parsed = vexFeePreviewSchema.safeParse(roundTripped);
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data).toEqual(block);
    }
  });

  it.each([
    "v",
    "charged",
    "bps",
    "chargedOn",
    "tokenAddress",
    "tokenSymbol",
    "tokenDecimals",
    "feeAmountRaw",
    "feeAmountDecimal",
    "receiver",
    "totalDebitedRaw",
    "netAmountRaw",
    "collection",
  ])("rejects a charged block missing %s", (field) => {
    const block: Record<string, unknown> = { ...CHARGED };
    delete block[field];
    expect(vexFeePreviewSchema.safeParse(block).success).toBe(false);
  });

  it.each(["v", "charged", "bps", "reason", "totalDebitedRaw", "netAmountRaw", "collection"])(
    "rejects a skipped block missing %s",
    (field) => {
      const block: Record<string, unknown> = { ...SKIPPED };
      delete block[field];
      expect(vexFeePreviewSchema.safeParse(block).success).toBe(false);
    },
  );

  it.each([
    ["a numeric fee amount", { feeAmountRaw: 2500 }],
    ["a decimal raw amount", { feeAmountRaw: "25.00" }],
    ["a signed raw amount", { netAmountRaw: "-997500" }],
    ["a hex raw amount", { totalDebitedRaw: "0x2710" }],
    ["a fractional bps", { bps: 25.5 }],
    ["a zero bps on the charged arm", { bps: 0 }],
    ["a fee taken on the output token", { chargedOn: "currency_out" }],
    ["fractional token decimals", { tokenDecimals: 6.5 }],
    ["a numeric symbol", { tokenSymbol: 6 }],
    ["a collection the enum does not name", { collection: "at_settlement" }],
    ["a version this build does not write", { v: "vex-fee-v2" }],
  ])("rejects %s", (_label, override) => {
    expect(vexFeePreviewSchema.safeParse({ ...CHARGED, ...override }).success).toBe(false);
  });

  it("rejects a charged block whose parts do not add up", () => {
    expect(
      vexFeePreviewSchema.safeParse({ ...CHARGED, netAmountRaw: "997499" }).success,
    ).toBe(false);
    expect(
      vexFeePreviewSchema.safeParse({ ...CHARGED, feeAmountRaw: "2501" }).success,
    ).toBe(false);
  });

  it("rejects a skipped block that moved less than the total debited", () => {
    // Nothing was taken, so the whole amount must move.
    expect(vexFeePreviewSchema.safeParse({ ...SKIPPED, netAmountRaw: "398" }).success).toBe(false);
  });

  it("accepts a null symbol and null decimals, and then a null human amount", () => {
    // A Solana source leg on a bridge: the EVM contract resolver read nothing,
    // and a guessed scale would be worse than an absent one.
    const parsed = vexFeePreviewSchema.safeParse({
      ...CHARGED,
      tokenSymbol: null,
      tokenDecimals: null,
      feeAmountDecimal: null,
    });
    expect(parsed.success).toBe(true);
  });

  it("bounds the skip reason by REFUSING a longer one, never by cutting it", () => {
    const atBound = { ...SKIPPED, reason: "x".repeat(VEX_FEE_SKIP_REASON_MAX_CHARS) };
    const overBound = { ...SKIPPED, reason: "x".repeat(VEX_FEE_SKIP_REASON_MAX_CHARS + 1) };
    expect(vexFeePreviewSchema.safeParse(atBound).success).toBe(true);
    const parsed = vexFeePreviewSchema.safeParse(overBound);
    expect(parsed.success).toBe(false);
  });
});

describe("toVexFeePreview", () => {
  it("projects the bridge venue shape, mapping bridgedAmountRaw to netAmountRaw", () => {
    const block = toVexFeePreview("relay.quote.get", VENUE_BRIDGE);
    expect(block).toEqual(CHARGED);
    // The USD estimate and the prose note are dropped: the card states exact
    // figures, and an estimate beside them reads as one of them.
    expect(block).not.toHaveProperty("feeUsdEstimate");
    expect(block).not.toHaveProperty("note");
  });

  it("projects the same bridge shape from the other bridge quote tool", () => {
    expect(toVexFeePreview("khalani.quote.get", VENUE_BRIDGE)).toEqual(CHARGED);
  });

  it("projects the swap venue shape, mapping swappedAmountRaw to netAmountRaw", () => {
    const block = toVexFeePreview("uniswap.swap.quote", VENUE_SWAP);
    expect(block).toMatchObject({
      charged: true,
      feeAmountRaw: "25000",
      netAmountRaw: "9975000",
      totalDebitedRaw: "10000000",
      collection: "separate_transfer_after_success",
    });
  });

  it("projects the KyberSwap shape and reads its collection from the table", () => {
    const block = toVexFeePreview("kyberswap.swap.quote", VENUE_SWAP);
    expect(block?.collection).toBe("inside_route");
  });

  it("takes `collection` from the quote tool, NEVER from the payload", () => {
    // WHEN Vex takes its own money is a property of the integration. A payload
    // that stated it would be stating that.
    const block = toVexFeePreview("relay.quote.get", {
      ...VENUE_BRIDGE,
      collection: "inside_route",
    });
    expect(block?.collection).toBe("separate_transfer_after_success");
  });

  it("projects a skipped venue disclosure", () => {
    const block = toVexFeePreview("relay.quote.get", {
      charged: false,
      bps: 0,
      reason: "the origin token is flagged as a honeypot, so Vex does not transfer it",
      bridgedAmountRaw: "1000000",
      totalDebitedRaw: "1000000",
      note: "No Vex bridge fee was taken on this bridge.",
    });
    expect(block).toEqual({
      v: "vex-fee-v1",
      charged: false,
      bps: 0,
      reason: "the origin token is flagged as a honeypot, so Vex does not transfer it",
      totalDebitedRaw: "1000000",
      netAmountRaw: "1000000",
      collection: "separate_transfer_after_success",
    });
  });

  it("yields undefined for a quote tool that carries no Vex fee on this channel", () => {
    // Jupiter keeps its richer `feePreview`; Pendle and Morpho carry no fee.
    expect(toVexFeePreview("solana.swap.quote", VENUE_SWAP)).toBeUndefined();
    expect(toVexFeePreview("pendle.pt.quote", VENUE_SWAP)).toBeUndefined();
    expect(toVexFeePreview("not.a.tool", VENUE_SWAP)).toBeUndefined();
  });

  it.each([
    ["nothing at all", undefined],
    ["null", null],
    ["a string", "25 bps"],
    ["an empty object", {}],
    ["a disclosure with no net amount under any name", { ...VENUE_BRIDGE, bridgedAmountRaw: undefined }],
    ["a disclosure whose parts do not add up", { ...VENUE_BRIDGE, bridgedAmountRaw: "999999" }],
    ["a disclosure with a rate but no amount", { charged: true, bps: 25 }],
  ])("yields undefined for %s", (_label, value) => {
    expect(toVexFeePreview("relay.quote.get", value)).toBeUndefined();
  });
});

describe("vexFeeFromSafetyDetail", () => {
  it("reads the block back through the schema the recorder validated against", () => {
    expect(vexFeeFromSafetyDetail({ vexFee: JSON.parse(JSON.stringify(CHARGED)) })).toEqual(CHARGED);
  });

  it("yields undefined for a row that carries no block, or a forged one", () => {
    expect(vexFeeFromSafetyDetail({})).toBeUndefined();
    expect(vexFeeFromSafetyDetail({ bridge: true })).toBeUndefined();
    // A block edited in the store to a shape this build cannot re-validate is
    // absent, never partially believed.
    expect(vexFeeFromSafetyDetail({ vexFee: { ...CHARGED, feeAmountRaw: "1" } })).toBeUndefined();
  });
});

describe("withVexFee", () => {
  it("stores the projected block beside the quote's own safety block", () => {
    const fold = withVexFee("relay.quote.get", { bridge: true }, VENUE_BRIDGE);
    expect(fold.kind).toBe("ok");
    if (fold.kind !== "ok") return;
    expect(fold.safetyDetail).toEqual({ bridge: true, vexFee: CHARGED });
  });

  it("SKIPS the row when a fee-bearing quote states no readable fee", () => {
    for (const value of [undefined, null, {}, { charged: true, bps: 25 }]) {
      const fold = withVexFee("kyberswap.swap.quote", {}, value);
      expect(fold.kind).toBe("skip");
      if (fold.kind === "skip") expect(fold.reason).toBe("vex_fee_unreadable");
    }
  });

  it("ignores the key entirely for a tool that carries no Vex fee", () => {
    // A venue that happened to echo a `vexFee` field cannot write one into its
    // row, and a Pendle quote is never skipped for want of a fee it never has.
    const fold = withVexFee("pendle.pt.quote", { termLock: { maturityIso: "2027-01-01" } }, VENUE_SWAP);
    expect(fold).toEqual({
      kind: "ok",
      safetyDetail: { termLock: { maturityIso: "2027-01-01" } },
    });
  });
});

describe("the fee-bearing registries", () => {
  it("names exactly the four quote tools that state a Vex fee on this channel", () => {
    expect([...FEE_BEARING_QUOTE_TOOLS].sort()).toEqual([
      "khalani.quote.get",
      "kyberswap.swap.quote",
      "relay.quote.get",
      "uniswap.swap.quote",
    ]);
  });

  it("names exactly the four RESOLVED gated executes the gate refuses without a block", () => {
    for (const toolId of [
      "kyberswap.swap.execute",
      "uniswap.swap.execute",
      "relay.bridge",
      "khalani.bridge",
    ]) {
      expect(isFeeBearingGatedExecute(toolId)).toBe(true);
    }
    for (const toolId of [
      "solana.swap.execute",
      "pendle.pt.buy",
      "morpho.vault.deposit",
      "trench.trade_execute",
      // The aliases never reach the GATE: the router resolves the venue id
      // before `executeProtocolTool` runs, so requiring a block under an alias
      // name would refuse a call the gate never sees under it.
      "SwapExecute",
      "BridgeExecute",
    ]) {
      expect(isFeeBearingGatedExecute(toolId)).toBe(false);
    }
  });

  it("gives the CARD a noun for the aliases as well as the resolved ids", () => {
    expect(vexFeeOperationNoun("SwapExecute")).toBe("swap");
    expect(vexFeeOperationNoun("SwapExecuteUniswap")).toBe("swap");
    expect(vexFeeOperationNoun("BridgeExecute")).toBe("bridge");
    expect(vexFeeOperationNoun("BridgeExecuteRelay")).toBe("bridge");
    expect(vexFeeOperationNoun("kyberswap.swap.execute")).toBe("swap");
    expect(vexFeeOperationNoun("relay.bridge")).toBe("bridge");
    expect(vexFeeOperationNoun("something.else")).toBeUndefined();
  });
});
