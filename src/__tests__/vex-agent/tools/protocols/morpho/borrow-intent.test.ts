/**
 * What a Morpho Blue MARKET operation RECORDS before anything is signed.
 *
 * Three properties are pinned here, and each one is a way an activity row could
 * quietly lie about money:
 *
 * 1. ONE LEG, ON THE SIDE THE OPERATION ACTUALLY MOVES. `tokenIn` is what the
 *    wallet sends and `tokenOut` is what it receives, so a borrow (the wallet
 *    RECEIVES the loan token) and a repay (the wallet SENDS it) sit on opposite
 *    sides of the same token. Getting that inverted turns a debt into an income
 *    on every downstream surface that reads the row.
 * 2. EVERY AMOUNT CARRIES THE DECIMALS OF ITS OWN TOKEN. The market under test
 *    is the real shape: 8-decimal cbBTC collateral against 6-decimal USDC debt.
 *    A row that recorded one `decimals` for both would be off by a hundred on
 *    one of its two tokens (rules/90's thousandfold error, same defect).
 * 3. A REPAYMENT BY SHARES RECORDS NO AMOUNT AT ALL, deliberately. The assets it
 *    will consume are decided on chain, so the leg carries its token and scale
 *    and NOTHING else, and the settlement decoder fills the amount in from the
 *    receipt's own Repay event.
 *
 * The approval predicates are here for the same reason: an approval attached to
 * an operation that only receives, or naming a token the operation does not
 * move, is standing spending authority nobody asked for. Both REFUSE by name at
 * plan time, before a durable row exists and before anything is signed.
 */

import { describe, it, expect } from "vitest";

import {
  buildMorphoBorrowIntentParams,
  planMorphoBorrowLegs,
  MORPHO_BORROW_EFFECTS_VERSION,
  type MorphoLegPlan,
} from "@vex-agent/tools/protocols/morpho/handlers/signed-broadcast.js";
import { definedValue } from "../../../../_test-value-guards.js";
import type {
  MorphoAllowancePlan,
  MorphoBorrowIntent,
  MorphoBorrowLeg,
  MorphoBorrowOperation,
  MorphoMarketIdentity,
} from "@tools/morpho/mutations.js";

const WALLET = "0xaAAabbbbccccddddeeeeffff0000111122223333" as const;
const BLUE = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb" as const;
const BUNDLER3 = "0x6BFd8137e702540E7A42B74178A4a49Ba43920C4" as const;
const CBBTC = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf" as const;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

/** The real Base pair: 8-decimal collateral, 6-decimal debt. */
const MARKET: MorphoMarketIdentity = {
  chainId: 8453,
  marketId: `0x${"a1".repeat(32)}`,
  loanToken: USDC,
  loanDecimals: 6,
  loanSymbol: "USDC",
  collateralToken: CBBTC,
  collateralDecimals: 8,
  collateralSymbol: "cbBTC",
  oracle: "0x1111111111111111111111111111111111111111",
  irm: "0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC",
  lltvRaw: "860000000000000000",
};

function intentFor(
  operation: MorphoBorrowOperation,
  over: Partial<MorphoBorrowIntent> = {},
): MorphoBorrowIntent {
  return {
    operation,
    market: MARKET,
    userAddress: WALLET,
    recipient: WALLET,
    amountRaw: 5_000_000n,
    sharesRaw: null,
    repayMode: operation === "repay" ? "assets" : null,
    ...over,
  };
}

function legFor(operation: MorphoBorrowOperation, amountRaw: string | null = "5000000"): MorphoBorrowLeg {
  const collateral = operation === "supply_collateral" || operation === "withdraw_collateral";
  return {
    direction: operation === "supply_collateral" || operation === "repay" || operation === "supply"
      ? "in"
      : "out",
    tokenAddress: collateral ? CBBTC : USDC,
    tokenSymbol: collateral ? "cbBTC" : "USDC",
    decimals: collateral ? 8 : 6,
    amountRaw,
  };
}

function approvalPlan(token: string, amountRaw: bigint): MorphoAllowancePlan {
  return {
    shape: "approve",
    token: token as `0x${string}`,
    owner: WALLET,
    spender: BLUE,
    spenderRole: "morphoBlue",
    requiredAmountRaw: amountRaw,
    currentAllowanceRaw: 0n,
    steps: [{
      kind: "allowance",
      to: token as `0x${string}`,
      data: "0xdeadbeef",
      spender: BLUE,
      amountRaw,
      explanation: "approve exactly this operation's amount",
    }],
  };
}

