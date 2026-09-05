/**
 * The approve-step guard: what a bridge may and may not sign on the user's own
 * token.
 *
 * WHY THIS SUITE EXISTS. Both bridge venues signed a provider's approve step
 * after checking only the chain, the sender and the native value; the spender,
 * the token and the allowance were decoded afterwards, to record evidence. A
 * provider returning `approve(stranger, 2^256-1)` on the origin token therefore
 * signed cleanly and left the user's whole balance of that token drainable. The
 * table below is the state cross-product of that decision: origin asset x
 * approve step x deposit kind x allowance, every cell either allowed with an
 * exact allowance or a NAMED refusal.
 *
 * The pin-note cases are not decoration. viem 2.54.3 decodes a canonical
 * `approve` blob with trailing bytes appended and SILENTLY discards them, so a
 * guard that trusted `decodeFunctionData` alone would sign calldata whose tail
 * it never looked at.
 */

import { describe, expect, it } from "vitest";
import { encodeFunctionData, getAddress } from "viem";

import {
  refuseApproveStep,
  verifyApprovalSequence,
  verifyApproveStepAuthorizesDeposit,
  verifyApproveStepBindsPlan,
  type ApproveStepCall,
  type Erc20ApproveStepRefusalReason,
  type Erc20ApproveStepVerdict,
} from "@tools/evm-chains/erc20-approve-step-guard.js";

const USDC = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
const DAI = getAddress("0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb");
const DEPOSIT_TARGET = getAddress("0x4cD00E387622C35bDDB9b4c962C136462338BC31");
const STRANGER = getAddress("0x000000000000000000000000000000000000dEaD");
const WALLET = getAddress("0x33eF6673BD80cB11fcC41b82Bc2181E65cC4d2fA");

/** The post-Vex-fee principal Vex asked the venue to bridge. */
const PRINCIPAL = 5_000_000n;
const UNLIMITED = (1n << 256n) - 1n;

const APPROVE_ABI = [{
  type: "function", name: "approve", stateMutability: "nonpayable",
  inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
  outputs: [{ name: "", type: "bool" }],
}] as const;

function approveData(spender: string, allowance: bigint): string {
  return encodeFunctionData({ abi: APPROVE_ABI, functionName: "approve", args: [getAddress(spender), allowance] });
}

/**
 * Both rules, in the order a venue that sees the whole plan runs them: the
 * plan-internal binding first, then the Vex-derived amounts. The first refusal
 * wins, which is why a plan with no deposit call refuses before the origin
 * asset is even considered.
 */
function verifyApproveStep(
  call: ApproveStepCall,
  plan: { depositTarget: string | null; originToken: string | null; wallet: string; principalRaw: bigint | null },
): Erc20ApproveStepVerdict {
  const bound = verifyApproveStepAuthorizesDeposit(call, { depositTarget: plan.depositTarget });
  if (!bound.ok) return bound;
  return verifyApproveStepBindsPlan(call, {
    originToken: plan.originToken,
    wallet: plan.wallet,
    principalRaw: plan.principalRaw,
  });
}

// ── The state cross-product ─────────────────────────────────────────────────
//
// Origin asset x deposit kind x allowance, for a plan that DOES carry an
// approve step. The "approve step absent" half of the product is proven at the
// planners (a native Relay quote and a Khalani TRANSFER plan carry none), where
// the absence is observable; here there would be no call to make.
//
// Deposit kind collapses to one fact this guard can see: the address an
// approval may name. A Relay deposit step and a Khalani CONTRACT_CALL both
// carry a deposit CALL, so they behave identically and are asserted as one
// row each; a Khalani TRANSFER makes no call at all, so its deposit target is
// `null` and NO approve step in such a plan is legitimate.

type DepositKind = "relay_deposit_tx" | "khalani_contract_call" | "khalani_transfer";
type AllowanceKind = "equal" | "larger" | "unlimited" | "smaller" | "reset";

