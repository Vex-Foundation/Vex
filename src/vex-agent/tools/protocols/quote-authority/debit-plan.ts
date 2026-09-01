/**
 * THE BOUND DEBIT PLAN: the executable artifact a quote seals alongside the
 * route it displays, so the execute cannot broadcast a different set of
 * transactions than the one the human approved.
 *
 * ## The gap this closes
 *
 * Until now a snapshot bound the PRICE (the approved output and the floor) and
 * nothing about what the swap would COST to send. Both venues measured a full
 * leg plan at quote time - allowance reset, allowance, swap, fee transfer - and
 * disclosed its native debit on the approval card, and then both threw that
 * plan away: the execute re-derived its own leg set from a fresh allowance read
 * and priced it at a fresh fee cap. A wallet whose allowance changed between the
 * quote and the click therefore signed two extra transactions the card never
 * mentioned, and the execute proceeded because the wallet happened to be solvent
 * for them. Rule 90 says approval binds to the exact parameters and is
 * revalidated immediately before signing; the leg set and the per-gas ceiling
 * are parameters, so they are bound here.
 *
 * MetaMask reaches the same shape from the other direction: a quote answer
 * carries `batchTransactions`, the executable artifact, SEPARATELY from the
 * display `quotes` (`transaction-pay-controller/src/utils/quotes.ts:735-760`),
 * and a quote the wallet cannot fund is kept for display with an EMPTY
 * `batchTransactions` (`:762-775`). This module is Vex's `batchTransactions`,
 * and the same rule holds: an ineligible quote seals no snapshot, so it carries
 * no plan and can authorize nothing.
 *
 * ## What is bound, and what deliberately is NOT
 *
 * BOUND: the ordered leg-role list, each leg's per-gas fee cap, the follow-up
 * reserve's identity and its cap, and an explicit marker for a leg whose gas
 * units could not be measured at quote time.
 *
 * NOT BOUND: gas UNITS. MEASURED (WP2-K, Base, 2026-08-31) 2.07x block-to-block
 * drift in the router's own gas estimate inside the 15-minute quote window - a
 * units ceiling taken at quote time would refuse swaps the wallet can perfectly
 * well afford, for a number that was never a promise to the user. Units stay an
 * execute-time fact, measured fresh against the live chain.
 *
 * That is also why this module did NOT reuse the substrate's persisted-cap
 * shape (`PersistedLegFeeCap`, since deleted with its codec): it bundled a
 * `gasLimit` with the cap, and `checkFeeCap` compared it first, so binding a
 * plan through it would have smuggled in exactly the units ceiling the
 * measurement forbids.
 *
 * ## Serialization
 *
 * Every amount is an exact base-10 integer STRING. The plan crosses durable
 * JSONB, where a JavaScript number would be a money value that lost precision on
 * the way to a signature (rule 90). {@link canonicalizeDebitPlan} produces the
 * digest input, and by construction it contains no U+0000, so either venue's
 * snapshot canonicalization can embed it as a single NUL-separated field.
 */

import { z } from "zod";

import type { LegFeeCap, NativeDebitLegRole } from "@tools/evm-chains/swap-native-debit.js";

/** Exact atomic units: a base-10 integer, no sign, no separators, no exponent. */
const ATOMIC_INTEGER = /^\d+$/;
/** 78 digits is a full uint256 in base 10; the bound leaves room and no more. */
const MAX_ATOMIC_DIGITS = 80;

/**
 * The most legs any venue on this lane plans: allowance reset, allowance, swap,
 * fee transfer. A bound, not a cut - a longer list is refused as unreadable
 * rather than silently shortened.
 */
export const MAX_BOUND_DEBIT_LEGS = 4;

const atomicString = z.string().regex(ATOMIC_INTEGER).max(MAX_ATOMIC_DIGITS);

/**
 * One leg's approved per-gas ceiling, as it survives the trip through the
 * database.
 *
 * The PRICE half only. For EIP-1559 `maxFeePerGasWei` is the whole ceiling -
 * the priority fee is paid out of it, never beside it - and the priority value
 * is carried because a request may not exceed the approved tip either.
 */
export type BoundFeeCap =
  | {
      readonly mode: "eip1559";
      readonly maxFeePerGasWei: string;
      readonly maxPriorityFeePerGasWei: string;
    }
  | { readonly mode: "legacy"; readonly gasPriceWei: string };

const boundFeeCapSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("eip1559"),
    maxFeePerGasWei: atomicString,
    maxPriorityFeePerGasWei: atomicString,
  }),
  z.object({ mode: z.literal("legacy"), gasPriceWei: atomicString }),
]);

