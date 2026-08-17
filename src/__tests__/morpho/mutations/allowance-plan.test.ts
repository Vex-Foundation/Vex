/**
 * The single owner of the allowance fact, and the disagreement it refuses.
 *
 * FOUR QUESTIONS ARE PINNED HERE, and each of them is a way a money path goes
 * wrong quietly:
 *
 * 1. A standing allowance that already covers the operation produces NO steps.
 *    A redundant approval is not free: it is a transaction the user pays for and
 *    a row that claims work happened.
 * 2. A short allowance produces the EXACT approval and nothing wider. The whole
 *    policy is that a failed second leg can leave at most one operation's worth
 *    standing, which is only true if the approval is sized to the operation.
 * 3. A NON-ZERO short allowance produces the reset FIRST. Some tokens revert a
 *    non-zero to non-zero approve, and the reset is decided by allowance STATE
 *    rather than by a token allowlist that is wrong the day a new token appears.
 * 4. A disagreement between Vex's chain read and the SDK's requirement list is
 *    REFUSED, in both directions. This is the owner's option-B ruling: two
 *    readers of one money fact are not allowed to drift, and Vex does not
 *    resolve the drift by picking a side.
 *
 * The allowance READ ITSELF is also pinned: a read that did not answer refuses
 * the operation rather than defaulting to zero. Zero would schedule an approval
 * that may be redundant; "sufficient" would schedule a deposit that reverts
 * after the gas is spent. Both invent a fact the chain never supplied.
 */

import { describe, it, expect, vi } from "vitest";
import { decodeFunctionData, parseAbi, type Address } from "viem";

import {
  crossCheckMorphoAllowancePlan,
  describeMorphoAllowancePlan,
  planMorphoAllowance,
  type MorphoAllowancePlan,
} from "@tools/morpho/mutations.js";
import type { MorphoApprovalRequirement } from "@tools/morpho/mutations.js";
import { VexError } from "../../../errors.js";

/** Base, whose pinned GeneralAdapter1 the plan must name and no other address. */
const CHAIN_ID = 8453;
const BASE_GENERAL_ADAPTER_1 = "0xb98c948cfa24072e58935bc004a8a7b376ae746a";
const USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WALLET: Address = "0xaAaAbBbBccCCddddEeeEFffF0000111122223333";
const AMOUNT = 1_000_000n;

const APPROVE_ABI = parseAbi(["function approve(address,uint256) returns (bool)"]);

function readerReturning(allowance: bigint | Error) {
  return {
    readContract: vi.fn(async () => {
      if (allowance instanceof Error) throw allowance;
      return allowance;
    }),
  };
}

async function planWith(allowance: bigint | Error): Promise<MorphoAllowancePlan> {
  return planMorphoAllowance(readerReturning(allowance), {
    chainId: CHAIN_ID,
    assetAddress: USDC,
    walletAddress: WALLET,
    requiredAmountRaw: AMOUNT,
  });
}

/** What the SDK would independently report for a wallet that still owes an approval. */
function sdkApproval(overrides: Partial<MorphoApprovalRequirement> = {}): MorphoApprovalRequirement {
  return {
    kind: "approval",
    token: USDC.toLowerCase(),
    spender: BASE_GENERAL_ADAPTER_1,
    spenderRole: "GeneralAdapter1",
    amountRaw: AMOUNT.toString(),
    explanation: "sdk",
    ...overrides,
  };
}

/** The `approve(spender, amount)` a step would actually send, decoded from its calldata. */
function decodeStep(data: `0x${string}`): { spender: string; amount: bigint } {
  const decoded = decodeFunctionData({ abi: APPROVE_ABI, data });
  const [spender, amount] = decoded.args as readonly [Address, bigint];
  return { spender: spender.toLowerCase(), amount };
}

