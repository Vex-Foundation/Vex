/**
 * The owner's approval policy (2026-08-17), asserted as code.
 *
 * One standing approval, to the CANONICAL Permit2 and nothing else. Every
 * operation then authorised by its own signature with its own amount and its own
 * deadline. The GeneralAdapter1 case is the one that matters most: the SDK will
 * happily produce it (spike, `supportSignature: false`), it is a perfectly
 * ordinary DeFi pattern, and it is the contract that actually pulls the user's
 * tokens. It is refused here by name.
 */

import { describe, it, expect } from "vitest";

import { VexError } from "../../../errors.js";
import { classifyMorphoRequirements } from "@tools/morpho/mutations.js";
import { MORPHO_CONTRACTS } from "@tools/morpho/constants.js";
import { BASE_CHAIN_ID, BASE_GENERAL_ADAPTER_1, BASE_PERMIT2, BASE_USDC } from "./bundle-fixtures.js";

/** `type(uint160).max`, the unbounded Permit2 approval the live capture carried. */
const UINT160_MAX = 2n ** 160n - 1n;

function approvalRequirement(spender: string, amount = UINT160_MAX, token: string = BASE_USDC) {
  return { to: token, data: "0x", value: 0n, action: { type: "erc20Approval", args: { spender, amount } } };
}

function permit2Requirement() {
  return {
    sign: () => Promise.reject(new Error("a preview must never call sign()")),
    action: {
      type: "permit2",
      args: {
        spender: BASE_GENERAL_ADAPTER_1,
        amount: 1_000_000n,
        deadline: 1_786_962_015n,
        expiration: 281_474_976_710_655n,
      },
    },
  };
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

describe("classifyMorphoRequirements - the approval policy", () => {
  it("accepts the canonical Permit2 approval and names it as unbounded", () => {
    const [requirement] = classifyMorphoRequirements(
      [approvalRequirement(BASE_PERMIT2)],
      BASE_CHAIN_ID,
      BASE_USDC,
    );

    expect(requirement?.kind).toBe("approval");
    if (requirement?.kind !== "approval") throw new Error("unreachable");
    expect(requirement.spender).toBe(BASE_PERMIT2.toLowerCase());
    expect(requirement.unbounded).toBe(true);
    // The unbounded grant is DISCLOSED, not hidden behind "one-time step".
    expect(requirement.explanation.toLowerCase()).toContain("unbounded");
    expect(requirement.explanation.toLowerCase()).toContain("revoked");
  });

  it("refuses an approval to GeneralAdapter1, the contract that pulls the tokens", () => {
    expectPolicyRefusal(
      () => classifyMorphoRequirements([approvalRequirement(BASE_GENERAL_ADAPTER_1)], BASE_CHAIN_ID, BASE_USDC),
      "generaladapter1",
      "canonical permit2",
      "is refused",
    );
  });

  it("refuses an approval to Morpho Blue itself, however legitimate that contract is", () => {
    const morphoBlue = MORPHO_CONTRACTS[BASE_CHAIN_ID]?.morphoBlue;
    expect(morphoBlue).toBeTruthy();
    expectPolicyRefusal(
      () => classifyMorphoRequirements([approvalRequirement(morphoBlue!)], BASE_CHAIN_ID, BASE_USDC),
      "canonical permit2",
    );
  });

  it("refuses an EXACT-amount approval to a non-Permit2 spender, so the size is not the test", () => {
    expectPolicyRefusal(
      () => classifyMorphoRequirements([approvalRequirement(BASE_GENERAL_ADAPTER_1, 1_000_000n)], BASE_CHAIN_ID, BASE_USDC),
      "canonical permit2",
    );
  });

  it("refuses an approval on a token the operation does not move", () => {
    expectPolicyRefusal(
      () =>
        classifyMorphoRequirements(
          [approvalRequirement(BASE_PERMIT2, UINT160_MAX, "0x000000000000000000000000000000000000dEaD")],
          BASE_CHAIN_ID,
          BASE_USDC,
        ),
      "not the vault's own asset",
    );
  });

  it("refuses any approval at all on a chain the pinned registry has no Permit2 for", () => {
    // Monad (143) and HyperEVM (999) genuinely have no Permit2 in the registry.
    expect(MORPHO_CONTRACTS[143]?.permit2).toBeNull();
    expectPolicyRefusal(
      () => classifyMorphoRequirements([approvalRequirement(BASE_PERMIT2)], 143, BASE_USDC),
      "no permit2 on chain 143",
    );
  });

  it("describes a permit2 signature with its amount and deadline, and never signs it", () => {
    const [requirement] = classifyMorphoRequirements([permit2Requirement()], BASE_CHAIN_ID, BASE_USDC);

    expect(requirement?.kind).toBe("signature");
    if (requirement?.kind !== "signature") throw new Error("unreachable");
    expect(requirement.scheme).toBe("permit2");
    expect(requirement.amountRaw).toBe("1000000");
    expect(requirement.deadlineSeconds).toBe("1786962015");
    expect(requirement.expirationSeconds).toBe("281474976710655");
    expect(requirement.explanation.toLowerCase()).toContain("nothing has been signed");
    // The `sign` callable is the authorisation gate and must NOT be carried out
    // of this layer, where a caller could reach it from a preview.
    expect(Object.hasOwn(requirement, "sign")).toBe(false);
  });

  it("refuses a requirement it cannot classify rather than passing it through", () => {
    expectPolicyRefusal(
      () => classifyMorphoRequirements([{ action: { type: "somethingNew", args: {} } }], BASE_CHAIN_ID, BASE_USDC),
      "does not recognise",
    );
  });

  it("refuses an approval whose amount does not read as a number", () => {
    expectPolicyRefusal(
      () =>
        classifyMorphoRequirements(
          [{ to: BASE_USDC, action: { type: "erc20Approval", args: { spender: BASE_PERMIT2, amount: "lots" } } }],
          BASE_CHAIN_ID,
          BASE_USDC,
        ),
      "did not read as a whole number",
    );
  });
});