/**
 * One leg of the approved plan.
 *
 * `unpriced` is the honest marker for a leg whose gas UNITS could not be
 * measured when the quote was answered - a swap through an ERC-20 the router may
 * not yet move cannot be simulated before its allowance leg lands, so its
 * estimate reverts inside `transferFrom`. Such a leg is bound by ROLE and by
 * PRICE CAP and left unbound in units, and the disclosed debit total that
 * included it was an explicit LOWER BOUND (ratified 2026-08-31). It is not the
 * same statement as a leg that costs nothing.
 */
export interface BoundDebitLeg {
  readonly role: NativeDebitLegRole;
  readonly feeCap: BoundFeeCap;
  readonly unpriced: boolean;
}

/**
 * The follow-up reserve the plan set aside, by IDENTITY rather than by amount.
 *
 * The amount is a live measurement (a freshly priced zero-value self-transfer,
 * owner decision 2026-08-31), so binding wei would bind a number that must move.
 * What is bound is WHICH transaction was reserved for and the ceiling it was
 * priced under, which is what makes the disclosed reserve checkable later.
 */
export interface BoundDebitReserve {
  readonly kind: "zero_value_self_transfer";
  readonly feeCap: BoundFeeCap;
}

/** The whole executable artifact of one quote. */
export interface BoundDebitPlan {
  /** In BROADCAST order. The order is part of what was approved. */
  readonly legs: readonly BoundDebitLeg[];
  readonly reserve: BoundDebitReserve;
}

const legRoleSchema = z.enum(["allowance_reset", "allowance", "swap", "swap_fee"]);

/**
 * The shape a bound plan must still have when it comes back out of storage.
 *
 * STRICT, and rejecting rather than repairing: a plan this build cannot read is
 * a plan it cannot enforce, and enforcing nothing while claiming to be bound is
 * worse than requiring a fresh quote.
 */
export const boundDebitPlanSchema = z.object({
  legs: z
    .array(
      z.object({
        role: legRoleSchema,
        feeCap: boundFeeCapSchema,
        unpriced: z.boolean(),
      }),
    )
    .min(1)
    .max(MAX_BOUND_DEBIT_LEGS),
  reserve: z.object({
    kind: z.literal("zero_value_self_transfer"),
    feeCap: boundFeeCapSchema,
  }),
});

/** The runtime cap, in the persistable shape. */
export function boundFeeCapFrom(cap: LegFeeCap): BoundFeeCap {
  return cap.mode === "eip1559"
    ? {
        mode: "eip1559",
        maxFeePerGasWei: cap.maxFeePerGasWei.toString(10),
        maxPriorityFeePerGasWei: cap.maxPriorityFeePerGasWei.toString(10),
      }
    : { mode: "legacy", gasPriceWei: cap.gasPriceWei.toString(10) };
}

/** The persisted cap, back in the shape the debit arithmetic and `checkFeeCap` take. */
export function toLegFeeCap(cap: BoundFeeCap): LegFeeCap {
  return cap.mode === "eip1559"
    ? {
        mode: "eip1559",
        maxFeePerGasWei: BigInt(cap.maxFeePerGasWei),
        maxPriorityFeePerGasWei: BigInt(cap.maxPriorityFeePerGasWei),
      }
    : { mode: "legacy", gasPriceWei: BigInt(cap.gasPriceWei) };
}

/**
 * Seal a venue's measured plan into the bound artifact.
 *
 * ONE cap argument, because both venues on this lane read ONE per-gas ceiling
 * per plan and sign every leg under it (Rabby binds the same price it priced
 * with, `SendToken/index.tsx:1188`). The wire shape still carries the cap PER
 * LEG so a venue that ever prices legs separately needs no format change, and
 * {@link uniformPlanFeeCap} is what turns the per-leg form back into the single
 * ceiling today's executors take.
 */
export function buildBoundDebitPlan(input: {
  readonly legs: readonly { readonly role: NativeDebitLegRole; readonly unpriced: boolean }[];
  readonly feeCap: LegFeeCap;
}): BoundDebitPlan {
  const feeCap = boundFeeCapFrom(input.feeCap);
  return {
    legs: input.legs.map((leg) => ({ role: leg.role, feeCap, unpriced: leg.unpriced })),
    reserve: { kind: "zero_value_self_transfer", feeCap },
  };
}

/** The approved leg roles, in broadcast order. */
export function debitPlanRoles(plan: BoundDebitPlan): readonly NativeDebitLegRole[] {
  return plan.legs.map((leg) => leg.role);
}

function sameCap(a: BoundFeeCap, b: BoundFeeCap): boolean {
  if (a.mode === "eip1559" && b.mode === "eip1559") {
    return a.maxFeePerGasWei === b.maxFeePerGasWei
      && a.maxPriorityFeePerGasWei === b.maxPriorityFeePerGasWei;
  }
  return a.mode === "legacy" && b.mode === "legacy" && a.gasPriceWei === b.gasPriceWei;
}

