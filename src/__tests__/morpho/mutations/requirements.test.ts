/**
 * The owner's FINAL approval policy (2026-08-17), asserted as code.
 *
 * NO SIGNATURE PATHS OF ANY KIND. Every Morpho operation is authorised by one
 * plain ERC-20 `approve()` for EXACTLY the operation's amount, to the pinned
 * GeneralAdapter1 of that chain, followed by the operation itself. Permit2 and
 * EIP-2612 are not merely unused here: a signature requirement arriving under
 * `supportSignature: false` contradicts the SDK behavior this layer was built
 * against, so it is refused by name rather than quietly handled.
 *
 * The two refusals that matter most, and why each is a REFUSAL and not a warning:
 *   - a spender other than the chain's pinned GeneralAdapter1, whatever amount it
 *     names, because the spender is what actually gets to pull the tokens;
 *   - an amount that is not exactly the operation's, unbounded above all, because
 *     "approve more than the operation needs" is the residual this policy exists
 *     to prevent.
 */

import { describe, it, expect } from "vitest";

import { VexError } from "../../../errors.js";
import { classifyMorphoRequirements } from "@tools/morpho/mutations.js";
import { MORPHO_CONTRACTS, UINT256_MAX } from "@tools/morpho/constants.js";
import { BASE_CHAIN_ID, BASE_GENERAL_ADAPTER_1, BASE_PERMIT2, BASE_USDC } from "./bundle-fixtures.js";
import { definedValue } from "../../_test-value-guards.js";

/** The operation every requirement below is classified against: 1 USDC, 6 decimals. */
const OPERATION_AMOUNT = 1_000_000n;

/** `type(uint160).max`, the unbounded value a Permit2-style approval carries. */
const UINT160_MAX = 2n ** 160n - 1n;

function approvalRequirement(spender: string, amount: bigint | string = OPERATION_AMOUNT, token: string = BASE_USDC) {
  return { to: token, data: "0x", value: 0n, action: { type: "erc20Approval", args: { spender, amount } } };
}

function permit2Requirement() {
  return {
    sign: () => Promise.reject(new Error("no signature path exists under this policy")),
    action: {
      type: "permit2",
      args: {
        spender: BASE_GENERAL_ADAPTER_1,
        amount: OPERATION_AMOUNT,
        deadline: 1_786_962_015n,
        expiration: 281_474_976_710_655n,
      },
    },
  };
}

function classify(requirements: readonly unknown[], chainId = BASE_CHAIN_ID) {
  return classifyMorphoRequirements(requirements, chainId, BASE_USDC, OPERATION_AMOUNT);
}

function expectPolicyRefusal(run: () => unknown, ...phrases: string[]): void {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(VexError);
    const vexError = err as VexError;
    expect(vexError.code).toBe("MORPHO_APPROVAL_POLICY_VIOLATION");
    for (const phrase of phrases) {
      expect(`${vexError.message} ${vexError.hint ?? ""}`.toLowerCase()).toContain(phrase.toLowerCase());
    }
    return;
  }
  throw new Error("expected a policy refusal, but the requirement was accepted");
}

describe("classifyMorphoRequirements - the exact-amount approval policy", () => {
  it("accepts an exact-amount approval to the chain's pinned GeneralAdapter1", () => {
    const [requirement] = classify([approvalRequirement(BASE_GENERAL_ADAPTER_1)]);

    expect(requirement?.kind).toBe("approval");
    if (requirement?.kind !== "approval") throw new Error("unreachable");
    expect(requirement.spender).toBe(BASE_GENERAL_ADAPTER_1.toLowerCase());
    expect(requirement.amountRaw).toBe(OPERATION_AMOUNT.toString());
    expect(requirement.token).toBe(BASE_USDC.toLowerCase());
    // The residual is DISCLOSED rather than presented as a one-time convenience.
    expect(requirement.explanation.toLowerCase()).toContain("exactly");
  });

  it("accepts an empty requirement list, which is what a sufficient allowance produces", () => {
    expect(classify([])).toEqual([]);
  });

  it("refuses an approval to Permit2, because this policy has no signature step to use it", () => {
    expectPolicyRefusal(
      () => classify([approvalRequirement(BASE_PERMIT2)]),
      "permit2",
      "generaladapter1",
    );
  });

  it("refuses an approval to Morpho Blue itself, however legitimate that contract is", () => {
    const morphoBlue = definedValue(MORPHO_CONTRACTS[BASE_CHAIN_ID]?.morphoBlue, "Base Morpho Blue address");
    expect(morphoBlue).toBeTruthy();
    expectPolicyRefusal(() => classify([approvalRequirement(morphoBlue)]), "generaladapter1");
  });

  it("refuses an UNBOUNDED approval even when the spender is the right one", () => {
    expectPolicyRefusal(
      () => classify([approvalRequirement(BASE_GENERAL_ADAPTER_1, UINT256_MAX)]),
      "exactly",
    );
    expectPolicyRefusal(
      () => classify([approvalRequirement(BASE_GENERAL_ADAPTER_1, UINT160_MAX)]),
      "exactly",
    );
  });

  it("refuses an approval LARGER than the operation by a single raw unit", () => {
    expectPolicyRefusal(
      () => classify([approvalRequirement(BASE_GENERAL_ADAPTER_1, OPERATION_AMOUNT + 1n)]),
      "exactly",
    );
  });

  it("refuses an approval SMALLER than the operation, which would strand the deposit", () => {
    expectPolicyRefusal(
      () => classify([approvalRequirement(BASE_GENERAL_ADAPTER_1, OPERATION_AMOUNT - 1n)]),
      "exactly",
    );
  });

  it("refuses an approval on a token the operation does not move", () => {
    expectPolicyRefusal(
      () =>
        classify([
          approvalRequirement(BASE_GENERAL_ADAPTER_1, OPERATION_AMOUNT, "0x000000000000000000000000000000000000dEaD"),
        ]),
      "not the vault's own asset",
    );
  });

  it("refuses any approval on a chain the pinned registry has no GeneralAdapter1 for", () => {
    expectPolicyRefusal(
      () => classify([approvalRequirement(BASE_GENERAL_ADAPTER_1)], 424_242),
      "no pinned generaladapter1 on chain 424242",
    );
  });

  it("REFUSES a signature requirement outright, because none may exist under this policy", () => {
    expectPolicyRefusal(
      () => classify([permit2Requirement()]),
      "signature",
      "supportsignature: false",
    );
  });

  it("refuses a requirement it cannot classify rather than passing it through", () => {
    expectPolicyRefusal(() => classify([{ action: { type: "somethingNew", args: {} } }]), "does not recognise");
  });

  it("refuses an approval whose amount does not read as a number", () => {
    expectPolicyRefusal(
      () =>
        classify([
          { to: BASE_USDC, action: { type: "erc20Approval", args: { spender: BASE_GENERAL_ADAPTER_1, amount: "lots" } } },
        ]),
      "did not read as a whole number",
    );
  });
});