function plan(
  operation: MorphoBorrowOperation,
  over: {
    intent?: Partial<MorphoBorrowIntent>;
    leg?: MorphoBorrowLeg;
    allowancePlan?: MorphoAllowancePlan | null;
    verifiedTarget?: `0x${string}`;
  } = {},
) {
  return planMorphoBorrowLegs({
    sessionId: "session-1",
    walletAddress: WALLET,
    intent: intentFor(operation, over.intent ?? {}),
    leg: over.leg ?? legFor(operation),
    allowancePlan: over.allowancePlan ?? null,
    blueAddress: BLUE,
    // Bundler3 for the two bundled operations, Blue itself for the two direct
    // ones (fork capture, Base 2026-08-17). The decoder must still bind to BLUE.
    verifiedTarget: over.verifiedTarget
      ?? (operation === "supply_collateral" || operation === "repay" || operation === "supply"
        ? BUNDLER3
        : BLUE),
  });
}

/**
 * The planned legs, read by position and failing BY NAME when the plan is
 * shorter than the assertion expects. A missing leg is a real failure of the
 * planner, and it has to read as one instead of as a TypeError on `undefined`.
 */
function firstLeg(legs: readonly MorphoLegPlan[]): MorphoLegPlan {
  return definedValue(legs[0], "the first planned leg");
}

function lastLeg(legs: readonly MorphoLegPlan[]): MorphoLegPlan {
  return definedValue(legs.at(-1), "the last planned leg");
}

describe("morpho borrow intent: one leg, on the side the operation moves", () => {
  it("records supply_collateral as a leg the wallet SENDS, in the COLLATERAL scale", () => {
    const legs = plan("supply_collateral");
    expect(legs).toHaveLength(1);
    expect(firstLeg(legs).eventRole).toBe("lend_borrow_operate");
    expect(firstLeg(legs).event.tokenIn).toEqual({
      tokenAddress: CBBTC.toLowerCase(),
      tokenSymbol: "cbBTC",
      tokenDecimals: 8,
      amountHuman: "0.05",
      amountRaw: "5000000",
    });
    expect(firstLeg(legs).event.tokenOut).toBeUndefined();
  });

  it("records withdraw_collateral on the RECEIVING side of the same token", () => {
    const legs = plan("withdraw_collateral");
    expect(firstLeg(legs).event.tokenOut).toMatchObject({ tokenAddress: CBBTC.toLowerCase(), tokenDecimals: 8 });
    expect(firstLeg(legs).event.tokenIn).toBeUndefined();
  });

  it("records a borrow as RECEIVED and a repay as SENT, in the LOAN token's own scale", () => {
    const borrowed = plan("borrow", { leg: legFor("borrow", "500000000") });
    expect(firstLeg(borrowed).event.tokenOut).toEqual({
      tokenAddress: USDC.toLowerCase(),
      tokenSymbol: "USDC",
      tokenDecimals: 6,
      amountHuman: "500",
      amountRaw: "500000000",
    });

    const repaid = plan("repay", { leg: legFor("repay", "500000000") });
    expect(firstLeg(repaid).event.tokenIn).toMatchObject({ tokenDecimals: 6, amountHuman: "500" });
    expect(firstLeg(repaid).event.tokenOut).toBeUndefined();
  });

  it("records a repay by SHARES with its token and scale but NO amount", () => {
    const legs = plan("repay", {
      intent: { repayMode: "shares", amountRaw: null, sharesRaw: 500_000_000_000_000n },
      leg: legFor("repay", null),
    });
    expect(firstLeg(legs).event.tokenIn).toEqual({
      tokenAddress: USDC.toLowerCase(),
      tokenSymbol: "USDC",
      tokenDecimals: 6,
    });
  });

  it("states the chain family and the chain id the market identity carries", () => {
    const legs = plan("borrow");
    expect(firstLeg(legs).event.chainFamily).toBe("eip155");
    expect(firstLeg(legs).event.chainId).toBe(8453);
    expect(firstLeg(legs).event.kind).toBe("lend");
    expect(firstLeg(legs).event.protocol).toBe("morpho");
  });

  it("persists the three facts the settlement decoder must read the receipt against", () => {
    const legs = plan("repay", { leg: legFor("repay", null) });
    expect(firstLeg(legs).event.routeProvenance).toMatchObject({
      morphoBorrow: {
        operation: "repay",
        marketId: MARKET.marketId,
        blueAddress: BLUE.toLowerCase(),
      },
    });
  });

  it("leaves the operation leg with no transaction, because it is built after the approval lands", () => {
    expect(lastLeg(plan("repay")).txParams).toBeNull();
  });

  it("records the verified TARGET and the event EMITTER as the different contracts they are", () => {
    // Fork capture, Base 2026-08-17: a repay goes through Bundler3 while Blue
    // still emits the Repay event. A row that recorded Bundler3 as the emitter
    // would send the settlement decoder at a contract that emits nothing.
    const bundled = lastLeg(plan("repay")).event.routeProvenance;
    expect(bundled).toMatchObject({
      morphoBorrow: { blueAddress: BLUE.toLowerCase() },
      settlementDecode: { routerAddress: BUNDLER3 },
    });

    // A borrow is a DIRECT Blue call, so the two coincide - and they coincide
    // because the target IS Blue, not because the code conflates them.
    expect(lastLeg(plan("borrow")).event.routeProvenance).toMatchObject({
      morphoBorrow: { blueAddress: BLUE.toLowerCase() },
      settlementDecode: { routerAddress: BLUE },
    });
  });
});