const ALLOWANCES: Readonly<Record<AllowanceKind, bigint>> = {
  equal: PRINCIPAL,
  larger: PRINCIPAL + 1n,
  unlimited: UNLIMITED,
  smaller: PRINCIPAL - 1n,
  // The `approve(spender, 0)` a non-standard token needs before a new grant.
  // Exempt from the amount EQUALITY and from nothing else.
  reset: 0n,
};

const DEPOSIT_TARGETS: Readonly<Record<DepositKind, string | null>> = {
  relay_deposit_tx: DEPOSIT_TARGET,
  khalani_contract_call: DEPOSIT_TARGET,
  khalani_transfer: null,
};

interface Cell {
  readonly origin: "native" | "erc20";
  readonly deposit: DepositKind;
  readonly allowance: AllowanceKind;
  /** `null` means allowed, and the allowance granted must be the exact principal. */
  readonly refusal: Erc20ApproveStepRefusalReason | null;
}

const CROSS_PRODUCT: readonly Cell[] = (["relay_deposit_tx", "khalani_contract_call", "khalani_transfer"] as const)
  .flatMap((deposit) => (["native", "erc20"] as const)
    .flatMap((origin) => (["equal", "larger", "unlimited", "smaller", "reset"] as const)
      .map((allowance): Cell => {
        // A plan with no deposit call refuses first, whatever the origin asset
        // or the amount: there is nothing in it an allowance could serve.
        if (deposit === "khalani_transfer") return { origin, deposit, allowance, refusal: "plan_has_no_deposit_call" };
        // A native origin moves its money as `tx.value`; there is no token to
        // approve, so an approve step on one is a step Vex never asked for.
        if (origin === "native") return { origin, deposit, allowance, refusal: "approve_on_native_origin" };
        // A zero reset passes rule 2's amount check by definition; every other
        // amount must equal the principal exactly.
        if (allowance === "equal" || allowance === "reset") return { origin, deposit, allowance, refusal: null };
        return { origin, deposit, allowance, refusal: "allowance_not_principal" };
      })));

describe("approve-step guard - the state cross-product", () => {
  it("covers every origin x deposit-kind x allowance cell exactly once", () => {
    expect(CROSS_PRODUCT).toHaveLength(30);
    expect(new Set(CROSS_PRODUCT.map((c) => `${c.origin}/${c.deposit}/${c.allowance}`)).size).toBe(30);
  });

  for (const cell of CROSS_PRODUCT) {
    const name = `${cell.origin} origin, ${cell.deposit}, ${cell.allowance} allowance`;
    it(cell.refusal === null ? `${name}: allowed for exactly the principal` : `${name}: refused as ${cell.refusal}`, () => {
      const allowance = ALLOWANCES[cell.allowance];
      const verdict = verifyApproveStep(
        { to: USDC, data: approveData(DEPOSIT_TARGET, allowance), value: 0n, from: WALLET },
        {
          depositTarget: DEPOSIT_TARGETS[cell.deposit],
          originToken: cell.origin === "native" ? null : USDC,
          wallet: WALLET,
          principalRaw: PRINCIPAL,
        },
      );
      if (cell.refusal === null) {
        expect(verdict).toEqual({ ok: true, spender: DEPOSIT_TARGET, allowance });
      } else {
        expect(verdict.ok).toBe(false);
        if (!verdict.ok) expect(verdict.reason).toBe(cell.refusal);
      }
    });
  }
});