/**
 * The ONE ceiling this plan authorizes, or `null` when its legs do not agree on
 * one.
 *
 * Today every plan this build writes is uniform by construction. A row that is
 * not - a future venue's, or a hand-edited one - is refused by the caller rather
 * than resolved by picking a leg, because picking would mean signing some leg at
 * a ceiling nobody approved for it.
 */
export function uniformPlanFeeCap(plan: BoundDebitPlan): LegFeeCap | null {
  const first = plan.legs[0];
  if (first === undefined) return null;
  if (!sameCap(first.feeCap, plan.reserve.feeCap)) return null;
  for (const leg of plan.legs) {
    if (!sameCap(first.feeCap, leg.feeCap)) return null;
  }
  return toLegFeeCap(first.feeCap);
}

/** The cap this plan approved for one role, or `null` when the role is not in it. */
export function planFeeCapForRole(
  plan: BoundDebitPlan,
  role: NativeDebitLegRole,
): LegFeeCap | null {
  const leg = plan.legs.find((candidate) => candidate.role === role);
  return leg === undefined ? null : toLegFeeCap(leg.feeCap);
}

/**
 * The digest input for one plan.
 *
 * Written out field by field rather than by `JSON.stringify`: the object arrives
 * from durable JSONB on the read side, where Postgres owns key order, so a
 * digest over an implicit ordering would fail for reasons that have nothing to
 * do with tampering. Every value is an enum member, a boolean or a base-10
 * integer, so the result contains no U+0000 and can be embedded as one field of
 * either venue's own NUL-separated canonicalization.
 */
export function canonicalizeDebitPlan(plan: BoundDebitPlan): string {
  const cap = (value: BoundFeeCap): string =>
    value.mode === "eip1559"
      ? `eip1559:${value.maxFeePerGasWei}:${value.maxPriorityFeePerGasWei}`
      : `legacy:${value.gasPriceWei}`;
  const legs = plan.legs
    .map((leg) => `${leg.role}@${cap(leg.feeCap)}@${leg.unpriced ? "unpriced" : "priced"}`)
    .join(";");
  return `legs[${legs}]|reserve[${plan.reserve.kind}@${cap(plan.reserve.feeCap)}]`;
}

// ── Execute-time enforcement ────────────────────────────────────────────

/** Why an execute may not build against the plan it just claimed. */
export type DebitPlanDriftKind = "leg_set_changed" | "fee_cap_not_uniform";

/**
 * Split into `message` and `hint` for the reason the sibling refusals give: a
 * `VexError`'s hint leads the rendered line and the pair is capped TOGETHER, so
 * the way out belongs in the hint.
 */
export interface DebitPlanDrift {
  readonly kind: DebitPlanDriftKind;
  readonly message: string;
  readonly hint: string;
}

/**
 * Hold the leg set this execute is about to broadcast against the one the quote
 * bound.
 *
 * An extra allowance leg, a vanished reset, a fee leg that appeared: each is a
 * DIFFERENT set of transactions than the human authorized and each is refused by
 * name, with a fresh quote as the way out. It is not a price comparison and
 * never refuses for market movement - the approved floor already carries the
 * tolerance the human agreed to.
 */
export function compareDebitPlanRoles(
  plan: BoundDebitPlan,
  actualRoles: readonly NativeDebitLegRole[],
  freshQuoteTool: string,
): DebitPlanDrift | null {
  const approved = debitPlanRoles(plan);
  const same = approved.length === actualRoles.length
    && approved.every((role, index) => role === actualRoles[index]);
  if (!same) {
    return {
      kind: "leg_set_changed",
      message:
        `Refused before signing: this execute would broadcast ${describeRoles(actualRoles)},`
        + ` but the approved quote was answered for ${describeRoles(approved)}.`,
      hint:
        `Nothing was signed; the transaction set you approved was not widened to make the swap fit.`
        + ` Request a fresh ${freshQuoteTool} and execute against that.`,
    };
  }
  if (uniformPlanFeeCap(plan) === null) {
    return {
      kind: "fee_cap_not_uniform",
      message:
        "Refused before signing: the approved quote's gas-price ceilings do not agree across its legs,"
        + " so this build cannot say which ceiling each transaction was authorized under.",
      hint: `Nothing was signed. Request a fresh ${freshQuoteTool} and execute against that.`,
    };
  }
  return null;
}

/** The leg set as a person reads it. Never empty text - "no legs" is a fact too. */
function describeRoles(roles: readonly NativeDebitLegRole[]): string {
  return roles.length === 0 ? "no transactions" : roles.join(", ");
}