describe("morpho borrow intent: the approval predicates", () => {
  it("records an approval leg before the operation for a PULLING operation", () => {
    const legs = plan("repay", { allowancePlan: approvalPlan(USDC, 500_000_000n) });
    expect(legs.map((l) => l.eventRole)).toEqual(["allowance", "lend_borrow_operate"]);
    expect(firstLeg(legs).event.tokenIn).toMatchObject({ tokenDecimals: 6, amountRaw: "500000000" });
    expect(firstLeg(legs).txParams).toEqual({ to: USDC, data: "0xdeadbeef", value: 0n });
  });

  it("REFUSES an approval attached to an operation that only receives", () => {
    expect(() => plan("borrow", { allowancePlan: approvalPlan(USDC, 1n) }))
      .toThrow(/only ever RECEIVES/);
    expect(() => plan("withdraw_collateral", { allowancePlan: approvalPlan(CBBTC, 1n) }))
      .toThrow(/only ever RECEIVES/);
  });

  it("REFUSES an approval for a token the operation does not move", () => {
    expect(() => plan("repay", { allowancePlan: approvalPlan(CBBTC, 1n) }))
      .toThrow(/moves 0x833589/);
  });

  it("REFUSES a signing wallet that is not the position owner", () => {
    expect(() => planMorphoBorrowLegs({
      sessionId: "session-1",
      walletAddress: "0x9999999999999999999999999999999999999999",
      intent: intentFor("borrow"),
      leg: legFor("borrow"),
      allowancePlan: null,
      blueAddress: BLUE,
      verifiedTarget: BLUE,
    })).toThrow(/is not the position owner/);
  });
});

describe("morpho borrow intent_params: the versioned effects payload", () => {
  it("carries the operation, both tokens WITH both decimals, and the single normalized effect", () => {
    const params = buildMorphoBorrowIntentParams(intentFor("borrow"), legFor("borrow", "500000000"));
    expect(params).toEqual({
      effectsVersion: MORPHO_BORROW_EFFECTS_VERSION,
      operation: "borrow",
      market: {
        chainId: 8453,
        marketId: MARKET.marketId,
        loanToken: USDC.toLowerCase(),
        loanDecimals: 6,
        loanSymbol: "USDC",
        collateralToken: CBBTC.toLowerCase(),
        collateralDecimals: 8,
        collateralSymbol: "cbBTC",
        oracle: MARKET.oracle,
        irm: MARKET.irm.toLowerCase(),
        lltvRaw: MARKET.lltvRaw,
      },
      userAddress: WALLET.toLowerCase(),
      recipient: WALLET.toLowerCase(),
      repayMode: null,
      sharesRaw: null,
      effects: [{
        leg: "debt",
        direction: "out",
        tokenAddress: USDC.toLowerCase(),
        tokenSymbol: "USDC",
        decimals: 6,
        amountRaw: "500000000",
        amountHuman: "500",
      }],
    });
  });

  it("names collateral operations as the COLLATERAL leg and debt operations as the DEBT leg", () => {
    const supplied = buildMorphoBorrowIntentParams(intentFor("supply_collateral"), legFor("supply_collateral"));
    expect(supplied.effects[0]).toMatchObject({ leg: "collateral", direction: "in", decimals: 8 });
    const withdrawn = buildMorphoBorrowIntentParams(intentFor("withdraw_collateral"), legFor("withdraw_collateral"));
    expect(withdrawn.effects[0]).toMatchObject({ leg: "collateral", direction: "out" });
  });

  it("states the share count and the null amount of a repay by shares", () => {
    const params = buildMorphoBorrowIntentParams(
      intentFor("repay", { repayMode: "shares", amountRaw: null, sharesRaw: 500_000_000_000_000n }),
      legFor("repay", null),
    );
    expect(params.repayMode).toBe("shares");
    expect(params.sharesRaw).toBe("500000000000000");
    expect(params.effects[0]).toMatchObject({ amountRaw: null, amountHuman: null, decimals: 6 });
  });

  it("is assignable to the intentParams boundary without a cast", () => {
    // The reason it is a `type` alias and not an `interface` - see the module
    // note. This line failing to compile IS the assertion.
    const boundary: Record<string, unknown> = buildMorphoBorrowIntentParams(intentFor("borrow"), legFor("borrow"));
    expect(boundary.effectsVersion).toBe(MORPHO_BORROW_EFFECTS_VERSION);
  });
});