describe("approve-step guard - rule 1, the spender must be this plan's deposit", () => {
  it("refuses an allowance granted to an address the plan never calls", () => {
    const verdict = verifyApproveStepAuthorizesDeposit(
      { to: USDC, data: approveData(STRANGER, PRINCIPAL), value: 0n },
      { depositTarget: DEPOSIT_TARGET },
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("spender_not_deposit_target");
  });

  it("accepts the live shape: spender IS the deposit target, compared without regard to checksum case", () => {
    const verdict = verifyApproveStepAuthorizesDeposit(
      { to: USDC, data: approveData(DEPOSIT_TARGET, PRINCIPAL), value: 0n },
      { depositTarget: DEPOSIT_TARGET.toLowerCase() },
    );
    expect(verdict).toEqual({ ok: true, spender: DEPOSIT_TARGET, allowance: PRINCIPAL });
  });

  it("refuses an approval that also sends native currency", () => {
    const verdict = verifyApproveStepAuthorizesDeposit(
      { to: USDC, data: approveData(DEPOSIT_TARGET, PRINCIPAL), value: 1n },
      { depositTarget: DEPOSIT_TARGET },
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("approve_carries_native_value");
  });

  it("reports a second grant in the plan's own vocabulary", () => {
    const verdict = refuseApproveStep("extra_approve_step", "two grants");
    expect(verdict).toEqual({ ok: false, reason: "extra_approve_step", detail: "two grants" });
  });
});

describe("approve-step guard - rule 2, the token, the sender and the exact allowance", () => {
  const bind = (
    call: ApproveStepCall,
    principalRaw: bigint | null = PRINCIPAL,
    originToken: string | null = USDC,
  ): Erc20ApproveStepVerdict =>
    verifyApproveStepBindsPlan(call, { originToken, wallet: WALLET, principalRaw });

  it("refuses an approval on a token that is not the origin currency", () => {
    const verdict = bind({ to: DAI, data: approveData(DEPOSIT_TARGET, PRINCIPAL), value: 0n });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("token_not_origin_currency");
  });

  it("refuses an approval sent from an address that is not the selected wallet", () => {
    const verdict = bind({ to: USDC, data: approveData(DEPOSIT_TARGET, PRINCIPAL), value: 0n, from: STRANGER });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("sender_not_selected_wallet");
  });

  it("accepts an approval that names no sender at all, as Khalani plans sometimes do", () => {
    expect(bind({ to: USDC, data: approveData(DEPOSIT_TARGET, PRINCIPAL), value: 0n }).ok).toBe(true);
  });

  it("refuses when Vex derived no principal, rather than binding to nothing", () => {
    const verdict = bind({ to: USDC, data: approveData(DEPOSIT_TARGET, PRINCIPAL), value: 0n }, null);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("principal_not_derivable");
  });

  it("names the granted and the required amount, so an agent can report the difference", () => {
    const verdict = bind({ to: USDC, data: approveData(DEPOSIT_TARGET, UNLIMITED), value: 0n });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.detail).toContain(`${UNLIMITED}`);
    if (!verdict.ok) expect(verdict.detail).toContain(`${PRINCIPAL}`);
  });
});

// ── The zero reset: exempt from the amount, from nothing else ───────────────
//
// A non-standard token requires `approve(spender, 0)` before a new grant, so
// binding the reset's zero to the principal would refuse the one sequence such
// a token needs. Everything ELSE a grant must satisfy, a reset must satisfy:
// `approve(x, 0)` on a token the user is not bridging, or from an account that
// is not theirs, is an unauthorized state change on their own asset paid for
// with their own gas.

describe("approve-step guard - a zero reset gets every check except the amount", () => {
  const reset = (over: Partial<ApproveStepCall> = {}): ApproveStepCall => ({
    to: USDC, data: approveData(DEPOSIT_TARGET, 0n), value: 0n, from: WALLET, ...over,
  });

  it("accepts the reset a non-standard token needs, on the origin token, from the wallet", () => {
    expect(bindReset(reset())).toEqual({ ok: true, spender: DEPOSIT_TARGET, allowance: 0n });
  });

  it("refuses a reset on a token that is not the origin currency", () => {
    const verdict = bindReset(reset({ to: DAI }));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("token_not_origin_currency");
  });

  it("refuses a reset sent from an address that is not the selected wallet", () => {
    const verdict = bindReset(reset({ from: STRANGER }));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("sender_not_selected_wallet");
  });

  it("refuses a reset when the origin asset is the chain's native currency", () => {
    const verdict = verifyApproveStepBindsPlan(reset(), { originToken: null, wallet: WALLET, principalRaw: PRINCIPAL });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("approve_on_native_origin");
  });

  it("refuses a reset whose spender is not this plan's deposit target", () => {
    const verdict = verifyApproveStepAuthorizesDeposit(
      { to: USDC, data: approveData(STRANGER, 0n), value: 0n },
      { depositTarget: DEPOSIT_TARGET },
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("spender_not_deposit_target");
  });

  it("accepts a reset even when Vex derived no principal: zero binds to nothing", () => {
    expect(verifyApproveStepBindsPlan(reset(), { originToken: USDC, wallet: WALLET, principalRaw: null }).ok).toBe(true);
  });

  function bindReset(call: ApproveStepCall): Erc20ApproveStepVerdict {
    return verifyApproveStepBindsPlan(call, { originToken: USDC, wallet: WALLET, principalRaw: PRINCIPAL });
  }
});

// ── The order: reset -> exact grant -> deposit, and nothing else ────────────

describe("verifyApprovalSequence - the only approval shape a bridge may sign", () => {
  const GRANT = PRINCIPAL;

  it("accepts a plan with no approval at all", () => {
    expect(verifyApprovalSequence([], 0)).toEqual({ ok: true });
  });

  it("accepts one grant before the deposit", () => {
    expect(verifyApprovalSequence([{ position: 0, allowance: GRANT }], 1)).toEqual({ ok: true });
  });

  it("accepts reset then grant, both before the deposit", () => {
    expect(verifyApprovalSequence(
      [{ position: 0, allowance: 0n }, { position: 1, allowance: GRANT }],
      2,
    )).toEqual({ ok: true });
  });

  it("refuses a grant sequenced AFTER the deposit", () => {
    const verdict = verifyApprovalSequence([{ position: 1, allowance: GRANT }], 0);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("approve_after_deposit");
  });

  it("refuses a reset-only plan, which is a bare revocation", () => {
    const verdict = verifyApprovalSequence([{ position: 0, allowance: 0n }], 1);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("allowance_reset_without_grant");
  });

  it("refuses a reset sequenced after its grant, which would leave the deposit unfunded", () => {
    const verdict = verifyApprovalSequence(
      [{ position: 0, allowance: GRANT }, { position: 1, allowance: 0n }],
      2,
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("allowance_reset_after_grant");
  });

  it("refuses two grants", () => {
    const verdict = verifyApprovalSequence(
      [{ position: 0, allowance: GRANT }, { position: 1, allowance: GRANT }],
      2,
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("extra_approve_step");
  });

  it("refuses two resets", () => {
    const verdict = verifyApprovalSequence(
      [{ position: 0, allowance: 0n }, { position: 1, allowance: 0n }, { position: 2, allowance: GRANT }],
      3,
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("extra_approve_step");
  });

  it("refuses any approval in a plan that makes no deposit call", () => {
    const verdict = verifyApprovalSequence([{ position: 0, allowance: GRANT }], null);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("plan_has_no_deposit_call");
  });
});

// ── Pin-note: measured viem 2.54.3 behaviour, 2026-09-04 ────────────────────

describe("approve-step guard - calldata canonicality (viem 2.54.3 pin-note)", () => {
  const canonical = approveData(DEPOSIT_TARGET, PRINCIPAL);
  const rows: readonly (readonly [string, string | undefined])[] = [
    ["trailing bytes viem would silently discard", `${canonical}deadbeef`],
    ["a trailing zero word", `${canonical}${"00".repeat(32)}`],
    ["a transfer selector", `0xa9059cbb${canonical.slice(10)}`],
    ["the approve selector with no arguments", "0x095ea7b3"],
    ["a truncated argument body", canonical.slice(0, 74)],
    ["empty calldata", "0x"],
    ["no calldata at all", undefined],
  ];

  for (const [label, data] of rows) {
    it(`refuses ${label} as non-canonical`, () => {
      const verdict = verifyApproveStepAuthorizesDeposit({ to: USDC, data, value: 0n }, { depositTarget: DEPOSIT_TARGET });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe("not_canonical_approve");
    });
  }

  it("accepts the exact 68-byte body the live quotes carry", () => {
    expect(canonical).toHaveLength(138);
    expect(verifyApproveStepAuthorizesDeposit({ to: USDC, data: canonical, value: 0n }, { depositTarget: DEPOSIT_TARGET }).ok).toBe(true);
  });
});