describe("planMorphoAllowance", () => {
  it("plans NO steps when the standing allowance already covers the operation", async () => {
    const plan = await planWith(AMOUNT);

    expect(plan.shape).toBe("none-needed");
    expect(plan.steps).toHaveLength(0);
    expect(plan.currentAllowanceRaw).toBe(AMOUNT);
    expect(describeMorphoAllowancePlan(plan)).toHaveLength(0);
  });

  it("plans ONE approval for EXACTLY the operation's amount when nothing is approved", async () => {
    const plan = await planWith(0n);

    expect(plan.shape).toBe("approve");
    expect(plan.steps).toHaveLength(1);
    const step = plan.steps[0];
    expect(step.kind).toBe("allowance");
    // The transaction targets the ASSET, and authorises the pinned adapter for
    // the operation's own amount. Never `maxUint256`, never a rounded-up figure.
    expect(step.to.toLowerCase()).toBe(USDC.toLowerCase());
    expect(decodeStep(step.data)).toEqual({ spender: BASE_GENERAL_ADAPTER_1, amount: AMOUNT });
  });

  it("plans a reset to zero BEFORE the approval when a non-zero allowance is short", async () => {
    const plan = await planWith(AMOUNT - 1n);

    expect(plan.shape).toBe("reset-then-approve");
    expect(plan.steps.map((s) => s.kind)).toEqual(["allowance_reset", "allowance"]);
    // Order is the property under test: the zeroing must precede the grant, or a
    // USDT-shaped token reverts the approval that pays for the operation.
    expect(decodeStep(plan.steps[0].data)).toEqual({ spender: BASE_GENERAL_ADAPTER_1, amount: 0n });
    expect(decodeStep(plan.steps[1].data)).toEqual({ spender: BASE_GENERAL_ADAPTER_1, amount: AMOUNT });
  });

  it("projects the reset step as its own named requirement rather than a second approval", async () => {
    const requirements = describeMorphoAllowancePlan(await planWith(AMOUNT - 1n));

    expect(requirements.map((r) => r.kind)).toEqual(["approval_reset", "approval"]);
    expect(requirements[0].amountRaw).toBe("0");
    expect(requirements[1].amountRaw).toBe(AMOUNT.toString());
  });

  it("REFUSES the operation when the allowance could not be read, rather than assuming zero", async () => {
    await expect(planWith(new Error("upstream RPC returned 503"))).rejects.toMatchObject({
      code: "MORPHO_RPC_ERROR",
    });
  });

  it("refuses a chain with no pinned GeneralAdapter1 rather than guessing a deployment", async () => {
    await expect(
      planMorphoAllowance(readerReturning(0n), {
        chainId: 999_999,
        assetAddress: USDC,
        walletAddress: WALLET,
        requiredAmountRaw: AMOUNT,
      }),
    ).rejects.toMatchObject({ code: "MORPHO_APPROVAL_POLICY_VIOLATION" });
  });
});

describe("crossCheckMorphoAllowancePlan", () => {
  it("agrees when both readers say an exact approval is owed", async () => {
    const plan = await planWith(0n);
    expect(() => crossCheckMorphoAllowancePlan(plan, [sdkApproval()])).not.toThrow();
  });

  it("agrees when both readers say nothing is owed", async () => {
    const plan = await planWith(AMOUNT);
    expect(() => crossCheckMorphoAllowancePlan(plan, [])).not.toThrow();
  });

  it("accepts the reset shape, which the SDK has no opinion about", async () => {
    // The SDK models the Morpho operation, not the token's `approve`
    // implementation, so it reports one approval for a wallet that needs a reset
    // first. Demanding agreement about a step it cannot know would refuse every
    // USDT-shaped operation.
    const plan = await planWith(AMOUNT - 1n);
    expect(() => crossCheckMorphoAllowancePlan(plan, [sdkApproval()])).not.toThrow();
  });

  it("REFUSES when Vex read the allowance as sufficient and the SDK still wants one", async () => {
    const plan = await planWith(AMOUNT);
    expect(() => crossCheckMorphoAllowancePlan(plan, [sdkApproval()])).toThrow(VexError);
    try {
      crossCheckMorphoAllowancePlan(plan, [sdkApproval()]);
    } catch (err) {
      expect((err as VexError).code).toBe("MORPHO_APPROVAL_POLICY_VIOLATION");
      // The refusal names BOTH readings, so the disagreement is diagnosable
      // rather than a bare "policy violation".
      expect((err as VexError).message).toContain(AMOUNT.toString());
    }
  });

  it("REFUSES when Vex read the allowance as short and the SDK reports none owed", async () => {
    const plan = await planWith(0n);
    expect(() => crossCheckMorphoAllowancePlan(plan, [])).toThrow(VexError);
  });

  it("REFUSES an SDK approval whose amount, token or spender is not the planned one", async () => {
    const plan = await planWith(0n);
    for (const drift of [
      sdkApproval({ amountRaw: (AMOUNT + 1n).toString() }),
      sdkApproval({ token: "0x4200000000000000000000000000000000000006" }),
      sdkApproval({ spender: "0x000000000022d473030f116ddee9f6b43ac78ba3" }),
    ]) {
      expect(() => crossCheckMorphoAllowancePlan(plan, [drift])).toThrow(VexError);
    }
  });

  it("REFUSES a list longer than the one approval this lane can account for", async () => {
    const plan = await planWith(0n);
    expect(() => crossCheckMorphoAllowancePlan(plan, [sdkApproval(), sdkApproval()])).toThrow(VexError);
  });
});