/**
 * THE LENDER'S SIDE IN THE LEDGER.
 *
 * Supplying a market's loan asset IS lending, so it files under the EXISTING
 * `lend_deposit` / `lend_withdraw` roles a vault deposit uses, with no migration
 * and no new vocabulary. The role answers "what did the agent do"; a role per
 * venue-internal shape would make "show me everything I lent" return the wrong
 * set forever.
 *
 * WHICH MAKES THE ROW'S OWN `intent_params` LOAD BEARING, because the role no
 * longer says which venue was used. These cases pin that a market supply row and
 * a vault deposit row remain distinguishable from each other by their intent
 * params alone: the market row carries a versioned effects payload naming a Blue
 * MARKET ID and an operation, and the vault row carries neither.
 */
describe("the market lender lane files under the vault lane's roles, and stays distinguishable", () => {
  it("files a market SUPPLY under lend_deposit and a market WITHDRAW under lend_withdraw", () => {
    expect(lastLeg(plan("supply")).eventRole).toBe("lend_deposit");
    expect(lastLeg(plan("withdraw")).eventRole).toBe("lend_withdraw");
  });

  it("still files all four BORROWER-side operations under lend_borrow_operate", () => {
    for (const operation of ["supply_collateral", "withdraw_collateral", "borrow", "repay"] as const) {
      expect(lastLeg(plan(operation)).eventRole, operation).toBe("lend_borrow_operate");
    }
  });

  it("names the supplied side as the SUPPLY leg, not collateral and not debt", () => {
    // A market supply backs no debt and cannot be liquidated, and it is not
    // money the wallet owes. Filing it under either of the borrower's two legs
    // would corrupt every later query about the wallet's exposure.
    const supplied = buildMorphoBorrowIntentParams(intentFor("supply"), legFor("supply"));
    expect(supplied.effects[0]).toMatchObject({ leg: "supply", direction: "in", decimals: 6 });
    const withdrawn = buildMorphoBorrowIntentParams(intentFor("withdraw"), legFor("withdraw"));
    expect(withdrawn.effects[0]).toMatchObject({ leg: "supply", direction: "out", decimals: 6 });
  });

  it("moves the LOAN token, at the loan token's own scale", () => {
    // Not the collateral token. A market pairing 8-decimal cbBTC against
    // 6-decimal USDC would make a lender's amount a hundredfold wrong if the
    // wrong side were recorded.
    const supplied = buildMorphoBorrowIntentParams(intentFor("supply"), legFor("supply"));
    expect(supplied.effects[0]?.tokenAddress).toBe(USDC.toLowerCase());
    expect(supplied.effects[0]?.tokenSymbol).toBe("USDC");
  });

  it("is distinguishable from a vault deposit by its intent params alone", () => {
    // The vault lane records the tool's own echoed params: a vault ADDRESS and a
    // direction, and no effects payload. The market lane records a versioned
    // effects payload anchored on a 64-hex MARKET ID. A reader with only the
    // role and the intent params can still tell which venue moved the money.
    const marketSupply: Record<string, unknown> =
      buildMorphoBorrowIntentParams(intentFor("supply"), legFor("supply"));
    const vaultDeposit: Record<string, unknown> = {
      vaultAddress: "0x4200000000000000000000000000000000000006",
      chain: "base",
      direction: "deposit",
      depositAmountRaw: "5000000",
      slippageBps: 50,
    };

    expect(marketSupply.effectsVersion).toBe(MORPHO_BORROW_EFFECTS_VERSION);
    expect(vaultDeposit.effectsVersion).toBeUndefined();
    expect(marketSupply.operation).toBe("supply");
    expect(vaultDeposit.operation).toBeUndefined();
    expect(marketSupply.vaultAddress).toBeUndefined();
    expect(vaultDeposit.vaultAddress).toBeDefined();

    const market = definedValue(
      (marketSupply.market as { marketId?: string } | undefined),
      "the market block of a market supply's intent params",
    );
    expect(market.marketId).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("keeps the market lane's own route provenance on the row, which is what routes the decode", () => {
    // The settlement lane routes on THIS block before it looks at the role, and
    // it must: a Blue supply position is not an ERC-20 and mints no share token,
    // so the vault's net-delta rule would decline it forever.
    const provenance = lastLeg(plan("supply")).event.routeProvenance as Record<string, unknown>;
    expect(provenance.morphoBorrow).toBeDefined();
  });
});
